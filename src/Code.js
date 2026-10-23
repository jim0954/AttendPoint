/*
 * AttendPoint：Google Apps Script 後端
 *
 * 同一個 GAS 專案內需包含：store.js、auth.js、migrate-v2.js、Code.js（依此順序載入）與 Index.html。
 * 請用 npm run build 產生 dist/gas/，再整個資料夾推送（clasp push）或複製。
 *
 * Script Properties（專案設定 → 指令碼屬性）：
 *   OWNER_PIN       擁有者主帳號的 PIN（4–8 位數字，必填）
 *   OWNER_NAME      擁有者主帳號顯示名稱（選填，預設「擁有者」）
 *   SPREADSHEET_ID  資料存放的試算表 ID（選填；從試算表建立的專案可省略）
 *   USERS           壇務帳號（由系統自動維護，請勿手動修改）
 *
 * 所有 api* 函式都回傳 { ok: true, ... } 或 { ok: false, code, message }，不會丟出例外。
 */

const DATA_SHEET = '_data';
const BACKUP_PREFIX = '_backup_';
const CHUNK_SIZE = 40000; // 單一儲存格上限 50,000 字
const CHUNK_MARK = '~'; // 避免內容被試算表當成數字或公式
const TOKEN_TTL = 6 * 60 * 60; // 登入 6 小時有效（CacheService 上限）
const LOCK_WAIT_MS = 15000;
const MAX_FAILS = 5;
const FAIL_WINDOW = 15 * 60;
const OWNER_ID = 'U-owner';

// ---------- 網頁 ----------

// Index.html 由 npm run build 產生（已內嵌所有前端程式），不使用 GAS 樣板語法
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('佛堂點名加分系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('AttendPoint')
      .addItem('更新報表工作表', 'rebuildReportSheets')
      .addToUi();
  } catch (e) {
    // 不是從試算表開啟時沒有選單可用
  }
}

// ---------- 共用工具 ----------

function appError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function respond_(fn) {
  try {
    return Object.assign({ ok: true }, fn());
  } catch (e) {
    if (e && e.code) return { ok: false, code: e.code, message: e.message };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, code: 'SERVER_ERROR', message: '系統發生錯誤，請稍後再試' };
  }
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function cache_() {
  return CacheService.getScriptCache();
}

function nowIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); })
    .join('');
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', '目前使用人數較多，請稍後再試一次');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------- 資料儲存（試算表 _data 工作表） ----------

function spreadsheet_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw appError_('NOT_CONFIGURED', '尚未設定資料試算表，請在 Script Properties 設定 SPREADSHEET_ID');
  return ss;
}

function readState_() {
  const sheet = spreadsheet_().getSheetByName(DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 1) return AttendStore.emptyState();
  const json = sheet
    .getRange(1, 1, sheet.getLastRow(), 1)
    .getValues()
    .map(function (row) { return String(row[0]).slice(CHUNK_MARK.length); })
    .join('');
  if (!json) return AttendStore.emptyState();
  return AttendMigrate.loadAny(json).state;
}

function writeJson_(sheetName, json, hidden) {
  const ss = spreadsheet_();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  const rows = [];
  for (let i = 0; i < json.length; i += CHUNK_SIZE) rows.push([CHUNK_MARK + json.slice(i, i + CHUNK_SIZE)]);
  sheet.clearContents();
  const range = sheet.getRange(1, 1, rows.length, 1);
  range.setNumberFormat('@');
  range.setValues(rows);
  if (hidden) sheet.hideSheet();
}

function writeState_(state) {
  writeJson_(DATA_SHEET, JSON.stringify(state), true);
}

function backup_(state, label) {
  const name = BACKUP_PREFIX + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss') + (label ? '_' + label : '');
  writeJson_(name, JSON.stringify(state), true);
  return name;
}

// ---------- 帳號 ----------

function storedUsers_() {
  const raw = props_().getProperty('USERS');
  return raw ? JSON.parse(raw) : [];
}

function saveUsers_(users) {
  props_().setProperty('USERS', JSON.stringify(users));
}

function builtinOwner_() {
  return {
    id: OWNER_ID,
    name: props_().getProperty('OWNER_NAME') || '擁有者',
    role: 'owner',
    builtin: true,
    disabled: false
  };
}

function findUser_(userId) {
  if (userId === OWNER_ID) return builtinOwner_();
  return storedUsers_().find(function (u) { return u.id === userId; }) || null;
}

function checkPin_(user, pin) {
  if (user.builtin) {
    const ownerPin = props_().getProperty('OWNER_PIN');
    if (!ownerPin) throw appError_('NOT_CONFIGURED', '尚未設定擁有者 PIN，請在 Script Properties 設定 OWNER_PIN');
    return AttendAuth.verifyPin(
      { salt: 'builtin', pinHash: AttendAuth.hashPin(ownerPin, 'builtin', sha256Hex_) },
      pin,
      sha256Hex_
    );
  }
  return AttendAuth.verifyPin(user, pin, sha256Hex_);
}

/** 由 token 取得登入者；沒有 token 視為訪客（null）。token 無效時丟出 SESSION_EXPIRED。 */
function userFromToken_(token) {
  if (!token) return null;
  const key = 'tok:' + token;
  const userId = cache_().get(key);
  const user = userId ? findUser_(userId) : null;
  if (!user || user.disabled) {
    cache_().remove(key);
    throw appError_('SESSION_EXPIRED', '登入已逾時，請重新登入');
  }
  cache_().put(key, userId, TOKEN_TTL); // 使用中自動延長
  return AttendAuth.publicUser(user);
}

function requireUser_(token) {
  const user = userFromToken_(token);
  if (!user) throw appError_('FORBIDDEN', '請先登入壇務帳號');
  return user;
}

// ---------- 對前端公開的 API ----------

/** 登入畫面用的帳號清單（只有名稱與角色） */
function apiLoginOptions() {
  return respond_(function () {
    const users = [builtinOwner_()].concat(storedUsers_())
      .filter(function (u) { return !u.disabled; })
      .map(function (u) { return { id: u.id, name: u.name, roleLabel: AttendAuth.ROLE_LABELS[u.role] }; });
    return { users: users };
  });
}

function apiLogin(userId, pin) {
  return respond_(function () {
    const failKey = 'fail:' + userId;
    const fails = Number(cache_().get(failKey) || 0);
    if (fails >= MAX_FAILS) throw appError_('LOCKED', '嘗試次數過多，請 15 分鐘後再試');
    const user = findUser_(userId);
    if (!user || user.disabled || !checkPin_(user, pin)) {
      cache_().put(failKey, String(fails + 1), FAIL_WINDOW);
      const left = MAX_FAILS - fails - 1;
      throw appError_('WRONG_PIN', left > 0 ? `帳號或 PIN 碼不正確（還可以再試 ${left} 次）` : '嘗試次數過多，請 15 分鐘後再試');
    }
    cache_().remove(failKey);
    const token = newToken_();
    cache_().put('tok:' + token, user.id, TOKEN_TTL);
    return { token: token, user: AttendAuth.publicUser(user) };
  });
}

function apiLogout(token) {
  return respond_(function () {
    if (token) cache_().remove('tok:' + token);
    return {};
  });
}

/** 讀取資料。token 失效時改回傳訪客畫面，並標記 sessionExpired。 */
function apiGetState(token) {
  return respond_(function () {
    let user = null;
    let sessionExpired = false;
    try {
      user = userFromToken_(token);
    } catch (e) {
      if (e.code !== 'SESSION_EXPIRED') throw e;
      sessionExpired = true;
    }
    const state = readState_();
    return { user: user, sessionExpired: sessionExpired, state: AttendAuth.viewFor(state, user) };
  });
}

/** 執行一個資料操作（op 格式見 docs/data-model.md），回傳結果與最新資料 */
function apiApply(token, op) {
  return respond_(function () {
    const user = requireUser_(token);
    return withLock_(function () {
      const state = readState_();
      const now = nowIso_();
      AttendAuth.authorize(state, op, user, now.slice(0, 10));
      let backup = null;
      if (op.type === 'year.reset') backup = backup_(state, 'year_reset');
      const r = AttendStore.apply(state, op, { now: function () { return nowIso_(); }, operatorId: user.id, operatorName: user.name });
      writeState_(r.state);
      return { result: r.result, backup: backup, state: AttendAuth.viewFor(r.state, user) };
    });
  });
}

/** 擁有者：帳號清單 */
function apiListUsers(token) {
  return respond_(function () {
    const user = requireUser_(token);
    if (user.role !== 'owner') throw appError_('FORBIDDEN', '帳號管理僅限擁有者操作');
    return { users: [builtinOwner_()].concat(storedUsers_()).map(AttendAuth.publicUser) };
  });
}

/** 帳號操作：user.create / user.update / user.resetPin / user.delete（擁有者），self.changePin（本人） */
function apiUserOp(token, op) {
  return respond_(function () {
    const user = requireUser_(token);
    if (op && op.id === OWNER_ID) throw appError_('FORBIDDEN', '擁有者主帳號請在 Script Properties 修改');
    return withLock_(function () {
      const r = AttendAuth.applyUserOp(storedUsers_(), op, user, {
        sha256Hex: sha256Hex_,
        newSalt: function () { return Utilities.getUuid(); },
        newId: function (prefix) { return prefix + '-' + Utilities.getUuid().slice(0, 8); },
        now: nowIso_
      });
      saveUsers_(r.users);
      // 停用或刪除的帳號，下次呼叫時 token 會自動失效（userFromToken_ 會檢查）
      const users = user.role === 'owner' ? [builtinOwner_()].concat(r.users).map(AttendAuth.publicUser) : null;
      return { result: r.result, users: users };
    });
  });
}

/** 擁有者：下載完整備份（JSON 字串） */
function apiExportBackup(token) {
  return respond_(function () {
    const user = requireUser_(token);
    if (user.role !== 'owner') throw appError_('FORBIDDEN', '備份下載僅限擁有者操作');
    return { json: JSON.stringify(readState_()) };
  });
}

/**
 * 擁有者：匯入資料（v3 備份或 v2 單機版資料），會整份取代現有資料。
 * 匯入前自動在試算表留一份備份。
 */
function apiImportState(token, raw) {
  return respond_(function () {
    const user = requireUser_(token);
    if (user.role !== 'owner') throw appError_('FORBIDDEN', '匯入資料僅限擁有者操作');
    return withLock_(function () {
      const loaded = AttendMigrate.loadAny(raw, { now: nowIso_ });
      const backup = backup_(readState_(), 'before_import');
      writeState_(loaded.state);
      return { migratedFrom: loaded.migratedFrom, report: loaded.report, backup: backup, state: loaded.state };
    });
  });
}

/** 擁有者：從網頁觸發更新報表工作表 */
function apiRebuildReports(token) {
  return respond_(function () {
    const user = requireUser_(token);
    if (user.role !== 'owner') throw appError_('FORBIDDEN', '更新報表僅限擁有者操作');
    return { sheets: rebuildReportSheets() };
  });
}

// ---------- 給人看的報表工作表 ----------

function writeTable_(name, header, rows) {
  const ss = spreadsheet_();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  const values = [header].concat(rows);
  sheet.getRange(1, 1, values.length, header.length).setValues(values);
  sheet.setFrozenRows(1);
}

/**
 * 依目前資料重建「學員總表」「流水帳」「服務人員」「課次」工作表（唯讀參考用，修改請用網頁）。
 * 可從試算表選單「AttendPoint → 更新報表工作表」執行，或設定每小時觸發。
 */
function rebuildReportSheets() {
  const state = readState_();
  const totals = AttendStore.computeTotals(state);
  const duty = AttendStore.computeStaffDuty(state);
  const byId = function (list) {
    const map = {};
    list.forEach(function (x) { map[x.id] = x; });
    return map;
  };
  const classes = byId(state.classes);
  const students = byId(state.students);
  const sessions = byId(state.sessions);
  const teamName = function (s) {
    const cls = classes[s.classId];
    const team = cls && cls.teams.find(function (t) { return t.id === s.teamId; });
    return team ? team.name : '';
  };
  const status = function (x) { return x.deletedAt ? '回收區' : ''; };
  const typeLabel = { checkin: '報到', points: '加減分', redeem: '兌換', adjust: '校正', reversal: '撤銷' };

  writeTable_('學員總表',
    ['學號', '班別', '小隊', '姓名', '榮譽總分', '可用點數', '出席堂數', '備註', '狀態'],
    state.students.map(function (s) {
      const t = totals[s.id];
      return [s.id, (classes[s.classId] || {}).name || '', teamName(s), s.name, t.honor, t.balance, t.sessionIds.length, s.note || '', status(s)];
    }));

  writeTable_('流水帳',
    ['時間', '上課日期', '類型', '班別', '學號', '姓名', '事由', '榮譽變動', '點數變動', '操作者'],
    state.logs.slice().reverse().map(function (l) {
      return [
        l.at.replace('T', ' '), (sessions[l.sessionId] || {}).date || '', typeLabel[l.type] || l.type,
        (classes[l.classId] || {}).name || '', l.studentId, (students[l.studentId] || {}).name || '',
        l.reason, l.honorDelta, l.balanceDelta, l.operatorName || ''
      ];
    }));

  writeTable_('服務人員',
    ['姓名', '職務', '支援班別', '護持堂數', '備註', '狀態'],
    state.staff.map(function (p) {
      return [p.name, p.role, (p.classIds || []).map(function (id) { return (classes[id] || {}).name || ''; }).join('、'), duty[p.id] || 0, p.note || '', status(p)];
    }));

  const staffMap = byId(state.staff);
  writeTable_('課次',
    ['上課日期', '班別', '時間', '課程主題', '執勤人員', '狀態'],
    state.sessions.map(function (s) {
      return [
        s.date, (classes[s.classId] || {}).name || '', s.start && s.end ? s.start + '–' + s.end : '', s.topic,
        (s.dutyStaffIds || []).map(function (id) { return (staffMap[id] || {}).name || ''; }).join('、'), status(s)
      ];
    }));

  return ['學員總表', '流水帳', '服務人員', '課次'];
}
