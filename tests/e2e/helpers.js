// 瀏覽器自動化測試共用工具（需要 Playwright；沒有安裝時測試會略過並提示安裝方式）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', 'dist');

let playwright = null;
try {
  playwright = require('playwright');
} catch (e) {
  playwright = null;
}

const SKIP = playwright
  ? false
  : '需要 Playwright：npm install --no-save playwright && npx playwright install chromium';

/** 用 Node 內建 http 提供 dist/ 靜態檔案，port 由系統分配 */
function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(DIST, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/** 啟動瀏覽器與伺服器；回傳 open(file) 開新分頁（手機尺寸），並收集頁面錯誤 */
async function launch() {
  for (const f of ['AttendPoint.html', 'gas-sim.html']) {
    if (!fs.existsSync(path.join(DIST, f))) throw new Error(`找不到 dist/${f}，請先執行 npm run gas-sim`);
  }
  const { server, base } = await startServer();
  const browser = await playwright.chromium.launch();
  const pages = [];
  async function open(file) {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(base + file);
    await page.waitForFunction(() => window.App && App.s.backend && document.querySelector('#tabBar').children.length > 0);
    pages.push(page);
    return page;
  }
  async function close() {
    await browser.close();
    server.close();
  }
  return { open, close };
}

// ---------- 頁面操作 ----------

/** 等所有資料操作都送到後端並完成 */
function idle(page) {
  return page.waitForFunction(() => !App.isBusy());
}

/** 最上層的對話框 */
function modal(page) {
  return page.locator('.modal-backdrop').last();
}

/**
 * 等新開的對話框準備好再操作：對話框開啟 30ms 後才把游標移到第一個欄位（autofocus），
 * 太快輸入會被搶走焦點、打到別的欄位。
 */
async function dialog(page) {
  await modal(page).waitFor();
  await page.waitForFunction(() => {
    const all = document.querySelectorAll('.modal-backdrop');
    const af = all.length && all[all.length - 1].querySelector('[autofocus]');
    return !af || document.activeElement === af;
  });
  return modal(page);
}

/** 等出現包含文字的提示 */
function toast(page, text) {
  return page.locator('#toastRoot .toast', { hasText: text }).first().waitFor();
}

async function tab(page, key) {
  await page.click(`#tabBar [data-tab="${key}"]`);
}

/** 點「確認」對話框的確定按鈕 */
async function confirm(page) {
  await modal(page).locator('[data-yes]').click();
}

/** 學員卡片（點名頁） */
function card(page, name) {
  return page.locator('#studentGrid .student-card', { has: page.locator('.name', { hasText: name }) });
}

/** 卡片上的分數：{ honor, balance, attend } */
async function cardPoints(page, name) {
  const nums = await card(page, name).locator('.points b').allTextContents();
  return { honor: Number(nums[0]), balance: Number(nums[1]), attend: Number(nums[2]) };
}

/** 從登入對話框登入（userName 不給時用預設第一個帳號） */
async function login(page, pin, userName) {
  await page.click('#userBtn');
  const m = await dialog(page);
  if (userName) {
    const value = await m.locator('#loginUser option', { hasText: userName }).getAttribute('value');
    await m.locator('#loginUser').selectOption(value);
  }
  await m.locator('#loginPin').fill(pin);
  await m.locator('button[type=submit]').click();
  // 登入後會重新讀取資料再重畫；等到壇務才有的「班務管理」分頁出現
  await page.locator('#tabBar [data-tab="manage"]').waitFor();
  await idle(page);
}

async function logout(page) {
  await page.click('#userBtn');
  await modal(page).locator('[data-action="logout"]').click();
  await page.locator('#tabBar [data-tab="manage"]').waitFor({ state: 'detached' });
  await idle(page);
}

module.exports = { SKIP, launch, idle, modal, dialog, toast, tab, confirm, card, cardPoints, login, logout };
