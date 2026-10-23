const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildIndex } = require('../scripts/build.js');

test('建置：Index.html 內嵌所有程式，且沒有 GAS 樣板語法', () => {
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
