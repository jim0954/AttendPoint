/*
 * AttendPoint：Google Apps Script 後端
 *
 * 同一個 GAS 專案內需包含：store.js、auth.js、migrate-v2.js、Code.js（依此順序載入）。
 * 請用 npm run build 產生 dist/gas/，再整個資料夾推送（clasp push）或複製。
 * 網頁放在 GitHub Pages，以 fetch POST 呼叫這裡的 doPost（見 src/ui/backend.js）。
 *
 * Script Properties（專案設定 → 指令碼屬性）：
 *   OWNER_PIN       擁有者主帳號的 PIN（4–8 位數字，必填）
 *   OWNER_NAME      擁有者主帳號顯示名稱（選填，預設「擁有者」）
 *   SPREADSHEET_ID  資料存放的試算表 ID（選填；從試算表建立的專案可省略）
 *   USERS…          壇務帳號（USERS、USERS_2…、USERS_PARTS，由系統自動維護，請勿手動修改）
 *   DATA_SHEET      目前使用中的資料工作表（由系統自動維護，請勿手動修改）
 *   BACKUP_KEEP     自動保留的備份份數（選填，預設 10；跨年度結算的備份一律保留，不計入）
 *
 * 所有 api* 函式都回傳 { ok: true, ... } 或 { ok: false, code, message }，不會丟出例外。
 */

// 資料輪流寫在兩個工作表，寫完並檢查無誤才切換 DATA_SHEET 屬性，寫到一半失敗也不會損壞現有資料
const DATA_SHEETS = ['_data', '_data_2'];
const DATA_PTR = 'DATA_SHEET';
const BACKUP_PREFIX = '_backup_';
const BACKUP_KEEP = 10;
const YEAR_RESET_LABEL = 'year_reset';
const CHUNK_SIZE = 40000; // 單一儲存格上限 50,000 字
const CHUNK_MARK = '~'; // 避免內容被試算表當成數字或公式
const TOKEN_TTL = 6 * 60 * 60; // 登入 6 小時有效（CacheService 上限）
const LOCK_WAIT_MS = 15000;
const MAX_FAILS = 5;
const FAIL_WINDOW = 15 * 60;
const OWNER_ID = 'U-owner';
// 後台程式版本：npm run build 時換成 store／auth／migrate-v2／Code 的指紋，
// 網頁比對不同時會提示擁有者更新 Apps Script
const BACKEND_VERSION = '@BACKEND_VERSION@';

// ---------- 網頁呼叫的入口 ----------

// 開啟網址只顯示說明；網頁在 GitHub Pages，資料透過 doPost 存取
function doGet() {
  return ContentService.createTextOutput('AttendPoint 後台運作中（版本 ' + BACKEND_VERSION + '）。請使用佛堂點名系統的網頁網址。');
}

// 網頁可以呼叫的 API（其他函式一律拒絕）
const API_FUNCTIONS = [
  'apiLoginOptions', 'apiLogin', 'apiLogout', 'apiGetState', 'apiApply',
  'apiListUsers', 'apiUserOp', 'apiExportBackup', 'apiImportState', 'apiRebuildReports',
  'apiGetLogo', 'apiSetLogo'
];

/**
 * 網頁以 fetch POST 純文字 JSON { fn, args } 呼叫（text/plain 屬於簡單請求，不會觸發 CORS 預檢），
 * 回傳 JSON：api* 函式的結果，或 { ok: false, code, message }。
 */
function doPost(e) {
  let res;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (API_FUNCTIONS.indexOf(req.fn) === -1) {
      res = { ok: false, code: 'INVALID_OP', message: '不支援的操作' };
    } else {
      res = globalThis[req.fn].apply(null, Array.isArray(req.args) ? req.args : []);
    }
  } catch (err) {
    res = { ok: false, code: 'INVALID_OP', message: '請求格式錯誤' };
  }
  res.backendVersion = BACKEND_VERSION;
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
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

// ---------- 資料儲存（試算表 _data／_data_2 工作表） ----------

function spreadsheet_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw appError_('NOT_CONFIGURED', '尚未設定資料試算表，請在 Script Properties 設定 SPREADSHEET_ID');
  return ss;
}

/** 讀取分段存放的 JSON；工作表不存在或空白時回傳空字串 */
function readJson_(sheetName) {
  const sheet = spreadsheet_().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 1) return '';
  return sheet
    .getRange(1, 1, sheet.getLastRow(), 1)
    .getValues()
    .map(function (row) { return String(row[0]).slice(CHUNK_MARK.length); })
    .join('');
}

function readState_() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ptr = props_().getProperty(DATA_PTR);
    const json = readJson_(ptr || DATA_SHEETS[0]);
    // 只有還沒寫過資料（全新安裝）才當作空白資料；寫過之後讀不到就停止，避免空白資料覆蓋原本的資料
    if (!json && !ptr) return AttendStore.emptyState();
    if (!json) continue;
    try {
      return AttendMigrate.loadAny(json).state;
    } catch (e) {
      // 讀取時剛好遇到別人連續寫入（極少見），內容不完整，重新讀一次
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  throw appError_('DATA_UNREADABLE', '資料讀取失敗，為了保護資料已暫停操作，請稍後再試；持續發生請擁有者從備份工作表還原');
}

/** 寫入分段 JSON，回傳寫入的列數 */
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
  return rows.length;
}

/** 寫到目前沒在使用的工作表，確認寫入完整後才切換，切換前讀取的人仍看到舊資料 */
function writeData_(json) {
  const current = props_().getProperty(DATA_PTR) || DATA_SHEETS[0];
  const target = current === DATA_SHEETS[0] ? DATA_SHEETS[1] : DATA_SHEETS[0];
  const count = writeJson_(target, json, true);
  SpreadsheetApp.flush();
  const sheet = spreadsheet_().getSheetByName(target);
  const last = sheet.getRange(count, 1, 1, 1).getValues()[0][0];
  const tail = json.slice((count - 1) * CHUNK_SIZE);
  if (sheet.getLastRow() !== count || String(last) !== CHUNK_MARK + tail) {
    throw appError_('WRITE_FAILED', '資料寫入不完整，這次操作沒有生效，請再試一次');
  }
  props_().setProperty(DATA_PTR, target);
}

function backup_(state, label) {
  const name = BACKUP_PREFIX + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss') + (label ? '_' + label : '');
  writeJson_(name, JSON.stringify(state), true);
  try {
    pruneBackups_();
  } catch (e) {
    // 清理失敗不影響這次操作，下次備份時會再清
    console.error(e && e.stack ? e.stack : e);
  }
  return name;
}

function backupKeep_() {
  const n = Number(props_().getProperty('BACKUP_KEEP'));
  return Number.isInteger(n) && n >= 1 ? n : BACKUP_KEEP;
}

/**
 * 只保留最新的 BACKUP_KEEP 份備份，較舊的刪除。
 * 跨年度結算的備份是前一年度唯一的完整紀錄，一年只有一份，一律保留。
 * 工作表名稱含日期時間（_backup_yyyyMMdd_HHmmss_…），依名稱排序即為新舊順序。
 */
function pruneBackups_() {
  const ss = spreadsheet_();
  const old = ss.getSheets()
    .filter(function (sh) {
      const name = sh.getName();
      return name.indexOf(BACKUP_PREFIX) === 0 && name.slice(-YEAR_RESET_LABEL.length) !== YEAR_RESET_LABEL;
    })
    .sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; })
    .slice(backupKeep_());
  old.forEach(function (sh) { ss.deleteSheet(sh); });
  return old.map(function (sh) { return sh.getName(); });
}

// 快取目前資料版本，資料沒變時讀取不必打開試算表（快取遺失時改讀試算表）
const SYNC_KEY = 'sync';

function syncKey_(info) {
  return info.syncId + ':' + info.rev;
}

function writeState_(state) {
  cache_().remove(SYNC_KEY);
  writeData_(JSON.stringify(state));
  cache_().put(SYNC_KEY, syncKey_(AttendAuth.syncInfo(state)), TOKEN_TTL);
}

// ---------- 帳號 ----------

// 單一指令碼屬性最多 9 KB（約 35 個帳號），帳號清單分段存在 USERS、USERS_2、USERS_3…，
// USERS_PARTS 記錄段數（沒有這個屬性時是舊版，整份都在 USERS）
const USERS_PART_CHARS = 2500; // 中文一字 3 bytes，2500 字以內一定不超過 9 KB

function storedUsers_() {
  const props = props_();
  const parts = Number(props.getProperty('USERS_PARTS') || 1);
  let raw = props.getProperty('USERS') || '';
  for (let i = 2; i <= parts; i++) raw += props.getProperty('USERS_' + i) || '';
  return raw ? JSON.parse(raw) : [];
}

function saveUsers_(users) {
  const props = props_();
  const json = JSON.stringify(users);
  const before = Number(props.getProperty('USERS_PARTS') || 1);
  const values = { USERS: json.slice(0, USERS_PART_CHARS) };
  let parts = 1;
  while (parts * USERS_PART_CHARS < json.length) {
    parts++;
    values['USERS_' + parts] = json.slice((parts - 1) * USERS_PART_CHARS, parts * USERS_PART_CHARS);
  }
  values.USERS_PARTS = String(parts);
  props.setProperties(values); // 一次寫入，不會只寫到一半
  for (let i = parts + 1; i <= before; i++) props.deleteProperty('USERS_' + i);
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
    // 帳號 id 很短；過長的值（快取鍵上限 250 字）直接當成帳號不正確
    if (typeof userId !== 'string' || userId.length > 64) throw appError_('WRONG_PIN', '帳號或 PIN 碼不正確');
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

/**
 * 讀取資料。token 失效時改回傳訪客畫面，並標記 sessionExpired。
 * since 為前端手上的版本（見 AttendAuth.syncView），有的話只回傳變動。
 */
function apiGetState(token, since) {
  return respond_(function () {
    let user = null;
    let sessionExpired = false;
    try {
      user = userFromToken_(token);
    } catch (e) {
      if (e.code !== 'SESSION_EXPIRED') throw e;
      sessionExpired = true;
    }
    const kind = AttendAuth.viewKind(user);
    if (since && since.view === kind && cache_().get(SYNC_KEY) === syncKey_(since)) {
      return { user: user, sessionExpired: sessionExpired, view: kind, unchanged: true };
    }
    return Object.assign({ user: user, sessionExpired: sessionExpired }, AttendAuth.syncView(readState_(), user, since));
  });
}

/** 執行一個資料操作（op 格式見 docs/data-model.md），回傳結果與最新資料（有 since 時只回傳變動） */
function apiApply(token, op, since) {
  return respond_(function () {
    const user = requireUser_(token);
    return withLock_(function () {
      const state = readState_();
      const now = nowIso_();
      AttendAuth.authorize(state, op, user, now.slice(0, 10));
      let backup = null;
      if (op.type === 'year.reset') backup = backup_(state, YEAR_RESET_LABEL);
      const r = AttendStore.apply(state, op, { now: function () { return nowIso_(); }, operatorId: user.id, operatorName: user.name });
      writeState_(r.state);
      return Object.assign({ result: r.result, backup: backup }, AttendAuth.syncView(r.state, user, since));
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
      loaded.state.meta.syncId = 'Y' + Utilities.getUuid(); // 整份換掉，各裝置都要重新下載
      // 現有資料讀不到時（DATA_UNREADABLE）仍允許匯入，讓擁有者可以用備份檔復原
      let current = null;
      try {
        current = readState_();
      } catch (e) {
        if (e.code !== 'DATA_UNREADABLE') throw e;
      }
      const backup = current ? backup_(current, 'before_import') : null;
      writeState_(loaded.state);
      return { migratedFrom: loaded.migratedFrom, report: loaded.report, backup: backup, view: 'full', state: loaded.state };
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

// ---------- LOGO ----------
// LOGO 圖檔不放進程式碼（GitHub 公開），由擁有者從網頁上傳，存在試算表隱藏的 _logo 工作表

const LOGO_SHEET = '_logo';
const LOGO_MAX_CHARS = 200000;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/;

/** 所有人：讀取 LOGO（data URI；沒有設定時為空字串） */
function apiGetLogo() {
  return respond_(function () {
    return { logo: readJson_(LOGO_SHEET).trim() }; // 移除時存的是一個空白
  });
}

/** 擁有者：上傳 LOGO（data URI），傳空字串為移除 */
function apiSetLogo(token, logo) {
  return respond_(function () {
    const user = requireUser_(token);
    if (user.role !== 'owner') throw appError_('FORBIDDEN', '設定 LOGO 僅限擁有者操作');
    const value = String(logo || '');
    if (value && (value.length > LOGO_MAX_CHARS || !LOGO_RE.test(value))) {
      throw appError_('INVALID_INPUT', 'LOGO 需為 PNG、JPEG 或 WebP 圖片，且不超過 150 KB');
    }
    return withLock_(function () {
      writeJson_(LOGO_SHEET, value || ' ', true);
      return { logo: value };
    });
  });
}

// ---------- 給人看的報表工作表 ----------

function writeTable_(name, header, rows) {
  const ss = spreadsheet_();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  // 開頭是 = + - @ 的文字（例如姓名、加分事由）會被試算表當成公式，前面補 ' 當純文字
  const values = [header].concat(rows).map(function (row) {
    return row.map(function (v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; });
  });
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
