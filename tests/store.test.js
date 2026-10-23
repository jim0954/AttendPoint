// 執行：node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../src/store.js');

// 固定時間與 ID，讓測試結果可重現
function fixedCtx() {
  let n = 0;
  return {
    now: () => '2026-10-24T09:30:00',
    newId: (prefix) => prefix + String(++n).padStart(3, '0'),
    operatorId: 'tester'
  };
}

// 建立一個有班別、課次、學員、禮品的基本狀態
function setup() {
  const ctx = fixedCtx();
  let state = Store.emptyState({ yearLabel: '2026 年度' });
  const run = (op) => {
    const r = Store.apply(state, op, ctx);
    state = r.state;
    return r.result;
  };
  const cls = run({
    type: 'class.create',
    name: '兒童讀經班',
    idPrefix: 'k',
    defaultSchedule: { weekday: 6, start: '09:30', end: '11:30' },
    teams: ['孝順隊', '仁愛隊'],
    addRules: [
      { label: '準時報到', points: 10, isCheckin: true },
      { label: '背經通過', points: 15 }
    ],
    deductRules: [{ label: '秩序提醒', points: 5 }]
  });
  const c = () => state.classes.find((x) => x.id === cls.id);
  const session = run({ type: 'session.ensure', classId: cls.id, date: '2026-10-24' });
  const a = run({ type: 'student.create', classId: cls.id, name: '範例甲' });
  const b = run({ type: 'student.create', classId: cls.id, name: '範例乙', teamId: c().teams[1].id });
  const gift = run({ type: 'gift.create', name: '文具組', cost: 20 });
  return {
    get state() { return state; },
    run,
    classId: cls.id,
    cls: c,
    sessionId: session.id,
    a: a.id,
    b: b.id,
    giftId: gift.id
  };
}

function expectError(fn, code) {
  assert.throws(fn, (err) => err instanceof Store.StoreError && err.code === code);
}

test('建立班別：學號前綴轉大寫、自動產生學號、依常態時間建立課次', () => {
  const t = setup();
  assert.equal(t.cls().idPrefix, 'K');
  assert.equal(t.a, 'K01');
  assert.equal(t.b, 'K02');
  const session = t.state.sessions[0];
  assert.equal(session.start, '09:30');
  assert.equal(session.end, '11:30');
});

test('apply 不修改原狀態，失敗時也不留下半套變更', () => {
  const t = setup();
  const before = JSON.stringify(t.state);
  Store.apply(t.state, { type: 'points.checkin', studentId: t.a, sessionId: t.sessionId }, fixedCtx());
  assert.equal(JSON.stringify(t.state), before);
  expectError(
    () => Store.apply(t.state, { type: 'points.batch', classId: t.classId, points: 5, reason: 'x', target: { teamId: 'nope' } }, fixedCtx()),
    'NOT_FOUND'
  );
  assert.equal(JSON.stringify(t.state), before);
});

test('報到：依報到規則加分、不可重複報到、計入出席', () => {
  const t = setup();
  const r = t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId });
  assert.equal(r.points, 10);
  expectError(() => t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId }), 'ALREADY_CHECKED_IN');
  const totals = Store.studentTotals(t.state, t.a);
  assert.deepEqual(totals, { honor: 10, balance: 10, sessionIds: [t.sessionId] });
});

test('加扣分：依規則或自訂事由，扣分不會低於 0', () => {
  const t = setup();
  const add = t.cls().addRules[1];
  const deduct = t.cls().deductRules[0];
  t.run({ type: 'points.award', studentId: t.a, ruleId: add.id });
  t.run({ type: 'points.award', studentId: t.a, ruleId: deduct.id });
  assert.equal(Store.studentTotals(t.state, t.a).honor, 10);
  const r = t.run({ type: 'points.award', studentId: t.a, points: -50, reason: '測試大扣分' });
  assert.equal(r.honorDelta, -10);
  assert.equal(Store.studentTotals(t.state, t.a).honor, 0);
  expectError(() => t.run({ type: 'points.award', studentId: t.a, points: 5 }), 'INVALID_INPUT');
});

test('報到規則不能用一般加分重複使用', () => {
  const t = setup();
  const checkinRule = t.cls().addRules[0];
  expectError(() => t.run({ type: 'points.award', studentId: t.a, ruleId: checkinRule.id }), 'INVALID_INPUT');
});

test('小隊加分與「本堂已報到」加分', () => {
  const t = setup();
  const team2 = t.cls().teams[1].id;
  assert.equal(t.run({ type: 'points.batch', classId: t.classId, points: 5, reason: '整齊', target: { teamId: team2 } }).count, 1);
  assert.equal(Store.studentTotals(t.state, t.b).honor, 5);
  expectError(
    () => t.run({ type: 'points.batch', classId: t.classId, sessionId: t.sessionId, points: 5, reason: '全勤', target: { checkedIn: true } }),
    'NO_MATCH'
  );
  t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId });
  const r = t.run({ type: 'points.batch', classId: t.classId, sessionId: t.sessionId, points: 5, reason: '全勤', target: { checkedIn: true } });
  assert.equal(r.count, 1);
  assert.equal(Store.studentTotals(t.state, t.a).honor, 15);
});

test('兌換禮品：只扣可用點數，不扣榮譽總分；點數不足會拒絕', () => {
  const t = setup();
  expectError(() => t.run({ type: 'points.redeem', studentId: t.a, giftId: t.giftId }), 'INSUFFICIENT_POINTS');
  t.run({ type: 'points.award', studentId: t.a, points: 25, reason: '表現優良' });
  t.run({ type: 'points.redeem', studentId: t.a, giftId: t.giftId });
  assert.deepEqual(Store.studentTotals(t.state, t.a), { honor: 25, balance: 5, sessionIds: [] });
});

test('撤銷：新增反向紀錄、取消出席、不可重複撤銷、點數已兌換時拒絕', () => {
  const t = setup();
  const c = t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId });
  t.run({ type: 'log.reverse', logId: c.logId });
  assert.deepEqual(Store.studentTotals(t.state, t.a), { honor: 0, balance: 0, sessionIds: [] });
  assert.equal(t.state.logs.length, 2);
  expectError(() => t.run({ type: 'log.reverse', logId: c.logId }), 'ALREADY_REVERSED');
  // 撤銷後可以重新報到
  t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId });

  const award = t.run({ type: 'points.award', studentId: t.a, points: 15, reason: '背經' });
  t.run({ type: 'points.redeem', studentId: t.a, giftId: t.giftId });
  expectError(() => t.run({ type: 'log.reverse', logId: award.logId }), 'NEGATIVE_POINTS');
});

test('修改課次日期：點名紀錄跟著課次移動', () => {
  const t = setup();
  t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId });
  t.run({ type: 'session.save', id: t.sessionId, date: '2026-10-25', start: '14:00', end: '16:00', topic: '弟子規' });
  assert.equal(Store.findSession(t.state, t.classId, '2026-10-24'), null);
  assert.equal(Store.findSession(t.state, t.classId, '2026-10-25').id, t.sessionId);
  assert.ok(Store.isCheckedIn(t.state, t.a, t.sessionId));
  expectError(() => t.run({ type: 'session.save', id: t.sessionId, date: '2026-10-25', start: '16:00', end: '14:00' }), 'INVALID_INPUT');
});

test('刪除課次：有未撤銷紀錄時拒絕', () => {
  const t = setup();
  const c = t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId });
  expectError(() => t.run({ type: 'session.delete', id: t.sessionId }), 'SESSION_HAS_LOGS');
  t.run({ type: 'log.reverse', logId: c.logId });
  t.run({ type: 'session.delete', id: t.sessionId });
  assert.equal(Store.active(t.state.sessions).length, 0);
});

test('小隊改名不影響學員；刪除仍有學員的小隊會被拒絕', () => {
  const t = setup();
  const teams = t.cls().teams;
  t.run({ type: 'class.update', id: t.classId, patch: { teams: [{ id: teams[0].id, name: '孝親隊' }, teams[1], '智慧隊'] } });
  assert.equal(t.cls().teams[0].name, '孝親隊');
  assert.equal(t.cls().teams.length, 3);
  expectError(() => t.run({ type: 'class.update', id: t.classId, patch: { teams: [teams[1]] } }), 'TEAM_IN_USE');
});

test('班別名稱與學號前綴不可重複', () => {
  const t = setup();
  expectError(() => t.run({ type: 'class.create', name: '兒童讀經班', idPrefix: 'Z', teams: ['A'] }), 'DUPLICATE');
  expectError(() => t.run({ type: 'class.create', name: '青少年班', idPrefix: 'K', teams: ['A'] }), 'DUPLICATE');
  expectError(() => t.run({ type: 'class.create', name: '青少年班', idPrefix: 'Y', teams: [] }), 'INVALID_INPUT');
});

test('升班：換班時自動分到新班第一個小隊，學號與積分保留', () => {
  const t = setup();
  t.run({ type: 'points.award', studentId: t.a, points: 30, reason: '背經' });
  const y = t.run({ type: 'class.create', name: '青少年班', idPrefix: 'Y', teams: ['慈悲組', '精進組'] });
  t.run({ type: 'student.update', id: t.a, patch: { classId: y.id } });
  const s = t.state.students.find((x) => x.id === t.a);
  assert.equal(s.classId, y.id);
  assert.equal(s.teamId, t.state.classes.find((x) => x.id === y.id).teams[0].id);
  assert.equal(Store.studentTotals(t.state, t.a).honor, 30);
  // 新班新生的學號用新班前綴
  assert.equal(t.run({ type: 'student.create', classId: y.id, name: '範例丙' }).id, 'Y02');
});

test('刪除班別：有學員時需選擇轉班或一併刪除', () => {
  const t = setup();
  expectError(() => t.run({ type: 'class.delete', id: t.classId }), 'CLASS_HAS_STUDENTS');
  const y = t.run({ type: 'class.create', name: '青少年班', idPrefix: 'Y', teams: ['慈悲組'] });
  const yTeam = t.state.classes.find((x) => x.id === y.id).teams[0].id;
  const r = t.run({ type: 'class.delete', id: t.classId, moveStudentsTo: { classId: y.id, teamId: yTeam } });
  assert.equal(r.affectedStudents, 2);
  assert.ok(t.state.students.every((s) => s.classId === y.id));
});

test('軟刪除與還原：學員刪除後留在回收區，可還原', () => {
  const t = setup();
  t.run({ type: 'student.delete', id: t.a });
  assert.equal(Store.active(t.state.students).length, 1);
  expectError(() => t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId }), 'NOT_FOUND');
  t.run({ type: 'student.restore', id: t.a });
  assert.equal(Store.active(t.state.students).length, 2);
  expectError(() => t.run({ type: 'student.restore', id: t.a }), 'NOT_DELETED');
});

test('服務人員：執勤指派與護持堂數統計', () => {
  const t = setup();
  const p = t.run({ type: 'staff.create', name: '範例講師', role: '講師', classIds: [t.classId] });
  t.run({ type: 'session.save', id: t.sessionId, date: '2026-10-24', dutyStaffIds: [p.id] });
  t.run({ type: 'session.save', classId: t.classId, date: '2026-10-31', dutyStaffIds: [p.id] });
  assert.equal(Store.computeStaffDuty(t.state)[p.id], 2);
  expectError(() => t.run({ type: 'session.save', classId: t.classId, date: '2026-11-07', dutyStaffIds: ['P999'] }), 'NOT_FOUND');
});

test('跨年度結算：清空紀錄與課次、永久清除回收區、保留名冊', () => {
  const t = setup();
  t.run({ type: 'points.checkin', studentId: t.a, sessionId: t.sessionId });
  t.run({ type: 'student.delete', id: t.b });
  const r = t.run({ type: 'year.reset', yearLabel: '2027 年度' });
  assert.equal(r.purged, 1);
  assert.equal(t.state.logs.length, 0);
  assert.equal(t.state.sessions.length, 0);
  assert.equal(t.state.students.length, 1);
  assert.equal(t.state.meta.yearLabel, '2027 年度');
  assert.equal(Store.studentTotals(t.state, t.a).honor, 0);
});

test('每次操作都會遞增版本號', () => {
  const t = setup();
  const rev = t.state.meta.rev;
  t.run({ type: 'meta.update', templeTitle: '範例佛堂' });
  assert.equal(t.state.meta.rev, rev + 1);
  expectError(() => t.run({ type: 'nope' }), 'INVALID_OP');
});

test('批次匯入：自動學號、自動新增小隊、同名更新、對應班別、略過錯誤列', () => {
  const t = setup();
  const y = t.run({ type: 'class.create', name: '青少年班', idPrefix: 'Y', teams: ['慈悲組'] });
  const r = t.run({
    type: 'student.import',
    defaultClassId: t.classId,
    rows: [
      { name: '範例丙', teamName: '智慧隊' },
      { name: '範例甲', teamName: '仁愛隊', note: '新備註' },
      { className: '青少年', name: '範例丁' },
      { className: 'Y', name: '範例戊', id: 'y09' },
      { name: '' },
      { name: '範例己', id: 'Y09' } // 學號已屬於其他班的學員
    ]
  });
  assert.equal(r.added, 3);
  assert.equal(r.updated, 1);
  assert.deepEqual(r.skipped.map((s) => s.line), [5, 6]);
  const kids = t.cls();
  assert.deepEqual(kids.teams.map((x) => x.name), ['孝順隊', '仁愛隊', '智慧隊']);
  const a = t.state.students.find((s) => s.id === t.a);
  assert.equal(a.teamId, kids.teams[1].id);
  assert.equal(a.note, '新備註');
  assert.equal(t.state.students.find((s) => s.name === '範例丙').id, 'K03');
  assert.equal(t.state.students.find((s) => s.name === '範例丁').classId, y.id);
  assert.equal(t.state.students.find((s) => s.name === '範例戊').id, 'Y09');
});
