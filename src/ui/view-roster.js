/* 學員名冊：新增、編輯（換隊／升班）、刪除、批次匯入、匯出 CSV */
(function (App) {
  'use strict';
  const html = App.html;

  App.views.roster = {
    order: 4,
    icon: '📇',
    label: '學員名冊',
    minRole: 'staff',
    render: function () {
      const cls = App.cls();
      const totals = App.totals();
      const students = App.students(cls.id).slice().sort(function (a, b) { return a.id.localeCompare(b.id); });
      return html`
        <div class="toolbar">
          <button type="button" class="btn btn-primary" data-action="edit-student">＋ 新增學員</button>
          <button type="button" class="btn" data-action="import-students">📥 批次匯入</button>
          <button type="button" class="btn" data-action="export-roster">📤 匯出名冊 CSV</button>
          <button type="button" class="btn" data-action="export-logs">📤 匯出流水帳 CSV</button>
        </div>
        <div class="card table-wrap">
          <table class="table">
            <thead><tr><th>學號</th><th>姓名</th><th>小隊</th><th>榮譽</th><th>可用</th><th>出席</th><th>備註</th><th></th></tr></thead>
            <tbody>
              ${students.map(function (s) {
                const t = totals[s.id];
                return html`
                  <tr>
                    <td class="faint">${s.id}</td>
                    <td><b>${s.name}</b></td>
                    <td>${App.teamName(s)}</td>
                    <td class="num">${t.honor}</td>
                    <td class="num">${t.balance}</td>
                    <td class="num">${t.sessionIds.length}</td>
                    <td class="faint" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${s.note}</td>
                    <td>
                      <button type="button" class="btn btn-sm" data-action="edit-student" data-id="${s.id}">✏️ 編輯</button>
                      ${App.can({ type: 'student.delete', id: s.id }) ? html`<button type="button" class="btn btn-sm" data-action="delete-student" data-id="${s.id}">🗑️</button>` : ''}
                    </td>
                  </tr>`;
              })}
            </tbody>
          </table>
          ${students.length ? '' : html`<div class="empty">這個班還沒有學員，點「新增學員」或「批次匯入」開始建立名冊</div>`}
        </div>`;
    }
  };

  function teamOptions(cls, selected) {
    return cls.teams.map(function (t) {
      return html`<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${t.name}</option>`;
    });
  }

  Object.assign(App.actions, {
    'edit-student': function (el) {
      const s = el.dataset.id ? App.studentById(el.dataset.id) : null;
      const cls = s ? App.classById(s.classId) : App.cls();
      const classes = App.classes();
      const canAdjust = s && App.can({ type: 'points.adjust', studentId: s.id });
      App.modal({
        title: s ? '編輯學員：' + s.name : '新增學員',
        body: html`
          <form class="form-grid">
            <div class="field"><label>姓名</label><input class="input" name="name" value="${s ? s.name : ''}" maxlength="20" autofocus /></div>
            <div class="field">
              <label>學號</label>
              ${s ? html`<input class="input" value="${s.id}" disabled />` : html`<input class="input" name="id" maxlength="12" placeholder="留空自動產生（${AttendStore.nextStudentId(App.s.data, cls.id)}）" />`}
            </div>
            <div class="field">
              <label>班別${s ? '（可升班）' : ''}</label>
              <select class="select" name="classId" data-class-select>
                ${classes.map(function (c) { return html`<option value="${c.id}" ${c.id === cls.id ? 'selected' : ''}>${c.name}</option>`; })}
              </select>
            </div>
            <div class="field"><label>小隊</label><select class="select" name="teamId" data-team-select>${teamOptions(cls, s && s.teamId)}</select></div>
            <div class="field full"><label>備註（家長聯絡、注意事項，訪客看不到）</label><textarea class="textarea" name="note" maxlength="200">${s ? s.note : ''}</textarea></div>
            <button type="submit" class="btn btn-primary full">儲存</button>
          </form>
          ${canAdjust ? html`
            <div class="card card-pad stack" data-adjust>
              <b>👑 手動校正積分（僅擁有者）</b>
              <span class="hint">輸入要增減的數字（可為負數），例如補登紙本紀錄。會記一筆「校正」紀錄。</span>
              <div class="form-grid">
                <div class="field"><label>榮譽總分 ±</label><input class="input" name="honorDelta" type="number" value="0" /></div>
                <div class="field"><label>可用點數 ±</label><input class="input" name="balanceDelta" type="number" value="0" /></div>
                <div class="field full"><label>校正原因</label><input class="input" name="reason" maxlength="60" /></div>
              </div>
              <button type="button" class="btn" data-adjust-btn>套用校正</button>
            </div>` : ''}`,
        onMount: function (m, close) {
          const form = m.querySelector('form');
          form.querySelector('[data-class-select]').addEventListener('change', function (e) {
            App.setHtml(form.querySelector('[data-team-select]'), teamOptions(App.classById(e.target.value)));
          });
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            const f = App.formData(form);
            const op = s
              ? { type: 'student.update', id: s.id, patch: { name: f.name, note: f.note, classId: f.classId, teamId: f.teamId } }
              : { type: 'student.create', classId: f.classId, teamId: f.teamId, name: f.name, note: f.note, id: f.id };
            App.run(op).then(function (res) {
              close();
              App.toast(s ? '✏️ 已更新 ' + f.name : `🙏 已新增 ${f.name}（${res.result.id}）`, 'ok');
            });
          });
          const adjust = m.querySelector('[data-adjust-btn]');
          if (adjust) {
            adjust.addEventListener('click', function () {
              const box = m.querySelector('[data-adjust]');
              const f = App.formData(box);
              App.run({ type: 'points.adjust', studentId: s.id, honorDelta: Number(f.honorDelta) || 0, balanceDelta: Number(f.balanceDelta) || 0, reason: f.reason }).then(function () {
                close();
                App.toast('👑 已校正 ' + s.name + ' 的積分', 'ok');
              });
            });
          }
        }
      });
    },

    'delete-student': function (el) {
      const s = App.studentById(el.dataset.id);
      App.confirm(`確定要刪除學員「${s.name}」（${s.id}）嗎？\n刪除後會移到回收區，紀錄保留，可以還原。`, { danger: true, okLabel: '刪除' }).then(function (yes) {
        if (yes) App.run({ type: 'student.delete', id: s.id }).then(function () { App.toast('🗑️ 已將 ' + s.name + ' 移到回收區'); });
      });
    },

    'import-students': function () {
      const cls = App.cls();
      App.modal({
        title: '批次匯入學員',
        body: html`
          <div class="hint">
            每行一位學員，欄位用逗號或 Tab 分隔（可直接從 Excel 或 LINE 複製貼上）：<br>
            ・<b>姓名</b><br>
            ・<b>小隊, 姓名</b><br>
            ・<b>班別, 小隊, 姓名, 學號, 備註</b>（學號、備註可省略）<br>
            沒寫班別的學員會加入「${cls.name}」；不存在的小隊會自動建立；同班同名的學員只會更新小隊與備註。
          </div>
          <div class="field">
            <label>選擇 CSV 檔</label>
            <input class="input" type="file" accept=".csv,.txt,text/csv" data-file />
          </div>
          <div class="field">
            <label>或直接貼上</label>
            <textarea class="textarea" data-text placeholder="孝順隊, 王小明&#10;仁愛隊, 陳小華"></textarea>
          </div>
          <div data-preview class="faint"></div>
          <div class="btn-row">
            <button type="button" class="btn" data-action="download-template">下載範本</button>
            <button type="button" class="btn btn-primary grow" data-import>開始匯入</button>
          </div>`,
        onMount: function (m, close) {
          const text = m.querySelector('[data-text]');
          const preview = m.querySelector('[data-preview]');
          function rows() {
            const all = App.parseCsv(text.value);
            const header = all[0] && /姓名|班別|小隊/.test(all[0].join(''));
            return (header ? all.slice(1) : all).map(function (c) {
              if (c.length >= 3) return { className: c[0], teamName: c[1], name: c[2], id: c[3], note: c[4] };
              if (c.length === 2) return { teamName: c[0], name: c[1] };
              return { name: c[0] };
            });
          }
          function updatePreview() {
            const r = rows();
            preview.textContent = r.length ? `共 ${r.length} 筆，例如：${r.slice(0, 3).map(function (x) { return x.name; }).join('、')}` : '';
          }
          text.addEventListener('input', updatePreview);
          m.querySelector('[data-file]').addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (file) App.readFile(file).then(function (t) { text.value = t; updatePreview(); });
          });
          m.querySelector('[data-import]').addEventListener('click', function () {
            const r = rows();
            if (!r.length) return App.toast('⚠️ 沒有可匯入的資料', 'warn');
            App.run({ type: 'student.import', defaultClassId: cls.id, rows: r }).then(function (res) {
              close();
              const x = res.result;
              App.toast(`📥 匯入完成：新增 ${x.added} 位、更新 ${x.updated} 位${x.skipped.length ? `、略過 ${x.skipped.length} 筆` : ''}`, 'ok');
              if (x.skipped.length) {
                App.modal({
                  title: '以下資料沒有匯入',
                  body: html`<div class="card list">${x.skipped.map(function (s) { return html`<div class="list-item">第 ${s.line} 筆：${s.reason}</div>`; })}</div>`
                });
              }
            });
          });
        }
      });
    },

    'download-template': function () {
      App.download('學員名冊範本.csv', App.toCsv([
        ['班別', '小隊', '姓名', '學號', '備註'],
        [App.cls().name, App.cls().teams[0].name, '王小明', '', '家長：王先生'],
        [App.cls().name, App.cls().teams[0].name, '陳小華', '', '']
      ]));
    },

    'export-roster': function () {
      const totals = App.totals();
      const rows = [['年度', '學號', '班別', '小隊', '姓名', '榮譽稱號', '出席堂數', '榮譽總分', '可用點數', '備註']];
      App.classes().forEach(function (c) {
        App.students(c.id).forEach(function (s) {
          const t = totals[s.id];
          rows.push([App.s.data.meta.yearLabel, s.id, c.name, App.teamName(s), s.name, App.rank(t.honor).title, t.sessionIds.length, t.honor, t.balance, s.note]);
        });
      });
      App.download(`學員總表_${App.today()}.csv`, App.toCsv(rows));
    },

    'export-logs': function () {
      const TYPE = { checkin: '報到', points: '加減分', redeem: '兌換', adjust: '校正', reversal: '撤銷' };
      const rows = [['時間', '上課日期', '類型', '班別', '學號', '姓名', '事由', '榮譽變動', '點數變動', '操作者']];
      App.s.data.logs.forEach(function (l) {
        const s = App.studentById(l.studentId);
        const c = App.classById(l.classId);
        const session = App.sessionById(l.sessionId);
        rows.push([l.at.replace('T', ' '), session ? session.date : '', TYPE[l.type] || l.type, c ? c.name : '', l.studentId, s ? s.name : '', l.reason, l.honorDelta, l.balanceDelta, l.operatorName || '']);
      });
      App.download(`流水帳_${App.today()}.csv`, App.toCsv(rows));
    }
  });
})(window.App = window.App || {});
