// 在 Node 中模擬 Google Apps Script 服務，測試 Code.js 的完整流程
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas } = require('../scripts/gas-mock.js');

// 後台回應以 JSON 傳給網頁，這裡用 JSON 模擬
function ok(res) {
  assert.equal(res.ok, true, `${res.code}: ${res.message}`);
  return JSON.parse(JSON.stringify(res));
}

// 目前使用中的資料工作表
function dataSheet(env) {
  return env.sheets[env.props.DATA_SHEET || '_data'];
}

function fail(res, code) {
  assert.equal(res.ok, false, '應該失敗');
  assert.equal(res.code, code, res.message);
}

function setup() {
  const env = createGas({ OWNER_PIN: '246810', OWNER_NAME: '堂主' });
  const g = env.gas;
  const owner = ok(g.apiLogin('U-owner', '246810')).token;
  const cls = ok(g.apiApply(owner, {
    type: 'class.create', name: '兒童讀經班', idPrefix: 'K', teams: ['孝順隊'],
    addRules: [{ label: '準時報到', points: 10, isCheckin: true }]
  })).result;
  const created = ok(g.apiUserOp(owner, { type: 'user.create', name: '壇務甲', pin: '123456' })).result;
  const staff = ok(g.apiLogin(created.id, '123456')).token;
  return Object.assign(env, { g, owner, staff, staffUserId: created.id, classId: cls.id });
}

test('沒有設定 OWNER_PIN 時無法登入，並提示設定方式', () => {
  const { gas } = createGas({});
  fail(gas.apiLogin('U-owner', '123456'), 'NOT_CONFIGURED');
});

test('登入：PIN 錯誤會倒數，錯 5 次鎖定', () => {
  const { g } = setup();
  for (let i = 0; i < 4; i++) fail(g.apiLogin('U-owner', '000000'), 'WRONG_PIN');
  fail(g.apiLogin('U-owner', '000000'), 'WRONG_PIN');
  fail(g.apiLogin('U-owner', '246810'), 'LOCKED');
});

test('登入：比對 PIN 之前就先記下這次嘗試（同時送出大量請求也無法超過 5 次）', () => {
  const { g, cache } = setup();
  const seen = [];
  const check = g.checkPin_;
  g.checkPin_ = function () { seen.push(cache['fail:U-owner']); return false; };
  for (let i = 0; i < 6; i++) g.apiLogin('U-owner', '000000');
  g.checkPin_ = check;
  assert.deepEqual(seen, ['1', '2', '3', '4', '5'], '第 6 次在比對前就被擋下');
  fail(g.apiLogin('U-owner', '246810'), 'LOCKED');
});

test('登入：擁有者 PIN 少於 6 位數時提示修改；改版前的 4 位數壇務 PIN 仍可登入', () => {
  const { gas } = createGas({ OWNER_PIN: '2468' });
  const res = gas.apiLogin('U-owner', '2468');
  fail(res, 'NOT_CONFIGURED');
  assert.match(res.message, /6–8 位數字/);
  const { g, owner, props } = setup();
  fail(g.apiUserOp(owner, { type: 'user.create', name: '乙', pin: '1234' }), 'INVALID_PIN');
  // 舊帳號：直接放一個以 4 位數 PIN 雜湊的帳號
  const users = JSON.parse(props.USERS);
  const legacy = Object.assign({}, users[0], { id: 'U-legacy', name: '舊帳號', salt: 's' });
  legacy.pinHash = g.AttendAuth.hashPin('1234', 's', g.sha256Hex_);
  g.saveUsers_(users.concat([legacy]));
  ok(g.apiLogin('U-legacy', '1234'));
});

test('PIN 改了之後，之前登入的裝置都要重新登入（自己改 PIN 的這台除外）', () => {
  const { g, owner, staff, staffUserId, props } = setup();
  // 壇務自己改 PIN：這台保持登入，另一台失效
  const other = ok(g.apiLogin(staffUserId, '123456')).token;
  ok(g.apiUserOp(staff, { type: 'self.changePin', oldPin: '123456', newPin: '567890' }));
  ok(g.apiGetState(staff));
  assert.equal(ok(g.apiGetState(other)).sessionExpired, true);
  // 擁有者重設壇務 PIN：壇務的登入失效
  ok(g.apiUserOp(owner, { type: 'user.resetPin', id: staffUserId, pin: '135790' }));
  fail(g.apiApply(staff, { type: 'gift.create', name: 'x', cost: 1 }), 'SESSION_EXPIRED');
  // 在指令碼屬性改 OWNER_PIN：擁有者的登入失效
  ok(g.apiListUsers(owner));
  props.OWNER_PIN = '97531086';
  fail(g.apiListUsers(owner), 'SESSION_EXPIRED');
  ok(g.apiLogin('U-owner', '97531086'));
});

test('改版前的登入（token 只記帳號 id）需要重新登入', () => {
  const { g, cache } = setup();
  cache['tok:legacy'] = 'U-owner';
  fail(g.apiListUsers('legacy'), 'SESSION_EXPIRED');
});

test('合併送出：一次讀寫試算表，失敗的操作不影響其他操作', () => {
  const env = setup();
  const { g, owner, staff, classId, props } = env;
  const ids = ['王小明', '李小華', '陳大同'].map((name) => ok(g.apiApply(staff, { type: 'student.create', classId, teamId: null, name })).result.id);
  const date = '2026-10-24';
  ok(g.apiApply(staff, { type: 'points.checkin', studentId: ids[0], date }));
  const before = props.DATA_SHEET;
  const res = ok(g.apiApplyBatch(staff, [
    { type: 'points.checkin', studentId: ids[1], date },
    { type: 'points.checkin', studentId: ids[0], date }, // 已經報到過
    { type: 'student.delete', id: ids[2] }, // 壇務不能刪除
    { type: 'points.award', studentId: ids[2], date, points: 3, reason: '幫忙' }
  ], null));
  assert.deepEqual(res.results.map((r) => r.ok ? 'ok' : r.code), ['ok', 'ALREADY_CHECKED_IN', 'FORBIDDEN', 'ok']);
  assert.notEqual(props.DATA_SHEET, before, '有成功的操作才寫入');
  const after = props.DATA_SHEET;
  const state = ok(g.apiGetState(owner)).state;
  assert.equal(state.students.filter((x) => !x.deletedAt).length, 3);
  assert.equal(state.logs.filter((l) => l.type === 'checkin').length, 2);
  assert.ok(state.logs.some((l) => l.reason === '幫忙' && l.operatorName === '壇務甲'));
  assert.ok(res.state, '回傳最新資料');
  // 全部失敗時不寫入
  const none = ok(g.apiApplyBatch(staff, [{ type: 'points.checkin', studentId: ids[1], date }], null));
  assert.equal(none.results[0].ok, false);
  assert.equal(props.DATA_SHEET, after);
  // 格式與權限
  fail(g.apiApplyBatch(staff, [], null), 'INVALID_INPUT');
  fail(g.apiApplyBatch(staff, new Array(31).fill({ type: 'gift.create', name: 'x', cost: 1 }), null), 'INVALID_INPUT');
  fail(g.apiApplyBatch(null, [{ type: 'gift.create', name: 'x', cost: 1 }], null), 'FORBIDDEN');
  assert.equal(ok(g.apiApplyBatch(staff, [null], null)).results[0].ok, false);
});

test('登入清單只有名稱與角色，不含 PIN 資訊', () => {
  const { g } = setup();
  const res = ok(g.apiLoginOptions());
  assert.deepEqual(res.users.map((u) => u.name), ['堂主', '壇務甲']);
  assert.equal(JSON.stringify(res).includes('pinHash'), false);
});

test('壇務完整流程：建課次、建學員、點名、加分，資料寫入試算表', () => {
  const env = setup();
  const { g, staff, classId } = env;
  const session = ok(g.apiApply(staff, { type: 'session.ensure', classId, date: '2026-10-24' })).result;
  const stu = ok(g.apiApply(staff, { type: 'student.create', classId, name: '王小明' })).result;
  const res = ok(g.apiApply(staff, { type: 'points.checkin', studentId: stu.id, sessionId: session.id }));
  assert.equal(res.result.points, 10);
  const log = res.state.logs[0];
  assert.equal(log.operatorName, '壇務甲');
  // 試算表中的資料是加了標記的 JSON
  const cell = dataSheet(env).cells()[0][0];
  assert.equal(cell[0], '~');
  assert.ok(dataSheet(env).hidden);
  // 重新讀取仍一致
  const again = ok(g.apiGetState(staff));
  assert.equal(again.state.logs.length, 1);
  fail(g.apiApply(staff, { type: 'points.checkin', studentId: stu.id, sessionId: session.id }), 'ALREADY_CHECKED_IN');
});

test('壇務刪除會被後端拒絕；擁有者可以', () => {
  const { g, staff, owner, classId } = setup();
  const stu = ok(g.apiApply(staff, { type: 'student.create', classId, name: '王小明' })).result;
  fail(g.apiApply(staff, { type: 'student.delete', id: stu.id }), 'FORBIDDEN');
  ok(g.apiApply(owner, { type: 'student.delete', id: stu.id }));
});

test('訪客：可讀遮蔽後的資料，不能寫入', () => {
  const { g, staff, classId } = setup();
  ok(g.apiApply(staff, { type: 'student.create', classId, name: '王小明', note: '過敏' }));
  const res = ok(g.apiGetState(null));
  assert.equal(res.user, null);
  assert.equal(res.state.students[0].name, '王○明');
  assert.equal(JSON.stringify(res.state).includes('過敏'), false);
  fail(g.apiApply(null, { type: 'student.create', classId, name: 'x' }), 'FORBIDDEN');
});

test('token 失效：讀取退回訪客畫面，寫入要求重新登入', () => {
  const { g, staff } = setup();
  ok(g.apiLogout(staff));
  const res = ok(g.apiGetState(staff));
  assert.equal(res.sessionExpired, true);
  assert.equal(res.user, null);
  fail(g.apiApply(staff, { type: 'meta.update', templeTitle: 'x' }), 'SESSION_EXPIRED');
});

test('停用帳號後，原本的登入立即失效', () => {
  const { g, owner, staff, staffUserId } = setup();
  ok(g.apiUserOp(owner, { type: 'user.update', id: staffUserId, patch: { disabled: true } }));
  fail(g.apiApply(staff, { type: 'gift.create', name: 'x', cost: 1 }), 'SESSION_EXPIRED');
  fail(g.apiLogin(staffUserId, '123456'), 'WRONG_PIN');
});

test('帳號管理：壇務不能管理帳號，但可以改自己的 PIN；PIN 不以明文儲存', () => {
  const { g, owner, staff, staffUserId, props } = setup();
  fail(g.apiListUsers(staff), 'FORBIDDEN');
  fail(g.apiUserOp(staff, { type: 'user.create', name: '乙', pin: '111111' }), 'FORBIDDEN');
  ok(g.apiUserOp(staff, { type: 'self.changePin', oldPin: '123456', newPin: '567890' }));
  ok(g.apiLogin(staffUserId, '567890'));
  assert.equal(props.USERS.includes('567890'), false);
  fail(g.apiUserOp(owner, { type: 'user.delete', id: 'U-owner' }), 'FORBIDDEN');
  assert.equal(ok(g.apiListUsers(owner)).users.length, 2);
});

test('匯入 v2 資料：自動移轉並先備份；跨年度結算前自動備份', () => {
  const { g, owner, sheets } = setup();
  const v2 = {
    students: [{ id: 'K01', classType: 'kids', name: '範例甲', team: '孝順隊', honorPoints: 50, availablePoints: 30, attendedDates: ['2026-10-01'] }],
    logs: []
  };
  const res = ok(g.apiImportState(owner, JSON.stringify(v2)));
  assert.equal(res.migratedFrom, 2);
  assert.ok(sheets[res.backup], '匯入前應留備份');
  const state = ok(g.apiGetState(owner)).state;
  assert.equal(state.students[0].id, 'K01');

  const reset = ok(g.apiApply(owner, { type: 'year.reset', yearLabel: '2027 年度' }));
  assert.ok(sheets[reset.backup], '結算前應留備份');
  assert.equal(reset.state.logs.length, 0);
});

test('報表工作表：學員總表包含計算後的分數', () => {
  const { g, owner, staff, classId, sheets } = setup();
  const teamId = ok(g.apiGetState(owner)).state.classes[0].teams[0].id;
  const stu = ok(g.apiApply(staff, { type: 'student.create', classId, teamId, name: '王小明' })).result;
  ok(g.apiApply(staff, { type: 'points.award', studentId: stu.id, points: 15, reason: '背經' }));
  assert.deepEqual(ok(g.apiRebuildReports(owner)).sheets, ['學員總表', '流水帳', '服務人員', '課次']);
  const rows = sheets['學員總表'].cells();
  assert.deepEqual(rows[1].slice(0, 7), [stu.id, '兒童讀經班', '孝順隊', '王小明', 15, 15, 0]);
  fail(g.apiRebuildReports(staff), 'FORBIDDEN');
});

test('報表工作表：每堂課的出席人數、出席率與名單；服務人員的各班護持堂數', () => {
  const { g, owner, staff, classId, sheets } = setup();
  const ids = ['王小明', '李小華', '陳大同', '林小美'].map((name) => ok(g.apiApply(staff, { type: 'student.create', classId, teamId: null, name })).result.id);
  const p = ok(g.apiApply(owner, { type: 'staff.create', name: '林輔導', role: '護持壇務', classIds: [classId] })).result;
  ok(g.apiApply(owner, { type: 'staff.create', name: '陳師姐', role: '', classIds: [classId] }));
  const date = '2026-10-24';
  ok(g.apiApplyBatch(staff, [
    { type: 'points.checkin', studentId: ids[0], date },
    { type: 'points.checkin', studentId: ids[1], date },
    { type: 'points.checkin', studentId: ids[2], date },
    { type: 'session.duty', classId, staffId: p.id, date }
  ], null));
  ok(g.apiRebuildReports(owner));
  const rows = sheets['課次'].cells();
  assert.deepEqual(rows[0].slice(4, 12), ['學員出席', '學員出席率', '出席學員', '缺席學員', '服務人員出席', '服務人員出席率', '出席服務人員', '缺席服務人員']);
  assert.deepEqual(rows[1].slice(4, 12), ['3 / 4', '75%', '王小明、李小華、陳大同', '林小美', '1 / 2', '50%', '林輔導', '陳師姐']);
  const staffRows = sheets['服務人員'].cells();
  assert.equal(staffRows[0][4], '各班護持堂數');
  assert.equal(staffRows.find((r) => r[0] === '林輔導')[4], '兒童讀經班 1');
});

test('報表工作表：開頭像公式的文字以純文字寫入，數字不變', () => {
  const { g, owner, staff, classId, sheets } = setup();
  const stu = ok(g.apiApply(staff, { type: 'student.create', classId, teamId: null, name: '=HYPERLINK("x")' })).result;
  ok(g.apiApply(staff, { type: 'points.award', studentId: stu.id, points: 3, reason: '-遲到' }));
  ok(g.apiRebuildReports(owner));
  const row = sheets['學員總表'].cells()[1];
  assert.equal(row[3], `'=HYPERLINK("x")`);
  assert.equal(row[4], 3);
  assert.ok(sheets['流水帳'].cells().some((r) => r.indexOf("'-遲到") !== -1));
});

test('帳號：超過單一屬性 9 KB 時分段存放，刪減後清掉多的段落；舊版整份 USERS 也讀得到', () => {
  const env = setup();
  const { g, owner, props } = env;
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(ok(g.apiUserOp(owner, { type: 'user.create', name: '範例壇務' + i, pin: '123456' })).result.id);
  assert.ok(Number(props.USERS_PARTS) >= 3, props.USERS_PARTS);
  const list = ok(g.apiListUsers(owner)).users;
  assert.equal(list.filter((u) => u.name.indexOf('範例壇務') === 0).length, 60);
  ok(g.apiLogin(ids[59], '123456'));

  // 舊版：只有 USERS、沒有 USERS_PARTS
  const users = JSON.parse(Array.from({ length: Number(props.USERS_PARTS) }, (_, i) => props[i ? 'USERS_' + (i + 1) : 'USERS']).join(''));
  // 帳號變少：多的段落刪掉
  g.saveUsers_(users.slice(0, 3));
  assert.equal(props.USERS_PARTS, '1');
  assert.equal(Object.keys(props).filter((k) => /^USERS_\d/.test(k)).length, 0);
  assert.equal(ok(g.apiListUsers(owner)).users.length, 4); // 含擁有者
  // 舊版：只有 USERS、沒有 USERS_PARTS
  delete props.USERS_PARTS;
  props.USERS = JSON.stringify(users.slice(0, 2));
  assert.equal(ok(g.apiListUsers(owner)).users.length, 3);
  ok(g.apiUserOp(owner, { type: 'user.create', name: '新帳號', pin: '123456' }));
  assert.equal(props.USERS_PARTS, '1');
});

test('登入：過長或不是文字的帳號 id 回覆帳號不正確', () => {
  const { g } = setup();
  fail(g.apiLogin('U-' + 'x'.repeat(300), '123456'), 'WRONG_PIN');
  fail(g.apiLogin({ id: 1 }, '123456'), 'WRONG_PIN');
});

test('大量資料會分段存放在多個儲存格', () => {
  const env = setup();
  const { g, owner, classId } = env;
  const state = ok(g.apiGetState(owner)).state;
  // 直接寫入一份大資料（約 20 萬字）再讀回
  const big = JSON.parse(JSON.stringify(state));
  for (let i = 0; i < 1500; i++) {
    big.students.push({ id: 'X' + i, classId, teamId: big.classes[0].teams[0].id, name: '範例學員' + i, note: '備註'.repeat(50), deletedAt: null });
  }
  ok(g.apiImportState(owner, JSON.stringify(big)));
  assert.ok(dataSheet(env).cells().length > 3);
  assert.equal(ok(g.apiGetState(owner)).state.students.length, 1500);
});

test('增量同步：點名只回傳新增紀錄；資料沒變時不讀試算表', () => {
  const { g, staff, classId, sheets, props } = setup();
  const session = ok(g.apiApply(staff, { type: 'session.ensure', classId, date: '2026-10-24' })).result;
  const stu = ok(g.apiApply(staff, { type: 'student.create', classId, name: '王小明' })).result;
  let base = ok(g.apiGetState(staff, null)).state;
  const since = () => g.AttendAuth.sinceOf(base, 'full');

  const res = ok(g.apiApply(staff, { type: 'points.checkin', studentId: stu.id, sessionId: session.id }, since()));
  assert.equal(res.state, undefined);
  assert.equal(res.delta.logs.length, 1);
  base = JSON.parse(JSON.stringify(g.AttendAuth.mergeView(base, res)));
  assert.deepEqual(base, ok(g.apiGetState(staff, null)).state);

  // 沒有變動：直接由快取判斷，不打開試算表
  const name = props.DATA_SHEET;
  const data = sheets[name];
  sheets[name] = null;
  const same = ok(g.apiGetState(staff, since()));
  assert.equal(same.unchanged, true);
  assert.equal(same.state, undefined);
  assert.equal(same.user.name, '壇務甲');
  sheets[name] = data;
});

test('增量同步：快取遺失時改讀試算表；匯入資料後各裝置整份重新下載', () => {
  const { g, owner, cache } = setup();
  const base = ok(g.apiGetState(owner, null)).state;
  const since = g.AttendAuth.sinceOf(base, 'full');
  delete cache.sync;
  assert.equal(ok(g.apiGetState(owner, since)).unchanged, true);

  const backup = ok(g.apiExportBackup(owner)).json;
  const imported = ok(g.apiImportState(owner, backup));
  assert.notEqual(imported.state.meta.syncId, base.meta.syncId);
  assert.ok(ok(g.apiGetState(owner, since)).state);
});

// ---------- 寫入安全 ----------

test('寫入安全：輪流寫兩個工作表，寫完才切換，上一版保留在另一個工作表', () => {
  const env = setup();
  const { g, owner, classId, sheets, props } = env;
  const before = props.DATA_SHEET;
  const prev = JSON.stringify(dataSheet(env).cells());
  ok(g.apiApply(owner, { type: 'student.create', classId, name: '王小明' }));
  assert.notEqual(props.DATA_SHEET, before);
  assert.deepEqual(['_data', '_data_2'].sort(), [before, props.DATA_SHEET].sort());
  assert.equal(JSON.stringify(sheets[before].cells()), prev);
  assert.ok(sheets._data_2.hidden && sheets._data.hidden);
});

test('寫入安全：寫到一半出錯時，原本的資料不受影響，之後可以繼續操作', () => {
  const env = setup();
  const { g, owner, classId, sheets, props } = env;
  ok(g.apiApply(owner, { type: 'student.create', classId, name: '王小明' }));
  const good = ok(g.apiGetState(owner)).state;
  const target = props.DATA_SHEET === '_data' ? '_data_2' : '_data';
  const sheet = sheets[target];
  const realGetRange = sheet.getRange;

  // 情況一：寫入時丟出錯誤（例如逾時、試算表忙碌）
  sheet.getRange = (...args) => Object.assign(realGetRange(...args), { setValues() { throw new Error('Service timed out'); } });
  fail(g.apiApply(owner, { type: 'student.create', classId, name: '李小華' }), 'SERVER_ERROR');
  assert.deepEqual(ok(g.apiGetState(owner)).state, good);

  // 情況二：沒有錯誤但只寫進一部分
  sheet.getRange = (r, c, nr, nc) => {
    const range = realGetRange(r, c, nr, nc);
    return Object.assign(range, { setValues: (values) => realGetRange(r, c, 1, nc).setValues(values.slice(0, 1).map((row) => [row[0].slice(0, 10)])) });
  };
  fail(g.apiApply(owner, { type: 'student.create', classId, name: '李小華' }), 'WRITE_FAILED');
  assert.deepEqual(ok(g.apiGetState(owner)).state, good);

  // 恢復正常後可以繼續
  sheet.getRange = realGetRange;
  ok(g.apiApply(owner, { type: 'student.create', classId, name: '李小華' }));
  assert.deepEqual(ok(g.apiGetState(owner)).state.students.map((s) => s.name), ['王小明', '李小華']);
});

test('寫入安全：資料工作表被刪除或內容損壞時停止操作，不會用空白資料覆蓋', () => {
  const env = setup();
  const { g, owner, staff, classId, sheets, props } = env;
  ok(g.apiApply(owner, { type: 'student.create', classId, name: '王小明' }));
  const name = props.DATA_SHEET;
  const saved = sheets[name];

  sheets[name] = null; // 有人誤刪了工作表
  fail(g.apiGetState(staff, null), 'DATA_UNREADABLE');
  fail(g.apiApply(staff, { type: 'student.create', classId, name: '李小華' }), 'DATA_UNREADABLE');
  assert.equal(props.DATA_SHEET, name); // 沒有切換、沒有寫入

  sheets[name] = saved;
  const cells = saved.cells();
  const original = cells[0][0];
  cells[0][0] = original.slice(0, 20); // 內容被改壞
  fail(g.apiGetState(staff, null), 'DATA_UNREADABLE');
  cells[0][0] = original;
  const backup = ok(g.apiExportBackup(owner)).json;
  assert.equal(ok(g.apiGetState(staff, null)).state.students.length, 1);

  // 資料讀不到時，擁有者仍可以匯入備份檔復原
  sheets[name] = null;
  const restored = ok(g.apiImportState(owner, backup));
  assert.equal(restored.backup, null);
  assert.equal(ok(g.apiGetState(staff, null)).state.students.length, 1);
});

test('寫入安全：舊版只有 _data 工作表時照常讀取，下次寫入改用 _data_2', () => {
  const env = setup();
  const { g, owner, classId, sheets, props } = env;
  // 模擬舊版：資料在 _data，沒有 DATA_SHEET 屬性
  sheets._data = sheets[props.DATA_SHEET];
  delete sheets._data_2;
  delete props.DATA_SHEET;
  delete env.cache.sync;
  assert.equal(ok(g.apiGetState(owner, null)).state.classes.length, 1);
  ok(g.apiApply(owner, { type: 'student.create', classId, name: '王小明' }));
  assert.equal(props.DATA_SHEET, '_data_2');
  assert.equal(ok(g.apiGetState(owner, null)).state.students.length, 1);
});

// ---------- 備份清理 ----------

function backupNames(sheets) {
  return Object.keys(sheets).filter((n) => n.startsWith('_backup_') && sheets[n]).sort();
}

test('備份清理：只保留最新 10 份，跨年度結算的備份一律保留', () => {
  const { g, owner, sheets } = setup();
  const backup = ok(g.apiExportBackup(owner)).json;
  // 先放 12 份舊的匯入備份、2 份舊的跨年度結算備份
  for (let i = 1; i <= 12; i++) g.writeJson_(`_backup_2025${String(i).padStart(2, '0')}01_090000_before_import`, backup, true);
  g.writeJson_('_backup_20240101_090000_year_reset', backup, true);
  g.writeJson_('_backup_20250101_090000_year_reset', backup, true);

  const res = ok(g.apiImportState(owner, backup)); // 產生第 13 份匯入備份，觸發清理
  const names = backupNames(sheets);
  assert.ok(names.includes(res.backup));
  assert.ok(names.includes('_backup_20240101_090000_year_reset'));
  assert.ok(names.includes('_backup_20250101_090000_year_reset'));
  const imports = names.filter((n) => !n.endsWith('year_reset'));
  assert.equal(imports.length, 10);
  // 刪掉的是最舊的三份
  assert.equal(imports.includes('_backup_20250101_090000_before_import'), false);
  assert.equal(imports.includes('_backup_20250301_090000_before_import'), false);
  assert.equal(imports.includes('_backup_20250401_090000_before_import'), true);
  // 資料工作表不受影響
  assert.ok(ok(g.apiGetState(owner, null)).state.classes.length === 1);
});

test('備份清理：可用 BACKUP_KEEP 調整份數，設定錯誤時用預設值', () => {
  const env = setup();
  const { g, owner, sheets, props } = env;
  const backup = ok(g.apiExportBackup(owner)).json;
  for (let i = 1; i <= 5; i++) g.writeJson_(`_backup_2025010${i}_090000_before_import`, backup, true);
  props.BACKUP_KEEP = '3';
  ok(g.apiImportState(owner, backup));
  assert.equal(backupNames(sheets).length, 3);

  props.BACKUP_KEEP = 'abc';
  for (let i = 1; i <= 12; i++) g.writeJson_(`_backup_2024${String(i).padStart(2, '0')}01_090000_before_import`, backup, true);
  assert.equal(g.backupKeep_(), 10);
  g.pruneBackups_();
  assert.equal(backupNames(sheets).length, 10);
});

test('備份清理：清理失敗不影響跨年度結算', () => {
  const env = setup();
  const { g, owner, sheets } = env;
  const ss = g.SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets = () => { throw new Error('Service error'); };
  const errors = [];
  const origError = console.error;
  console.error = (e) => errors.push(e);
  try {
    const res = ok(g.apiApply(owner, { type: 'year.reset', yearLabel: '2027 年度' }));
    assert.ok(res.backup.endsWith('year_reset'));
  } finally {
    console.error = origError;
  }
  assert.equal(errors.length, 1); // 清理失敗有記錄下來
  assert.equal(ok(g.apiGetState(owner, null)).state.meta.yearLabel, '2027 年度');
  assert.ok(backupNames(sheets).length >= 1);
});

// ---------- 網頁呼叫入口（doPost） ----------

function post(g, fn, ...args) {
  const out = g.doPost({ postData: { contents: JSON.stringify({ fn, args }) } });
  return JSON.parse(out.getContent());
}

test('doPost：網頁以 JSON 呼叫 api 函式，回應附上後台版本', () => {
  const { g } = setup();
  const login = post(g, 'apiLogin', 'U-owner', '246810');
  assert.equal(login.ok, true);
  assert.equal(login.backendVersion, '@BACKEND_VERSION@'); // 建置時才會換成指紋
  const state = post(g, 'apiGetState', login.token, null);
  assert.equal(state.ok, true);
  assert.equal(state.state.classes.length, 1);
  assert.equal(post(g, 'apiApply', null, { type: 'student.create' }).code, 'FORBIDDEN');
});

test('doPost：只能呼叫網頁 API，格式錯誤時回傳錯誤而不是丟出例外', () => {
  const { g, props } = setup();
  assert.equal(post(g, 'readState_').code, 'INVALID_OP');
  assert.equal(post(g, 'saveUsers_', []).code, 'INVALID_OP');
  assert.ok(props.USERS.includes('壇務甲')); // 沒有被清掉
  const bad = JSON.parse(g.doPost({ postData: { contents: 'not json' } }).getContent());
  assert.equal(bad.code, 'INVALID_OP');
  assert.equal(JSON.parse(g.doPost(undefined).getContent()).code, 'INVALID_OP');
  assert.match(g.doGet().getContent(), /AttendPoint 後台運作中/);
});

// ---------- LOGO ----------

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('LOGO：擁有者上傳後所有人（含訪客）都讀得到，可以移除', () => {
  const { g, owner, staff, sheets } = setup();
  assert.equal(ok(g.apiGetLogo()).logo, '');
  fail(g.apiSetLogo(staff, PNG_1PX), 'FORBIDDEN');
  fail(g.apiSetLogo(null, PNG_1PX), 'FORBIDDEN');
  ok(g.apiSetLogo(owner, PNG_1PX));
  assert.equal(ok(g.apiGetLogo()).logo, PNG_1PX);
  assert.ok(sheets._logo.hidden);
  ok(g.apiSetLogo(owner, ''));
  assert.equal(ok(g.apiGetLogo()).logo, '');
});

test('LOGO：只接受圖片 data URI，太大會拒絕；大圖分段存放', () => {
  const { g, owner } = setup();
  fail(g.apiSetLogo(owner, 'https://example.com/logo.png'), 'INVALID_INPUT');
  fail(g.apiSetLogo(owner, 'data:image/svg+xml;base64,PHN2Zz4='), 'INVALID_INPUT');
  fail(g.apiSetLogo(owner, 'data:image/png;base64,' + 'A'.repeat(200001)), 'INVALID_INPUT');
  const big = 'data:image/png;base64,' + 'A'.repeat(120000);
  ok(g.apiSetLogo(owner, big));
  assert.equal(ok(g.apiGetLogo()).logo, big);
});
