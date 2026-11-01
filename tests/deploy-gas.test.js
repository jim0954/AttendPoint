// 自動更新後台（scripts/deploy-gas.js）：以假的 fetch 檢查送給 Google 的請求
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { credentials, projectFiles, deploy } = require('../scripts/deploy-gas.js');

const V2 = JSON.stringify({ token: { access_token: 'a', refresh_token: 'r2' }, oauth2ClientSettings: { clientId: 'c2', clientSecret: 's2', redirectUri: 'http://localhost' }, isLocalCreds: false });
const V3 = JSON.stringify({ tokens: { default: { client_id: 'c3', client_secret: 's3', type: 'authorized_user', refresh_token: 'r3', access_token: 'a' } } });
const ENV = { CLASPRC_JSON: V3, GAS_SCRIPT_ID: 'SCRIPT', GAS_DEPLOYMENT_ID: 'AKfycDEPLOY' };

function fixture(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-gas-'));
  const gas = path.join(dir, 'gas');
  fs.mkdirSync(gas);
  fs.writeFileSync(path.join(gas, 'appsscript.json'), '{"timeZone":"Asia/Taipei"}');
  ['store.js', 'auth.js', 'migrate-v2.js'].forEach((f) => fs.writeFileSync(path.join(gas, f), '// ' + f));
  fs.writeFileSync(path.join(gas, 'Code.js'), `const BACKEND_VERSION = '${version}';`);
  const configFile = path.join(dir, 'config.js');
  fs.writeFileSync(configFile, "window.ATTENDPOINT_CONFIG = { GAS_URL: 'https://script.google.com/macros/s/X/exec' };");
  return { gasDir: gas, configFile };
}

/** 假的 Google：記錄請求；doGet 回報 live 版本，部署後改成新版本 */
function fakeGoogle(live, opts = {}) {
  const calls = [];
  const state = { live };
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.includes('/macros/s/')) return reply(200, `AttendPoint 後台運作中（版本 ${state.live}）。`);
    if (url.includes('oauth2')) return opts.badToken ? reply(400, { error: 'invalid_grant' }) : reply(200, { access_token: 'TOKEN' });
    if (url.endsWith('/content')) return opts.apiOff ? reply(403, { error: { message: 'User has not enabled the Apps Script API.' } }) : reply(200, {});
    if (url.endsWith('/versions')) return reply(200, { versionNumber: 7 });
    if (url.includes('/deployments/')) { state.live = opts.newVersion; return reply(200, {}); }
    throw new Error('unexpected ' + url);
  };
  return { fetch, calls };
}

const quiet = { log() {}, wait: async () => {} };

test('授權檔：clasp 2.x 與 3.x 格式都能讀出 OAuth 用戶端與 refresh token', () => {
  assert.deepEqual(credentials(V2), { clientId: 'c2', clientSecret: 's2', refreshToken: 'r2' });
  assert.deepEqual(credentials(V3), { clientId: 'c3', clientSecret: 's3', refreshToken: 'r3' });
  assert.throws(() => credentials('不是 JSON'), /不是正確的 JSON/);
  assert.throws(() => credentials('{"foo":1}'), /無法辨識/);
});

test('上傳的檔案：manifest 加上四個後台檔案，依載入順序排列', () => {
  const f = fixture('aaaaaaaaaaaa');
  assert.deepEqual(projectFiles(f.gasDir).map((x) => [x.name, x.type]), [
    ['appsscript', 'JSON'], ['store', 'SERVER_JS'], ['auth', 'SERVER_JS'], ['migrate-v2', 'SERVER_JS'], ['Code', 'SERVER_JS']
  ]);
});

test('沒有設定 Secret 時略過；後台已是最新版本時不建立新版本', async () => {
  const f = fixture('aaaaaaaaaaaa');
  const g1 = fakeGoogle('aaaaaaaaaaaa');
  assert.equal(await deploy({ ...f, ...quiet, env: { GAS_SCRIPT_ID: 'x' }, fetch: g1.fetch }), 'skipped');
  assert.equal(g1.calls.length, 0);
  assert.equal(await deploy({ ...f, ...quiet, env: ENV, fetch: g1.fetch }), 'unchanged');
  assert.deepEqual(g1.calls.map((c) => c.method + ' ' + c.url.split('/').slice(-1)[0]), ['GET exec']);
});

test('版本不同：上傳、建立版本、把現有部署作業指到新版本，再確認網址', async () => {
  const f = fixture('bbbbbbbbbbbb');
  const g = fakeGoogle('aaaaaaaaaaaa', { newVersion: 'bbbbbbbbbbbb' });
  const logs = [];
  assert.equal(await deploy({ ...f, wait: async () => {}, log: (m) => logs.push(m), env: ENV, fetch: g.fetch }), 'deployed');
  const steps = g.calls.map((c) => c.method + ' ' + c.url.replace('https://script.googleapis.com/v1/projects/', ''));
  assert.deepEqual(steps, [
    'GET https://script.google.com/macros/s/X/exec',
    'POST https://oauth2.googleapis.com/token',
    'PUT SCRIPT/content',
    'POST SCRIPT/versions',
    'PUT SCRIPT/deployments/AKfycDEPLOY',
    'GET https://script.google.com/macros/s/X/exec'
  ]);
  assert.match(g.calls[1].body, /refresh_token=r3/);
  assert.equal(JSON.parse(g.calls[2].body).files.length, 5);
  assert.deepEqual(JSON.parse(g.calls[4].body).deploymentConfig, {
    scriptId: 'SCRIPT', versionNumber: 7, manifestFileName: 'appsscript', description: '自動部署 bbbbbbbbbbbb'
  });
  assert.ok(logs.some((m) => m.includes('✓ 後台網址已是新版本')));
  assert.equal(logs.join('\n').includes('TOKEN'), false, '紀錄中不出現授權資訊');
});

test('授權失效或沒有開啟 Apps Script API 時，失敗並說明處理方式', async () => {
  const f = fixture('bbbbbbbbbbbb');
  await assert.rejects(deploy({ ...f, ...quiet, env: ENV, fetch: fakeGoogle('a', { badToken: true }).fetch }), /重新執行 clasp login/);
  await assert.rejects(deploy({ ...f, ...quiet, env: ENV, fetch: fakeGoogle('a', { apiOff: true }).fetch }), /usersettings/);
});
