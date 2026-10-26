// 在 Node 中模擬 Google Apps Script 服務（試算表、指令碼屬性、快取、鎖定），
// 載入 src/ 的後端程式。tests/gas.test.js 與 scripts/stress.js 共用。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC = path.join(__dirname, '..', 'src');
const LOAD_ORDER = ['store.js', 'auth.js', 'migrate-v2.js', 'Code.js'];

function mockSheet() {
  let cells = []; // cells[row][col]
  return {
    hidden: false,
    cells: () => cells,
    getLastRow: () => cells.length,
    clearContents() { cells = []; },
    clear() { cells = []; },
    hideSheet() { this.hidden = true; },
    setFrozenRows() {},
    getRange(r, c, nr, nc) {
      return {
        setNumberFormat() {},
        getValues: () => cells.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + (nc || 1))),
        setValues(values) {
          values.forEach((row, i) => {
            cells[r - 1 + i] = cells[r - 1 + i] || [];
            row.forEach((v, j) => { cells[r - 1 + i][c - 1 + j] = v; });
          });
        }
      };
    }
  };
}

function createGas(propsInit) {
  const sheets = {};
  const props = Object.assign({}, propsInit);
  const cache = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = mockSheet())
  };
  const context = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush() {}, getUi: () => { throw new Error('no ui'); } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = String(v); },
        remove: (k) => { delete cache[k]; }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, text) => Array.from(crypto.createHash('sha256').update(text, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (d, tz, fmt) => {
        const iso = new Date(d.getTime() + 8 * 3600 * 1000).toISOString();
        if (fmt === 'yyyyMMdd_HHmmss') return iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
        return iso.slice(0, 19);
      }
    },
    HtmlService: {}
  };
  vm.createContext(context);
  LOAD_ORDER.forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f }));
  return { gas: context, sheets, props, cache };
}

module.exports = { createGas, mockSheet };
