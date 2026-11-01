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
  return { gasDir: gas };
}

/** 假的 Apps Script API：記錄請求；部署作業目前指到第 6 版（指紋 live），更新後指到新版本 */
function fakeGoogle(live, opts = {}) {
  const calls = [];
  const versions = { 6: live };
  let deployed = 6;
  let uploaded = null;
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.includes('oauth2')) return opts.badToken ? reply(400, { error: 'invalid_grant' }) : reply(200, { access_token: 'TOKEN' });
    if (opts.apiOff) return reply(403, { error: { message: 'User has not enabled the Apps Script API.' } });
    if (url.endsWith('/deployments/AKfycDEPLOY')) {
      if (init.method === 'PUT') { if (!opts.ignoreUpdate) deployed = JSON.parse(init.body).deploymentConfig.versionNumber; return reply(200, {}); }
      return reply(200, { deploymentConfig: { versionNumber: deployed } });
    }
    const m = url.match(/content\?versionNumber=(\d+)$/);
    if (m) return reply(200, { files: [{ name: 'Code', source: `const BACKEND_VERSION = '${versions[m[1]]}';` }] });
    if (url.endsWith('/content')) { uploaded = JSON.parse(init.body).files.find((f) => f.name === 'Code').source.match(/'(\w+)'/)[1]; return reply(200, {}); }
    if (url.endsWith('/versions')) { versions[7] = uploaded; return reply(200, { versionNumber: 7 }); }
    throw new Error('unexpected ' + url);
  };
  return { fetch, calls };
}

const quiet = { log() {} };
const steps = (g) => g.calls.map((c) => c.method + ' ' + c.url.replace('https://script.googleapis.com/v1/projects/', ''));

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

test('沒有設定 Secret 時略過；部署作業已是最新版本時不建立新版本（不需要開啟後台網址）', async () => {
  const f = fixture('aaaaaaaaaaaa');
  const g1 = fakeGoogle('aaaaaaaaaaaa');
  assert.equal(await deploy({ ...f, ...quiet, env: { GAS_SCRIPT_ID: 'x' }, fetch: g1.fetch }), 'skipped');
  assert.equal(g1.calls.length, 0);
  assert.equal(await deploy({ ...f, ...quiet, env: ENV, fetch: g1.fetch }), 'unchanged');
  assert.deepEqual(steps(g1), ['POST https://oauth2.googleapis.com/token', 'GET SCRIPT/deployments/AKfycDEPLOY', 'GET SCRIPT/content?versionNumber=6']);
  assert.equal(g1.calls.some((c) => c.url.includes('script.google.com')), false);
});

test('版本不同：上傳、建立版本、把現有部署作業指到新版本，再讀部署作業確認', async () => {
  const f = fixture('bbbbbbbbbbbb');
  const g = fakeGoogle('aaaaaaaaaaaa');
  const logs = [];
  assert.equal(await deploy({ ...f, log: (m) => logs.push(m), env: ENV, fetch: g.fetch }), 'deployed');
  assert.deepEqual(steps(g), [
    'POST https://oauth2.googleapis.com/token',
    'GET SCRIPT/deployments/AKfycDEPLOY',
    'GET SCRIPT/content?versionNumber=6',
    'PUT SCRIPT/content',
    'POST SCRIPT/versions',
    'PUT SCRIPT/deployments/AKfycDEPLOY',
    'GET SCRIPT/deployments/AKfycDEPLOY',
    'GET SCRIPT/content?versionNumber=7'
  ]);
  assert.match(g.calls[0].body, /refresh_token=r3/);
  assert.equal(JSON.parse(g.calls[3].body).files.length, 5);
  assert.deepEqual(JSON.parse(g.calls[5].body).deploymentConfig, {
    scriptId: 'SCRIPT', versionNumber: 7, manifestFileName: 'appsscript', description: '自動部署 bbbbbbbbbbbb'
  });
  assert.ok(logs.some((m) => m.includes('✓ 已發布第 7 版')));
  assert.equal(logs.join('\n').includes('TOKEN'), false, '紀錄中不出現授權資訊');
  // 再跑一次：已是最新，不再建立版本
  assert.equal(await deploy({ ...f, ...quiet, env: ENV, fetch: g.fetch }), 'unchanged');
});

test('部署作業沒有換到新版本時失敗', async () => {
  const f = fixture('bbbbbbbbbbbb');
  await assert.rejects(deploy({ ...f, ...quiet, env: ENV, fetch: fakeGoogle('aaaaaaaaaaaa', { ignoreUpdate: true }).fetch }), /部署作業目前是第 6 版/);
});

test('授權失效或沒有開啟 Apps Script API 時，失敗並說明處理方式', async () => {
  const f = fixture('bbbbbbbbbbbb');
  await assert.rejects(deploy({ ...f, ...quiet, env: ENV, fetch: fakeGoogle('a', { badToken: true }).fetch }), /重新執行 clasp login/);
  await assert.rejects(deploy({ ...f, ...quiet, env: ENV, fetch: fakeGoogle('a', { apiOff: true }).fetch }), /usersettings/);
});
