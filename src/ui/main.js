/* 啟動：選擇後端、讀取資料、定時同步 */
(function (App) {
  'use strict';

  const POLL_MS = 30000;

  function start() {
    App.loadPrefs();
    App.s.backend = App.createBackend();
    App.s.date = App.today();
    App.render();
    App.$('#syncStatus').textContent = '讀取資料中…';

    App.loadLogo();
    App.s.backend.init().then(function (res) {
      App.loadData(res.state);
      App.s.user = res.user || null;
      App.render();
      if (res.notice) App.toast(res.notice, 'ok');
      if (res.sessionExpired) App.toast('登入已逾時，請重新登入', 'warn');
    }, function (err) {
      App.handleError(err);
      App.$('#syncStatus').textContent = '⚠️ 讀取失敗，請重新整理頁面';
    });

    // 雲端版：定時取得其他服務人員的變更（畫面在背景、有操作進行中或對話框開啟時暫停）
    if (App.s.backend.mode === 'gas') {
      setInterval(function () {
        if (document.hidden || App.isBusy() || App.hasModal()) return;
        App.refresh(true);
      }, POLL_MS);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && !App.isBusy()) App.refresh(true);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window.App = window.App || {});
