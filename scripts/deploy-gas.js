#!/usr/bin/env node
/*
 * 自動更新 Google Apps Script 後台（GitHub Actions 在 npm run build 之後執行）。
 *
 * 需要三個環境變數（GitHub 的 Settings → Secrets and variables → Actions）：
 *   CLASPRC_JSON       電腦上 clasp login 產生的 ~/.clasprc.json 全部內容（clasp 2.x、3.x 格式都可以）
 *   GAS_SCRIPT_ID      Apps Script「專案設定」的指令碼 ID
 *   GAS_DEPLOYMENT_ID  現有網頁應用程式部署作業的 ID（AKfyc 開頭），更新後網址不變
 * 沒有設定時直接略過（照舊手動更新後台）。
 *
 * 流程：開啟後台網址比對版本指紋，相同就不動（Apps Script 每個專案最多 200 個版本，
 * 只在後台程式真的改變時才建立新版本）；不同時以 Apps Script API 上傳 dist/gas/、
 * 建立新版本、把現有部署作業指到新版本，最後再開一次網址確認。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 後台檔案的載入順序（Code.js 用到前面三個）
const ORDER = ['store.js', 'auth.js', 'migrate-v2.js', 'Code.js'];
const API = 'https://script.googleapis.com/v1/projects/';

/** 從 .clasprc.json 取出 OAuth 用戶端與 refresh token（clasp 3.x 為 tokens.default，2.x 為 token＋oauth2ClientSettings） */
function credentials(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error('CLASPRC_JSON 不是正確的 JSON，請把 .clasprc.json 的全部內容貼進 Secret');
  }
  let c = null;
  if (j && j.tokens) {
    const t = j.tokens.default || Object.values(j.tokens)[0] || {};
    c = { clientId: t.client_id, clientSecret: t.client_secret, refreshToken: t.refresh_token };
  } else if (j && j.token && j.oauth2ClientSettings) {
    c = { clientId: j.oauth2ClientSettings.clientId, clientSecret: j.oauth2ClientSettings.clientSecret, refreshToken: j.token.refresh_token };
  }
  if (!c || !c.clientId || !c.clientSecret || !c.refreshToken) {
    throw new Error('無法辨識 CLASPRC_JSON 的格式，請在電腦上重新執行 clasp login 後再貼一次');
  }
  return c;
}

/** dist/gas/ 的檔案轉成 Apps Script API 的格式 */
function projectFiles(gasDir) {
  const files = [{ name: 'appsscript', type: 'JSON', source: fs.readFileSync(path.join(gasDir, 'appsscript.json'), 'utf8') }];
  ORDER.forEach((f) => {
    files.push({ name: f.replace(/\.js$/, ''), type: 'SERVER_JS', source: fs.readFileSync(path.join(gasDir, f), 'utf8') });
  });
  return files;
}

function builtVersion(gasDir) {
  const m = fs.readFileSync(path.join(gasDir, 'Code.js'), 'utf8').match(/const BACKEND_VERSION = '([0-9a-f]+)'/);
  if (!m) throw new Error('dist/gas/Code.js 沒有版本指紋，請先執行 npm run build');
  return m[1];
}

function gasUrl(configFile) {
  const m = fs.readFileSync(configFile, 'utf8').match(/GAS_URL:\s*'([^']*)'/);
  return m ? m[1] : '';
}

/** 開啟後台網址（doGet）讀出目前的版本指紋；讀不到時回傳 null */
async function liveVersion(url, fetch) {
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const m = (await res.text()).match(/版本 ([0-9a-f]{12})/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

async function call(fetch, method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error.message; } catch (e) { /* 保留原文 */ }
    if (/Apps Script API/.test(msg)) msg += '（請到 https://script.google.com/home/usersettings 開啟「Google Apps Script API」）';
    throw new Error(`${method} ${url.replace(API, '')} 失敗（${res.status}）：${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * 回傳 'skipped'（沒有設定）、'unchanged'（後台已是最新）或 'deployed'。
 * opts: { env, fetch, gasDir, configFile, log, wait }
 */
async function deploy(opts) {
  const env = opts.env;
  const fetch = opts.fetch;
  const log = opts.log || console.log;
  const wait = opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const missing = ['CLASPRC_JSON', 'GAS_SCRIPT_ID', 'GAS_DEPLOYMENT_ID'].filter((k) => !env[k]);
  if (missing.length) {
    log(`略過自動更新後台：沒有設定 ${missing.join('、')}（請手動更新 Apps Script，見 docs/deploy-gas.md）`);
    return 'skipped';
  }
  const scriptId = env.GAS_SCRIPT_ID.trim();
  const deploymentId = env.GAS_DEPLOYMENT_ID.trim();
  const version = builtVersion(opts.gasDir);
  const url = gasUrl(opts.configFile);
  const live = await liveVersion(url, fetch);
  if (live === version) {
    log(`後台已是最新版本（${version}），不需要更新`);
    return 'unchanged';
  }
  log(`更新後台：${live || '（讀不到目前版本）'} → ${version}`);

  const c = credentials(env.CLASPRC_JSON);
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' }).toString()
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(`Google 授權失敗（${tokenRes.status}：${tokenJson.error || '未知'}），請在電腦上重新執行 clasp login，並更新 CLASPRC_JSON`);
  }
  const token = tokenJson.access_token;

  await call(fetch, 'PUT', API + scriptId + '/content', token, { files: projectFiles(opts.gasDir) });
  const ver = await call(fetch, 'POST', API + scriptId + '/versions', token, { description: '自動部署 ' + version });
  await call(fetch, 'PUT', API + scriptId + '/deployments/' + deploymentId, token, {
    deploymentConfig: { scriptId, versionNumber: ver.versionNumber, manifestFileName: 'appsscript', description: '自動部署 ' + version }
  });
  log(`已上傳並發布第 ${ver.versionNumber} 版`);

  // 確認網址已經換成新版本（Google 偶爾要幾秒才生效）
  for (let i = 0; url && i < 5; i++) {
    if (await liveVersion(url, fetch) === version) {
      log(`✓ 後台網址已是新版本（${version}）`);
      return 'deployed';
    }
    await wait(3000);
  }
  if (url) log(`⚠️ 已發布，但後台網址還沒回報新版本（${version}），請稍後開啟網頁確認`);
  return 'deployed';
}

module.exports = { credentials, projectFiles, deploy };

if (require.main === module) {
  deploy({
    env: process.env,
    fetch: globalThis.fetch,
    gasDir: path.join(ROOT, 'dist', 'gas'),
    configFile: path.join(ROOT, 'src', 'config.js')
  }).catch((e) => {
    console.error('✗ 自動更新後台失敗：' + e.message);
    process.exit(1);
  });
}
