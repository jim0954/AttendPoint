/* 班務管理：班別設定（小隊、加扣分規則、常態時間）、課次與執勤、服務人員 */
(function (App) {
  'use strict';
  const html = App.html;

  const THEMES = [['amber', '琥珀'], ['emerald', '翠綠'], ['sky', '天藍'], ['rose', '玫瑰'], ['violet', '紫羅蘭'], ['stone', '石墨']];
  const ROLES = AttendStore.STAFF_ROLES;
  const SECTIONS = [['classes', '🏫 班別設定'], ['sessions', '🗓️ 課次與執勤'], ['staff', '🙋 服務人員']];

  App.s.manageSection = 'classes';

  App.views.manage = {
    order: 5,
    icon: '⚙️',
    label: '班務管理',
    minRole: 'staff',
    needsClass: false,
    render: function () {
      const sec = App.s.manageSection;
      const body = sec === 'sessions' ? renderSessions() : sec === 'staff' ? renderStaff() : renderClasses();
      return html`
        <div class="pills" style="margin-bottom:12px">
          ${SECTIONS.map(function (s) {
            return html`<button type="button" class="pill ${sec === s[0] ? 'active' : ''}" data-action="manage-section" data-id="${s[0]}">${s[1]}</button>`;
          })}
        </div>
        ${body}`;
    }
  };

  App.actions['manage-section'] = function (el) {
    App.s.manageSection = el.dataset.id;
    App.render();
  };

  // ---------- 班別 ----------

  const scheduleText = App.scheduleText;

  function renderClasses() {
    const classes = App.classes();
    return html`
      <div class="toolbar"><button type="button" class="btn btn-primary" data-action="new-class">＋ 新增班別</button></div>
      <div class="stack">
        ${classes.map(function (c) {
          return html`
            <div class="card card-pad stack" data-theme="${c.themeColor}">
              <div class="spread">
                <div><b style="font-size:17px">${c.icon} ${c.name}</b> <span class="chip chip-theme">學號 ${c.idPrefix}01…</span></div>
                <div class="btn-row">
                  <button type="button" class="btn btn-sm" data-action="edit-class" data-id="${c.id}">✏️ 編輯</button>
                  ${App.can({ type: 'class.delete', id: c.id }) ? html`<button type="button" class="btn btn-sm" data-action="delete-class" data-id="${c.id}">🗑️</button>` : ''}
                </div>
              </div>
              <div class="faint">🕘 ${scheduleText(c)}・👥 ${App.students(c.id).length} 位學員</div>
              <div class="row">${c.teams.length ? c.teams.map(function (t) { return html`<span class="chip">${t.name}</span>`; }) : html`<span class="faint">不分小隊</span>`}</div>
              <div class="row">
                ${c.addRules.map(function (r) { return html`<span class="chip chip-ok">${r.icon} ${r.label} +${r.points}${r.isCheckin ? '（報到）' : ''}</span>`; })}
                ${c.deductRules.map(function (r) { return html`<span class="chip chip-warn">${r.icon} ${r.label} −${r.points}</span>`; })}
              </div>
            </div>`;
        })}
        ${classes.length ? '' : html`<div class="card empty">還沒有班別</div>`}
      </div>`;
  }

  function teamRow(t, removable) {
    return html`
      <div class="row" data-row="team" data-id="${t ? t.id : ''}">
        <input class="input grow" data-f="name" value="${t ? t.name : ''}" maxlength="20" placeholder="小隊名稱" />
        ${removable ? html`<button type="button" class="btn btn-sm" data-remove>✕</button>` : ''}
      </div>`;
  }

  function slotRow(slot) {
    slot = slot || { weekday: 6, nth: 0, start: '', end: '' };
    return html`
      <div class="row" data-row="slot">
        <select class="select" data-f="nth" style="width:auto">
          ${App.NTH_OPTIONS.map(function (o) { return html`<option value="${o[0]}" ${(slot.nth || 0) === o[0] ? 'selected' : ''}>${o[1]}</option>`; })}
        </select>
        <select class="select" data-f="weekday" style="width:auto">
          ${[1, 2, 3, 4, 5, 6, 0].map(function (d) { return html`<option value="${d}" ${slot.weekday === d ? 'selected' : ''}>${App.weekdayName(d)}</option>`; })}
        </select>
        <input class="input" data-f="start" type="time" value="${slot.start}" style="width:auto" /> –
        <input class="input" data-f="end" type="time" value="${slot.end}" style="width:auto" />
        <button type="button" class="btn btn-sm" data-remove>✕</button>
      </div>`;
  }

  function ruleRow(kind, r, removable) {
    return html`
      <div class="row" data-row="${kind}" data-id="${r ? r.id : ''}">
        <input class="input" data-f="icon" value="${r ? r.icon : ''}" maxlength="8" placeholder="圖示" style="width:64px" />
        <input class="input grow" data-f="label" value="${r ? r.label : ''}" maxlength="40" placeholder="${kind === 'add' ? '加分項目' : '扣分項目'}" />
        <input class="input" data-f="points" type="number" min="1" value="${r ? r.points : 5}" style="width:76px" />
        ${kind === 'add' ? html`<label class="check"><input type="checkbox" data-f="isCheckin" ${r && r.isCheckin ? 'checked' : ''} />報到</label>` : ''}
        ${removable ? html`<button type="button" class="btn btn-sm" data-remove>✕</button>` : ''}
      </div>`;
  }

  function collectRows(m, kind) {
    return App.$$('[data-row="' + kind + '"]', m).map(function (row) {
      const get = function (f) { const el = row.querySelector('[data-f="' + f + '"]'); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
      if (kind === 'slot') {
        return { weekday: Number(get('weekday')), nth: Number(get('nth')), start: get('start'), end: get('end') };
      }
      const out = row.dataset.id ? { id: row.dataset.id } : {};
      if (kind === 'team') out.name = get('name');
      else {
        out.label = get('label');
        out.points = Number(get('points'));
        out.icon = get('icon');
        if (kind === 'add') out.isCheckin = get('isCheckin');
      }
      return out;
    }).filter(function (x) { return kind === 'slot' || (kind === 'team' ? x.name.trim() : x.label.trim()); });
  }

  function openClassEditor(cls) {
    const owner = App.isOwner();
    App.modal({
      title: cls ? '編輯班別：' + cls.name : '新增班別',
      body: html`
        <form class="stack" data-class-form>
          <div class="form-grid">
            <div class="field"><label>班名</label><input class="input" name="name" value="${cls ? cls.name : ''}" maxlength="30" placeholder="例如：幼幼班" autofocus /></div>
            <div class="field"><label>學號前綴（1–3 碼英數）</label><input class="input" name="idPrefix" value="${cls ? cls.idPrefix : ''}" maxlength="3" placeholder="例如：B" /></div>
            <div class="field"><label>圖示（emoji）</label><input class="input" name="icon" value="${cls ? cls.icon : '📚'}" maxlength="8" /></div>
            <div class="field"><label>主題色</label>
              <select class="select" name="themeColor">${THEMES.map(function (t) { return html`<option value="${t[0]}" ${cls && cls.themeColor === t[0] ? 'selected' : ''}>${t[1]}</option>`; })}</select>
            </div>
          </div>

          <div class="stack" data-list="slot">
            <div class="spread"><b>常態上課時間（選填）</b><button type="button" class="btn btn-sm" data-add="slot">＋ 時段</button></div>
            <span class="hint">可以設定多個時段，例如「每月第 1 個 週六」加上「每月第 3 個 週日」，各自有不同時間。</span>
            ${((cls && cls.schedule) || []).map(slotRow)}
          </div>

          <div class="stack" data-list="team">
            <div class="spread"><b>小隊（選填）</b><button type="button" class="btn btn-sm" data-add="team">＋ 小隊</button></div>
            <span class="hint">不需要分小隊的班別，這裡留空即可。</span>
            ${(cls ? cls.teams : []).map(function (t) { return teamRow(t, owner || !cls); })}
          </div>

          <div class="stack" data-list="add">
            <div class="spread"><b>加分項目</b><button type="button" class="btn btn-sm" data-add="add">＋ 加分項目</button></div>
            <span class="hint">勾選「報到」的項目會在點名時自動加分（每班一項）。</span>
            ${(cls ? cls.addRules : [{ label: '準時報到', points: 10, icon: '⏰', isCheckin: true }]).map(function (r) { return ruleRow('add', r, owner || !cls); })}
          </div>

          <div class="stack" data-list="deduct">
            <div class="spread"><b>扣分項目</b><button type="button" class="btn btn-sm" data-add="deduct">＋ 扣分項目</button></div>
            ${(cls ? cls.deductRules : []).map(function (r) { return ruleRow('deduct', r, owner || !cls); })}
          </div>
          ${cls && !owner ? html`<span class="hint">壇務可以修改名稱與新增項目；移除既有的小隊或項目請洽擁有者。</span>` : ''}
          <button type="submit" class="btn btn-primary">儲存班別</button>
        </form>`,
      onMount: function (m, close) {
        m.addEventListener('click', function (e) {
          const add = e.target.closest('[data-add]');
          if (add) {
            const kind = add.dataset.add;
            const tpl = document.createElement('div');
            tpl.innerHTML = String(kind === 'slot' ? slotRow(null) : kind === 'team' ? teamRow(null, true) : ruleRow(kind, null, true));
            m.querySelector('[data-list="' + kind + '"]').appendChild(tpl.firstElementChild);
          }
          const rm = e.target.closest('[data-remove]');
          if (rm) rm.closest('[data-row]').remove();
        });
        m.querySelector('form').addEventListener('submit', function (e) {
          e.preventDefault();
          const f = App.formData(m.querySelector('.form-grid'));
          const fields = {
            name: f.name,
            idPrefix: f.idPrefix,
            icon: f.icon,
            themeColor: f.themeColor,
            schedule: collectRows(m, 'slot'),
            teams: collectRows(m, 'team'),
            addRules: collectRows(m, 'add'),
            deductRules: collectRows(m, 'deduct')
          };
          const op = cls ? { type: 'class.update', id: cls.id, patch: fields } : Object.assign({ type: 'class.create' }, fields);
          App.run(op).then(function (res) {
            close();
            if (!cls) App.s.classId = res.result.id;
            App.render();
            App.toast('🏫 已儲存「' + f.name + '」', 'ok');
          });
        });
      }
    });
  }

  Object.assign(App.actions, {
    'new-class': function () { openClassEditor(null); },
    'edit-class': function (el) { openClassEditor(App.classById(el.dataset.id)); },
    'delete-class': function (el) {
      const cls = App.classById(el.dataset.id);
      const members = App.students(cls.id);
      const others = App.classes().filter(function (c) { return c.id !== cls.id; });
      if (!members.length) {
        App.confirm(`確定要刪除班別「${cls.name}」嗎？\n會移到回收區，可以還原。`, { danger: true, okLabel: '刪除' }).then(function (yes) {
          if (yes) App.run({ type: 'class.delete', id: cls.id }).then(function () { App.toast('🗑️ 已刪除班別'); });
        });
        return;
      }
      App.modal({
        title: '刪除班別：' + cls.name,
        body: html`
          <p style="margin:0">這個班還有 <b>${members.length}</b> 位學員，請選擇處理方式：</p>
          <form class="stack">
            ${others.length ? html`
              <label class="check"><input type="radio" name="mode" value="move" checked /> 轉到其他班別</label>
              <select class="select" name="target">
                ${others.map(function (c) {
                  return [html`<option value="${c.id}|">${c.name}（不分小隊）</option>`].concat(c.teams.map(function (t) { return html`<option value="${c.id}|${t.id}">${c.name}・${t.name}</option>`; }));
                })}
              </select>` : ''}
            <label class="check"><input type="radio" name="mode" value="delete" ${others.length ? '' : 'checked'} /> 學員一併移到回收區</label>
            <button type="submit" class="btn btn-danger">確定刪除班別</button>
          </form>`,
        onMount: function (m, close) {
          m.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            const form = e.target;
            const mode = form.querySelector('[name=mode]:checked').value;
            const op = { type: 'class.delete', id: cls.id };
            if (mode === 'move') {
              const parts = form.target.value.split('|');
              op.moveStudentsTo = { classId: parts[0], teamId: parts[1] };
            } else op.deleteStudents = true;
            App.run(op).then(function () {
              close();
              App.toast('🗑️ 已刪除班別「' + cls.name + '」');
            });
          });
        }
      });
    }
  });

  // ---------- 課次 ----------

  function staffName(id) {
    const p = App.s.data.staff.find(function (x) { return x.id === id; });
    return p ? p.name : '';
  }

  function renderSessions() {
    const cls = App.cls();
    if (!cls) return html`<div class="card empty">請先建立班別</div>`;
    const sessions = AttendStore.active(App.s.data.sessions)
      .filter(function (s) { return s.classId === cls.id; })
      .sort(function (a, b) { return b.date.localeCompare(a.date) || (b.start || '').localeCompare(a.start || ''); });
    const totals = App.totals();
    const attendance = {};
    Object.keys(totals).forEach(function (id) {
      totals[id].sessionIds.forEach(function (sid) { attendance[sid] = (attendance[sid] || 0) + 1; });
    });
    return html`
      <div class="toolbar">
        <button type="button" class="btn btn-primary" data-action="new-session">＋ 新增課次</button>
        ${cls.schedule && cls.schedule.length ? html`<button type="button" class="btn" data-action="generate-sessions">📅 依常態時間產生課表</button>` : ''}
        <span class="faint">${cls.name}・常態：${scheduleText(cls)}</span>
      </div>
      <div class="card list">
        ${sessions.map(function (s) {
          return html`
            <div class="list-item">
              <div class="grow">
                <b>${App.dateLabel(s.date)}</b> <span class="faint">${s.date.slice(0, 4)}</span> ${App.timeRange(s)}
                ${s.topic ? html`<div>📖 ${s.topic}</div>` : ''}
                <div class="faint">出席 ${attendance[s.id] || 0} 人${s.dutyStaffIds.length ? html`・執勤：${s.dutyStaffIds.map(staffName).join('、')}` : ''}</div>
              </div>
              <button type="button" class="btn btn-sm" data-action="edit-session" data-id="${s.id}">✏️</button>
              ${App.can({ type: 'session.delete', id: s.id }) ? html`<button type="button" class="btn btn-sm" data-action="delete-session" data-id="${s.id}">🗑️</button>` : ''}
            </div>`;
        })}
        ${sessions.length ? '' : html`<div class="empty">還沒有課次。點名時會自動建立當天的課次，也可以先排好課表。</div>`}
      </div>`;
  }

  /** 新課次的預設日期：從目前日期起，下一個還沒有課次的常態上課日（沒有常態時間就每 7 天找） */
  function nextFreeDate(cls) {
    const free = function (d) { return !AttendStore.findSession(App.s.data, cls.id, d); };
    const found = AttendStore.upcomingDates(cls, App.s.date, 60).find(free);
    if (found) return found;
    for (let i = 0; i < 60; i++) {
      const d = AttendStore.addDays(App.s.date, i * 7);
      if (free(d)) return d;
    }
    return App.s.date;
  }

  function openSessionEditor(session, date) {
    const cls = App.classById(session ? session.classId : App.s.classId);
    const day = date || nextFreeDate(cls);
    const slot = AttendStore.scheduleSlotFor(cls, day) || (cls.schedule || [])[0] || {};
    const s = session || { date: day, start: slot.start, end: slot.end, topic: '', dutyStaffIds: [] };
    const staff = App.staffList().slice().sort(function (a, b) {
      const ai = a.classIds.indexOf(cls.id) !== -1 ? 0 : 1;
      const bi = b.classIds.indexOf(cls.id) !== -1 ? 0 : 1;
      return ai - bi || a.name.localeCompare(b.name);
    });
    App.modal({
      title: (session ? '編輯課次' : '新增課次') + '・' + cls.name,
      body: html`
        <form class="form-grid">
          <div class="field"><label>上課日期</label><input class="input" name="date" type="date" value="${s.date}" /></div>
          <div class="field"><label>時間</label>
            <div class="row"><input class="input" name="start" type="time" value="${s.start || ''}" style="width:auto" /> – <input class="input" name="end" type="time" value="${s.end || ''}" style="width:auto" /></div>
          </div>
          <div class="field full"><label>課程主題／進度</label><input class="input" name="topic" value="${s.topic}" maxlength="100" placeholder="例如：弟子規 入則孝" /></div>
          <div class="field full">
            <span class="label">當日執勤服務人員</span>
            ${staff.length ? html`<div class="row">${staff.map(function (p) {
              return html`<label class="check chip"><input type="checkbox" data-staff value="${p.id}" ${s.dutyStaffIds.indexOf(p.id) !== -1 ? 'checked' : ''} />${p.name}${p.role ? html`<span class="faint">・${p.role}</span>` : ''}</label>`;
            })}</div>` : html`<span class="hint">還沒有服務人員名冊，可以到「服務人員」新增。</span>`}
          </div>
          ${session ? html`<span class="hint full">修改日期時，這堂課的點名與加分紀錄會一起移到新日期。</span>` : ''}
          <button type="submit" class="btn btn-primary full">儲存課次</button>
        </form>`,
      onMount: function (m, close) {
        m.querySelector('form').addEventListener('submit', function (e) {
          e.preventDefault();
          const f = App.formData(m);
          const duty = App.$$('[data-staff]', m).filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
          const op = { type: 'session.save', date: f.date, start: f.start, end: f.end, topic: f.topic, dutyStaffIds: duty };
          if (session) op.id = session.id;
          else op.classId = cls.id;
          App.run(op).then(function () {
            close();
            if (session && session.date === App.s.date) App.s.date = f.date; // 移動目前這堂課時，畫面跟著到新日期
            App.render();
            App.toast('🗓️ 已儲存課次', 'ok');
          });
        });
      }
    });
  }

  Object.assign(App.actions, {
    'generate-sessions': function () {
      const cls = App.cls();
      const from = App.today();
      const to = AttendStore.addDays(from, 90);
      App.modal({
        title: '依常態時間產生課表・' + cls.name,
        body: html`
          <p class="faint" style="margin:0">常態：${App.scheduleText(cls)}。已經有課次的日期會略過，產生後可以再個別修改主題與執勤。</p>
          <form class="form-grid">
            <div class="field"><label>從</label><input class="input" name="from" type="date" value="${from}" /></div>
            <div class="field"><label>到</label><input class="input" name="to" type="date" value="${to}" /></div>
            <div class="field full" data-preview></div>
            <button type="submit" class="btn btn-primary full">產生課次</button>
          </form>`,
        onMount: function (m, close) {
          const form = m.querySelector('form');
          function preview() {
            const f = App.formData(form);
            const dates = f.from && f.to ? AttendStore.upcomingDates(cls, f.from, 100).filter(function (d) { return d <= f.to; }) : [];
            App.setHtml(m.querySelector('[data-preview]'), dates.length
              ? html`<span class="hint">共 ${dates.length} 個上課日：${dates.slice(0, 12).map(App.dateLabel).join('、')}${dates.length > 12 ? '…' : ''}</span>`
              : html`<span class="hint">這段期間沒有符合的上課日</span>`);
          }
          form.addEventListener('change', preview);
          preview();
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            const f = App.formData(form);
            App.run({ type: 'session.generate', classId: cls.id, from: f.from, to: f.to }).then(function (res) {
              close();
              const r = res.result;
              App.toast(`📅 已產生 ${r.created} 堂課${r.skipped ? `（略過已存在的 ${r.skipped} 堂）` : ''}`, 'ok');
            });
          });
        }
      });
    },
    'new-session': function () { openSessionEditor(null); },
    'edit-session': function (el) {
      // 從課次列點選：編輯目前日期的課次，沒有就以目前日期建立
      const session = el.dataset.id ? App.sessionById(el.dataset.id) : App.session();
      openSessionEditor(session || null, App.s.date);
    },
    'delete-session': function (el) {
      const s = App.sessionById(el.dataset.id);
      App.confirm(`確定要刪除 ${s.date} 的課次嗎？\n有點名或加分紀錄的課次，需要先撤銷紀錄。`, { danger: true, okLabel: '刪除' }).then(function (yes) {
        if (yes) App.run({ type: 'session.delete', id: s.id }).then(function () { App.toast('🗑️ 已刪除課次'); });
      });
    }
  });

  // ---------- 服務人員 ----------

  function renderStaff() {
    const duty = AttendStore.computeStaffDuty(App.s.data);
    const list = App.staffList().slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    return html`
      <div class="toolbar">
        <button type="button" class="btn btn-primary" data-action="edit-staff">＋ 新增服務人員</button>
        <button type="button" class="btn" data-action="export-staff">📤 匯出護持表 CSV</button>
      </div>
      <div class="card list">
        ${list.map(function (p) {
          return html`
            <div class="list-item">
              <div class="grow">
                <b>${p.name}</b> ${p.role ? html`<span class="chip chip-theme">${p.role}</span>` : ''}
                <div class="faint">${p.classIds.length ? p.classIds.map(function (id) { const c = App.classById(id); return c ? c.name : ''; }).join('、') : '跨班支援'}・年度護持 ${duty[p.id] || 0} 堂</div>
                ${p.note ? html`<div class="faint">📝 ${p.note}</div>` : ''}
              </div>
              <button type="button" class="btn btn-sm" data-action="edit-staff" data-id="${p.id}">✏️</button>
              ${App.can({ type: 'staff.delete', id: p.id }) ? html`<button type="button" class="btn btn-sm" data-action="delete-staff" data-id="${p.id}">🗑️</button>` : ''}
            </div>`;
        })}
        ${list.length ? '' : html`<div class="empty">還沒有服務人員</div>`}
      </div>`;
  }

  Object.assign(App.actions, {
    'edit-staff': function (el) {
      const p = el.dataset.id ? App.s.data.staff.find(function (x) { return x.id === el.dataset.id; }) : null;
      App.modal({
        title: p ? '編輯服務人員' : '新增服務人員',
        body: html`
          <form class="form-grid">
            <div class="field"><label>姓名</label><input class="input" name="name" value="${p ? p.name : ''}" maxlength="20" autofocus /></div>
            <div class="field"><label>職務</label>
              <select class="select" name="role">
                <option value="" ${p && p.role ? '' : 'selected'}>（未填）</option>
                ${ROLES.map(function (r) { return html`<option value="${r}" ${p && p.role === r ? 'selected' : ''}>${r}</option>`; })}
                ${p && p.role && ROLES.indexOf(p.role) === -1 ? html`<option value="${p.role}" selected>${p.role}（舊）</option>` : ''}
              </select>
            </div>
            <div class="field full"><span class="label">所屬班別（都不勾 = 跨班支援）</span>
              <div class="row">${App.classes().map(function (c) {
                return html`<label class="check chip"><input type="checkbox" data-class value="${c.id}" ${p && p.classIds.indexOf(c.id) !== -1 ? 'checked' : ''} />${c.name}</label>`;
              })}</div>
            </div>
            <div class="field full"><label>備註</label><input class="input" name="note" value="${p ? p.note : ''}" maxlength="200" /></div>
            <button type="submit" class="btn btn-primary full">儲存</button>
          </form>`,
        onMount: function (m, close) {
          m.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            const f = App.formData(m);
            const classIds = App.$$('[data-class]', m).filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
            const fields = { name: f.name, role: f.role, note: f.note, classIds: classIds };
            const op = p ? { type: 'staff.update', id: p.id, patch: fields } : Object.assign({ type: 'staff.create' }, fields);
            App.run(op).then(function () {
              close();
              App.toast('🙋 已儲存 ' + f.name, 'ok');
            });
          });
        }
      });
    },
    'delete-staff': function (el) {
      const p = App.s.data.staff.find(function (x) { return x.id === el.dataset.id; });
      App.confirm(`確定要刪除服務人員「${p.name}」嗎？\n會移到回收區，過去的執勤紀錄保留。`, { danger: true, okLabel: '刪除' }).then(function (yes) {
        if (yes) App.run({ type: 'staff.delete', id: p.id }).then(function () { App.toast('🗑️ 已移到回收區'); });
      });
    },
    'export-staff': function () {
      const duty = AttendStore.computeStaffDuty(App.s.data);
      const rows = [['姓名', '職務', '所屬班別', '年度護持堂數', '執勤日期', '備註']];
      App.staffList().forEach(function (p) {
        const dates = AttendStore.active(App.s.data.sessions)
          .filter(function (s) { return s.dutyStaffIds.indexOf(p.id) !== -1; })
          .map(function (s) { const c = App.classById(s.classId); return s.date + (c ? '(' + c.name + ')' : ''); })
          .sort();
        rows.push([p.name, p.role, p.classIds.map(function (id) { const c = App.classById(id); return c ? c.name : ''; }).join('、') || '跨班支援', duty[p.id] || 0, dates.join(' '), p.note]);
      });
      App.download(`服務人員護持表_${App.today()}.csv`, App.toCsv(rows));
    }
  });
})(window.App = window.App || {});
