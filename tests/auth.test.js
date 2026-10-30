const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Store = require('../src/store.js');
const Auth = require('../src/auth.js');

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const TODAY = '2026-10-24';
const owner = { id: 'U-owner', name: '擁有者', role: 'owner', builtin: true };
const staffA = { id: 'U-a', name: '壇務甲', role: 'staff' };
const staffB = { id: 'U-b', name: '壇務乙', role: 'staff' };

function setup() {
  let n = 0;
  const ctx = (user, now) => ({
    now: () => now || TODAY + 'T09:30:00',
    newId: (p) => p + String(++n).padStart(3, '0'),
    operatorId: user && user.id,
    operatorName: user && user.name
  });
  let state = Store.emptyState();
  const run = (op, user, now) => {
    Auth.authorize(state, op, user, (now || TODAY).slice(0, 10));
    const r = Store.apply(state, op, ctx(user, now));
    state = r.state;
    return r.result;
  };
  const cls = run({ type: 'class.create', name: '兒童讀經班', idPrefix: 'K', teams: ['孝順隊', '仁愛隊'], addRules: [{ label: '準時報到', points: 10, isCheckin: true }] }, owner);
  const session = run({ type: 'session.ensure', classId: cls.id, date: TODAY }, staffA);
  const stu = run({ type: 'student.create', classId: cls.id, name: '王小明', note: '家長電話 09xx' }, staffA);
  return { get state() { return state; }, run, classId: cls.id, sessionId: session.id, studentId: stu.id };
}

const forbidden = (e) => e instanceof Auth.AuthError && e.code === 'FORBIDDEN';

test('訪客不能做任何修改', () => {
  const t = setup();
  assert.throws(() => t.run({ type: 'points.checkin', studentId: t.studentId, sessionId: t.sessionId }, null), forbidden);
});

test('壇務可以點名、加分、新增與編輯，但不能刪除、還原、校正、結算', () => {
  const t = setup();
  t.run({ type: 'points.checkin', studentId: t.studentId, sessionId: t.sessionId }, staffA);
  t.run({ type: 'points.award', studentId: t.studentId, points: 5, reason: '背經' }, staffA);
  t.run({ type: 'student.update', id: t.studentId, patch: { name: '王小明明' } }, staffA);
  t.run({ type: 'staff.create', name: '範例壇務', role: '主壇務' }, staffA);
  t.run({ type: 'gift.create', name: '文具', cost: 10 }, staffA);
  for (const op of [
    { type: 'student.delete', id: t.studentId },
    { type: 'class.delete', id: t.classId, deleteStudents: true },
    { type: 'session.delete', id: t.sessionId },
    { type: 'points.adjust', studentId: t.studentId, honorDelta: 100, reason: 'x' },
    { type: 'year.reset', yearLabel: '2027' },
    { type: 'meta.update', templeTitle: 'x' }
  ]) {
    assert.throws(() => t.run(op, staffA), forbidden, op.type);
  }
  assert.ok(Auth.OWNER_ONLY.every((type) => Store.OP_TYPES.includes(type)), '權限表裡的操作都必須存在');
});

test('擁有者可以刪除與還原', () => {
  const t = setup();
  t.run({ type: 'student.delete', id: t.studentId }, owner);
  t.run({ type: 'student.restore', id: t.studentId }, owner);
});

test('壇務只能撤銷自己今天的紀錄', () => {
  const t = setup();
  const mine = t.run({ type: 'points.award', studentId: t.studentId, points: 5, reason: '甲加的' }, staffA);
  const others = t.run({ type: 'points.award', studentId: t.studentId, points: 5, reason: '乙加的' }, staffB);
  const old = t.run({ type: 'points.award', studentId: t.studentId, points: 5, reason: '昨天' }, staffA, '2026-10-23T10:00:00');
  assert.throws(() => t.run({ type: 'log.reverse', logId: others.logId }, staffA), forbidden);
  assert.throws(() => t.run({ type: 'log.reverse', logId: old.logId }, staffA), forbidden);
  t.run({ type: 'log.reverse', logId: mine.logId }, staffA);
  t.run({ type: 'log.reverse', logId: others.logId }, owner);
  const log = t.state.logs.find((l) => l.id === mine.logId);
  assert.equal(log.operatorName, '壇務甲');
});

test('壇務可以改小隊名稱、新增小隊，但不能移除小隊', () => {
  const t = setup();
  const teams = t.state.classes[0].teams;
  t.run({ type: 'class.update', id: t.classId, patch: { teams: [{ id: teams[0].id, name: '孝親隊' }, teams[1], '智慧隊'] } }, staffA);
  const now = t.state.classes[0].teams;
  assert.throws(() => t.run({ type: 'class.update', id: t.classId, patch: { teams: [now[0], now[1]] } }, staffA), forbidden);
  t.run({ type: 'class.update', id: t.classId, patch: { teams: [now[0], now[1]] } }, owner);
});

test('訪客畫面：名字遮蔽、沒有備註與回收區、沒有操作者', () => {
  const t = setup();
  t.run({ type: 'points.checkin', studentId: t.studentId, sessionId: t.sessionId }, staffA);
  const s2 = t.run({ type: 'student.create', classId: t.classId, name: '陳宇' }, staffA);
  t.run({ type: 'points.award', studentId: s2.id, points: 5, reason: 'x' }, staffA);
  t.run({ type: 'student.delete', id: s2.id }, owner);
  const view = Auth.viewFor(t.state, null);
  assert.deepEqual(view.students, [{ id: t.studentId, classId: t.classId, teamId: view.students[0].teamId, name: '王○明' }]);
  assert.equal(view.logs.length, 1);
  assert.equal(JSON.stringify(view).includes('壇務甲'), false);
  assert.equal(JSON.stringify(view).includes('09xx'), false);
  assert.equal(Store.studentTotals(view, t.studentId).honor, 10, '訪客畫面也能算出分數');
  assert.equal(Auth.viewFor(t.state, staffA), t.state);
});

test('訪客畫面：自行輸入的事由與校正原因改成通用說法，規則、報到、兌換照常顯示', () => {
  const t = setup();
  t.run({ type: 'class.update', id: t.classId, patch: { addRules: t.state.classes[0].addRules.concat([{ label: '背誦經典', points: 5 }]) } }, owner);
  const ruleId = t.state.classes[0].addRules.find((r) => r.label === '背誦經典').id;
  t.run({ type: 'points.checkin', studentId: t.studentId, sessionId: t.sessionId }, staffA);
  t.run({ type: 'points.award', studentId: t.studentId, sessionId: t.sessionId, ruleId }, staffA);
  t.run({ type: 'points.award', studentId: t.studentId, points: 3, reason: '王小明家裡有事仍到' }, staffA);
  t.run({ type: 'points.award', studentId: t.studentId, points: -2, reason: '王小明上課吵鬧' }, staffA);
  t.run({ type: 'points.adjust', studentId: t.studentId, honorDelta: 1, reason: '家長來電更正' }, owner);
  t.run({ type: 'log.reverse', logId: t.state.logs.find((l) => l.reason === '王小明家裡有事仍到').id }, staffA);
  const reasons = Auth.viewFor(t.state, null).logs.map((l) => l.reason);
  assert.deepEqual(reasons, ['準時報到', '背誦經典', '加分', '扣分', '校正', '撤銷：加分']);
  assert.equal(JSON.stringify(Auth.viewFor(t.state, null)).includes('王小明'), false);
  assert.ok(Auth.viewFor(t.state, staffA).logs.some((l) => l.reason === '王小明上課吵鬧'), '壇務看得到原文');
});

test('名字遮蔽規則', () => {
  assert.equal(Auth.maskName('王小明'), '王○明');
  assert.equal(Auth.maskName('陳宇'), '陳○');
  assert.equal(Auth.maskName('歐陽小明'), '歐○○明');
  assert.equal(Auth.maskName('Amy'), 'A○y');
});

test('帳號：建立、驗證 PIN、改 PIN、停用、權限檢查', () => {
  let n = 0;
  const deps = { sha256Hex, newSalt: () => 'salt' + ++n, newId: (p) => p + ++n, now: () => TODAY };
  let users = [];
  const r = Auth.applyUserOp(users, { type: 'user.create', name: '壇務甲', pin: '123456' }, owner, deps);
  users = r.users;
  const u = users[0];
  assert.equal(u.role, 'staff');
  assert.equal(JSON.stringify(u).includes('123456'), false, 'PIN 不可明文儲存');
  assert.ok(Auth.verifyPin(u, '123456', sha256Hex));
  assert.equal(Auth.verifyPin(u, '1235', sha256Hex), false);
  assert.equal(Auth.publicUser(u).pinHash, undefined);

  const actor = Auth.publicUser(u);
  assert.throws(() => Auth.applyUserOp(users, { type: 'user.create', name: 'x', pin: '111111' }, actor, deps), forbidden);
  assert.throws(() => Auth.applyUserOp(users, { type: 'self.changePin', oldPin: '0000', newPin: '567890' }, actor, deps), (e) => e.code === 'WRONG_PIN');
  users = Auth.applyUserOp(users, { type: 'self.changePin', oldPin: '123456', newPin: '567890' }, actor, deps).users;
  assert.ok(Auth.verifyPin(users[0], '567890', sha256Hex));

  assert.throws(() => Auth.applyUserOp(users, { type: 'user.create', name: '壇務甲', pin: '111111' }, owner, deps), (e) => e.code === 'DUPLICATE');
  assert.throws(() => Auth.applyUserOp(users, { type: 'user.create', name: '乙', pin: '12' }, owner, deps), (e) => e.code === 'INVALID_PIN');
  users = Auth.applyUserOp(users, { type: 'user.update', id: u.id, patch: { disabled: true } }, owner, deps).users;
  assert.equal(users[0].disabled, true);
  assert.throws(() => Auth.applyUserOp(users, { type: 'self.changePin', oldPin: '1', newPin: '222222' }, owner, deps), forbidden);
});

// 模擬前端：保留上次的資料，送出 since，把回應合併回完整資料
function syncClient(user) {
  let base = null;
  let kind = null;
  return {
    pull(state, who) {
      const res = JSON.parse(JSON.stringify(Auth.syncView(state, who === undefined ? user : who, Auth.sinceOf(base, kind))));
      base = Auth.mergeView(base, res);
      kind = res.view;
      return res;
    },
    get base() { return base; }
  };
}

test('增量同步：第一次整份，之後只傳新增的紀錄，沒變動時不傳資料', () => {
  const t = setup();
  const c = syncClient(staffA);
  assert.ok(c.pull(t.state).state);
  assert.deepEqual(c.pull(t.state), { view: 'full', unchanged: true });

  t.run({ type: 'points.checkin', studentId: t.studentId, sessionId: t.sessionId }, staffA);
  t.run({ type: 'student.update', id: t.studentId, patch: { note: '改過' } }, staffA);
  const res = c.pull(t.state);
  assert.equal(res.delta.logsFrom, 0);
  assert.equal(res.delta.logs.length, 1);
  assert.deepEqual(c.base, t.state); // 合併後與後端完全一致
});

test('增量同步：訪客看遮蔽後的資料；刪除學員後整份重傳', () => {
  const t = setup();
  const guest = syncClient(null);
  guest.pull(t.state);
  t.run({ type: 'points.checkin', studentId: t.studentId, sessionId: t.sessionId }, staffA);
  const res = guest.pull(t.state);
  assert.equal(res.view, 'guest');
  assert.equal(res.delta.logs.length, 1);
  assert.equal(res.delta.logs[0].operatorName, undefined);
  assert.deepEqual(guest.base, Auth.viewFor(t.state, null));

  t.run({ type: 'student.delete', id: t.studentId }, owner);
  assert.ok(guest.pull(t.state).state);
  assert.deepEqual(guest.base, Auth.viewFor(t.state, null));
  assert.equal(guest.base.logs.length, 0);
});

test('增量同步：登入後由訪客畫面換成完整資料；版本對不上時整份重傳', () => {
  const t = setup();
  const c = syncClient(null);
  c.pull(t.state);
  const res = c.pull(t.state, staffA);
  assert.equal(res.view, 'full');
  assert.ok(res.state);
  assert.equal(c.base.students[0].name, '王小明');
  // since 異常（紀錄數比後端多）時不給增量
  const odd = Auth.syncView(t.state, staffA, { view: 'full', syncId: t.state.meta.syncId, rev: 0, logCount: 99 });
  assert.ok(odd.state);
  // 合併時長度對不上會報錯，不會產生錯誤資料
  assert.throws(() => Auth.mergeView({ logs: [] }, { delta: { logsFrom: 3, logs: [] } }), (e) => e.code === 'SYNC_MISMATCH');
});
