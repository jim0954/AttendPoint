#!/usr/bin/env node
/*
 * 壓力測試：模擬佛堂使用一整年後的資料量，量測雲端版每次操作的耗時與傳輸量。
 *
 *   npm run stress                    執行小、中、大三種規模
 *   npm run stress -- --out dist      另外把模擬資料存成 dist/stress-*.json（可在測試用部署「匯入資料」實測）
 *
 * 試算表讀寫在這裡是記憶體模擬，不含 Google 的網路與試算表延遲，
 * 所以數字是「程式本身」的下限，真正部署後會更慢。
 * 名字全部是假資料。
 */
const fs = require('node:fs');
const path = require('node:path');
const Store = require('../src/store.js');
const { createGas } = require('./gas-mock.js');

const SCENARIOS = [
  { key: 'small', label: '小型：1 班 × 30 人', classes: 1, students: 30 },
  { key: 'medium', label: '中型：3 班 × 50 人', classes: 3, students: 50 },
  { key: 'large', label: '大型：5 班 × 80 人', classes: 5, students: 80 }
];
const WEEKS = 48; // 一年約 48 堂
const ATTEND_RATE = 0.85; // 出席率
const AWARDS_PER_PRESENT = 1.5; // 每位出席學員每堂平均加扣分次數
const REDEEM_EVERY = 8; // 每 8 週開放一次兌換
const REDEEM_RATE = 0.3;
const RUNS = 7; // 每項量測重複次數，取中位數
const CELL_CHARS = 40000; // 與 Code.js CHUNK_SIZE 相同
const LOCAL_STORAGE_CHARS = 5 * 1024 * 1024; // 一般瀏覽器 localStorage 約 5M 字元，依瀏覽器而定

const SURNAMES = '王李張劉陳楊黃趙吳周徐孫馬朱胡郭何林';
const GIVEN = '小明美華志強淑芬家豪怡君冠宇雅婷俊傑宜蓁';

// 固定亂數種子，每次結果一致
function rng(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function fakeName(i) {
  return SURNAMES[i % SURNAMES.length] + GIVEN[(i * 7) % GIVEN.length] + GIVEN[(i * 13 + 3) % GIVEN.length];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 產生一年份的資料。基本資料走 apply()，流水帳直接依 pushLog 的格式產生（apply 每次會複製整份資料，逐筆跑太慢） */
function buildYear(sc) {
  const rand = rng(20261024);
  const ctx = Store.makeCtx({ now: () => '2026-01-04T09:00:00', operatorId: 'U-stress', operatorName: '壇務甲' });
  let state = Store.emptyState();
  const run = (op) => {
    const r = Store.apply(state, op, ctx);
    state = r.state;
    return r.result;
  };

  run({ type: 'gift.create', name: '文具組', cost: 50 });
  run({ type: 'gift.create', name: '故事書', cost: 120 });

  const classes = [];
  for (let c = 0; c < sc.classes; c++) {
    const id = run({
      type: 'class.create',
      name: '第' + (c + 1) + '班',
      idPrefix: String.fromCharCode(65 + c),
      teams: ['孝順隊', '誠信隊', '仁愛隊'],
      schedule: [{ weekday: 0, nth: 0, start: '09:00', end: '11:00' }],
      addRules: [
        { label: '準時報到', points: 10, isCheckin: true },
        { label: '背誦經典', points: 5 },
        { label: '主動幫忙', points: 3 }
      ],
      deductRules: [{ label: '遲到', points: 2 }]
    }).id;
    const cls = state.classes.find((x) => x.id === id);
    const students = [];
    for (let i = 0; i < sc.students; i++) {
      const sid = run({ type: 'student.create', classId: id, name: fakeName(c * 100 + i), teamId: cls.teams[i % 3].id }).id;
      students.push(sid);
    }
    classes.push({ cls, students });
  }
  for (let i = 0; i < 4; i++) run({ type: 'staff.create', name: '服務員' + (i + 1), role: '輔導', classIds: classes.map((x) => x.cls.id) });

  const giftList = state.gifts;
  for (let w = 0; w < WEEKS; w++) {
    const date = addDays('2026-01-04', w * 7);
    for (const { cls, students } of classes) {
      const sessionId = run({ type: 'session.ensure', classId: cls.id, date }).id;
      const at = (min) => date + 'T09:' + String(min).padStart(2, '0') + ':00';
      const log = (fields) => {
        state.logs.push(Object.assign({
          id: ctx.newId('L'), at: at(Math.floor(rand() * 60)), type: 'points', classId: cls.id, studentId: null,
          sessionId, ruleId: null, giftId: null, reversesId: null, batchId: null, reason: '',
          honorDelta: 0, balanceDelta: 0, operatorId: ctx.operatorId, operatorName: ctx.operatorName
        }, fields));
      };
      const present = students.filter(() => rand() < ATTEND_RATE);
      const checkinRule = cls.addRules[0];
      present.forEach((studentId) => {
        log({ type: 'checkin', studentId, ruleId: checkinRule.id, reason: checkinRule.label, honorDelta: 10, balanceDelta: 10 });
      });
      present.forEach((studentId) => {
        const n = Math.floor(AWARDS_PER_PRESENT * 2 * rand());
        for (let k = 0; k < n; k++) {
          const r = rand() < 0.85 ? cls.addRules[1 + Math.floor(rand() * 2)] : cls.deductRules[0];
          const pts = r.isCheckin === undefined ? -r.points : r.points;
          log({ studentId, ruleId: r.id, reason: r.label, honorDelta: pts, balanceDelta: pts });
        }
      });
      // 每堂一次小隊加分
      const team = cls.teams[w % 3];
      const batchId = ctx.newId('B');
      students.filter((s) => state.students.find((x) => x.id === s).teamId === team.id).forEach((studentId) => {
        log({ studentId, batchId, reason: '[團體] 小隊表現優良', honorDelta: 5, balanceDelta: 5 });
      });
      if (w % REDEEM_EVERY === REDEEM_EVERY - 1) {
        present.filter(() => rand() < REDEEM_RATE).forEach((studentId) => {
          const g = giftList[Math.floor(rand() * giftList.length)];
          log({ type: 'redeem', studentId, sessionId: null, giftId: g.id, reason: '兌換：' + g.name, balanceDelta: -g.cost });
        });
      }
    }
  }
  return state;
}

function time(fn) {
  const t = process.hrtime.bigint();
  const v = fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, v };
}

function median(fn) {
  const xs = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    const r = time(fn);
    xs.push(r.ms);
    last = r.v;
  }
  xs.sort((a, b) => a - b);
  return { ms: xs[Math.floor(xs.length / 2)], v: last };
}

const mb = (chars) => (chars / 1024 / 1024).toFixed(2) + ' MB';
const kb = (chars) => (chars / 1024).toFixed(1) + ' KB';
const ms = (x) => x.toFixed(1) + ' ms';

function measure(sc, outDir) {
  const state = buildYear(sc);
  const json = JSON.stringify(state);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `stress-${sc.key}.json`), json);
  }

  const { gas: g } = createGas({ OWNER_PIN: '246810' });
  g.writeState_(state);
  const token = g.apiLogin('U-owner', '246810').token;

  // 為量測準備一堂新課，每次點名不同學員
  const cls = state.classes[0];
  const sessionId = g.apiApply(token, { type: 'session.ensure', classId: cls.id, date: addDays('2026-01-04', WEEKS * 7) }).result.id;
  const ids = state.students.filter((s) => s.classId === cls.id).map((s) => s.id);
  let next = 0;
  const checkinOp = () => ({ type: 'points.checkin', studentId: ids[next++ % ids.length], sessionId });

  // 後端：一次點名的完整流程與各步驟（前端第一次整份下載，之後只收變動）
  const Auth = g.AttendAuth;
  const staffBase = JSON.parse(JSON.stringify(g.apiGetState(token, null))).state;
  let base = staffBase;
  const apply = median(() => {
    const res = g.apiApply(token, checkinOp(), Auth.sinceOf(base, 'full'));
    if (!res.ok) throw new Error(res.code + ' ' + res.message);
    const wire = JSON.stringify(res); // google.script.run 會把回傳值序列化傳回瀏覽器
    base = Auth.mergeView(base, JSON.parse(wire));
    return wire;
  });
  const applyFull = median(() => JSON.stringify(g.apiApply(token, checkinOp())));
  const read = median(() => g.readState_());
  const cur = read.v;
  const user = g.AttendAuth.publicUser(g.builtinOwner_());
  const applyOnly = median(() => g.AttendStore.apply(cur, { type: 'points.award', studentId: ids[0], points: 1, reason: '量測' }, { operatorId: user.id, operatorName: user.name }));
  const write = median(() => g.writeState_(cur));

  // 讀取（每 30 秒輪詢一次）
  const getStaffFull = median(() => JSON.stringify(g.apiGetState(token, null)));
  const getGuestFull = median(() => JSON.stringify(g.apiGetState(null, null)));
  base = JSON.parse(getStaffFull.v).state;
  const getUnchanged = median(() => JSON.stringify(g.apiGetState(token, Auth.sinceOf(base, 'full'))));
  // 訪客：兩次輪詢之間有 10 人點名
  const guestBase = JSON.parse(getGuestFull.v).state;
  for (let i = 0; i < 10; i++) g.apiApply(token, checkinOp());
  const getGuestDelta = median(() => JSON.stringify(g.apiGetState(null, Auth.sinceOf(guestBase, 'guest'))));

  // 瀏覽器端：解析回傳資料、重算總分
  const parse = median(() => JSON.parse(apply.v));
  const totals = median(() => Store.computeTotals(cur));

  return {
    sc,
    logs: cur.logs.length,
    chars: json.length,
    bytes: Buffer.byteLength(json),
    cells: Math.ceil(json.length / CELL_CHARS),
    apply: apply.ms,
    applyResponse: apply.v.length,
    applyFullResponse: applyFull.v.length,
    read: read.ms,
    applyOnly: applyOnly.ms,
    write: write.ms,
    getStaff: getStaffFull.ms,
    getStaffSize: getStaffFull.v.length,
    getUnchanged: getUnchanged.ms,
    getUnchangedSize: getUnchanged.v.length,
    getGuestDeltaSize: getGuestDelta.v.length,
    parse: parse.ms,
    totals: totals.ms
  };
}

function main() {
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx > 0 ? path.resolve(process.argv[outIdx + 1] || 'dist') : null;
  console.log(`AttendPoint 壓力測試（${WEEKS} 堂、出席率 ${ATTEND_RATE * 100}%、每項取 ${RUNS} 次中位數，Node ${process.version}）\n`);
  const rows = SCENARIOS.map((sc) => measure(sc, outDir));
  const table = [
    ['', ...rows.map((r) => r.sc.label)],
    ['流水帳筆數', ...rows.map((r) => r.logs.toLocaleString())],
    ['資料大小（JSON）', ...rows.map((r) => mb(r.chars))],
    ['試算表儲存格數', ...rows.map((r) => String(r.cells))],
    ['單機版 localStorage 用量', ...rows.map((r) => Math.round((r.chars / LOCAL_STORAGE_CHARS) * 100) + '%')],
    ['── 一次點名（apiApply）', ...rows.map(() => '')],
    ['  後端總耗時', ...rows.map((r) => ms(r.apply))],
    ['    讀取＋解析資料', ...rows.map((r) => ms(r.read))],
    ['    套用操作（複製整份資料）', ...rows.map((r) => ms(r.applyOnly))],
    ['    寫回試算表', ...rows.map((r) => ms(r.write))],
    ['  回傳給瀏覽器（只傳變動）', ...rows.map((r) => kb(r.applyResponse))],
    ['  回傳給瀏覽器（舊做法整份）', ...rows.map((r) => mb(r.applyFullResponse))],
    ['  瀏覽器解析回傳', ...rows.map((r) => ms(r.parse))],
    ['  瀏覽器重算總分', ...rows.map((r) => ms(r.totals))],
    ['── 讀取（每 30 秒輪詢）', ...rows.map(() => '')],
    ['  資料沒變：後端耗時', ...rows.map((r) => ms(r.getUnchanged))],
    ['  資料沒變：傳輸大小', ...rows.map((r) => kb(r.getUnchangedSize))],
    ['  有 10 人點名：傳輸大小（訪客）', ...rows.map((r) => kb(r.getGuestDeltaSize))],
    ['  開啟網頁第一次下載：後端耗時', ...rows.map((r) => ms(r.getStaff))],
    ['  開啟網頁第一次下載：傳輸大小', ...rows.map((r) => mb(r.getStaffSize))]
  ];
  const width = (s) => Array.from(s).reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const cols = table[0].map((_, i) => Math.max(...table.map((row) => width(row[i]))));
  table.forEach((row) => console.log(row.map((cell, i) => cell + ' '.repeat(cols[i] - width(cell))).join('  ')));
  if (outDir) console.log(`\n模擬資料已存到 ${outDir}/stress-*.json`);
}

main();
