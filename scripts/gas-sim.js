#!/usr/bin/env node
/*
 * 開發用：產生 dist/gas-sim.html，在瀏覽器中模擬 Google Apps Script 環境，
 * 不用部署就能測試雲端版的完整流程（google.script.run → Code.js → 試算表）。
 *
 *   npm run build && node scripts/gas-sim.js
 *   然後用本機伺服器開啟 dist/gas-sim.html（擁有者 PIN：OWNER_PIN 預設 246810）
 *
 * 資料只存在記憶體，重新整理頁面就會清空。每次呼叫延遲 300ms，模擬網路。
 */
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');

const mocks = `
<script>
(function () {
  const sheets = {};
  const props = { OWNER_PIN: '246810', OWNER_NAME: '模擬堂主' };
  const cache = {};
  function sheet() {
    let cells = [];
    return {
      getLastRow: function () { return cells.length; },
      clearContents: function () { cells = []; },
      clear: function () { cells = []; },
      hideSheet: function () {},
      setFrozenRows: function () {},
      getRange: function (r, c, nr, nc) {
        return {
          setNumberFormat: function () {},
          getValues: function () { return cells.slice(r - 1, r - 1 + nr).map(function (row) { return row.slice(c - 1, c - 1 + (nc || 1)); }); },
          setValues: function (values) { values.forEach(function (row, i) { cells[r - 1 + i] = row.slice(); }); }
        };
      }
    };
  }
  const ss = {
    getSheetByName: function (n) { return sheets[n] || null; },
    insertSheet: function (n) { return (sheets[n] = sheet()); }
  };
  window.__simSheets = sheets;
  window.SpreadsheetApp = { getActiveSpreadsheet: function () { return ss; }, openById: function () { return ss; }, getUi: function () { throw new Error('no ui'); } };
  window.PropertiesService = { getScriptProperties: function () { return {
    getProperty: function (k) { return k in props ? props[k] : null; },
    setProperty: function (k, v) { props[k] = String(v); }
  }; } };
  window.CacheService = { getScriptCache: function () { return {
    get: function (k) { return k in cache ? cache[k] : null; },
    put: function (k, v) { cache[k] = String(v); },
    remove: function (k) { delete cache[k]; }
  }; } };
  window.LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
  window.Session = { getScriptTimeZone: function () { return 'Asia/Taipei'; } };
  window.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    getUuid: function () { return crypto.randomUUID(); },
    computeDigest: function (alg, text) {
      const hex = App.sha256Hex(text);
      const out = [];
      for (let i = 0; i < hex.length; i += 2) { const b = parseInt(hex.slice(i, i + 2), 16); out.push(b > 127 ? b - 256 : b); }
      return out;
    },
    formatDate: function (d, tz, fmt) {
      const iso = AttendStore.localIso(d);
      return fmt === 'yyyyMMdd_HHmmss' ? iso.replace(/[-:]/g, '').replace('T', '_') : iso;
    }
  };
  // google.script.run：非同步呼叫全域 api 函式，參數與回傳值都經過 JSON 序列化
  function runner(ok, fail) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return runner(fn, fail); };
        if (name === 'withFailureHandler') return function (fn) { return runner(ok, fn); };
        return function () {
          const args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
          setTimeout(function () {
            try {
              const res = JSON.parse(JSON.stringify(window[name].apply(null, args)));
              if (ok) ok(res);
            } catch (e) {
              console.error(e);
              if (fail) fail(e);
            }
          }, 300);
        };
      }
    });
  }
  window.google = { script: { run: runner(null, null) } };
})();
</script>`;

function main() {
  const index = fs.readFileSync(path.join(DIST, 'gas', 'Index.html'), 'utf8');
  const code = fs.readFileSync(path.join(DIST, 'gas', 'Code.js'), 'utf8');
  // 模擬服務要在前端程式之前定義；Code.js 放最後（它在呼叫時才用到 AttendStore 等全域物件）
  const out = index
    .replace('</body>', '<script>/* Code.js */\n' + code + '\n</script>\n</body>')
    .replace('<script>/* store.js */', mocks + '\n<script>/* store.js */');
  fs.writeFileSync(path.join(DIST, 'gas-sim.html'), out);
  console.log('✓ dist/gas-sim.html');
}

main();
