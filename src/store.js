/*
 * AttendPoint 資料層（v3）
 *
 * 純資料邏輯：不碰 DOM、不碰 localStorage / 試算表。
 * 前端（單機版）與 Google Apps Script 後端共用同一份程式，確保兩邊規則一致。
 *
 * 用法：
 *   const { state, result } = AttendStore.apply(state, { type: 'points.checkin', studentId, sessionId }, ctx);
 *   apply() 不會修改傳入的 state，而是回傳新的 state；操作失敗會丟出 StoreError，原 state 保持不變。
 *
 * 積分不直接存在學員身上，一律由流水帳 logs 加總算出（見 computeTotals）。
 * 撤銷不刪除紀錄，而是新增一筆反向的 reversal 紀錄，方便對帳。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AttendStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 3;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const PREFIX_RE = /^[A-Z0-9]{1,3}$/;

  class StoreError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'StoreError';
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new StoreError(code, message);
  }

  // ---------- 基本工具 ----------

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // 本地時間 ISO 字串（不含時區），例如 2026-10-23T09:30:05
  function localIso(d) {
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    );
  }

  let idCounter = 0;
  function defaultNewId(prefix) {
    idCounter = (idCounter + 1) % 1296;
    return (
      prefix +
      Date.now().toString(36) +
      idCounter.toString(36).padStart(2, '0') +
      Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')
    );
  }

  /**
   * 操作情境：時間、ID 產生器、操作者。測試時可注入固定值。
   */
  function makeCtx(overrides) {
    return Object.assign(
      {
        now: function () { return localIso(new Date()); },
        newId: defaultNewId,
        operatorId: null
      },
      overrides || {}
    );
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function text(value, label, opts) {
    opts = opts || {};
    const v = value === undefined || value === null ? '' : String(value).trim();
    if (!v && opts.required) fail('INVALID_INPUT', `請填寫「${label}」`);
    const max = opts.max || 100;
    if (v.length > max) fail('INVALID_INPUT', `「${label}」最多 ${max} 個字`);
    return v;
  }

  function int(value, label, opts) {
    opts = opts || {};
    const n = Number(value);
    if (!Number.isInteger(n)) fail('INVALID_INPUT', `「${label}」必須是整數`);
    if (opts.min !== undefined && n < opts.min) fail('INVALID_INPUT', `「${label}」不可小於 ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) fail('INVALID_INPUT', `「${label}」不可大於 ${opts.max}`);
    return n;
  }

  function date(value, label) {
    const v = text(value, label, { required: true });
    if (!DATE_RE.test(v) || isNaN(Date.parse(v))) fail('INVALID_INPUT', `「${label}」格式需為 YYYY-MM-DD`);
    return v;
  }

  function time(value, label) {
    const v = text(value, label);
    if (v && !TIME_RE.test(v)) fail('INVALID_INPUT', `「${label}」格式需為 HH:MM`);
    return v;
  }

  function active(list) {
    return list.filter(function (x) { return !x.deletedAt; });
  }

  function findById(list, id) {
    return list.find(function (x) { return x.id === id; }) || null;
  }

  function mustFind(list, id, label) {
    const item = findById(list, id);
    if (!item || item.deletedAt) fail('NOT_FOUND', `找不到${label}（${id}）`);
    return item;
  }

  function mustFindDeleted(list, id, label) {
    const item = findById(list, id);
    if (!item) fail('NOT_FOUND', `找不到${label}（${id}）`);
    if (!item.deletedAt) fail('NOT_DELETED', `${label}「${item.name || id}」不在回收區`);
    return item;
  }

  // ---------- 狀態 ----------

  function emptyState(opts) {
    opts = opts || {};
    return {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        templeTitle: opts.templeTitle || '佛堂班程報到加分系統',
        yearLabel: opts.yearLabel || '',
        rev: 0,
        updatedAt: null
      },
      classes: [],
      sessions: [],
      staff: [],
      students: [],
      gifts: [],
      logs: []
    };
  }

  // ---------- 查詢（不會修改 state） ----------

  /** 已被撤銷的紀錄 id 集合 */
  function reversedIds(state) {
    const set = new Set();
    state.logs.forEach(function (l) {
      if (l.type === 'reversal' && l.reversesId) set.add(l.reversesId);
    });
    return set;
  }

  /**
   * 每位學員的榮譽總分、可用點數、出席課次，全部由 logs 計算。
   * 回傳 { [studentId]: { honor, balance, sessionIds: [] } }
   */
  function computeTotals(state) {
    const totals = {};
    state.students.forEach(function (s) {
      totals[s.id] = { honor: 0, balance: 0, sessionIds: [] };
    });
    const reversed = reversedIds(state);
    state.logs.forEach(function (l) {
      const t = totals[l.studentId];
      if (!t) return;
      t.honor += l.honorDelta;
      t.balance += l.balanceDelta;
      if (l.type === 'checkin' && !reversed.has(l.id) && t.sessionIds.indexOf(l.sessionId) === -1) {
        t.sessionIds.push(l.sessionId);
      }
    });
    return totals;
  }

  function studentTotals(state, studentId) {
    return computeTotals(state)[studentId] || { honor: 0, balance: 0, sessionIds: [] };
  }

  function isCheckedIn(state, studentId, sessionId) {
    const reversed = reversedIds(state);
    return state.logs.some(function (l) {
      return l.type === 'checkin' && l.studentId === studentId && l.sessionId === sessionId && !reversed.has(l.id);
    });
  }

  /** 各服務人員的護持（執勤）堂數 */
  function computeStaffDuty(state) {
    const counts = {};
    state.staff.forEach(function (p) { counts[p.id] = 0; });
    active(state.sessions).forEach(function (s) {
      (s.dutyStaffIds || []).forEach(function (id) {
        if (counts[id] !== undefined) counts[id]++;
      });
    });
    return counts;
  }

  /** 依班別學號前綴產生下一個學號，例如 K07 */
  function nextStudentId(state, classId) {
    const cls = mustFind(state.classes, classId, '班別');
    const used = new Set(state.students.map(function (s) { return s.id.toUpperCase(); }));
    let num = state.students.filter(function (s) { return s.classId === classId; }).length + 1;
    while (used.has((cls.idPrefix + pad(num)).toUpperCase())) num++;
    return cls.idPrefix + pad(num);
  }

  function findSession(state, classId, dateStr) {
    return active(state.sessions).find(function (s) {
      return s.classId === classId && s.date === dateStr;
    }) || null;
  }

  // ---------- 正規化 ----------

  function normalizeSchedule(sch) {
    sch = sch || {};
    const weekday = sch.weekday === undefined || sch.weekday === null || sch.weekday === ''
      ? null
      : int(sch.weekday, '上課星期', { min: 0, max: 6 });
    const start = time(sch.start, '常態開始時間');
    const end = time(sch.end, '常態結束時間');
    if (start && end && start >= end) fail('INVALID_INPUT', '常態上課的結束時間需晚於開始時間');
    return { weekday: weekday, start: start, end: end };
  }

  function normalizeRules(rules, kind, ctx) {
    if (!Array.isArray(rules)) return [];
    const isAdd = kind === 'add';
    let checkinCount = 0;
    const out = rules.map(function (r) {
      const rule = {
        id: r.id || ctx.newId(isAdd ? 'RA' : 'RD'),
        label: text(r.label, '規則名稱', { required: true, max: 40 }),
        points: int(r.points, '規則分數', { min: 1, max: 1000 }),
        icon: text(r.icon, '圖示', { max: 8 })
      };
      if (isAdd) {
        rule.isCheckin = !!r.isCheckin;
        if (rule.isCheckin) checkinCount++;
      }
      return rule;
    });
    if (checkinCount > 1) fail('INVALID_INPUT', '每個班別只能有一個「報到」加分規則');
    return out;
  }

  /** teams 可為名稱字串或 { id?, name }；沒有 id 的視為新小隊 */
  function normalizeTeams(teams, ctx) {
    if (!Array.isArray(teams)) return [];
    const seen = new Set();
    return teams.map(function (t) {
      const obj = typeof t === 'string' ? { name: t } : t;
      const name = text(obj.name, '小隊名稱', { required: true, max: 20 });
      if (seen.has(name)) fail('INVALID_INPUT', `小隊名稱「${name}」重複`);
      seen.add(name);
      return { id: obj.id || ctx.newId('T'), name: name };
    });
  }

  function checkClassUnique(state, cls) {
    active(state.classes).forEach(function (c) {
      if (c.id === cls.id) return;
      if (c.name === cls.name) fail('DUPLICATE', `班別名稱「${cls.name}」已存在`);
      if (c.idPrefix === cls.idPrefix) fail('DUPLICATE', `學號前綴「${cls.idPrefix}」已被「${c.name}」使用`);
    });
  }

  function teamOf(cls, teamId) {
    const team = cls.teams.find(function (t) { return t.id === teamId; });
    if (!team) fail('NOT_FOUND', `「${cls.name}」沒有這個小隊`);
    return team;
  }

  function touch(item, ctx) {
    item.updatedAt = ctx.now();
  }

  // ---------- 流水帳 ----------

  function pushLog(state, ctx, fields) {
    const log = Object.assign(
      {
        id: ctx.newId('L'),
        at: ctx.now(),
        type: 'points',
        classId: null,
        studentId: null,
        sessionId: null,
        ruleId: null,
        giftId: null,
        reversesId: null,
        batchId: null,
        reason: '',
        honorDelta: 0,
        balanceDelta: 0,
        operatorId: ctx.operatorId || null
      },
      fields
    );
    state.logs.push(log);
    return log;
  }

  // 扣分不會讓分數低於 0（與 v2 一致），實際扣除的分數會記在紀錄上，確保加總正確
  function clampDelta(current, delta) {
    return delta < 0 ? Math.max(delta, -current) : delta;
  }

  function addPoints(state, ctx, student, sessionId, points, reason, extra) {
    const t = studentTotals(state, student.id);
    return pushLog(state, ctx, Object.assign({
      type: 'points',
      classId: student.classId,
      studentId: student.id,
      sessionId: sessionId || null,
      reason: reason,
      honorDelta: clampDelta(t.honor, points),
      balanceDelta: clampDelta(t.balance, points)
    }, extra || {}));
  }

  function optionalSession(state, sessionId) {
    if (!sessionId) return null;
    return mustFind(state.sessions, sessionId, '課次');
  }

  // ---------- 操作（每個操作都在 draft 上執行） ----------

  const OPS = {};

  // ----- 班別 -----

  OPS['class.create'] = function (state, p, ctx) {
    const cls = {
      id: ctx.newId('C'),
      name: text(p.name, '班別名稱', { required: true, max: 30 }),
      icon: text(p.icon, '圖示', { max: 8 }),
      themeColor: text(p.themeColor, '主題色', { max: 20 }) || 'amber',
      idPrefix: text(p.idPrefix, '學號前綴', { required: true, max: 3 }).toUpperCase(),
      defaultSchedule: normalizeSchedule(p.defaultSchedule),
      teams: normalizeTeams(p.teams, ctx),
      addRules: normalizeRules(p.addRules, 'add', ctx),
      deductRules: normalizeRules(p.deductRules, 'deduct', ctx),
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      deletedAt: null
    };
    if (!PREFIX_RE.test(cls.idPrefix)) fail('INVALID_INPUT', '學號前綴只能是 1–3 個英文字母或數字');
    if (cls.teams.length === 0) fail('INVALID_INPUT', '每個班別至少要有一個小隊');
    checkClassUnique(state, cls);
    state.classes.push(cls);
    return { id: cls.id };
  };

  OPS['class.update'] = function (state, p, ctx) {
    const cls = mustFind(state.classes, p.id, '班別');
    const patch = p.patch || {};
    const next = clone(cls);
    if ('name' in patch) next.name = text(patch.name, '班別名稱', { required: true, max: 30 });
    if ('icon' in patch) next.icon = text(patch.icon, '圖示', { max: 8 });
    if ('themeColor' in patch) next.themeColor = text(patch.themeColor, '主題色', { max: 20 }) || 'amber';
    if ('idPrefix' in patch) {
      next.idPrefix = text(patch.idPrefix, '學號前綴', { required: true, max: 3 }).toUpperCase();
      if (!PREFIX_RE.test(next.idPrefix)) fail('INVALID_INPUT', '學號前綴只能是 1–3 個英文字母或數字');
    }
    if ('defaultSchedule' in patch) next.defaultSchedule = normalizeSchedule(patch.defaultSchedule);
    if ('teams' in patch) {
      next.teams = normalizeTeams(patch.teams, ctx);
      if (next.teams.length === 0) fail('INVALID_INPUT', '每個班別至少要有一個小隊');
      const kept = new Set(next.teams.map(function (t) { return t.id; }));
      cls.teams.forEach(function (t) {
        if (kept.has(t.id)) return;
        const inUse = active(state.students).some(function (s) { return s.classId === cls.id && s.teamId === t.id; });
        if (inUse) fail('TEAM_IN_USE', `小隊「${t.name}」還有學員，請先把學員換到其他小隊`);
      });
    }
    if ('addRules' in patch) next.addRules = normalizeRules(patch.addRules, 'add', ctx);
    if ('deductRules' in patch) next.deductRules = normalizeRules(patch.deductRules, 'deduct', ctx);
    checkClassUnique(state, next);
    touch(next, ctx);
    Object.assign(cls, next);
    return { id: cls.id };
  };

  /**
   * 刪除班別（移到回收區）。班上若還有學員，需擇一：
   *   moveStudentsTo: { classId, teamId }  學員轉到其他班
   *   deleteStudents: true                 學員一併移到回收區
   */
  OPS['class.delete'] = function (state, p, ctx) {
    const cls = mustFind(state.classes, p.id, '班別');
    const members = active(state.students).filter(function (s) { return s.classId === cls.id; });
    if (members.length > 0) {
      if (p.moveStudentsTo) {
        const target = mustFind(state.classes, p.moveStudentsTo.classId, '目標班別');
        if (target.id === cls.id) fail('INVALID_INPUT', '目標班別不可與要刪除的班別相同');
        const team = teamOf(target, p.moveStudentsTo.teamId);
        members.forEach(function (s) {
          s.classId = target.id;
          s.teamId = team.id;
          touch(s, ctx);
        });
      } else if (p.deleteStudents) {
        members.forEach(function (s) { s.deletedAt = ctx.now(); });
      } else {
        fail('CLASS_HAS_STUDENTS', `「${cls.name}」還有 ${members.length} 位學員，請選擇轉班或一併刪除`);
      }
    }
    cls.deletedAt = ctx.now();
    return { id: cls.id, affectedStudents: members.length };
  };

  OPS['class.restore'] = function (state, p, ctx) {
    const cls = mustFindDeleted(state.classes, p.id, '班別');
    checkClassUnique(state, cls);
    cls.deletedAt = null;
    touch(cls, ctx);
    return { id: cls.id };
  };

  // ----- 課次 -----

  /** 新增或修改課次。改日期時，點名紀錄掛在課次 id 上，會自動跟著移動。 */
  OPS['session.save'] = function (state, p, ctx) {
    const existing = p.id ? mustFind(state.sessions, p.id, '課次') : null;
    const classId = existing ? existing.classId : p.classId;
    const cls = mustFind(state.classes, classId, '班別');
    const next = {
      date: date(p.date, '上課日期'),
      start: time(p.start, '開始時間'),
      end: time(p.end, '結束時間'),
      topic: text(p.topic, '課程主題', { max: 100 }),
      dutyStaffIds: Array.isArray(p.dutyStaffIds) ? p.dutyStaffIds.slice() : (existing ? existing.dutyStaffIds : [])
    };
    if (next.start && next.end && next.start >= next.end) fail('INVALID_INPUT', '結束時間需晚於開始時間');
    next.dutyStaffIds.forEach(function (id) { mustFind(state.staff, id, '服務人員'); });
    const clash = active(state.sessions).find(function (s) {
      return s.id !== (existing && existing.id) && s.classId === cls.id && s.date === next.date && s.start === next.start;
    });
    if (clash) fail('DUPLICATE', `「${cls.name}」在 ${next.date} ${next.start || ''} 已經有課次`);

    if (existing) {
      Object.assign(existing, next);
      touch(existing, ctx);
      return { id: existing.id };
    }
    const session = Object.assign({
      id: ctx.newId('S'),
      classId: cls.id,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      deletedAt: null
    }, next);
    state.sessions.push(session);
    return { id: session.id };
  };

  /** 取得某班某天的課次；沒有就依常態時間自動建立（點名畫面用） */
  OPS['session.ensure'] = function (state, p, ctx) {
    const cls = mustFind(state.classes, p.classId, '班別');
    const d = date(p.date, '上課日期');
    const found = findSession(state, cls.id, d);
    if (found) return { id: found.id, created: false };
    const sch = cls.defaultSchedule || {};
    const r = OPS['session.save'](state, { classId: cls.id, date: d, start: sch.start, end: sch.end }, ctx);
    return { id: r.id, created: true };
  };

  OPS['session.delete'] = function (state, p, ctx) {
    const session = mustFind(state.sessions, p.id, '課次');
    const reversed = reversedIds(state);
    const live = state.logs.filter(function (l) {
      return l.sessionId === session.id && l.type !== 'reversal' && !reversed.has(l.id);
    });
    if (live.length > 0) fail('SESSION_HAS_LOGS', `這堂課還有 ${live.length} 筆點名或加分紀錄，請先撤銷後再刪除`);
    session.deletedAt = ctx.now();
    return { id: session.id };
  };

  // ----- 服務人員 -----

  function staffFields(p, base) {
    const out = {};
    if (!base || 'name' in p) out.name = text(p.name, '姓名', { required: true, max: 20 });
    if (!base || 'role' in p) out.role = text(p.role, '職務', { max: 20 });
    if (!base || 'note' in p) out.note = text(p.note, '備註', { max: 200 });
    if (!base || 'classIds' in p) out.classIds = Array.isArray(p.classIds) ? p.classIds.slice() : [];
    return out;
  }

  OPS['staff.create'] = function (state, p, ctx) {
    const fields = staffFields(p, null);
    fields.classIds.forEach(function (id) { mustFind(state.classes, id, '班別'); });
    const person = Object.assign({ id: ctx.newId('P') }, fields, {
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      deletedAt: null
    });
    state.staff.push(person);
    return { id: person.id };
  };

  OPS['staff.update'] = function (state, p, ctx) {
    const person = mustFind(state.staff, p.id, '服務人員');
    const fields = staffFields(p.patch || {}, person);
    (fields.classIds || []).forEach(function (id) { mustFind(state.classes, id, '班別'); });
    Object.assign(person, fields);
    touch(person, ctx);
    return { id: person.id };
  };

  OPS['staff.delete'] = function (state, p, ctx) {
    const person = mustFind(state.staff, p.id, '服務人員');
    person.deletedAt = ctx.now();
    return { id: person.id };
  };

  OPS['staff.restore'] = function (state, p, ctx) {
    const person = mustFindDeleted(state.staff, p.id, '服務人員');
    person.deletedAt = null;
    touch(person, ctx);
    return { id: person.id };
  };

  // ----- 學員 -----

  OPS['student.create'] = function (state, p, ctx) {
    const cls = mustFind(state.classes, p.classId, '班別');
    const team = p.teamId ? teamOf(cls, p.teamId) : cls.teams[0];
    let id = text(p.id, '學號', { max: 12 }).toUpperCase();
    if (id) {
      const taken = state.students.some(function (s) { return s.id.toUpperCase() === id; });
      if (taken) fail('DUPLICATE', `學號「${id}」已被使用`);
    } else {
      id = nextStudentId(state, cls.id);
    }
    const student = {
      id: id,
      classId: cls.id,
      teamId: team.id,
      name: text(p.name, '姓名', { required: true, max: 20 }),
      note: text(p.note, '備註', { max: 200 }),
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      deletedAt: null
    };
    state.students.push(student);
    return { id: student.id };
  };

  /** 修改姓名、備註、換小隊、升班。學號不可修改（流水帳以學號對應）。 */
  OPS['student.update'] = function (state, p, ctx) {
    const student = mustFind(state.students, p.id, '學員');
    const patch = p.patch || {};
    if ('name' in patch) student.name = text(patch.name, '姓名', { required: true, max: 20 });
    if ('note' in patch) student.note = text(patch.note, '備註', { max: 200 });
    if ('classId' in patch || 'teamId' in patch) {
      const cls = mustFind(state.classes, patch.classId || student.classId, '班別');
      if (cls.id !== student.classId && !patch.teamId) {
        student.teamId = cls.teams[0].id;
      } else {
        student.teamId = teamOf(cls, patch.teamId || student.teamId).id;
      }
      student.classId = cls.id;
    }
    touch(student, ctx);
    return { id: student.id };
  };

  OPS['student.delete'] = function (state, p, ctx) {
    const student = mustFind(state.students, p.id, '學員');
    student.deletedAt = ctx.now();
    return { id: student.id };
  };

  OPS['student.restore'] = function (state, p, ctx) {
    const student = mustFindDeleted(state.students, p.id, '學員');
    const cls = findById(state.classes, student.classId);
    if (!cls || cls.deletedAt) fail('CLASS_DELETED', '這位學員原本的班別已刪除，請先還原班別');
    student.deletedAt = null;
    touch(student, ctx);
    return { id: student.id };
  };

  // ----- 報到與加減分 -----

  OPS['points.checkin'] = function (state, p, ctx) {
    const student = mustFind(state.students, p.studentId, '學員');
    const session = mustFind(state.sessions, p.sessionId, '課次');
    if (session.classId !== student.classId) fail('INVALID_INPUT', `${student.name} 不屬於這堂課的班別`);
    if (isCheckedIn(state, student.id, session.id)) {
      fail('ALREADY_CHECKED_IN', `${student.name} 在 ${session.date} 已經報到過了`);
    }
    const cls = mustFind(state.classes, student.classId, '班別');
    const rule = cls.addRules.find(function (r) { return r.isCheckin; });
    const log = pushLog(state, ctx, {
      type: 'checkin',
      classId: student.classId,
      studentId: student.id,
      sessionId: session.id,
      ruleId: rule ? rule.id : null,
      reason: rule ? rule.label : '報到',
      honorDelta: rule ? rule.points : 0,
      balanceDelta: rule ? rule.points : 0
    });
    return { logId: log.id, points: log.honorDelta };
  };

  /**
   * 加分或扣分。
   *   ruleId：依班別規則（加分規則為正、扣分規則為負）
   *   或 points + reason：自訂事由（points 可正可負）
   */
  OPS['points.award'] = function (state, p, ctx) {
    const student = mustFind(state.students, p.studentId, '學員');
    optionalSession(state, p.sessionId);
    let points;
    let reason;
    let ruleId = null;
    if (p.ruleId) {
      const cls = mustFind(state.classes, student.classId, '班別');
      const add = cls.addRules.find(function (r) { return r.id === p.ruleId; });
      const deduct = cls.deductRules.find(function (r) { return r.id === p.ruleId; });
      if (!add && !deduct) fail('NOT_FOUND', '找不到這個加扣分規則');
      if (add && add.isCheckin) fail('INVALID_INPUT', '報到請使用報到功能');
      points = add ? add.points : -deduct.points;
      reason = (add || deduct).label;
      ruleId = p.ruleId;
    } else {
      points = int(p.points, '分數', { min: -1000, max: 1000 });
      if (points === 0) fail('INVALID_INPUT', '分數不可為 0');
      reason = text(p.reason, '事由', { required: true, max: 60 });
    }
    const log = addPoints(state, ctx, student, p.sessionId, points, reason, { ruleId: ruleId });
    return { logId: log.id, honorDelta: log.honorDelta, balanceDelta: log.balanceDelta };
  };

  /**
   * 小隊或全體加減分。
   *   target: { teamId } 指定小隊；{ checkedIn: true } 本堂已報到的學員（需 sessionId）
   */
  OPS['points.batch'] = function (state, p, ctx) {
    const cls = mustFind(state.classes, p.classId, '班別');
    const session = optionalSession(state, p.sessionId);
    const points = int(p.points, '分數', { min: -1000, max: 1000 });
    if (points === 0) fail('INVALID_INPUT', '分數不可為 0');
    const reason = text(p.reason, '事由', { required: true, max: 60 });
    const target = p.target || {};
    let members = active(state.students).filter(function (s) { return s.classId === cls.id; });
    if (target.teamId) {
      teamOf(cls, target.teamId);
      members = members.filter(function (s) { return s.teamId === target.teamId; });
    } else if (target.checkedIn) {
      if (!session) fail('INVALID_INPUT', '選擇「本堂已報到」時需指定課次');
      members = members.filter(function (s) { return isCheckedIn(state, s.id, session.id); });
    } else {
      fail('INVALID_INPUT', '請選擇加減分對象');
    }
    if (members.length === 0) fail('NO_MATCH', '找不到符合條件的學員');
    const batchId = ctx.newId('B');
    members.forEach(function (s) {
      addPoints(state, ctx, s, p.sessionId, points, '[團體] ' + reason, { batchId: batchId });
    });
    return { batchId: batchId, count: members.length };
  };

  OPS['points.redeem'] = function (state, p, ctx) {
    const student = mustFind(state.students, p.studentId, '學員');
    const gift = mustFind(state.gifts, p.giftId, '禮品');
    const t = studentTotals(state, student.id);
    if (t.balance < gift.cost) {
      fail('INSUFFICIENT_POINTS', `${student.name} 可用點數不足（目前 ${t.balance} 點，需 ${gift.cost} 點）`);
    }
    const log = pushLog(state, ctx, {
      type: 'redeem',
      classId: student.classId,
      studentId: student.id,
      sessionId: p.sessionId || null,
      giftId: gift.id,
      reason: '兌換：' + gift.name,
      honorDelta: 0,
      balanceDelta: -gift.cost
    });
    return { logId: log.id, balance: t.balance - gift.cost };
  };

  /** 手動校正積分（之後限擁有者使用） */
  OPS['points.adjust'] = function (state, p, ctx) {
    const student = mustFind(state.students, p.studentId, '學員');
    const honorDelta = int(p.honorDelta || 0, '榮譽分調整', { min: -10000, max: 10000 });
    const balanceDelta = int(p.balanceDelta || 0, '可用點數調整', { min: -10000, max: 10000 });
    if (honorDelta === 0 && balanceDelta === 0) fail('INVALID_INPUT', '調整分數不可皆為 0');
    const t = studentTotals(state, student.id);
    if (t.honor + honorDelta < 0 || t.balance + balanceDelta < 0) fail('NEGATIVE_POINTS', '調整後分數不可小於 0');
    const log = pushLog(state, ctx, {
      type: 'adjust',
      classId: student.classId,
      studentId: student.id,
      reason: text(p.reason, '校正原因', { required: true, max: 60 }),
      honorDelta: honorDelta,
      balanceDelta: balanceDelta
    });
    return { logId: log.id };
  };

  /** 撤銷一筆紀錄：新增反向紀錄，原紀錄保留 */
  OPS['log.reverse'] = function (state, p, ctx) {
    const log = findById(state.logs, p.logId);
    if (!log) fail('NOT_FOUND', '找不到這筆紀錄');
    if (log.type === 'reversal') fail('INVALID_INPUT', '撤銷紀錄不能再撤銷');
    if (reversedIds(state).has(log.id)) fail('ALREADY_REVERSED', '這筆紀錄已經撤銷過了');
    const t = studentTotals(state, log.studentId);
    if (t.balance - log.balanceDelta < 0 || t.honor - log.honorDelta < 0) {
      fail('NEGATIVE_POINTS', '撤銷後分數會變成負數（點數可能已用於兌換），請先撤銷兌換紀錄');
    }
    const rev = pushLog(state, ctx, {
      type: 'reversal',
      classId: log.classId,
      studentId: log.studentId,
      sessionId: log.sessionId,
      reversesId: log.id,
      reason: '撤銷：' + log.reason,
      honorDelta: -log.honorDelta,
      balanceDelta: -log.balanceDelta
    });
    return { logId: rev.id };
  };

  // ----- 禮品 -----

  function giftFields(p, base) {
    const out = {};
    if (!base || 'name' in p) out.name = text(p.name, '禮品名稱', { required: true, max: 40 });
    if (!base || 'cost' in p) out.cost = int(p.cost, '兌換點數', { min: 1, max: 100000 });
    if (!base || 'icon' in p) out.icon = text(p.icon, '圖示', { max: 8 });
    if (!base || 'desc' in p) out.desc = text(p.desc, '說明', { max: 100 });
    return out;
  }

  OPS['gift.create'] = function (state, p, ctx) {
    const gift = Object.assign({ id: ctx.newId('G') }, giftFields(p, null), {
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      deletedAt: null
    });
    state.gifts.push(gift);
    return { id: gift.id };
  };

  OPS['gift.update'] = function (state, p, ctx) {
    const gift = mustFind(state.gifts, p.id, '禮品');
    Object.assign(gift, giftFields(p.patch || {}, gift));
    touch(gift, ctx);
    return { id: gift.id };
  };

  OPS['gift.delete'] = function (state, p, ctx) {
    const gift = mustFind(state.gifts, p.id, '禮品');
    gift.deletedAt = ctx.now();
    return { id: gift.id };
  };

  OPS['gift.restore'] = function (state, p, ctx) {
    const gift = mustFindDeleted(state.gifts, p.id, '禮品');
    gift.deletedAt = null;
    touch(gift, ctx);
    return { id: gift.id };
  };

  // ----- 設定與年度 -----

  OPS['meta.update'] = function (state, p) {
    if ('templeTitle' in p) state.meta.templeTitle = text(p.templeTitle, '佛堂與系統標題', { required: true, max: 60 });
    if ('yearLabel' in p) state.meta.yearLabel = text(p.yearLabel, '年度名稱', { max: 20 });
    return {};
  };

  /**
   * 跨年度結算：清空流水帳與課次、永久清除回收區，保留名冊、班別、人員、禮品。
   * 執行前應先匯出報表備份。
   */
  OPS['year.reset'] = function (state, p) {
    const yearLabel = text(p.yearLabel, '新年度名稱', { required: true, max: 20 });
    const report = { logs: state.logs.length, sessions: state.sessions.length, purged: 0 };
    ['classes', 'staff', 'students', 'gifts'].forEach(function (key) {
      const before = state[key].length;
      state[key] = active(state[key]);
      report.purged += before - state[key].length;
    });
    state.logs = [];
    state.sessions = [];
    state.meta.yearLabel = yearLabel;
    return report;
  };

  // ---------- 對外介面 ----------

  /**
   * 執行一個操作。成功回傳 { state: 新狀態, result }；失敗丟出 StoreError，原 state 不變。
   */
  function apply(state, op, ctx) {
    if (!op || typeof op.type !== 'string') fail('INVALID_OP', '操作格式錯誤');
    const handler = OPS[op.type];
    if (!handler) fail('INVALID_OP', `不支援的操作：${op.type}`);
    ctx = makeCtx(ctx);
    const draft = clone(state);
    const payload = Object.assign({}, op);
    delete payload.type;
    const result = handler(draft, payload, ctx);
    draft.meta.rev = (draft.meta.rev || 0) + 1;
    draft.meta.updatedAt = ctx.now();
    return { state: draft, result: result };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    OP_TYPES: Object.keys(OPS),
    StoreError: StoreError,
    emptyState: emptyState,
    makeCtx: makeCtx,
    apply: apply,
    active: active,
    computeTotals: computeTotals,
    studentTotals: studentTotals,
    computeStaffDuty: computeStaffDuty,
    isCheckedIn: isCheckedIn,
    findSession: findSession,
    nextStudentId: nextStudentId,
    localIso: localIso
  };
});
