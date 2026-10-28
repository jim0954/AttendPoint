const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildIndex } = require('../scripts/build.js');

test('建置：網頁內嵌所有程式', () => {
  const html = buildIndex();
  assert.ok(!html.includes('<?'));
  assert.ok(!html.includes('<!-- @scripts -->'));
  for (const name of ['store.js', 'auth.js', 'migrate-v2.js', 'ui/app.js', 'ui/main.js']) {
    assert.ok(html.includes(`/* ${name} */`), `缺少 ${name}`);
  }
});

test('建置：每段內嵌腳本都是合法的 JavaScript', () => {
  const html = buildIndex();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 10);
  scripts.forEach((code) => assert.doesNotThrow(() => new vm.Script(code)));
});

const fs = require('node:fs');
const path = require('node:path');
const { backendVersion } = require('../scripts/build.js');

function configOf(html) {
  const code = html.match(/<script>\/\* config\.js \*\/([\s\S]*?)<\/script>/)[1];
  const win = {};
  vm.runInNewContext(code, { window: win });
  return win.ATTENDPOINT_CONFIG;
}

test('建置：單機版不連後台；雲端版網頁使用 src/config.js，兩者都帶後台版本', () => {
  const local = configOf(buildIndex());
  const web = configOf(buildIndex({ cloud: true }));
  assert.equal(local.GAS_URL, '');
  assert.equal(local.BACKEND_VERSION, backendVersion());
  assert.equal(web.BACKEND_VERSION, backendVersion());
  assert.match(backendVersion(), /^[0-9a-f]{12}$/);
});

test('src/config.js 的後台網址為空白，或是 Apps Script 網頁應用程式網址（/exec 結尾）', () => {
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8'), { window: win });
  const url = win.ATTENDPOINT_CONFIG.GAS_URL;
  assert.ok(url === '' || /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url), `網址格式不正確：${url}`);
});
