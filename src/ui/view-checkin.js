/* 點名分頁：學員卡、報到、加減分、團體加分、本堂紀錄、學員小卡 */
(function (App) {
  'use strict';
  const html = App.html;

  const TYPE_LABEL = { checkin: '報到', points: '加減分', redeem: '兌換', adjust: '校正', reversal: '撤銷' };

  function delta(n) {
    if (!n) return '';
    return n > 0 ? html`<span class="plus">+${n}</span>` : html`<span class="minus">${n}</span>`;
  }

  function reversedSet() {
    const set = new Set();
    App.s.data.logs.forEach(function (l) { if (l.type === 'reversal') set.add(l.reversesId); });
    return set;
  }

  /** 一筆流水帳；showStudent 為 true 時顯示學員名字 */
  App.logItem = function (log, reversed, showStudent) {
    const student = App.studentById(log.studentId);
    const isReversed = reversed.has(log.id);
    const canUndo = log.type !== 'reversal' && !isReversed && !App.isBusy() &&
      App.can({ type: 'log.reverse', logId: log.id });
    const pts = log.type === 'redeem' ? delta(log.balanceDelta) : delta(log.honorDelta);
    return html`
      <div class="list-item ${isReversed ? 'reversed' : ''}">
        <div class="grow">
          <div>${showStudent && student ? html`<b>${student.name}</b>・` : ''}${log.reason} ${pts}</div>
          <div class="faint">${log.at.slice(5, 16).replace('T', ' ')}・${TYPE_LABEL[log.type] || log.type}${log.operatorName ? html`・${log.operatorName}` : ''}</div>
        </div>
        ${canUndo ? html`<button type="button" class="btn btn-sm" data-action="undo" data-log="${log.id}">↩️ 撤銷</button>` : ''}
      </div>`;
  };

  function filtered(cls, session) {
    return App.students(cls.id).filter(function (s) {
      if (App.s.teamFilter !== 'all' && cls.teams.length && s.teamId !== App.s.teamFilter) return false;
      if (App.s.statusFilter !== 'all') {
        const checked = !!session && AttendStore.isCheckedIn(App.s.data, s.id, session.id);
        if ((App.s.statusFilter === 'in') !== checked) return false;
      }
      return true;
    });
  }

  /** 服務人員點名：支援這個班（或沒有指定班別）的服務人員，點一下標記當天有來 */
  function staffDutyCard(cls, session) {
    const list = App.staffList().filter(function (p) {
      return !p.classIds || !p.classIds.length || p.classIds.indexOf(cls.id) !== -1;
    });
    const duty = session ? session.dutyStaffIds : [];
    const present = list.filter(function (p) { return duty.indexOf(p.id) !== -1; }).length;
    return html`
      <div class="card card-pad stack" data-staff-duty style="margin-bottom:12px">
        <div class="spread"><b>🙋 服務人員點名</b><span class="faint num">${present} / ${list.length} 到</span></div>
        ${list.length
          ? html`<div class="pills">${list.map(function (p) {
              const on = duty.indexOf(p.id) !== -1;
              return html`<button type="button" class="pill ${on ? 'active' : ''}" data-action="staff-duty" data-id="${p.id}" aria-pressed="${on ? 'true' : 'false'}">${on ? '✅ ' : ''}${p.name}</button>`;
            })}</div>`
          : html`<span class="faint">還沒有服務人員，請到「⚙️ 班務管理 → 🙋 服務人員」新增，支援班別勾選「${cls.name}」。</span>`}
      </div>`;
  }

  function studentCard(s, session) {
    const t = App.studentTotals(s.id);
    const checked = !!session && AttendStore.isCheckedIn(App.s.data, s.id, session.id);
    const rank = App.rank(t.honor);
    return html`
      <div class="card student-card ${checked ? 'checked' : ''}" data-search="${(s.name + ' ' + s.id + ' ' + App.teamName(s)).toLowerCase()}">
        <div class="spread">
          <div class="grow">
            <div class="name" data-action="open-student" data-id="${s.id}">${s.name}</div>
            <div class="row"><span class="id">${s.id}</span>${App.teamName(s) ? html`<span class="chip chip-theme">${App.teamName(s)}</span>` : ''}</div>
          </div>
          <span class="chip ${rank.cls}">${rank.title}</span>
        </div>
        <div class="points">
          <div><b class="num">${t.honor}</b><span>榮譽總分</span></div>
          <div><b class="num">${t.balance}</b><span>可用點數</span></div>
          <div><b class="num">${t.sessionIds.length}</b><span>出席堂數</span></div>
        </div>
        ${App.isStaff()
          ? html`<div class="card-actions">
              ${checked
                ? html`<button type="button" class="btn btn-soft" disabled>✅ 已報到</button>`
                : html`<button type="button" class="btn btn-ok" data-action="checkin" data-id="${s.id}">⏰ 報到</button>`}
              <button type="button" class="btn btn-primary" data-action="open-student" data-id="${s.id}">＋ 加減分</button>
            </div>`
          : checked ? html`<span class="chip chip-ok">✅ 本堂已報到</span>` : ''}
      </div>`;
  }

  App.views.checkin = {
    order: 1,
    icon: '✅',
    label: function () { return App.isStaff() ? '點名加分' : '出席'; },
    render: function () {
      const cls = App.cls();
      const session = App.session();
      const all = App.students(cls.id);
      const list = filtered(cls, session);
      const reversed = reversedSet();
      const sessionLogs = session
        ? App.s.data.logs.filter(function (l) { return l.sessionId === session.id; }).slice().reverse()
        : [];
      const present = session ? all.filter(function (s) { return AttendStore.isCheckedIn(App.s.data, s.id, session.id); }).length : 0;
      const gained = sessionLogs.reduce(function (sum, l) { return sum + (l.honorDelta > 0 ? l.honorDelta : 0); }, 0);
      const totals = App.totals();
      const avg = all.length ? Math.round(all.reduce(function (sum, s) { return sum + totals[s.id].honor; }, 0) / all.length) : 0;

      return html`
        <div class="stats">
          <div class="card stat"><div class="label">本堂出席</div><div class="value num">${present} / ${all.length}</div></div>
          <div class="card stat"><div class="label">本堂加分</div><div class="value num">+${gained}</div></div>
          <div class="card stat"><div class="label">平均榮譽分</div><div class="value num">${avg}</div></div>
        </div>

        ${App.isStaff() ? staffDutyCard(cls, session) : ''}

        <div class="toolbar">
          <input class="input" type="search" placeholder="🔍 搜尋姓名或學號" value="${App.s.search}" data-input="search" />
          ${App.isStaff() ? html`<button type="button" class="btn" data-action="open-batch">👥 ${cls.teams.length ? '小隊／全體' : '全體'}加減分</button>` : ''}
        </div>
        <div class="toolbar">
          ${cls.teams.length ? html`<div class="pills">
            <button type="button" class="pill ${App.s.teamFilter === 'all' ? 'active' : ''}" data-action="team-filter" data-id="all">全部小隊</button>
            ${cls.teams.map(function (t) {
              return html`<button type="button" class="pill ${App.s.teamFilter === t.id ? 'active' : ''}" data-action="team-filter" data-id="${t.id}">${t.name}</button>`;
            })}
          </div>` : ''}
          <div class="pills">
            ${[['all', '全部'], ['in', '已報到'], ['out', '未報到']].map(function (p) {
              return html`<button type="button" class="pill ${App.s.statusFilter === p[0] ? 'active' : ''}" data-action="status-filter" data-id="${p[0]}">${p[1]}</button>`;
            })}
          </div>
        </div>

        ${list.length
          ? html`<div class="student-grid" id="studentGrid">${list.map(function (s) { return studentCard(s, session); })}</div>`
          : html`<div class="card empty"><span class="big">🙏</span>${all.length ? '沒有符合條件的學員' : '這個班還沒有學員'}
              ${!all.length && App.isStaff() ? html`<p><button type="button" class="btn btn-primary" data-action="switch-tab" data-tab="roster">前往名冊新增學員</button></p>` : ''}</div>`}

        <div class="section-title"><h2>📋 本堂紀錄</h2><span class="faint">${session ? App.dateLabel(session.date) : ''}</span></div>
        <div class="card list">
          ${sessionLogs.length
            ? sessionLogs.slice(0, 50).map(function (l) { return App.logItem(l, reversed, true); })
            : html`<div class="empty">這堂課還沒有紀錄</div>`}
        </div>`;
    }
  };

  // 搜尋只隱藏卡片，不重畫，避免輸入框失去焦點
  function applySearch() {
    const q = App.s.search.trim().toLowerCase();
    App.$$('#studentGrid [data-search]').forEach(function (card) {
      card.hidden = !!q && card.dataset.search.indexOf(q) === -1;
    });
  }
  const originalRender = App.render;
  App.render = function () {
    originalRender();
    applySearch();
  };

  // ---------- 動作 ----------

  function afterAccepted(p, message, tone, sound) {
    if (p.accepted) {
      App.sound(sound || 'ok');
      App.toast(message, tone);
    }
    return p;
  }

  Object.assign(App.actions, {
    search: function (el) {
      App.s.search = el.value;
      applySearch();
    },
    'team-filter': function (el) {
      App.s.teamFilter = el.dataset.id;
      App.render();
    },
    'status-filter': function (el) {
      App.s.statusFilter = el.dataset.id;
      App.render();
    },
    checkin: function (el) {
      const s = App.studentById(el.dataset.id);
      el.disabled = true;
      // 只送上課日期：當天還沒有課次時由同一個操作建立，畫面不必先等後端
      const p = App.run({ type: 'points.checkin', studentId: s.id, date: App.s.date });
      afterAccepted(p, `🎉 ${s.name} 報到成功！`, 'ok');
    },
    'award-rule': function (el) {
      const s = App.studentById(el.dataset.id);
      const rule = el.dataset.rule;
      const label = el.dataset.label;
      const points = Number(el.dataset.points);
      const p = App.run({ type: 'points.award', studentId: s.id, date: App.s.date, ruleId: rule });
      afterAccepted(p, points > 0 ? `🎉 ${s.name}「${label}」+${points}` : `⚠️ ${s.name}「${label}」${points}`, points > 0 ? 'ok' : 'warn', points > 0 ? 'ok' : 'deduct');
    },
    'award-custom': function (el) {
      const box = el.closest('[data-custom]');
      const s = App.studentById(box.dataset.id);
      const raw = Math.abs(parseInt(box.querySelector('[name=points]').value, 10) || 0);
      const reason = box.querySelector('[name=reason]').value.trim();
      if (!raw) return App.toast('⚠️ 請輸入分數', 'warn');
      if (!reason) return App.toast('⚠️ 請輸入事由', 'warn');
      const points = Number(el.dataset.sign) * raw;
      const p = App.run({ type: 'points.award', studentId: s.id, date: App.s.date, points: points, reason: reason });
      afterAccepted(p, `${points > 0 ? '🎉' : '⚠️'} ${s.name}「${reason}」${points > 0 ? '+' : ''}${points}`, points > 0 ? 'ok' : 'warn', points > 0 ? 'ok' : 'deduct');
    },
    undo: function (el) {
      const log = App.s.data.logs.find(function (l) { return l.id === el.dataset.log; });
      if (!log) return;
      App.confirm(`確定要撤銷「${log.reason}」這筆紀錄嗎？\n撤銷後會保留一筆撤銷紀錄。`, { okLabel: '撤銷' }).then(function (yes) {
        if (!yes) return;
        App.run({ type: 'log.reverse', logId: log.id }).then(function () {
          App.toast('↩️ 已撤銷「' + log.reason + '」');
        });
      });
    },
    'staff-duty': function (el) {
      const person = App.s.data.staff.find(function (p) { return p.id === el.dataset.id; });
      const session = App.session();
      const on = !(session && session.dutyStaffIds.indexOf(person.id) !== -1);
      const p = App.run({ type: 'session.duty', classId: App.s.classId, staffId: person.id, date: App.s.date, on: on });
      afterAccepted(p, on ? `🙋 ${person.name} 已到` : `已取消 ${person.name} 的出席`, on ? 'ok' : '');
    },
    'open-student': function (el) { App.openStudent(el.dataset.id); },
    'open-batch': function () { openBatch(); }
  });

  // ---------- 學員小卡 ----------

  App.openStudent = function (id) {
    App.modal({
      title: '學員小卡',
      render: function () {
        const s = App.studentById(id);
        if (!s || s.deletedAt) return html`<div class="empty">這位學員已不在名冊中</div>`;
        const cls = App.classById(s.classId);
        const t = App.studentTotals(s.id);
        const rank = App.rank(t.honor);
        const session = App.session();
        const sameClass = App.s.classId === s.classId;
        const checked = session && AttendStore.isCheckedIn(App.s.data, s.id, session.id);
        const reversed = reversedSet();
        const logs = App.s.data.logs.filter(function (l) { return l.studentId === s.id; }).slice().reverse();
        const classSessions = AttendStore.active(App.s.data.sessions)
          .filter(function (x) { return x.classId === s.classId && x.date <= App.today(); }).length;
        return html`
          <div class="spread">
            <div>
              <h3 style="font-size:22px">${s.name}</h3>
              <div class="row"><span class="faint">${s.id}</span><span class="chip chip-theme">${cls ? cls.name : ''}${App.teamName(s) ? '・' + App.teamName(s) : ''}</span><span class="chip ${rank.cls}">${rank.title}</span></div>
            </div>
          </div>
          <div class="stats" style="margin:0">
            <div class="card stat"><div class="label">榮譽總分</div><div class="value num">${t.honor}</div></div>
            <div class="card stat"><div class="label">可用點數</div><div class="value num">${t.balance}</div></div>
            <div class="card stat"><div class="label">出席</div><div class="value num">${t.sessionIds.length}<small class="faint"> / ${classSessions}</small></div></div>
          </div>
          ${s.note && App.isStaff() ? html`<div class="card card-pad faint">📝 ${s.note}</div>` : ''}

          ${App.isStaff() && cls && sameClass ? html`
            <div class="stack">
              ${checked
                ? html`<span class="chip chip-ok">✅ ${App.dateLabel(App.s.date)} 已報到</span>`
                : html`<button type="button" class="btn btn-ok btn-block" data-action="checkin" data-id="${s.id}">⏰ ${App.dateLabel(App.s.date)} 報到</button>`}
              <div class="label faint">加分</div>
              <div class="rule-grid">
                ${cls.addRules.filter(function (r) { return !r.isCheckin; }).map(function (r) {
                  return html`<button type="button" class="btn rule-btn add" data-action="award-rule" data-id="${s.id}" data-rule="${r.id}" data-label="${r.label}" data-points="${r.points}"><span>${r.icon} ${r.label}</span><b>+${r.points}</b></button>`;
                })}
              </div>
              <div class="label faint">扣分</div>
              <div class="rule-grid">
                ${cls.deductRules.map(function (r) {
                  return html`<button type="button" class="btn rule-btn deduct" data-action="award-rule" data-id="${s.id}" data-rule="${r.id}" data-label="${r.label}" data-points="${-r.points}"><span>${r.icon} ${r.label}</span><b>−${r.points}</b></button>`;
                })}
              </div>
              <div class="card card-pad stack" data-custom data-id="${s.id}">
                <div class="label faint">自訂加減分</div>
                <div class="row">
                  <input class="input" name="points" type="number" min="1" max="1000" placeholder="分數" style="width:90px" />
                  <input class="input grow" name="reason" placeholder="事由（例如：主動幫忙收拾）" maxlength="60" />
                </div>
                <div class="btn-row">
                  <button type="button" class="btn btn-ok" data-action="award-custom" data-sign="1">＋ 加分</button>
                  <button type="button" class="btn btn-danger" data-action="award-custom" data-sign="-1">− 扣分</button>
                </div>
              </div>
            </div>` : ''}
          ${App.isStaff() && !sameClass ? html`<p class="faint">切換到「${cls ? cls.name : ''}」才能為這位學員點名加分。</p>` : ''}

          <div class="label faint">歷史紀錄（${logs.length} 筆）</div>
          <div class="card list">
            ${logs.length ? logs.map(function (l) { return App.logItem(l, reversed, false); }) : html`<div class="empty">還沒有紀錄</div>`}
          </div>`;
      }
    });
  };

  // ---------- 小隊／全體加減分 ----------

  function openBatch() {
    const cls = App.cls();
    App.modal({
      title: cls.teams.length ? '小隊／全體加減分' : '全體加減分',
      body: html`
        <form class="stack">
          <div class="field">
            <label>對象</label>
            <select class="select" name="target">
              <option value="checkedIn">本堂已報到的學員</option>
              <option value="all">全班學員</option>
              ${cls.teams.map(function (t) { return html`<option value="team:${t.id}">${t.name}</option>`; })}
            </select>
          </div>
          <div class="field">
            <label>分數</label>
            <div class="row">
              <input class="input" name="points" type="number" min="1" max="1000" value="10" style="width:100px" />
              ${[5, 10, 20, 30].map(function (n) { return html`<button type="button" class="btn btn-sm" data-preset="${n}">${n}</button>`; })}
            </div>
          </div>
          <div class="field">
            <label>事由</label>
            <input class="input" name="reason" maxlength="60" placeholder="例如：小隊競賽第一名、秩序良好" />
          </div>
          <div class="btn-row">
            <button type="submit" class="btn btn-ok grow" data-sign="1">＋ 全體加分</button>
            <button type="submit" class="btn btn-danger grow" data-sign="-1">− 全體扣分</button>
          </div>
        </form>`,
      onMount: function (el, close) {
        const form = el.querySelector('form');
        el.addEventListener('click', function (e) {
          const preset = e.target.closest('[data-preset]');
          if (preset) form.points.value = preset.dataset.preset;
        });
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          const sign = Number((e.submitter && e.submitter.dataset.sign) || 1);
          const f = App.formData(form);
          const points = sign * Math.abs(parseInt(f.points, 10) || 0);
          if (!points) return App.toast('⚠️ 請輸入分數', 'warn');
          const reason = f.reason.trim() || (sign > 0 ? '小隊團體加分' : '小隊團體扣分');
          const target = f.target === 'checkedIn' ? { checkedIn: true } : f.target === 'all' ? { all: true } : { teamId: f.target.slice(5) };
          const p = App.run({ type: 'points.batch', classId: cls.id, date: App.s.date, points: points, reason: reason, target: target });
          if (p.accepted) {
            close();
            p.then(function (res) {
              App.sound(points > 0 ? 'ok' : 'deduct');
              App.toast(`${points > 0 ? '⚡' : '⚠️'} 已為 ${res.result.count} 位學員${points > 0 ? '加' : '扣'} ${Math.abs(points)} 分`, points > 0 ? 'ok' : 'warn');
            });
          }
        });
      }
    });
  }
})(window.App = window.App || {});
