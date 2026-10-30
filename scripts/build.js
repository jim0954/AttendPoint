#!/usr/bin/env node
/*
 * 產生可部署的檔案（npm run build）：
 *   dist/AttendPoint.html   單機版：一個檔案，瀏覽器直接開啟即可使用（資料存在瀏覽器）
 *   dist/web/index.html     雲端版網頁：放在 GitHub Pages，依 src/config.js 的 GAS_URL 連到後台
 *   dist/gas/               Google Apps Script 後台（clasp push 或手動複製）
 *
 * 兩份網頁內容相同，只差在設定。後台版本指紋同時寫進網頁與 dist/gas/Code.js，
 * 網頁發現後台版本不同時會提示擁有者更新 Apps Script。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// 前端腳本載入順序：資料層 → 權限 → 移轉 → 介面
const SHARED = ['store.js', 'auth.js', 'migrate-v2.js'];
const UI = ['lib.js', 'sha256.js', 'backend.js', 'app.js', 'view-checkin.js', 'view-board.js', 'view-roster.js', 'view-manage.js', 'view-owner.js', 'main.js'];
const GAS_FILES = ['store.js', 'auth.js', 'migrate-v2.js', 'Code.js', 'appsscript.json'];
const BACKEND_FILES = ['store.js', 'auth.js', 'migrate-v2.js', 'Code.js'];

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function inlineScript(name, code) {
  // GAS 與瀏覽器都不允許腳本內出現 </script>
  if (/<\/script/i.test(code)) throw new Error(`${name} 內含 </script>，無法內嵌`);
  return `<script>/* ${name} */\n${code}\n</script>`;
}

/** 後台程式指紋：任何後台檔案改變（包含共用的資料規則）都會不同 */
function backendVersion() {
  const hash = crypto.createHash('sha256');
  // 統一換行符號：Windows 檢出（CRLF）與 GitHub Actions（LF）建置出的指紋才會相同
  BACKEND_FILES.forEach((f) => hash.update(read(path.join(SRC, f)).replace(/\r\n/g, '\n')));
  return hash.digest('hex').slice(0, 12);
}

/** 網頁設定腳本：cloud 為 true 時使用 src/config.js（GitHub Pages），否則為單機版 */
function configScript(cloud) {
  const version = `window.ATTENDPOINT_CONFIG.BACKEND_VERSION = '${backendVersion()}';`;
  const base = cloud ? read(path.join(SRC, 'config.js')) : "window.ATTENDPOINT_CONFIG = { GAS_URL: '' };";
  return inlineScript('config.js', base + '\n' + version);
}

function buildIndex(opts) {
  const cloud = !!(opts && opts.cloud);
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const template = read(path.join(SRC, 'ui', 'index.html'));
  const css = read(path.join(SRC, 'ui', 'styles.css'));
  const scripts = [configScript(cloud)].concat(SHARED.map((f) => inlineScript(f, read(path.join(SRC, f))))
    .concat(UI.filter((f) => fs.existsSync(path.join(SRC, 'ui', f))).map((f) => inlineScript('ui/' + f, read(path.join(SRC, 'ui', f))))))
    .join('\n');
  const out = template
    .replace('<!-- @styles -->', () => `<style>\n${css}\n</style>`)
    .replace('<!-- @scripts -->', () => scripts)
    .replace(/@VERSION@/g, pkg.version);
  if (out.includes('<?')) throw new Error('網頁不可包含 <?');
  return out;
}

function main() {
  const local = buildIndex();
  const web = buildIndex({ cloud: true });
  const version = backendVersion();
  fs.rmSync(path.join(DIST, 'gas'), { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'gas'), { recursive: true });
  fs.mkdirSync(path.join(DIST, 'web'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'AttendPoint.html'), local);
  fs.writeFileSync(path.join(DIST, 'web', 'index.html'), web);
  GAS_FILES.forEach((f) => {
    let code = read(path.join(SRC, f));
    if (f === 'Code.js') code = code.replace('@BACKEND_VERSION@', version);
    fs.writeFileSync(path.join(DIST, 'gas', f), code);
  });
  const url = read(path.join(SRC, 'config.js')).match(/GAS_URL:\s*'([^']*)'/);
  const kb = Math.round(Buffer.byteLength(local) / 1024);
  console.log(`✓ dist/AttendPoint.html（單機版，${kb} KB）`);
  console.log(`✓ dist/web/index.html（雲端版網頁，${url && url[1] ? '後台 ' + url[1] : '尚未設定 GAS_URL，會以單機版運作'}）`);
  console.log(`✓ dist/gas/（後台 ${GAS_FILES.length} 個檔案，版本 ${version}）`);
}

if (require.main === module) main();
module.exports = { buildIndex, backendVersion };
