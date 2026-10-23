#!/usr/bin/env node
/*
 * 產生可部署的檔案（npm run build）：
 *   dist/AttendPoint.html   單機版：一個檔案，瀏覽器直接開啟即可使用
 *   dist/gas/               Google Apps Script 專案（clasp push 或手動複製）
 *
 * 兩者使用同一份 Index.html，執行時自動判斷是否在 GAS 環境。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// 前端腳本載入順序：資料層 → 權限 → 移轉 → 介面
const SHARED = ['store.js', 'auth.js', 'migrate-v2.js'];
const UI = ['lib.js', 'sha256.js', 'backend.js', 'app.js', 'view-checkin.js', 'view-board.js', 'view-roster.js', 'view-manage.js', 'view-owner.js', 'main.js'];
const GAS_FILES = ['store.js', 'auth.js', 'migrate-v2.js', 'Code.js', 'appsscript.json'];

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function inlineScript(name, code) {
  // GAS 與瀏覽器都不允許腳本內出現 </script>
  if (/<\/script/i.test(code)) throw new Error(`${name} 內含 </script>，無法內嵌`);
  return `<script>/* ${name} */\n${code}\n</script>`;
}

function buildIndex() {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const template = read(path.join(SRC, 'ui', 'index.html'));
  const css = read(path.join(SRC, 'ui', 'styles.css'));
  const scripts = SHARED.map((f) => inlineScript(f, read(path.join(SRC, f))))
    .concat(UI.filter((f) => fs.existsSync(path.join(SRC, 'ui', f))).map((f) => inlineScript('ui/' + f, read(path.join(SRC, 'ui', f)))))
    .join('\n');
  const out = template
    .replace('<!-- @styles -->', () => `<style>\n${css}\n</style>`)
    .replace('<!-- @scripts -->', () => scripts)
    .replace(/@VERSION@/g, pkg.version);
  if (out.includes('<?')) throw new Error('Index.html 不可包含 <?（GAS 樣板語法）');
  return out;
}

function main() {
  const index = buildIndex();
  fs.mkdirSync(path.join(DIST, 'gas'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'AttendPoint.html'), index);
  fs.writeFileSync(path.join(DIST, 'gas', 'Index.html'), index);
  GAS_FILES.forEach((f) => fs.copyFileSync(path.join(SRC, f), path.join(DIST, 'gas', f)));
  const kb = Math.round(Buffer.byteLength(index) / 1024);
  console.log(`✓ dist/AttendPoint.html（${kb} KB）`);
  console.log(`✓ dist/gas/（${GAS_FILES.length + 1} 個檔案）`);
}

if (require.main === module) main();
module.exports = { buildIndex };
