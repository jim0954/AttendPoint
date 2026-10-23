/*
 * 後端介接：同一套介面，兩種實作
 *   GasBackend   部署在 Google Apps Script 時，呼叫 Code.js 的 api* 函式
 *   LocalBackend 單機版，資料存在這台電腦的瀏覽器（localStorage），規則與雲端版完全相同
 *
 * 所有方法都回傳 Promise；失敗時 reject BackendError { code, message }。
 */
(function (App) {
  'use strict';

  function BackendError(code, message) {
    this.code = code;
    this.message = message;
  }
  App.BackendError = BackendError;

  function wrapError(e) {
    if (e instanceof BackendError) return e;
    if (e && e.code) return new BackendError(e.code, e.message);
    console.error(e);
    return new BackendError('CLIENT_ERROR', '發生錯誤：' + (e && e.message ? e.message : e));
  }

  // ---------- Google Apps Script ----------

  function GasBackend() {
    this.mode = 'gas';
    this.token = null;
    try { this.token = localStorage.getItem('attendpoint_token'); } catch (e) {}
  }

  GasBackend.prototype.call = function (name) {
    const args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      google.script.run
        .withSuccessHandler(function (res) {
          if (res && res.ok) resolve(res);
          else reject(new BackendError(res ? res.code : 'SERVER_ERROR', res ? res.message : '伺服器沒有回應'));
        })
        .withFailureHandler(function () {
          reject(new BackendError('NETWORK', '連線失敗，請檢查網路後再試'));
        })[name].apply(null, args);
    });
  };

  GasBackend.prototype.setToken = function (token) {
    this.token = token;
    try {
      if (token) localStorage.setItem('attendpoint_token', token);
      else localStorage.removeItem('attendpoint_token');
    } catch (e) {}
  };

  GasBackend.prototype.init = function () { return this.getState(); };
  GasBackend.prototype.getState = function () {
    const self = this;
    return this.call('apiGetState', this.token).then(function (res) {
      if (res.sessionExpired) self.setToken(null);
      return res;
    });
  };
  GasBackend.prototype.loginOptions = function () {
    return this.call('apiLoginOptions').then(function (res) { return { users: res.users, needsOwnerSetup: false }; });
  };
  GasBackend.prototype.login = function (userId, pin) {
    const self = this;
    return this.call('apiLogin', userId, pin).then(function (res) {
      self.setToken(res.token);
      return res.user;
    });
  };
  GasBackend.prototype.logout = function () {
    const token = this.token;
    this.setToken(null);
    return this.call('apiLogout', token).catch(function () {});
  };
  GasBackend.prototype.apply = function (op) { return this.call('apiApply', this.token, op); };
  GasBackend.prototype.listUsers = function () { return this.call('apiListUsers', this.token); };
  GasBackend.prototype.userOp = function (op) { return this.call('apiUserOp', this.token, op); };
  GasBackend.prototype.exportBackup = function () {
    return this.call('apiExportBackup', this.token).then(function (res) { return res.json; });
  };
  GasBackend.prototype.importState = function (raw) { return this.call('apiImportState', this.token, raw); };
  GasBackend.prototype.rebuildReports = function () { return this.call('apiRebuildReports', this.token); };

  // ---------- 單機版（瀏覽器 localStorage） ----------

  const KEYS = {
    data: 'attendpoint_v3',
    users: 'attendpoint_v3_users',
    owner: 'attendpoint_v3_owner',
    backup: 'attendpoint_v3_backup',
    session: 'attendpoint_v3_session'
  };
  const OWNER_ID = 'U-owner';
  const MAX_FAILS = 5;

  function LocalBackend() {
    this.mode = 'local';
    this.fails = {};
    this.lockedUntil = {};
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      throw new BackendError('STORAGE_FULL', '瀏覽器儲存空間不足，請先下載備份後再進行跨年度結算');
    }
  }

  function randomId() {
    if (window.crypto && crypto.getRandomValues) {
      const a = new Uint32Array(2);
      crypto.getRandomValues(a);
      return a[0].toString(36) + a[1].toString(36);
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  LocalBackend.prototype.owner = function () { return readJson(KEYS.owner, null); };

  LocalBackend.prototype.findUser = function (userId) {
    if (userId === OWNER_ID) {
      const o = this.owner();
      return o ? { id: OWNER_ID, name: o.name, role: 'owner', builtin: true, salt: o.salt, pinHash: o.pinHash } : null;
    }
    return readJson(KEYS.users, []).find(function (u) { return u.id === userId; }) || null;
  };

  LocalBackend.prototype.currentUser = function () {
    let id = null;
    try { id = sessionStorage.getItem(KEYS.session); } catch (e) {}
    const u = id ? this.findUser(id) : null;
    return u && !u.disabled ? AttendAuth.publicUser(u) : null;
  };

  LocalBackend.prototype.requireUser = function () {
    const u = this.currentUser();
    if (!u) throw new BackendError('FORBIDDEN', '請先登入壇務帳號');
    return u;
  };

  LocalBackend.prototype.requireOwner = function () {
    const u = this.requireUser();
    if (u.role !== 'owner') throw new BackendError('FORBIDDEN', '此功能僅限擁有者操作');
    return u;
  };

  LocalBackend.prototype.readState = function () {
    const data = readJson(KEYS.data, null);
    return data ? AttendStore.upgrade(data) : AttendStore.emptyState();
  };

  LocalBackend.prototype.run = function (fn) {
    const self = this;
    return new Promise(function (resolve, reject) {
      try { resolve(fn.call(self)); } catch (e) { reject(wrapError(e)); }
    });
  };

  LocalBackend.prototype.init = function () {
    return this.run(function () {
      let notice = null;
      if (!localStorage.getItem(KEYS.data)) {
        const v2raw = localStorage.getItem(AttendMigrate.V2_STORAGE_KEY);
        if (v2raw) {
          const r = AttendMigrate.loadAny(v2raw);
          writeJson(KEYS.data, r.state);
          notice = `已自動匯入舊版（v2）資料：${r.report.students} 位學員、${r.report.logs} 筆紀錄。舊資料仍保留在瀏覽器中。`;
        }
      }
      const user = this.currentUser();
      return { state: AttendAuth.viewFor(this.readState(), user), user: user, notice: notice };
    });
  };

  LocalBackend.prototype.getState = function () {
    return this.run(function () {
      const user = this.currentUser();
      return { state: AttendAuth.viewFor(this.readState(), user), user: user };
    });
  };

  LocalBackend.prototype.loginOptions = function () {
    return this.run(function () {
      const o = this.owner();
      const users = (o ? [{ id: OWNER_ID, name: o.name, role: 'owner' }] : [])
        .concat(readJson(KEYS.users, []).filter(function (u) { return !u.disabled; }))
        .map(function (u) { return { id: u.id, name: u.name, roleLabel: AttendAuth.ROLE_LABELS[u.role] }; });
      return { users: users, needsOwnerSetup: !o };
    });
  };

  /** 單機版第一次使用：設定擁有者名稱與 PIN */
  LocalBackend.prototype.setupOwner = function (name, pin) {
    return this.run(function () {
      if (this.owner()) throw new BackendError('INVALID_INPUT', '已經設定過擁有者');
      const clean = String(name || '').trim() || '擁有者';
      const salt = randomId();
      writeJson(KEYS.owner, { name: clean, salt: salt, pinHash: AttendAuth.hashPin(AttendAuth.validatePin(pin), salt, App.sha256Hex) });
      sessionStorage.setItem(KEYS.session, OWNER_ID);
      return this.currentUser();
    });
  };

  LocalBackend.prototype.login = function (userId, pin) {
    return this.run(function () {
      if ((this.lockedUntil[userId] || 0) > Date.now()) throw new BackendError('LOCKED', '嘗試次數過多，請 15 分鐘後再試');
      const u = this.findUser(userId);
      if (!u || u.disabled || !AttendAuth.verifyPin(u, pin, App.sha256Hex)) {
        this.fails[userId] = (this.fails[userId] || 0) + 1;
        const left = MAX_FAILS - this.fails[userId];
        if (left <= 0) {
          this.lockedUntil[userId] = Date.now() + 15 * 60 * 1000;
          this.fails[userId] = 0;
          throw new BackendError('LOCKED', '嘗試次數過多，請 15 分鐘後再試');
        }
        throw new BackendError('WRONG_PIN', `帳號或 PIN 碼不正確（還可以再試 ${left} 次）`);
      }
      this.fails[userId] = 0;
      sessionStorage.setItem(KEYS.session, u.id);
      return AttendAuth.publicUser(u);
    });
  };

  LocalBackend.prototype.logout = function () {
    return this.run(function () { sessionStorage.removeItem(KEYS.session); });
  };

  LocalBackend.prototype.apply = function (op) {
    return this.run(function () {
      const user = this.requireUser();
      const state = this.readState();
      AttendAuth.authorize(state, op, user, App.today());
      let backup = null;
      if (op.type === 'year.reset') {
        writeJson(KEYS.backup, state);
        backup = '瀏覽器備份（' + App.today() + '）';
      }
      const r = AttendStore.apply(state, op, { operatorId: user.id, operatorName: user.name });
      writeJson(KEYS.data, r.state);
      return { result: r.result, backup: backup, state: AttendAuth.viewFor(r.state, user) };
    });
  };

  LocalBackend.prototype.allUsers = function () {
    const o = this.findUser(OWNER_ID);
    return (o ? [o] : []).concat(readJson(KEYS.users, [])).map(AttendAuth.publicUser);
  };

  LocalBackend.prototype.listUsers = function () {
    return this.run(function () {
      this.requireOwner();
      return { users: this.allUsers() };
    });
  };

  LocalBackend.prototype.userOp = function (op) {
    return this.run(function () {
      const user = this.requireUser();
      if (op && op.id === OWNER_ID) throw new BackendError('FORBIDDEN', '擁有者主帳號請在「系統」中修改');
      let r;
      if (op.type === 'self.changePin' && user.id === OWNER_ID) {
        // 單機版的擁有者主帳號可以直接在網頁改 PIN
        const o = this.owner();
        if (!AttendAuth.verifyPin(o, op.oldPin, App.sha256Hex)) throw new BackendError('WRONG_PIN', '原本的 PIN 碼不正確');
        o.salt = randomId();
        o.pinHash = AttendAuth.hashPin(AttendAuth.validatePin(op.newPin), o.salt, App.sha256Hex);
        writeJson(KEYS.owner, o);
        return { result: {}, users: null };
      }
      r = AttendAuth.applyUserOp(readJson(KEYS.users, []), op, user, {
        sha256Hex: App.sha256Hex,
        newSalt: randomId,
        newId: function (p) { return p + '-' + randomId().slice(0, 8); },
        now: function () { return AttendStore.localIso(new Date()); }
      });
      writeJson(KEYS.users, r.users);
      return { result: r.result, users: user.role === 'owner' ? this.allUsers() : null };
    });
  };

  LocalBackend.prototype.exportBackup = function () {
    return this.run(function () {
      this.requireOwner();
      return JSON.stringify(this.readState());
    });
  };

  LocalBackend.prototype.importState = function (raw) {
    return this.run(function () {
      this.requireOwner();
      const loaded = AttendMigrate.loadAny(raw);
      writeJson(KEYS.backup, this.readState());
      writeJson(KEYS.data, loaded.state);
      return { migratedFrom: loaded.migratedFrom, report: loaded.report, backup: '瀏覽器備份', state: loaded.state };
    });
  };

  LocalBackend.prototype.rebuildReports = function () {
    return Promise.reject(new BackendError('UNSUPPORTED', '單機版沒有試算表報表，請改用「匯出 CSV」'));
  };

  App.createBackend = function () {
    const inGas = typeof google !== 'undefined' && google.script && google.script.run;
    return inGas ? new GasBackend() : new LocalBackend();
  };
})(window.App = window.App || {});
