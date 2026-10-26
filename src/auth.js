/*
 * AttendPoint 權限規則
 *
 * 三種角色：
 *   viewer 訪客（未登入）：只能看，名字會遮蔽
 *   staff  壇務：點名、加減分、兌換、新增與編輯資料；不能刪除
 *   owner  擁有者：全部功能，包含刪除、還原、手動校正、跨年度結算、帳號管理
 *
 * 純邏輯，不碰 GAS 服務；雜湊函式由呼叫端注入，方便在 Node 測試。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AttendAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROLES = ['viewer', 'staff', 'owner'];
  const ROLE_LABELS = { viewer: '訪客', staff: '壇務', owner: '擁有者' };

  // 僅限擁有者的資料操作；其餘 store 操作壇務都可以使用
  const OWNER_ONLY = [
    'class.delete', 'class.restore',
    'session.delete',
    'staff.delete', 'staff.restore',
    'student.delete', 'student.restore',
    'gift.delete', 'gift.restore',
    'points.adjust',
    'meta.update',
    'year.reset'
  ];

  const PIN_RE = /^\d{4,8}$/;
  const HASH_ROUNDS = 500;

  class AuthError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'AuthError';
      this.code = code;
    }
  }

  function forbid(message) {
    throw new AuthError('FORBIDDEN', message);
  }

  function roleOf(user) {
    return user && ROLES.indexOf(user.role) > 0 ? user.role : 'viewer';
  }

  function atLeast(user, role) {
    return ROLES.indexOf(roleOf(user)) >= ROLES.indexOf(role);
  }

  /**
   * 檢查使用者能否執行某個資料操作，不行就丟出 AuthError(FORBIDDEN)。
   * 需要 state 是因為撤銷與班別修改要看資料內容才能判斷。
   */
  function authorize(state, op, user, today) {
    const role = roleOf(user);
    if (role === 'viewer') forbid('請先登入壇務帳號');
    if (role === 'owner') return;

    if (OWNER_ONLY.indexOf(op.type) !== -1) forbid('刪除、還原、校正與系統設定僅限擁有者操作');

    // 壇務只能撤銷自己今天的紀錄
    if (op.type === 'log.reverse') {
      const log = state.logs.find(function (l) { return l.id === op.logId; });
      if (!log) return; // 交給 store 回報找不到
      if (log.operatorId !== user.id || String(log.at).slice(0, 10) !== today) {
        forbid('壇務只能撤銷自己今天的紀錄，其他紀錄請洽擁有者');
      }
    }

    // 壇務修改班別時不可移除既有的小隊或規則（等同刪除）
    if (op.type === 'class.update' && op.patch) {
      const cls = state.classes.find(function (c) { return c.id === op.id; });
      if (!cls) return;
      [['teams', '小隊'], ['addRules', '加分規則'], ['deductRules', '扣分規則']].forEach(function (pair) {
        const key = pair[0];
        if (!(key in op.patch)) return;
        const kept = new Set((op.patch[key] || []).map(function (x) { return x && x.id; }));
        const removed = cls[key].some(function (x) { return !kept.has(x.id); });
        if (removed) forbid(`移除${pair[1]}僅限擁有者操作`);
      });
    }
  }

  /** 是否可以執行（不丟錯），給介面決定按鈕要不要顯示 */
  function can(state, op, user, today) {
    try {
      authorize(state, op, user, today);
      return true;
    } catch (e) {
      if (e instanceof AuthError) return false;
      throw e;
    }
  }

  // ---------- 給訪客看的資料 ----------

  /** 王小明 → 王○明；陳宇 → 陳○；英文名保留第一個字母 */
  function maskName(name) {
    const chars = Array.from(String(name || ''));
    if (chars.length <= 1) return chars.join('');
    if (chars.length === 2) return chars[0] + '○';
    return chars[0] + '○'.repeat(chars.length - 2) + chars[chars.length - 1];
  }

  /**
   * 依角色回傳可以看的資料。
   * 壇務、擁有者看完整資料；訪客看不到回收區、備註、操作者，學員名字遮蔽。
   */
  function viewFor(state, user) {
    if (atLeast(user, 'staff')) return state;
    const live = function (list) { return list.filter(function (x) { return !x.deletedAt; }); };
    const studentIds = new Set(live(state.students).map(function (s) { return s.id; }));
    return {
      schemaVersion: state.schemaVersion,
      meta: state.meta,
      classes: live(state.classes),
      sessions: live(state.sessions),
      staff: live(state.staff).map(function (p) {
        return { id: p.id, name: p.name, role: p.role, classIds: p.classIds };
      }),
      students: live(state.students).map(function (s) {
        return { id: s.id, classId: s.classId, teamId: s.teamId, name: maskName(s.name) };
      }),
      gifts: live(state.gifts),
      logs: state.logs
        .filter(function (l) { return studentIds.has(l.studentId); })
        .map(function (l) {
          return {
            id: l.id, at: l.at, type: l.type, classId: l.classId, studentId: l.studentId,
            sessionId: l.sessionId, reversesId: l.reversesId, reason: l.reason,
            honorDelta: l.honorDelta, balanceDelta: l.balanceDelta
          };
        })
    };
  }

  // ---------- 增量同步 ----------
  // 雲端版每次操作都傳整份資料太慢（一年可達數 MB），改成只傳變動：
  //   前端送出手上的版本 since = { view, syncId, rev, logCount }
  //   後端回傳 { view, unchanged: true }：資料沒變
  //            { view, delta }：流水帳只新增，delta 含 logsFrom 之後的新紀錄與其他（較小的）資料表
  //            { view, state }：版本對不上，整份重傳
  // 流水帳以外的資料表都不大，每次整份附上，避免逐筆比對出錯。

  function viewKind(user) {
    return atLeast(user, 'staff') ? 'full' : 'guest';
  }

  function syncInfo(state) {
    return { syncId: state.meta.syncId || '', rev: state.meta.rev || 0 };
  }

  function sameVersion(state, since, kind) {
    return !!since && since.view === kind && !!since.syncId &&
      since.syncId === state.meta.syncId && since.rev === state.meta.rev;
  }

  function syncView(state, user, since) {
    const kind = viewKind(user);
    if (sameVersion(state, since, kind)) return { view: kind, unchanged: true };
    const view = viewFor(state, user);
    const usable = !!since && since.view === kind && !!since.syncId && since.syncId === state.meta.syncId &&
      since.rev < state.meta.rev && since.logCount >= 0 && since.logCount <= view.logs.length;
    if (!usable) return { view: kind, state: view };
    const delta = {};
    Object.keys(view).forEach(function (k) { if (k !== 'logs') delta[k] = view[k]; });
    delta.logsFrom = since.logCount;
    delta.logs = view.logs.slice(since.logCount);
    return { view: kind, delta: delta };
  }

  /** 前端：送給後端的 since（base 為上次後端確認的資料） */
  function sinceOf(base, kind) {
    if (!base || !base.meta) return null;
    return { view: kind, syncId: base.meta.syncId || '', rev: base.meta.rev || 0, logCount: base.logs.length };
  }

  /** 前端：把 syncView 的回應合併到 base，回傳完整資料（不修改 base） */
  function mergeView(base, res) {
    if (res.state) return res.state;
    if (res.unchanged) return base;
    const d = res.delta;
    if (!base || base.logs.length !== d.logsFrom) throw new AuthError('SYNC_MISMATCH', '資料同步失敗，請重新整理頁面');
    const out = {};
    Object.keys(d).forEach(function (k) { if (k !== 'logsFrom') out[k] = d[k]; });
    out.logs = base.logs.concat(d.logs);
    return out;
  }

  // ---------- 帳號 ----------

  function validatePin(pin) {
    if (!PIN_RE.test(String(pin || ''))) throw new AuthError('INVALID_PIN', 'PIN 碼需為 4–8 位數字');
    return String(pin);
  }

  function hashPin(pin, salt, sha256Hex) {
    let h = salt + ':' + pin;
    for (let i = 0; i < HASH_ROUNDS; i++) h = sha256Hex(h + ':' + salt);
    return h;
  }

  function verifyPin(user, pin, sha256Hex) {
    if (!user || !user.pinHash || !user.salt) return false;
    const h = hashPin(String(pin || ''), user.salt, sha256Hex);
    // 長度固定，逐字比對避免提早結束
    let diff = h.length ^ user.pinHash.length;
    for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ (user.pinHash.charCodeAt(i) || 0);
    return diff === 0;
  }

  /** 移除雜湊資訊後的帳號資料，可以傳給前端 */
  function publicUser(u) {
    return { id: u.id, name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role], staffId: u.staffId || null, disabled: !!u.disabled, builtin: !!u.builtin };
  }

  /**
   * 帳號管理操作（只在後端執行）。users 是帳號陣列，回傳新的陣列與結果。
   * deps: { sha256Hex, newSalt, newId, now }
   */
  function applyUserOp(users, op, actor, deps) {
    const list = users.map(function (u) { return Object.assign({}, u); });
    const find = function (id) {
      const u = list.find(function (x) { return x.id === id; });
      if (!u) throw new AuthError('NOT_FOUND', '找不到這個帳號');
      return u;
    };
    const cleanName = function (name) {
      const v = String(name || '').trim();
      if (!v || v.length > 20) throw new AuthError('INVALID_INPUT', '帳號名稱需為 1–20 個字');
      if (list.some(function (u) { return u.name === v && u.id !== op.id; })) {
        throw new AuthError('DUPLICATE', `帳號名稱「${v}」已存在`);
      }
      return v;
    };
    const cleanRole = function (role) {
      if (role !== 'staff' && role !== 'owner') throw new AuthError('INVALID_INPUT', '角色只能是壇務或擁有者');
      return role;
    };
    const setPin = function (u, pin) {
      u.salt = deps.newSalt();
      u.pinHash = hashPin(validatePin(pin), u.salt, deps.sha256Hex);
    };

    if (op.type === 'self.changePin') {
      if (!actor || actor.builtin) throw new AuthError('FORBIDDEN', '擁有者主帳號的 PIN 請在 Script Properties 修改');
      const me = find(actor.id);
      if (!verifyPin(me, op.oldPin, deps.sha256Hex)) throw new AuthError('WRONG_PIN', '原本的 PIN 碼不正確');
      setPin(me, op.newPin);
      return { users: list, result: {} };
    }

    if (roleOf(actor) !== 'owner') forbid('帳號管理僅限擁有者操作');

    switch (op.type) {
      case 'user.create': {
        const u = {
          id: deps.newId('U'),
          name: cleanName(op.name),
          role: cleanRole(op.role || 'staff'),
          staffId: op.staffId || null,
          disabled: false,
          createdAt: deps.now()
        };
        setPin(u, op.pin);
        list.push(u);
        return { users: list, result: { id: u.id } };
      }
      case 'user.update': {
        const u = find(op.id);
        const patch = op.patch || {};
        if ('name' in patch) u.name = cleanName(patch.name);
        if ('role' in patch) u.role = cleanRole(patch.role);
        if ('staffId' in patch) u.staffId = patch.staffId || null;
        if ('disabled' in patch) u.disabled = !!patch.disabled;
        if (u.id === actor.id && (u.disabled || u.role !== 'owner')) {
          throw new AuthError('INVALID_INPUT', '不能停用自己或取消自己的擁有者權限');
        }
        return { users: list, result: { id: u.id } };
      }
      case 'user.resetPin': {
        setPin(find(op.id), op.pin);
        return { users: list, result: { id: op.id } };
      }
      case 'user.delete': {
        const u = find(op.id);
        if (u.id === actor.id) throw new AuthError('INVALID_INPUT', '不能刪除自己的帳號');
        return { users: list.filter(function (x) { return x.id !== u.id; }), result: { id: u.id } };
      }
      default:
        throw new AuthError('INVALID_OP', `不支援的帳號操作：${op.type}`);
    }
  }

  return {
    ROLES: ROLES,
    ROLE_LABELS: ROLE_LABELS,
    OWNER_ONLY: OWNER_ONLY,
    AuthError: AuthError,
    roleOf: roleOf,
    atLeast: atLeast,
    authorize: authorize,
    can: can,
    maskName: maskName,
    viewFor: viewFor,
    viewKind: viewKind,
    syncInfo: syncInfo,
    sameVersion: sameVersion,
    syncView: syncView,
    sinceOf: sinceOf,
    mergeView: mergeView,
    validatePin: validatePin,
    hashPin: hashPin,
    verifyPin: verifyPin,
    publicUser: publicUser,
    applyUserOp: applyUserOp
  };
});
