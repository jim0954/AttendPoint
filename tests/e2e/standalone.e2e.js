// 單機版（dist/AttendPoint.html）：從空白開始，透過畫面完成建班、名冊、點名、加減分、兌換、撤銷
const test = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, launch, idle, modal, dialog, toast, tab, confirm, card, cardPoints } = require('./helpers.js');

test('單機版', { skip: SKIP }, async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const page = await env.open('AttendPoint.html');

  await t.test('第一次使用：設定擁有者並登入', async () => {
    await page.locator('#modeBanner', { hasText: '單機版' }).waitFor();
    await page.click('#userBtn');
    const m = await dialog(page);
    await m.locator('form[data-setup]').waitFor();
    await m.locator('[name=name]').fill('堂主');
    await m.locator('[name=pin]').fill('246802');
    await m.locator('[name=pin2]').fill('246802');
    await m.locator('button[type=submit]').click();
    await page.locator('#userBtn', { hasText: '堂主' }).waitFor();
  });

  await t.test('建立班別：小隊、加分項目', async () => {
    await page.click('#view [data-action="new-class"]');
    const m = await dialog(page);
    await m.locator('[name=name]').fill('兒童讀經班');
    await m.locator('[name=idPrefix]').fill('K');
    await m.locator('[data-add="team"]').click();
    await m.locator('[data-list="team"] [data-f="name"]').last().fill('孝順隊');
    await m.locator('[data-add="add"]').click();
    const rule = m.locator('[data-row="add"]').last();
    await rule.locator('[data-f="label"]').fill('背誦經典');
    await rule.locator('[data-f="points"]').fill('5');
    await m.locator('button[type=submit]').click();
    await toast(page, '已儲存「兒童讀經班」');
    await page.locator('#classBar .class-chip', { hasText: '兒童讀經班' }).waitFor();
  });

  await t.test('名冊：新增學員', async () => {
    await tab(page, 'roster');
    for (const name of ['王小明', '李小華']) {
      await page.click('#view .toolbar [data-action="edit-student"]');
      const m = await dialog(page);
      await m.locator('[name=name]').fill(name);
      await m.locator('[name=teamId]').selectOption({ label: '孝順隊' });
      await m.locator('button[type=submit]').click();
      await toast(page, `已新增 ${name}`);
    }
    assert.deepEqual(await page.locator('#view tbody td:nth-child(2)').allTextContents(), ['王小明', '李小華']);
  });

  await t.test('點名：報到加分、計入出席', async () => {
    await tab(page, 'checkin');
    await card(page, '王小明').locator('[data-action="checkin"]').click();
    await toast(page, '王小明 報到成功');
    await idle(page);
    assert.deepEqual(await cardPoints(page, '王小明'), { honor: 10, balance: 10, attend: 1 });
    await card(page, '王小明').locator('button', { hasText: '已報到' }).waitFor();
  });

  await t.test('學員小卡：規則加分與自訂加分', async () => {
    await card(page, '王小明').locator('.name').click();
    const m = await dialog(page);
    await m.locator('.rule-btn', { hasText: '背誦經典' }).click();
    await idle(page);
    await m.locator('[data-custom] [name=points]').fill('3');
    await m.locator('[data-custom] [name=reason]').fill('主動幫忙');
    await m.locator('[data-action="award-custom"][data-sign="1"]').click();
    await idle(page);
    await m.locator('[data-close]').first().click();
    assert.deepEqual(await cardPoints(page, '王小明'), { honor: 18, balance: 18, attend: 1 });
  });

  await t.test('兌換：只扣可用點數，點數不足的學員不能兌換', async () => {
    await tab(page, 'gifts');
    await page.click('#view .section-title [data-action="edit-gift"]');
    let m = await dialog(page);
    await m.locator('[name=name]').fill('文具組');
    await m.locator('[name=cost]').fill('10');
    await m.locator('button[type=submit]').click();
    await toast(page, '已儲存禮品');
    await page.click('#view [data-action="redeem-pick"]');
    m = await dialog(page);
    const poor = m.locator('.list-item', { hasText: '李小華' }).locator('[data-action="redeem"]');
    assert.equal(await poor.isDisabled(), true);
    await m.locator('.list-item', { hasText: '王小明' }).locator('[data-action="redeem"]').click();
    await confirm(page);
    await toast(page, '兌換「文具組」成功');
    await idle(page);
    await m.locator('[data-close]').first().click();
    await tab(page, 'checkin');
    assert.deepEqual(await cardPoints(page, '王小明'), { honor: 18, balance: 8, attend: 1 });
  });

  await t.test('榮譽榜：依榮譽總分排序', async () => {
    await tab(page, 'board');
    const first = page.locator('#view .list-item[data-action="open-student"]').first();
    assert.match(await first.innerText(), /王小明[\s\S]*18/);
  });

  await t.test('撤銷：本堂紀錄撤銷自訂加分', async () => {
    await tab(page, 'checkin');
    await page.locator('#view .list-item', { hasText: '主動幫忙' }).locator('[data-action="undo"]').click();
    await confirm(page);
    await toast(page, '已撤銷「主動幫忙」');
    await idle(page);
    assert.deepEqual(await cardPoints(page, '王小明'), { honor: 15, balance: 5, attend: 1 });
  });

  await t.test('重新開啟網頁：資料保存在瀏覽器', async () => {
    await page.reload();
    await page.waitForFunction(() => window.App && App.s.data.students.length === 2);
    assert.deepEqual(await cardPoints(page, '王小明'), { honor: 15, balance: 5, attend: 1 });
  });

  await t.test('名字裡的 HTML 只當文字顯示，不會執行', async () => {
    await tab(page, 'roster');
    await page.click('#view .toolbar [data-action="edit-student"]');
    const m = await dialog(page);
    await m.locator('[name=name]').fill('<img src=x onerror=window.__xss=1>');
    await m.locator('button[type=submit]').click();
    await idle(page);
    await page.locator('#view tbody td', { hasText: '<img src=x' }).waitFor();
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#view img').count(), 0);
  });

  await t.test('服務人員：職務從四個選項中選擇', async () => {
    await tab(page, 'manage');
    await page.click('#view [data-action="manage-section"][data-id="staff"]');
    await page.click('#view .toolbar [data-action="edit-staff"]');
    const m = await dialog(page);
    const options = await m.locator('[name=role] option').allTextContents();
    assert.deepEqual(options, ['（未填）', '點傳師', '主壇務', '副主壇務', '護持壇務']);
    await m.locator('[name=name]').fill('林道長');
    await m.locator('[name=role]').selectOption('主壇務');
    await m.locator('button[type=submit]').click();
    await idle(page);
    // 完全比對：避免「副主壇務」也被當成符合
    await page.locator('#view .list-item', { hasText: '林道長' }).locator('.chip', { hasText: /^主壇務$/ }).waitFor();
    assert.equal(await page.evaluate(() => App.s.data.staff.find((p) => p.name === '林道長').role), '主壇務');
  });

  await t.test('服務人員：舊職務編輯時以「（舊）」保留，改選後才換掉', async () => {
    // 模擬改版前建立、職務不在四個選項內的服務人員（現在的規則不允許新建，直接改瀏覽器裡的資料）
    await page.evaluate(() => App.run({ type: 'staff.create', name: '陳師兄', role: '', classIds: [] }));
    await idle(page);
    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('attendpoint_v3'));
      data.staff.find((p) => p.name === '陳師兄').role = '小隊輔';
      localStorage.setItem('attendpoint_v3', JSON.stringify(data));
      return App.refresh(true);
    });
    const roleOf = () => page.evaluate(() => App.s.data.staff.find((p) => p.name.indexOf('陳師兄') === 0).role);
    const openEditor = async () => {
      await page.locator('#view .list-item', { hasText: '陳師兄' }).locator('[data-action="edit-staff"]').click();
      return dialog(page);
    };

    // 只改姓名：舊職務保留
    let m = await openEditor();
    assert.deepEqual(await m.locator('[name=role] option').allTextContents(), ['（未填）', '點傳師', '主壇務', '副主壇務', '護持壇務', '小隊輔（舊）']);
    assert.equal(await m.locator('[name=role]').inputValue(), '小隊輔');
    await m.locator('[name=name]').fill('陳師兄甲');
    await m.locator('button[type=submit]').click();
    await idle(page);
    assert.equal(await roleOf(), '小隊輔');

    // 改選新職務：換掉，之後不再出現「（舊）」
    m = await openEditor();
    await m.locator('[name=role]').selectOption('護持壇務');
    await m.locator('button[type=submit]').click();
    await idle(page);
    assert.equal(await roleOf(), '護持壇務');
    m = await openEditor();
    assert.equal(await m.locator('[name=role] option', { hasText: '（舊）' }).count(), 0);
    await m.locator('[data-close]').first().click();
  });

  await t.test('CSV 匯出：開頭像公式的文字前面補單引號，數字不變', async () => {
    const csv = await page.evaluate(() => App.toCsv([['=1+1', '@x', '-遲到', -5, '王小明']]));
    assert.equal(csv, "\ufeff'=1+1,'@x,'-遲到,-5,王小明");
  });

  await t.test('提示：相同的合併成一則並顯示次數，最多同時 3 則', async () => {
    const texts = () => page.locator('#toastRoot .toast').allInnerTexts();
    await page.evaluate(() => {
      document.querySelector('#toastRoot').innerHTML = '';
      for (let i = 0; i < 5; i++) App.toast('🎉 王小明「回答優良」+3', 'ok');
    });
    assert.deepEqual(await texts(), ['🎉 王小明「回答優良」+3×5']);
    await page.evaluate(() => ['甲', '乙', '丙'].forEach((x) => App.toast(x)));
    assert.deepEqual(await texts(), ['甲', '乙', '丙']);
    await page.evaluate(() => App.toast('甲'));
    assert.deepEqual(await texts(), ['乙', '丙', '甲×2']);
  });

  await t.test('沒有程式錯誤', () => {
    assert.deepEqual(page.errors, []);
  });
});
