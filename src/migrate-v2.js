/*
 * AttendPoint：v2 → v3 資料移轉
 *
 * v2 把積分直接存在學員身上（honorPoints / availablePoints / attendedDates），
 * v3 改由流水帳計算。移轉時：
 *   1. 保留 v2 的每一筆流水帳，並依日期時間排序
 *   2. 有出席日期卻沒有報到紀錄的，補一筆 0 分的報到紀錄（只用來記出席）
 *   3. v2 分數與流水帳加總不一致的部分（例如匯入的期初分數），補一筆「期初分數移轉」
 * 因此移轉後每位學員的榮譽總分、可用點數、出席堂數都與 v2 完全相同。
 *
 * v2 的壇務密碼（adminPin）不會移轉，v3 改由後端管理。
 */
(function (root, factory) {
  const api = factory(root.AttendStore || (typeof require === 'function' ? require('./store.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AttendMigrate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Store) {
  'use strict';

  const V2_STORAGE_KEY = 'temple_checkin_annual_v2';

  // v2 寫死在程式裡的班別設定，作為移轉時的預設值
  const V2_CLASSES = {
    kids: {
      name: '兒童讀經班',
      icon: '🌱',
      themeColor: 'amber',
      idPrefix: 'K',
      teams: ['孝順隊', '仁愛隊', '智慧隊'],
      addRules: [
        { id: 'k_ontime', label: '準時報到', points: 10, icon: '⏰', isCheckin: true },
        { id: 'k_book', label: '自備讀經本＆穿班服', points: 5, icon: '📘' },
        { id: 'k_recite1', label: '背經通過（一段）', points: 15, icon: '🗣️' },
        { id: 'k_recite2', label: '背經通過（全章）', points: 30, icon: '📜' },
        { id: 'k_lead', label: '上台帶讀經典', points: 20, icon: '🎤' },
        { id: 'k_service', label: '佛堂小幫手（排椅/擦桌）', points: 15, icon: '🧹' },
        { id: 'k_parent', label: '家長陪同共讀', points: 10, icon: '👨‍👩‍👧' },
        { id: 'k_friend', label: '邀請新同學參班', points: 30, icon: '🤝' }
      ],
      deductRules: [
        { id: 'kd_order', label: '課堂秩序提醒（講話/奔跑）', points: 5, icon: '🤫' },
        { id: 'kd_nobook', label: '未帶讀經本或聯絡簿', points: 5, icon: '📕' },
        { id: 'kd_clean', label: '座位環境未整理', points: 5, icon: '🗑️' },
        { id: 'kd_late', label: '無故遲到或早退調整', points: 5, icon: '⏳' }
      ]
    },
    youth: {
      name: '青少年班',
      icon: '🌟',
      themeColor: 'emerald',
      idPrefix: 'Y',
      teams: ['慈悲組', '精進組', '喜捨組'],
      addRules: [
        { id: 'y_ontime', label: '準時報到', points: 10, icon: '⏰', isCheckin: true },
        { id: 'y_share', label: '課堂提問與心得分享', points: 20, icon: '💡' },
        { id: 'y_service', label: '佛堂行功（音控/接待/環保）', points: 25, icon: '🙏' },
        { id: 'y_care', label: '帶領讀經班弟妹', points: 25, icon: '🌟' },
        { id: 'y_full', label: '全程參與不滑手機', points: 15, icon: '📵' },
        { id: 'y_friend', label: '邀約新朋友參班', points: 40, icon: '🎉' }
      ],
      deductRules: [
        { id: 'yd_phone', label: '上課期間不當使用手機', points: 10, icon: '📱' },
        { id: 'yd_order', label: '團體秩序或禮節提醒', points: 10, icon: '⚠️' },
        { id: 'yd_duty', label: '輪值行功未到場', points: 10, icon: '🧹' },
        { id: 'yd_late', label: '無故遲到或早退調整', points: 5, icon: '⏳' }
      ]
    }
  };

  const V2_GIFTS = [
    { id: 'g1', name: '智慧文具組（鉛筆＋橡皮擦）', cost: 30, icon: '✏️', desc: '適合兒童讀經班日常獎勵' },
    { id: 'g2', name: '精美讀經隨身筆記本', cost: 50, icon: '📓', desc: '燙金封面佛堂紀念筆記本' },
    { id: 'g3', name: '佛堂平安健康點心盒', cost: 80, icon: '🍪', desc: '天然蔬食餅乾與堅果結緣品' },
    { id: 'g4', name: '24色彩繪色鉛筆禮盒', cost: 120, icon: '🎨', desc: '期中讀經表現優良熱門獎品' },
    { id: 'g5', name: '保溫隨行環保杯', cost: 180, icon: '🥤', desc: '青少年班與讀經班高人氣實用品' },
    { id: 'g6', name: '年度精進狀元大禮包', cost: 250, icon: '🏆', desc: '年底結業典禮特優大獎' }
  ];

  const REDEEM_PREFIX = '🎁 兌換：';

  function isV2(data) {
    return !!data && typeof data === 'object' && !data.schemaVersion && Array.isArray(data.students);
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  /**
   * 把 v2 狀態轉成 v3。
   * 回傳 { state, report }，report 記錄補了哪些紀錄、丟掉哪些無法對應的資料。
   */
  function migrateV2(v2, ctxOverrides) {
    if (!isV2(v2)) throw new Store.StoreError('NOT_V2', '這不是 v2 格式的資料');
    const ctx = Store.makeCtx(ctxOverrides);
    const report = {
      students: 0,
      logs: 0,
      addedCheckins: 0,
      openingAdjustments: 0,
      droppedLogs: 0,
      droppedStudents: 0,
      pinDropped: !!v2.adminPin
    };

    const state = Store.emptyState({
      templeTitle: String(v2.templeTitle || '').trim() || undefined,
      yearLabel: String(v2.yearLabel || '').trim()
    });

    // ---- 班別與小隊 ----
    const teamIndex = {}; // classId → { 小隊名稱: teamId }
    ['kids', 'youth'].forEach(function (key) {
      const def = V2_CLASSES[key];
      const customTeams = Array.isArray(v2[key + 'Teams']) && v2[key + 'Teams'].length > 0 ? v2[key + 'Teams'] : def.teams;
      const cls = {
        id: key,
        name: String(v2[key + 'ClassName'] || '').trim() || def.name,
        icon: def.icon,
        themeColor: def.themeColor,
        idPrefix: def.idPrefix,
        defaultSchedule: { weekday: null, start: '', end: '' },
        teams: [],
        addRules: def.addRules.map(function (r) { return Object.assign({ isCheckin: false }, r); }),
        deductRules: def.deductRules.map(function (r) { return Object.assign({}, r); }),
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
        deletedAt: null
      };
      teamIndex[key] = {};
      customTeams.forEach(function (name) { addTeam(cls, teamIndex[key], name); });
      state.classes.push(cls);
    });

    function addTeam(cls, index, rawName) {
      const name = String(rawName || '').trim() || '第一小隊';
      if (!index[name]) {
        const id = cls.id + '-t' + (cls.teams.length + 1);
        cls.teams.push({ id: id, name: name });
        index[name] = id;
      }
      return index[name];
    }

    function classById(id) {
      return state.classes.find(function (c) { return c.id === id; });
    }

    // ---- 學員 ----
    const seenIds = new Set();
    v2.students.forEach(function (s) {
      const classId = s.classType === 'youth' ? 'youth' : 'kids';
      const id = String(s.id || '').trim().toUpperCase();
      const name = String(s.name || '').trim();
      if (!id || !name || seenIds.has(id)) {
        report.droppedStudents++;
        return;
      }
      seenIds.add(id);
      state.students.push({
        id: id,
        classId: classId,
        teamId: addTeam(classById(classId), teamIndex[classId], s.team),
        name: name,
        note: '',
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
        deletedAt: null
      });
      report.students++;
    });

    function studentById(id) {
      return state.students.find(function (s) { return s.id === id; });
    }

    // ---- 禮品 ----
    V2_GIFTS.forEach(function (g) {
      state.gifts.push(Object.assign({}, g, { createdAt: ctx.now(), updatedAt: ctx.now(), deletedAt: null }));
    });

    // ---- 課次：每個班別、每個上課日期一堂 ----
    function sessionFor(classId, date) {
      let s = state.sessions.find(function (x) { return x.classId === classId && x.date === date; });
      if (!s) {
        s = {
          id: 'S-' + classId + '-' + date,
          classId: classId,
          date: date,
          start: '',
          end: '',
          topic: '',
          dutyStaffIds: [],
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
          deletedAt: null
        };
        state.sessions.push(s);
      }
      return s;
    }

    function validDate(d) {
      return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    }

    // ---- 流水帳：v2 新的在前，先反轉再依時間穩定排序 ----
    const v2Logs = (Array.isArray(v2.logs) ? v2.logs.slice() : []).reverse();
    v2Logs.forEach(function (l) {
      const time = /^\d{2}:\d{2}(:\d{2})?$/.test(l.timestamp || '') ? l.timestamp : '00:00:00';
      l._at = (validDate(l.sessionDate) ? l.sessionDate : '0000-00-00') + 'T' + (time.length === 5 ? time + ':00' : time);
    });
    v2Logs.sort(function (a, b) { return a._at < b._at ? -1 : a._at > b._at ? 1 : 0; });

    const checkedIn = new Set(); // studentId|sessionId
    const sums = {}; // studentId → { honor, balance }

    function record(log) {
      state.logs.push(Object.assign({
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
        operatorId: null,
        operatorName: null,
        migrated: true
      }, log));
      const sum = sums[log.studentId] || (sums[log.studentId] = { honor: 0, balance: 0 });
      sum.honor += log.honorDelta || 0;
      sum.balance += log.balanceDelta || 0;
    }

    v2Logs.forEach(function (l) {
      const student = studentById(String(l.studentId || '').trim().toUpperCase());
      if (!student) {
        report.droppedLogs++;
        return;
      }
      const reason = String(l.reason || '');
      const base = {
        at: l._at,
        classId: student.classId,
        studentId: student.id,
        reason: reason,
        honorDelta: num(l.honorDelta),
        balanceDelta: num(l.balanceDelta)
      };
      if (validDate(l.sessionDate)) base.sessionId = sessionFor(student.classId, l.sessionDate).id;

      if (l.isCheckin && base.sessionId && !checkedIn.has(student.id + '|' + base.sessionId)) {
        checkedIn.add(student.id + '|' + base.sessionId);
        const rule = classById(student.classId).addRules.find(function (r) { return r.isCheckin; });
        base.type = 'checkin';
        base.ruleId = rule ? rule.id : null;
      } else if (reason.indexOf(REDEEM_PREFIX) === 0 && base.honorDelta === 0) {
        const giftName = reason.slice(REDEEM_PREFIX.length);
        const gift = state.gifts.find(function (g) { return g.name === giftName; });
        base.type = 'redeem';
        base.giftId = gift ? gift.id : null;
        base.reason = '兌換：' + giftName;
      }
      record(base);
      report.logs++;
    });

    // ---- 補出席紀錄與期初分數 ----
    const openings = [];
    v2.students.forEach(function (s) {
      const student = studentById(String(s.id || '').trim().toUpperCase());
      if (!student) return;
      const dates = Array.isArray(s.attendedDates) ? s.attendedDates.filter(validDate) : [];
      dates.forEach(function (d) {
        const session = sessionFor(student.classId, d);
        if (checkedIn.has(student.id + '|' + session.id)) return;
        checkedIn.add(student.id + '|' + session.id);
        record({
          type: 'checkin',
          at: d + 'T00:00:00',
          classId: student.classId,
          studentId: student.id,
          sessionId: session.id,
          reason: '出席（v2 移轉，分數已含於期初）'
        });
        report.addedCheckins++;
      });

      const sum = sums[student.id] || { honor: 0, balance: 0 };
      const honorDiff = num(s.honorPoints) - sum.honor;
      const balanceDiff = num(s.availablePoints) - sum.balance;
      if (honorDiff !== 0 || balanceDiff !== 0) {
        openings.push({
          id: ctx.newId('L'),
          at: '0000-00-00T00:00:00',
          type: 'adjust',
          classId: student.classId,
          studentId: student.id,
          sessionId: null,
          ruleId: null,
          giftId: null,
          reversesId: null,
          batchId: null,
          reason: '期初分數移轉（v2）',
          honorDelta: honorDiff,
          balanceDelta: balanceDiff,
          operatorId: null,
          operatorName: null,
          migrated: true
        });
        report.openingAdjustments++;
      }
    });

    // 期初分數放最前面，其餘依時間排序；未知日期（0000-00-00）以第一筆有效日期代替
    state.logs = openings.concat(state.logs);
    state.logs.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    const firstReal = state.logs.find(function (l) { return l.at.indexOf('0000') !== 0; });
    const fallbackAt = firstReal ? firstReal.at.slice(0, 10) + 'T00:00:00' : ctx.now();
    state.logs.forEach(function (l) {
      if (l.at.indexOf('0000') === 0) l.at = fallbackAt;
    });
    state.sessions.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    state.meta.updatedAt = ctx.now();
    return { state: state, report: report };
  }

  /**
   * 讀取任何版本的已存資料（字串或物件），回傳 v3 狀態。
   * 回傳 { state, migratedFrom: null | 2, report }
   */
  function loadAny(raw, ctxOverrides) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (data && data.schemaVersion === Store.SCHEMA_VERSION) {
      return { state: data, migratedFrom: null, report: null };
    }
    if (isV2(data)) {
      const r = migrateV2(data, ctxOverrides);
      return { state: r.state, migratedFrom: 2, report: r.report };
    }
    if (data && data.schemaVersion > Store.SCHEMA_VERSION) {
      throw new Store.StoreError('NEWER_VERSION', '資料版本比程式新，請更新系統後再開啟');
    }
    throw new Store.StoreError('UNKNOWN_FORMAT', '無法辨識的資料格式');
  }

  return {
    V2_STORAGE_KEY: V2_STORAGE_KEY,
    isV2: isV2,
    migrateV2: migrateV2,
    loadAny: loadAny
  };
});
