// 在 Node 中模擬 Google Apps Script 服務，測試 Code.js 的完整流程
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas } = require('../scripts/gas-mock.js');

// google.script.run 傳回前端時會序列化，這裡用 JSON 模擬
function ok(res) {
  assert.equal(res.ok, true, `${res.code}: ${res.message}`);
  return JSON.parse(JSON.stringify(res));
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
  const created = ok(g.apiUserOp(owner, { type: 'user.create', name: '壇務甲', pin: '1234' })).result;
  const staff = ok(g.apiLogin(created.id, '1234')).token;
  return Object.assign(env, { g, owner, staff, staffUserId: created.id, classId: cls.id });
}

test('沒有設定 OWNER_PIN 時無法登入，並提示設定方式', () => {
  const { gas } = createGas({});
  fail(gas.apiLogin('U-owner', '1234'), 'NOT_CONFIGURED');
});

test('登入：PIN 錯誤會倒數，錯 5 次鎖定', () => {
  const { g } = setup();
  for (let i = 0; i < 4; i++) fail(g.apiLogin('U-owner', '000000'), 'WRONG_PIN');
  fail(g.apiLogin('U-owner', '000000'), 'WRONG_PIN');
  fail(g.apiLogin('U-owner', '246810'), 'LOCKED');
});

test('登入清單只有名稱與角色，不含 PIN 資訊', () => {
  const { g } = setup();
  const res = ok(g.apiLoginOptions());
  assert.deepEqual(res.users.map((u) => u.name), ['堂主', '壇務甲']);
  assert.equal(JSON.stringify(res).includes('pinHash'), false);
});

test('壇務完整流程：建課次、建學員、點名、加分，資料寫入試算表', () => {
  const { g, staff, classId, sheets } = setup();
  const session = ok(g.apiApply(staff, { type: 'session.ensure', classId, date: '2026-10-24' })).result;
  const stu = ok(g.apiApply(staff, { type: 'student.create', classId, name: '王小明' })).result;
  const res = ok(g.apiApply(staff, { type: 'points.checkin', studentId: stu.id, sessionId: session.id }));
  assert.equal(res.result.points, 10);
  const log = res.state.logs[0];
  assert.equal(log.operatorName, '壇務甲');
  // 試算表中的資料是加了標記的 JSON
  const cell = sheets._data.cells()[0][0];
  assert.equal(cell[0], '~');
  assert.ok(sheets._data.hidden);
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
  fail(g.apiLogin(staffUserId, '1234'), 'WRONG_PIN');
});

test('帳號管理：壇務不能管理帳號，但可以改自己的 PIN；PIN 不以明文儲存', () => {
  const { g, owner, staff, staffUserId, props } = setup();
  fail(g.apiListUsers(staff), 'FORBIDDEN');
  fail(g.apiUserOp(staff, { type: 'user.create', name: '乙', pin: '1111' }), 'FORBIDDEN');
  ok(g.apiUserOp(staff, { type: 'self.changePin', oldPin: '1234', newPin: '5678' }));
  ok(g.apiLogin(staffUserId, '5678'));
  assert.equal(props.USERS.includes('5678'), false);
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

test('大量資料會分段存放在多個儲存格', () => {
  const { g, owner, classId, sheets } = setup();
  const state = ok(g.apiGetState(owner)).state;
  // 直接寫入一份大資料（約 20 萬字）再讀回
  const big = JSON.parse(JSON.stringify(state));
  for (let i = 0; i < 1500; i++) {
    big.students.push({ id: 'X' + i, classId, teamId: big.classes[0].teams[0].id, name: '範例學員' + i, note: '備註'.repeat(50), deletedAt: null });
  }
  ok(g.apiImportState(owner, JSON.stringify(big)));
  assert.ok(sheets._data.cells().length > 3);
  assert.equal(ok(g.apiGetState(owner)).state.students.length, 1500);
});
