/* 應用程式核心：狀態、操作佇列、外框（班別列、課次列、分頁）、登入 */
(function (App) {
  'use strict';

  App.views = {}; // 分頁：{ label, icon, minRole, order, render() }
  App.actions = {}; // data-action 對應的處理函式 (el, event)

  App.s = {
    backend: null,
    user: null,
    data: AttendStore.emptyState(),
    classId: null,
    tab: 'checkin',
    date: null,
    teamFilter: 'all',
    statusFilter: 'all',
    search: '',
    pending: 0
  };

  // ---------- 角色 ----------
  App.role = function () { return AttendAuth.roleOf(App.s.user); };
  App.isStaff = function () { return AttendAuth.atLeast(App.s.user, 'staff'); };
  App.isOwner = function () { return App.role() === 'owner'; };
  App.can = function (op) { return App.isStaff() && AttendAuth.can(App.s.data, op, App.s.user, App.today()); };

  // ---------- 查詢 ----------
  const memo = { data: null, totals: null };
  App.totals = function () {
    if (memo.data !== App.s.data) {
      memo.data = App.s.data;
      memo.totals = AttendStore.computeTotals(App.s.data);
    }
    return memo.totals;
  };
  App.studentTotals = function (id) { return App.totals()[id] || { honor: 0, balance: 0, sessionIds: [] }; };
  App.classes = function () { return AttendStore.active(App.s.data.classes); };
  App.cls = function () {
    return App.classes().find(function (c) { return c.id === App.s.classId; }) || null;
  };
  App.classById = function (id) { return App.s.data.classes.find(function (c) { return c.id === id; }) || null; };
  App.students = function (classId) {
    return AttendStore.active(App.s.data.students).filter(function (s) { return !classId || s.classId === classId; });
  };
  App.studentById = function (id) { return App.s.data.students.find(function (s) { return s.id === id; }) || null; };
  App.teamName = function (student) {
    const cls = App.classById(student.classId);
    const team = cls && cls.teams.find(function (t) { return t.id === student.teamId; });
    return team ? team.name : '';
  };
  App.session = function () {
    return App.s.classId && App.s.date ? AttendStore.findSession(App.s.data, App.s.classId, App.s.date) : null;
  };
  App.sessionById = function (id) { return App.s.data.sessions.find(function (s) { return s.id === id; }) || null; };
  App.gifts = function () { return AttendStore.active(App.s.data.gifts); };
  App.staffList = function () { return AttendStore.active(App.s.data.staff); };

  /** 榮譽稱號（沿用 v2） */
  App.rank = function (honor) {
    if (honor >= 300) return { title: '👑 智慧小狀元', cls: 'chip-gift' };
    if (honor >= 200) return { title: '🏅 讀經小舉人', cls: 'chip-ok' };
    if (honor >= 100) return { title: '📜 勤學小秀才', cls: 'chip-theme' };
    return { title: '🌱 初學小書僮', cls: '' };
  };

  // ---------- 操作佇列 ----------
  // 加減分類的操作先在畫面上立即生效（樂觀更新），再依序送到後端；
  // 後端回應後以後端資料為準，失敗時退回並提示。
  // 會建立新資料（需要後端給的 id）的操作則等後端回應後才更新畫面。
  const OPTIMISTIC = ['points.checkin', 'points.award', 'points.batch', 'points.redeem'];
  const queue = [];
  let confirmed = null; // 最後一次後端確認的資料
  let sending = false;

  function localApply(state, op) {
    AttendAuth.authorize(state, op, App.s.user, App.today());
    return AttendStore.apply(state, op, { operatorId: App.s.user && App.s.user.id, operatorName: App.s.user && App.s.user.name });
  }

  function replayPending() {
    let state = confirmed || App.s.data;
    queue.forEach(function (item) {
      if (!item.optimistic) return;
      try { state = localApply(state, item.op).state; } catch (e) { /* 已不適用的操作略過，後端會回報 */ }
    });
    App.s.data = state;
  }

  function pump() {
    if (sending || queue.length === 0) return;
    sending = true;
    const item = queue[0];
    function settle() {
      queue.shift();
      sending = false;
      App.s.pending = queue.length;
      if (queue.length === 0 && confirmed) App.s.data = confirmed;
      else replayPending();
      App.render();
    }
    // 先更新畫面資料再通知呼叫端，呼叫端拿到結果時就能看到新資料
    App.s.backend.apply(item.op).then(function (res) {
      confirmed = res.state;
      settle();
      item.resolve(res);
      pump();
    }, function (err) {
      settle();
      item.reject(err);
      App.handleError(err);
      pump();
    });
  }

  /**
   * 執行資料操作。成功時 Promise 帶著後端結果 { result, state } 完成。
   * 失敗時已經顯示提示，Promise 不會完成也不會 reject，呼叫端只要寫成功後要做的事。
   * 回傳的 Promise 有 accepted 屬性：true 表示已通過本機檢查（加減分類操作已經顯示在畫面上）。
   */
  function never() { return new Promise(function () {}); }

  App.run = function (op) {
    const optimistic = OPTIMISTIC.indexOf(op.type) !== -1;
    if (optimistic) {
      try {
        App.s.data = localApply(App.s.data, op).state;
      } catch (e) {
        App.handleError(e);
        const stalled = never();
        stalled.accepted = false;
        return stalled;
      }
    }
    const p = new Promise(function (resolve, reject) {
      queue.push({ op: op, optimistic: optimistic, resolve: resolve, reject: reject });
    }).then(null, never);
    p.accepted = true;
    App.s.pending = queue.length;
    App.render();
    pump();
    return p;
  };

  App.isBusy = function () { return queue.length > 0; };

  /** 以後端資料為準重設畫面資料（初始化、重新整理、匯入後使用） */
  App.loadData = function (state) {
    confirmed = state;
    App.s.data = state;
  };

  App.handleError = function (err) {
    const msg = (err && err.message) || '發生錯誤';
    App.toast('⚠️ ' + msg, 'warn');
    if (err && err.code === 'SESSION_EXPIRED') {
      App.setUser(null);
      App.refresh();
    }
  };

  /** 從後端重新讀取 */
  App.refresh = function (silent) {
    if (App.isBusy()) return Promise.resolve();
    return App.s.backend.getState().then(function (res) {
      if (App.isBusy()) return;
      App.loadData(res.state);
      if (res.sessionExpired) {
        App.setUser(null);
        App.toast('登入已逾時，請重新登入', 'warn');
      } else if ('user' in res) {
        App.s.user = res.user;
      }
      App.render();
      if (!silent) App.toast('已更新為最新資料');
    }, function (err) {
      if (!silent) App.handleError(err);
    });
  };

  App.setUser = function (user) {
    App.s.user = user;
    const view = App.views[App.s.tab];
    if (view && !AttendAuth.atLeast(user, view.minRole || 'viewer')) App.s.tab = 'checkin';
  };

  /** 取得目前班別、日期的課次；沒有就建立（點名前呼叫） */
  App.ensureSession = function () {
    const found = App.session();
    if (found) return Promise.resolve(found.id);
    return App.run({ type: 'session.ensure', classId: App.s.classId, date: App.s.date }).then(function (res) {
      return res.result.id;
    });
  };

  // ---------- 外框 ----------

  function renderHeader() {
    const meta = App.s.data.meta || {};
    App.$('#templeTitle').textContent = meta.templeTitle || '佛堂點名加分系統';
    document.title = meta.templeTitle || '佛堂點名加分系統';
    const year = App.$('#yearLabel');
    year.textContent = meta.yearLabel || '';
    year.hidden = !meta.yearLabel;
    App.$('#soundBtn').textContent = App.prefs.sound ? '🔊' : '🔇';
    const u = App.s.user;
    App.setHtml('#userBtn', u
      ? App.html`${u.role === 'owner' ? '👑' : '🙏'} ${u.name}<span class="label-long">・${u.roleLabel}</span>`
      : App.html`🔒 <span class="label-long">壇務</span>登入`);
    const banner = [];
    if (!u) banner.push('👀 訪客模式：只能查看，學員名字已遮蔽。服務人員請點右上角登入');
    if (App.s.backend.mode === 'local') banner.push('💻 單機版：資料只存在這台電腦的瀏覽器');
    App.$('#modeBanner').textContent = banner.join('　');
    App.$('#syncStatus').textContent = App.s.pending ? '⏳ 同步中（' + App.s.pending + '）…' : '';
  }

  function renderClassBar() {
    const classes = App.classes();
    App.setHtml('#classBar', classes.map(function (c) {
      const count = App.students(c.id).length;
      return App.html`
        <button type="button" class="class-chip ${c.id === App.s.classId ? 'active' : ''}" data-action="switch-class" data-id="${c.id}" data-theme="${c.themeColor}">
          <span>${c.icon || '📚'}</span>
          <span>${c.name}<br><small>${count} 位學員</small></span>
        </button>`;
    }));
  }

  function renderSessionBar() {
    const cls = App.cls();
    const bar = App.$('#sessionBar');
    bar.hidden = !cls;
    if (!cls) return;
    const session = App.session();
    const regular = cls.schedule && cls.schedule.length ? App.scheduleText(cls) : '';
    const next = AttendStore.upcomingDates(cls, App.today(), 1)[0];
    const offDay = !session && regular && !AttendStore.scheduleSlotFor(cls, App.s.date);
    App.setHtml(bar, App.html`
      <label class="faint" for="dateInput">上課日期</label>
      <input id="dateInput" class="input" type="date" value="${App.s.date}" data-change="set-date" />
      <div class="session-info">
        ${session
          ? App.html`<b>${App.dateLabel(session.date)}</b> ${App.timeRange(session)} ${session.topic ? App.html`・${session.topic}` : ''}`
          : App.html`<span class="faint">${offDay ? '這天不是常態上課日；' : '這天還沒有課次，'}點名時會自動建立</span>`}
        ${regular ? App.html`<div class="faint">常態：${regular}${next ? App.html`・下次上課 ${App.dateLabel(next)}` : ''}</div>` : ''}
      </div>
      ${App.isStaff() ? App.html`<button type="button" class="btn btn-sm" data-action="edit-session">🗓️ ${session ? '編輯課次' : '建立課次'}</button>` : ''}`);
  }

  function renderTabs() {
    const tabs = Object.keys(App.views)
      .map(function (k) { return Object.assign({ key: k }, App.views[k]); })
      .filter(function (v) { return AttendAuth.atLeast(App.s.user, v.minRole || 'viewer'); })
      .sort(function (a, b) { return a.order - b.order; });
    App.setHtml('#tabBar', tabs.map(function (t) {
      const label = typeof t.label === 'function' ? t.label() : t.label;
      return App.html`<button type="button" class="tab ${t.key === App.s.tab ? 'active' : ''}" data-action="switch-tab" data-tab="${t.key}">${t.icon} ${label}</button>`;
    }));
  }

  function renderEmpty() {
    App.setHtml('#view', App.html`
      <div class="card empty">
        <span class="big">🪷</span>
        <p>目前還沒有任何班別。</p>
        ${App.isStaff()
          ? App.html`<div class="btn-row" style="justify-content:center">
              <button type="button" class="btn btn-primary" data-action="new-class">＋ 建立第一個班別</button>
              ${App.isOwner() && App.s.backend.mode === 'local' ? App.html`<button type="button" class="btn" data-action="load-sample">載入範例資料</button>` : ''}
            </div>`
          : App.html`<p class="faint">請服務人員登入後建立班別。</p>`}
      </div>`);
  }

  App.render = function () {
    const classes = App.classes();
    if (!classes.some(function (c) { return c.id === App.s.classId; })) {
      App.s.classId = classes.length ? classes[0].id : null;
    }
    const cls = App.cls();
    document.body.setAttribute('data-theme', cls ? cls.themeColor : 'amber');
    renderHeader();
    renderClassBar();
    renderSessionBar();
    renderTabs();
    const view = App.views[App.s.tab];
    const needsClass = !view || view.needsClass !== false;
    if (!cls && needsClass) renderEmpty();
    else App.setHtml('#view', view.render());
    App.refreshModals();
  };

  // ---------- 事件委派 ----------
  // <button data-action="名稱"> 點擊時呼叫 App.actions[名稱](el, event)
  // <input data-change="名稱"> 變更時呼叫 App.actions[名稱](el, event)
  // <input data-input="名稱"> 輸入時呼叫 App.actions[名稱](el, event)
  function dispatch(attr) {
    return function (e) {
      const el = e.target.closest('[' + attr + ']');
      if (!el || el.disabled) return;
      const fn = App.actions[el.getAttribute(attr)];
      if (fn) {
        if (attr === 'data-action') e.preventDefault();
        fn(el, e);
      }
    };
  }
  document.addEventListener('click', dispatch('data-action'));
  document.addEventListener('change', dispatch('data-change'));
  document.addEventListener('input', dispatch('data-input'));

  Object.assign(App.actions, {
    'switch-class': function (el) {
      App.s.classId = el.dataset.id;
      App.s.teamFilter = 'all';
      App.render();
    },
    'switch-tab': function (el) {
      App.s.tab = el.dataset.tab;
      App.render();
    },
    'set-date': function (el) {
      if (!el.value) return;
      App.s.date = el.value;
      App.render();
    },
    'toggle-sound': function () {
      App.prefs.sound = !App.prefs.sound;
      App.savePrefs();
      App.render();
      App.toast(App.prefs.sound ? '🔊 音效開啟' : '🔇 已靜音');
    },
    refresh: function () { App.refresh(); },
    'open-login': function () {
      if (App.s.user) openUserMenu();
      else openLogin();
    }
  });

  // ---------- 登入 ----------

  function openLogin() {
    App.s.backend.loginOptions().then(function (opts) {
      if (opts.needsOwnerSetup) return openOwnerSetup();
      App.modal({
        title: '壇務登入',
        body: App.html`
          <form class="stack" data-login>
            <div class="field">
              <label for="loginUser">帳號</label>
              <select id="loginUser" class="select" name="userId">
                ${opts.users.map(function (u) { return App.html`<option value="${u.id}">${u.name}（${u.roleLabel}）</option>`; })}
              </select>
            </div>
            <div class="field">
              <label for="loginPin">PIN 碼</label>
              <input id="loginPin" class="input" name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" autofocus />
            </div>
            <button type="submit" class="btn btn-primary btn-block">登入</button>
          </form>`,
        onMount: function (el, close) {
          el.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            const f = App.formData(el);
            App.s.backend.login(f.userId, f.pin).then(function (user) {
              close();
              App.setUser(user);
              App.toast(`🙏 ${user.name}，歡迎登入（${user.roleLabel}）`, 'ok');
              App.refresh(true);
            }, App.handleError);
          });
        }
      });
    }, App.handleError);
  }

  function openOwnerSetup() {
    App.modal({
      title: '首次使用：設定擁有者',
      body: App.html`
        <p class="muted" style="margin:0">這是單機版第一次使用。請設定擁有者名稱與 PIN 碼，之後可以在「擁有者」分頁建立壇務帳號。</p>
        <form class="stack" data-setup>
          <div class="field"><label>擁有者名稱</label><input class="input" name="name" value="擁有者" maxlength="20" /></div>
          <div class="field"><label>PIN 碼（4–8 位數字）</label><input class="input" name="pin" type="password" inputmode="numeric" maxlength="8" autofocus /></div>
          <div class="field"><label>再輸入一次</label><input class="input" name="pin2" type="password" inputmode="numeric" maxlength="8" /></div>
          <button type="submit" class="btn btn-primary btn-block">完成設定並登入</button>
        </form>`,
      onMount: function (el, close) {
        el.querySelector('form').addEventListener('submit', function (e) {
          e.preventDefault();
          const f = App.formData(el);
          if (f.pin !== f.pin2) return App.toast('⚠️ 兩次輸入的 PIN 不一樣', 'warn');
          App.s.backend.setupOwner(f.name, f.pin).then(function (user) {
            close();
            App.setUser(user);
            App.toast('👑 設定完成，已登入為擁有者', 'ok');
            App.refresh(true);
          }, App.handleError);
        });
      }
    });
  }

  function openUserMenu() {
    const u = App.s.user;
    App.modal({
      title: u.name + '（' + u.roleLabel + '）',
      body: App.html`
        <div class="stack">
          ${u.builtin && App.s.backend.mode === 'gas'
            ? App.html`<p class="faint" style="margin:0">擁有者主帳號的 PIN 請在 Apps Script 的「指令碼屬性」OWNER_PIN 修改。</p>`
            : App.html`<button type="button" class="btn" data-action="change-my-pin">🔑 修改我的 PIN</button>`}
          <button type="button" class="btn btn-danger" data-action="logout">登出</button>
        </div>`
    });
  }

  App.actions.logout = function () {
    App.closeTopModal();
    App.s.backend.logout().then(function () {
      App.setUser(null);
      App.toast('已登出，回到訪客模式');
      App.refresh(true);
    });
  };

  App.actions['change-my-pin'] = function () {
    App.closeTopModal();
    App.modal({
      title: '修改我的 PIN',
      body: App.html`
        <form class="stack">
          <div class="field"><label>目前的 PIN</label><input class="input" name="oldPin" type="password" inputmode="numeric" maxlength="8" autofocus /></div>
          <div class="field"><label>新的 PIN（4–8 位數字）</label><input class="input" name="newPin" type="password" inputmode="numeric" maxlength="8" /></div>
          <div class="field"><label>再輸入一次</label><input class="input" name="newPin2" type="password" inputmode="numeric" maxlength="8" /></div>
          <button type="submit" class="btn btn-primary btn-block">儲存</button>
        </form>`,
      onMount: function (el, close) {
        el.querySelector('form').addEventListener('submit', function (e) {
          e.preventDefault();
          const f = App.formData(el);
          if (f.newPin !== f.newPin2) return App.toast('⚠️ 兩次輸入的新 PIN 不一樣', 'warn');
          App.s.backend.userOp({ type: 'self.changePin', oldPin: f.oldPin, newPin: f.newPin }).then(function () {
            close();
            App.toast('🔑 PIN 已更新', 'ok');
          }, App.handleError);
        });
      }
    });
  };
})(window.App = window.App || {});
