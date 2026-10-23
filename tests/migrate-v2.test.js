const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Store = require('../src/store.js');
const Migrate = require('../src/migrate-v2.js');

// 直接取出 v2 程式裡的 getDefaultState()，用真實的 v2 預設資料測試移轉
function loadV2DefaultState() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'AttendPoint.html'), 'utf8');
  const start = html.indexOf('function getDefaultState()');
  const end = html.indexOf('let state = getDefaultState();');
  assert.ok(start > 0 && end > start, '找不到 v2 的 getDefaultState()');
  return new Function(html.slice(start, end) + '\nreturn getDefaultState();')();
}

function fixedCtx() {
  let n = 0;
  return { now: () => '2026-10-24T09:30:00', newId: (p) => p + String(++n).padStart(4, '0') };
}

function assertSameAsV2(v2, state) {
  const totals = Store.computeTotals(state);
  v2.students.forEach((s) => {
    const t = totals[s.id];
    assert.ok(t, `移轉後找不到學員 ${s.id}`);
    assert.equal(t.honor, s.honorPoints, `${s.id} 榮譽總分`);
    assert.equal(t.balance, s.availablePoints, `${s.id} 可用點數`);
    const dates = t.sessionIds.map((id) => state.sessions.find((x) => x.id === id).date).sort();
    assert.deepEqual(dates, [...new Set(s.attendedDates)].sort(), `${s.id} 出席日期`);
  });
}

test('v2 預設資料：每位學員的分數與出席日期完全一致', () => {
  const v2 = loadV2DefaultState();
  const { state, report } = Migrate.migrateV2(v2, fixedCtx());
  assertSameAsV2(v2, state);
  assert.equal(report.students, 12);
  assert.equal(report.logs, 6);
  assert.equal(report.droppedLogs, 0);
  assert.ok(report.pinDropped);
  assert.equal(JSON.stringify(state).includes('8888'), false, '密碼不應出現在 v3 資料中');
  assert.deepEqual(state.classes.map((c) => c.name), ['兒童讀經班', '青少年班']);
  assert.equal(state.gifts.length, 6);
});

test('移轉後的資料可以繼續操作（報到、撤銷移轉來的紀錄）', () => {
  const v2 = loadV2DefaultState();
  let { state } = Migrate.migrateV2(v2, fixedCtx());
  const session = Store.findSession(state, 'kids', '2026-10-15');
  assert.ok(session);
  // K03 當天沒到，可以報到
  state = Store.apply(state, { type: 'points.checkin', studentId: 'K03', sessionId: session.id }, fixedCtx()).state;
  assert.equal(Store.studentTotals(state, 'K03').honor, 155);
  // K01 當天已到，不可重複
  assert.throws(
    () => Store.apply(state, { type: 'points.checkin', studentId: 'K01', sessionId: session.id }, fixedCtx()),
    (e) => e.code === 'ALREADY_CHECKED_IN'
  );
  // 撤銷 v2 的「背經通過（全章）」
  const log = state.logs.find((l) => l.studentId === 'K02' && l.reason === '背經通過（全章）');
  state = Store.apply(state, { type: 'log.reverse', logId: log.id }, fixedCtx()).state;
  assert.equal(Store.studentTotals(state, 'K02').honor, 280);
});

test('自訂班名與小隊、名冊中不在清單的小隊會自動補上', () => {
  const v2 = {
    kidsClassName: '幼幼班',
    kidsTeams: ['A隊'],
    students: [
      { id: 'k01', classType: 'kids', name: '範例甲', team: 'A隊', honorPoints: 0, availablePoints: 0, attendedDates: [] },
      { id: 'K02', classType: 'kids', name: '範例乙', team: 'B隊', honorPoints: 0, availablePoints: 0, attendedDates: [] }
    ],
    logs: []
  };
  const { state } = Migrate.migrateV2(v2, fixedCtx());
  const kids = state.classes.find((c) => c.id === 'kids');
  assert.equal(kids.name, '幼幼班');
  assert.deepEqual(kids.teams.map((t) => t.name), ['A隊', 'B隊']);
  assert.equal(state.students[0].id, 'K01');
  assert.equal(state.students[1].teamId, kids.teams[1].id);
});

test('兌換、重複報到、找不到學員的紀錄、匯入的期初分數', () => {
  const v2 = {
    students: [
      { id: 'Y01', classType: 'youth', name: '範例丙', team: '慈悲組', honorPoints: 100, availablePoints: 50, attendedDates: ['2026-10-01'] }
    ],
    logs: [
      { id: 'L4', timestamp: '10:05:00', sessionDate: '2026-10-01', classType: 'youth', studentId: 'Y99', reason: '準時報到', honorDelta: 10, balanceDelta: 10, isCheckin: true },
      { id: 'L3', timestamp: '10:04:00', sessionDate: '2026-10-01', classType: 'youth', studentId: 'Y01', reason: '🎁 兌換：精美讀經隨身筆記本', honorDelta: 0, balanceDelta: -50, isCheckin: false },
      { id: 'L2', timestamp: '10:03:00', sessionDate: '2026-10-01', classType: 'youth', studentId: 'Y01', reason: '準時報到', honorDelta: 10, balanceDelta: 10, isCheckin: true },
      { id: 'L1', timestamp: '10:02:00', sessionDate: '2026-10-01', classType: 'youth', studentId: 'Y01', reason: '準時報到', honorDelta: 10, balanceDelta: 10, isCheckin: true }
    ]
  };
  const { state, report } = Migrate.migrateV2(v2, fixedCtx());
  assertSameAsV2(v2, state);
  assert.equal(report.droppedLogs, 1);
  assert.equal(report.openingAdjustments, 1);
  const types = state.logs.map((l) => l.type);
  assert.deepEqual(types, ['adjust', 'checkin', 'points', 'redeem']);
  assert.equal(state.logs[3].giftId, 'g2');
  assert.equal(state.logs[0].at, '2026-10-01T00:00:00');
});

test('loadAny：v3 原樣回傳、v2 自動移轉、其他格式報錯', () => {
  const v3 = Store.emptyState();
  assert.equal(Migrate.loadAny(JSON.stringify(v3)).migratedFrom, null);
  const v2 = loadV2DefaultState();
  const r = Migrate.loadAny(JSON.stringify(v2), fixedCtx());
  assert.equal(r.migratedFrom, 2);
  assert.equal(r.state.schemaVersion, 3);
  assert.throws(() => Migrate.loadAny('{"foo":1}'), (e) => e.code === 'UNKNOWN_FORMAT');
  assert.throws(() => Migrate.loadAny('{"schemaVersion":99}'), (e) => e.code === 'NEWER_VERSION');
});
