// 雲端版（dist/gas-sim.html 模擬 Google Apps Script）：權限、帳號、多裝置同步、寫入失敗、登入逾時
const test = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, launch, idle, dialog, modal, toast, tab, card, login, logout } = require('./helpers.js');

const OWNER_PIN = '246810';
// 4×4 紅色 PNG，測試上傳 LOGO 用
const PNG_4PX = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'; // scripts/gas-sim.js 的模擬擁有者 PIN

test('雲端版', { skip: SKIP }, async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const page = await env.open('gas-sim.html');

  // 準備資料：直接呼叫模擬後端（像另一台電腦先建好班別與名冊）
  await page.evaluate((pin) => {
    const tok = apiLogin('U-owner', pin).token;
    const cls = apiApply(tok, {
      type: 'class.create', name: '兒童讀經班', idPrefix: 'K', teams: ['孝順隊'],
      addRules: [{ label: '準時報到', points: 10, isCheckin: true }]
    }).result;
    ['王小明', '李小華', '陳大同'].forEach((name) => apiApply(tok, { type: 'student.create', classId: cls.id, teamId: null, name }));
    apiApply(tok, { type: 'staff.create', name: '林輔導', role: '護持壇務', classIds: [cls.id] });
    // 記錄每次讀取／寫入的回應類型（整份、只傳變動、沒有變動）
    window.__calls = [];
    ['apiApply', 'apiGetState'].forEach((name) => {
      const orig = window[name];
      window[name] = function () {
        const res = orig.apply(null, arguments);
        window.__calls.push({ name, kind: res.unchanged ? 'unchanged' : res.delta ? 'delta' : res.state ? 'full' : res.code });
        return res;
      };
    });
  }, OWNER_PIN);
  await page.click('[data-action="refresh"]');
  await page.waitForFunction(() => App.s.data.students.length === 3);
  const calls = () => page.evaluate(() => window.__calls.splice(0));

  await t.test('訪客：名字遮蔽，只能查看', async () => {
    await page.locator('#modeBanner', { hasText: '訪客模式' }).waitFor();
    const names = await page.locator('#studentGrid .name').allTextContents();
    assert.deepEqual(names.sort(), ['李○華', '王○明', '陳○同']);
    assert.equal(await page.locator('[data-action="checkin"]').count(), 0);
    const tabs = await page.locator('#tabBar [data-tab]').evaluateAll((els) => els.map((e) => e.dataset.tab));
    assert.deepEqual(tabs, ['checkin', 'board', 'gifts']);
  });

  await t.test('擁有者：建立壇務帳號', async () => {
    await login(page, OWNER_PIN);
    await page.locator('#userBtn', { hasText: '模擬堂主' }).waitFor();
    assert.equal(await page.locator('#studentGrid .name', { hasText: '王小明' }).count(), 1); // 登入後看到完整名字
    await tab(page, 'owner');
    await page.click('#view [data-action="new-user"]');
    const m = await dialog(page);
    await m.locator('[name=name]').fill('壇務甲');
    await m.locator('[name=pin]').fill('1357');
    await m.locator('button[type=submit]').click();
    await toast(page, '已建立帳號「壇務甲」');

    // LOGO：從「系統與備份」上傳，存在後台（不放在程式碼裡）
    assert.equal(await page.locator('#brandLogo').isVisible(), false);
    await page.click('#view [data-action="owner-section"][data-id="system"]');
    await page.locator('input[data-change="upload-logo"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(PNG_4PX, 'base64') });
    await toast(page, '已更新 LOGO');
    assert.equal(await page.locator('#brandLogo').isVisible(), true);
    assert.equal(await page.locator('#brandMark').isVisible(), false);
    const saved = await page.evaluate(() => apiGetLogo().logo);
    assert.match(saved, /^data:image\/png;base64,/);
    assert.equal(await page.locator('#favicon').getAttribute('href'), saved);
    await logout(page);
    assert.equal(await page.locator('#brandLogo').isVisible(), true); // 訪客也看得到
  });

  await t.test('壇務：可以點名，不能刪除、看不到擁有者後台', async () => {
    await login(page, '1357', '壇務甲');
    const tabs = await page.locator('#tabBar [data-tab]').evaluateAll((els) => els.map((e) => e.dataset.tab));
    assert.equal(tabs.includes('owner'), false);
    assert.ok(tabs.includes('roster') && tabs.includes('manage'));
    await calls();
    // 今天第一次點名（還沒有課次）：按下去畫面立即更新，不必等後端建立課次（模擬後端每次延遲 300ms）
    assert.equal(await page.evaluate(() => App.session()), null);
    const reacted = await page.evaluate(() => {
      document.querySelector('#studentGrid [data-action="checkin"]').click(); // 王小明排第一
      const s = App.s.data.students.find((x) => x.name === '王小明');
      return !!App.session() && AttendStore.isCheckedIn(App.s.data, s.id, App.session().id);
    });
    assert.equal(reacted, true);
    await toast(page, '王小明 報到成功');
    await idle(page);
    await card(page, '王小明').locator('button', { hasText: '已報到' }).waitFor();
    // 點名只傳回變動，不是整份資料
    const applied = (await calls()).filter((c) => c.name === 'apiApply').map((c) => c.kind);
    assert.ok(applied.length >= 1 && applied.every((k) => k === 'delta'), JSON.stringify(applied));
    await tab(page, 'roster');
    assert.equal(await page.locator('[data-action="delete-student"]').count(), 0);
    await tab(page, 'checkin');
  });

  await t.test('服務人員點名：點一下立即標記到，再點一下取消', async () => {
    const chip = page.locator('[data-staff-duty] [data-action="staff-duty"]', { hasText: '林輔導' });
    await chip.click();
    assert.equal(await chip.getAttribute('aria-pressed'), 'true'); // 不必等後端
    await page.locator('[data-staff-duty]', { hasText: '1 / 1 到' }).waitFor();
    await idle(page);
    const dutyOnServer = () => page.evaluate(() => {
      const st = readState_();
      const p = st.staff.find((x) => x.name === '林輔導');
      return AttendStore.computeStaffDuty(st)[p.id];
    });
    assert.equal(await dutyOnServer(), 1);
    await chip.click();
    await idle(page);
    assert.equal(await chip.getAttribute('aria-pressed'), 'false');
    assert.equal(await dutyOnServer(), 0);
    await chip.click(); // 留下「到」，後面的步驟不受影響
    await idle(page);
  });

  await t.test('多裝置：別台點名後，這台重新整理只下載變動', async () => {
    await page.evaluate((pin) => {
      const tok = apiLogin('U-owner', pin).token;
      const s = App.session();
      const stu = App.s.data.students.find((x) => x.name === '李小華');
      apiApply(tok, { type: 'points.checkin', studentId: stu.id, sessionId: s.id });
    }, OWNER_PIN);
    await calls();
    await page.click('[data-action="refresh"]');
    await card(page, '李小華').locator('button', { hasText: '已報到' }).waitFor();
    assert.deepEqual(await calls(), [{ name: 'apiGetState', kind: 'delta' }]);
    // 再按一次：沒有變動
    await page.click('[data-action="refresh"]');
    await page.waitForFunction(() => window.__calls.length > 0);
    assert.deepEqual(await calls(), [{ name: 'apiGetState', kind: 'unchanged' }]);
    // 畫面上的資料與試算表完全一致
    assert.equal(await page.evaluate(() => JSON.stringify(App.s.data) === JSON.stringify(readState_())), true);
  });

  await t.test('寫入失敗：提示錯誤、畫面退回，資料不受影響，再按一次就成功', async () => {
    await page.evaluate(() => {
      const flush = SpreadsheetApp.flush;
      SpreadsheetApp.flush = function () {
        SpreadsheetApp.flush = flush;
        throw new Error('Service timed out');
      };
    });
    await card(page, '陳大同').locator('[data-action="checkin"]').click();
    await toast(page, '系統發生錯誤');
    await idle(page);
    await card(page, '陳大同').locator('[data-action="checkin"]').waitFor(); // 樂觀更新已退回
    assert.equal(await page.evaluate(() => JSON.stringify(App.s.data) === JSON.stringify(readState_())), true);
    await card(page, '陳大同').locator('[data-action="checkin"]').click();
    await toast(page, '陳大同 報到成功');
    await idle(page);
    await card(page, '陳大同').locator('button', { hasText: '已報到' }).waitFor();
  });

  await t.test('背景重新整理還在路上時加分：較慢回來的舊回應不會蓋掉剛加的分', async () => {
    await page.evaluate(() => {
      // 讓下一次讀取在後台處理完後，晚 1 秒才回到網頁（比之後送出的加分還晚回來）
      const fetch0 = window.fetch;
      window.__slowDone = false;
      window.fetch = function (url, opts) {
        if (opts.body.indexOf('"apiGetState"') === -1) return fetch0.apply(this, arguments);
        window.fetch = fetch0;
        return fetch0.apply(this, arguments).then(function (r) {
          return new Promise(function (resolve) { setTimeout(function () { window.__slowDone = true; resolve(r); }, 1000); });
        });
      };
      App.refresh(true);
      const s = App.s.data.students.find((x) => x.name === '王小明');
      App.run({ type: 'points.award', studentId: s.id, date: App.s.date, points: 2, reason: '慢回應測試' });
    });
    await page.waitForFunction(() => window.__slowDone);
    await idle(page);
    const has = () => page.evaluate(() => App.s.data.logs.some((l) => l.reason.indexOf('慢回應測試') !== -1));
    assert.equal(await has(), true);
    assert.equal(await page.evaluate(() => JSON.stringify(App.s.data) === JSON.stringify(readState_())), true);
    // 下一次重新整理仍是「沒有變動」：網頁手上的版本沒有被舊回應改回去
    await calls();
    await page.click('[data-action="refresh"]');
    await page.waitForFunction(() => window.__calls.length > 0);
    assert.deepEqual(await calls(), [{ name: 'apiGetState', kind: 'unchanged' }]);
  });

  await t.test('登入逾時：操作時提示重新登入，回到訪客畫面', async () => {
    await page.evaluate(() => CacheService.getScriptCache().remove('tok:' + App.s.backend.token));
    await page.click('#view [data-action="open-batch"]');
    const m = await dialog(page);
    await m.locator('[name=reason]').fill('秩序良好');
    await m.locator('button[type=submit][data-sign="1"]').click();
    await toast(page, '登入已逾時');
    await page.waitForFunction(() => !App.s.user);
    await idle(page);
    await page.locator('#modeBanner', { hasText: '訪客模式' }).waitFor();
    assert.equal(await page.evaluate(() => readState_().logs.some((l) => l.reason.indexOf('秩序良好') !== -1)), false);
    assert.equal(await modal(page).count(), 0);
  });

  await t.test('後台版本不同時提示擁有者更新；後台設定錯誤時提示原因', async () => {
    await page.evaluate(() => { window.__realVersion = ATTENDPOINT_CONFIG.BACKEND_VERSION; ATTENDPOINT_CONFIG.BACKEND_VERSION = 'old-page'; });
    await page.click('[data-action="refresh"]');
    await page.locator('#modeBanner', { hasText: '後台程式需要更新' }).waitFor();
    await page.evaluate(() => { ATTENDPOINT_CONFIG.BACKEND_VERSION = window.__realVersion; });
    await page.click('[data-action="refresh"]');
    await page.waitForFunction(() => !document.querySelector('#modeBanner').textContent.includes('後台程式需要更新'));

    // Apps Script 存取權沒設成「所有人」時，Google 會回登入頁（不是 JSON）
    await page.evaluate(() => {
      const fetch0 = window.fetch;
      window.fetch = function () {
        window.fetch = fetch0;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
      };
    });
    await page.click('[data-action="refresh"]');
    await toast(page, '確認 Apps Script 部署的存取權為「所有人」');
  });

  await t.test('沒有程式錯誤', () => {
    assert.deepEqual(page.errors, []);
  });
});
