/* 擁有者後台：帳號、回收區、系統設定、備份與跨年度結算 */
(function (App) {
  'use strict';

  // ---------- 範例資料（單機版試用） ----------
  function sampleV2() {
    const today = App.today();
    const names = {
      kids: [['K01', '林小安', '孝順隊'], ['K02', '陳小晴', '孝順隊'], ['K03', '張小宇', '仁愛隊'], ['K04', '黃小恩', '仁愛隊'], ['K05', '李小翰', '智慧隊'], ['K06', '吳小潔', '智慧隊']],
      youth: [['Y01', '王小廷', '慈悲組'], ['Y02', '許小瑜', '慈悲組'], ['Y03', '劉小均', '精進組'], ['Y04', '蔡小蓁', '精進組'], ['Y05', '鄭小翔', '喜捨組'], ['Y06', '楊小晴', '喜捨組']]
    };
    const students = [];
    Object.keys(names).forEach(function (classType) {
      names[classType].forEach(function (n, i) {
        const honor = 60 + ((i * 37) % 200);
        students.push({ id: n[0], classType: classType, name: n[1], team: n[2], honorPoints: honor, availablePoints: honor - (i % 3) * 20, attendedDates: [] });
      });
    });
    return { templeTitle: '範例佛堂｜年度班程報到加分系統', yearLabel: today.slice(0, 4) + ' 年度', students: students, logs: [] };
  }

  App.actions['load-sample'] = function () {
    App.confirm('載入 12 位範例學員、兩個班別與禮品目錄，方便試用。\n之後可以在「擁有者」分頁清除或匯入正式資料。', { okLabel: '載入範例' }).then(function (yes) {
      if (!yes) return;
      App.s.backend.importState(JSON.stringify(sampleV2())).then(function (res) {
        App.loadData(res.state);
        App.render();
        App.toast('📦 已載入範例資料', 'ok');
      }, App.handleError);
    });
  };

  const html = App.html;
  const SECTIONS = [['users', '🔑 帳號管理'], ['trash', '🗑️ 回收區'], ['system', '🛠️ 系統與備份']];
  App.s.ownerSection = 'users';
  let usersCache = null;

  App.views.owner = {
    order: 6,
    icon: '👑',
    label: '擁有者',
    minRole: 'owner',
    needsClass: false,
    render: function () {
      const sec = App.s.ownerSection;
      return html`
        <div class="pills" style="margin-bottom:12px">
          ${SECTIONS.map(function (s) {
            return html`<button type="button" class="pill ${sec === s[0] ? 'active' : ''}" data-action="owner-section" data-id="${s[0]}">${s[1]}</button>`;
          })}
        </div>
        ${sec === 'trash' ? renderTrash() : sec === 'system' ? renderSystem() : renderUsers()}`;
    }
  };

  App.actions['owner-section'] = function (el) {
    App.s.ownerSection = el.dataset.id;
    if (el.dataset.id === 'users') usersCache = null;
    App.render();
  };

  // ---------- 帳號 ----------

  let loadingUsers = false;
  function loadUsers() {
    if (loadingUsers) return;
    loadingUsers = true;
    App.s.backend.listUsers().then(function (res) {
      loadingUsers = false;
      usersCache = res.users;
      App.render();
    }, function (err) {
      loadingUsers = false;
      App.handleError(err);
    });
  }

  function renderUsers() {
    if (!usersCache) {
      loadUsers();
      return html`<div class="card empty">讀取帳號中…</div>`;
    }
    const staff = App.staffList();
    return html`
      <div class="toolbar">
        <button type="button" class="btn btn-primary" data-action="new-user">＋ 新增壇務帳號</button>
        <span class="faint">每位服務人員一組 PIN，流水帳會記錄是誰操作的。</span>
      </div>
      <div class="card list">
        ${usersCache.map(function (u) {
          const linked = u.staffId ? staff.find(function (p) { return p.id === u.staffId; }) : null;
          return html`
            <div class="list-item">
              <div class="grow">
                <b>${u.name}</b> <span class="chip ${u.role === 'owner' ? 'chip-gift' : 'chip-theme'}">${u.roleLabel}</span>
                ${u.builtin ? html`<span class="chip">主帳號</span>` : ''}${u.disabled ? html`<span class="chip chip-warn">已停用</span>` : ''}
                ${linked ? html`<div class="faint">對應服務人員：${linked.name}</div>` : ''}
              </div>
              ${u.builtin ? html`<span class="faint">${App.s.backend.mode === 'gas' ? 'PIN 在 Script Properties 修改' : ''}</span>` : html`
                <button type="button" class="btn btn-sm" data-action="edit-user" data-id="${u.id}">✏️</button>
                <button type="button" class="btn btn-sm" data-action="reset-pin" data-id="${u.id}">🔑 重設 PIN</button>
                <button type="button" class="btn btn-sm" data-action="toggle-user" data-id="${u.id}">${u.disabled ? '啟用' : '停用'}</button>
                <button type="button" class="btn btn-sm" data-action="delete-user" data-id="${u.id}">🗑️</button>`}
            </div>`;
        })}
      </div>`;
  }

  function userOp(op, message) {
    return App.s.backend.userOp(op).then(function (res) {
      if (res.users) usersCache = res.users;
      App.render();
      App.toast(message, 'ok');
      return res;
    }, function (err) {
      App.handleError(err);
      throw err;
    });
  }

  function userForm(u) {
    const staff = App.staffList();
    return html`
      <form class="form-grid">
        <div class="field"><label>帳號名稱（登入時顯示）</label><input class="input" name="name" value="${u ? u.name : ''}" maxlength="20" autofocus /></div>
        <div class="field"><label>角色</label>
          <select class="select" name="role">
            <option value="staff" ${!u || u.role === 'staff' ? 'selected' : ''}>壇務（不能刪除）</option>
            <option value="owner" ${u && u.role === 'owner' ? 'selected' : ''}>擁有者（全部權限）</option>
          </select>
        </div>
        ${u ? '' : html`<div class="field"><label>PIN 碼（6–8 位數字）</label><input class="input" name="pin" type="password" inputmode="numeric" maxlength="8" /></div>`}
        <div class="field"><label>對應服務人員（選填）</label>
          <select class="select" name="staffId">
            <option value="">（無）</option>
            ${staff.map(function (p) { return html`<option value="${p.id}" ${u && u.staffId === p.id ? 'selected' : ''}>${p.name}</option>`; })}
          </select>
        </div>
        <button type="submit" class="btn btn-primary full">儲存</button>
      </form>`;
  }

  function findUser(id) { return (usersCache || []).find(function (u) { return u.id === id; }); }

  function noop() {}

  Object.assign(App.actions, {
    'new-user': function () {
      App.modal({
        title: '新增壇務帳號',
        body: userForm(null),
        onMount: function (m, close) {
          m.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            const f = App.formData(m);
            userOp({ type: 'user.create', name: f.name, role: f.role, pin: f.pin, staffId: f.staffId || null }, '🔑 已建立帳號「' + f.name + '」').then(close, noop);
          });
        }
      });
    },
    'edit-user': function (el) {
      const u = findUser(el.dataset.id);
      App.modal({
        title: '編輯帳號：' + u.name,
        body: userForm(u),
        onMount: function (m, close) {
          m.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            const f = App.formData(m);
            userOp({ type: 'user.update', id: u.id, patch: { name: f.name, role: f.role, staffId: f.staffId || null } }, '已更新帳號').then(close, noop);
          });
        }
      });
    },
    'reset-pin': function (el) {
      const u = findUser(el.dataset.id);
      App.modal({
        title: '重設 PIN：' + u.name,
        body: html`
          <form class="stack">
            <div class="field"><label>新的 PIN（6–8 位數字）</label><input class="input" name="pin" type="password" inputmode="numeric" maxlength="8" autofocus /></div>
            <button type="submit" class="btn btn-primary">重設</button>
          </form>`,
        onMount: function (m, close) {
          m.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            userOp({ type: 'user.resetPin', id: u.id, pin: App.formData(m).pin }, '🔑 已重設 ' + u.name + ' 的 PIN').then(close, noop);
          });
        }
      });
    },
    'toggle-user': function (el) {
      const u = findUser(el.dataset.id);
      userOp({ type: 'user.update', id: u.id, patch: { disabled: !u.disabled } }, u.disabled ? '已啟用 ' + u.name : '已停用 ' + u.name + '，原本的登入會立即失效').catch(noop);
    },
    'delete-user': function (el) {
      const u = findUser(el.dataset.id);
      App.confirm(`確定要刪除帳號「${u.name}」嗎？\n過去的流水帳仍會保留操作者名字。`, { danger: true, okLabel: '刪除' }).then(function (yes) {
        if (yes) userOp({ type: 'user.delete', id: u.id }, '已刪除帳號').catch(noop);
      });
    }
  });

  // ---------- 回收區 ----------

  const TRASH = [
    ['students', '學員', 'student.restore', function (x) { const c = App.classById(x.classId); return x.name + '（' + x.id + (c ? '・' + c.name : '') + '）'; }],
    ['classes', '班別', 'class.restore', function (x) { return x.name; }],
    ['staff', '服務人員', 'staff.restore', function (x) { return x.name + (x.role ? '（' + x.role + '）' : ''); }],
    ['gifts', '禮品', 'gift.restore', function (x) { return x.name + '（' + x.cost + ' 點）'; }]
  ];

  function renderTrash() {
    const groups = TRASH.map(function (t) {
      return { def: t, items: App.s.data[t[0]].filter(function (x) { return x.deletedAt; }) };
    }).filter(function (g) { return g.items.length; });
    return html`
      <p class="faint" style="margin-top:0">刪除的資料會先放在這裡，可以還原。跨年度結算時才會永久清除。</p>
      ${groups.length ? groups.map(function (g) {
        return html`
          <div class="section-title"><h2>${g.def[1]}（${g.items.length}）</h2></div>
          <div class="card list">
            ${g.items.map(function (x) {
              return html`
                <div class="list-item">
                  <div class="grow">${g.def[3](x)}<div class="faint">刪除於 ${String(x.deletedAt).replace('T', ' ').slice(0, 16)}</div></div>
                  <button type="button" class="btn btn-sm" data-action="restore" data-type="${g.def[2]}" data-id="${x.id}">↩️ 還原</button>
                </div>`;
            })}
          </div>`;
      }) : html`<div class="card empty"><span class="big">🧺</span>回收區是空的</div>`}`;
  }

  App.actions.restore = function (el) {
    App.run({ type: el.dataset.type, id: el.dataset.id }).then(function () { App.toast('↩️ 已還原', 'ok'); });
  };

  // ---------- 系統與備份 ----------

  function renderSystem() {
    const meta = App.s.data.meta;
    const gas = App.s.backend.mode === 'gas';
    return html`
      <div class="card card-pad stack">
        <b>🏷️ 佛堂與年度</b>
        <form class="form-grid" data-meta-form>
          <div class="field"><label>佛堂與系統標題</label><input class="input" name="templeTitle" value="${meta.templeTitle}" maxlength="60" /></div>
          <div class="field"><label>年度名稱</label><input class="input" name="yearLabel" value="${meta.yearLabel}" maxlength="20" placeholder="例如：2026 年度" /></div>
          <button type="button" class="btn btn-primary full" data-action="save-meta">儲存</button>
        </form>
      </div>

      <div class="card card-pad stack" style="margin-top:12px">
        <b>🖼️ LOGO</b>
        <span class="hint">顯示在標題左邊、瀏覽器分頁與手機主畫面圖示。圖片存在${gas ? '後台試算表' : '這台電腦的瀏覽器'}，不會放進程式碼。</span>
        <div class="row">
          ${App.$('#brandLogo').hidden ? html`<span class="faint">目前沒有 LOGO</span>` : html`<img src="${App.$('#brandLogo').src}" alt="目前的 LOGO" style="width:64px;height:64px;border-radius:50%;border:1px solid var(--line)" />`}
          <label class="btn">📤 上傳圖片…<input type="file" accept="image/png,image/jpeg,image/webp" data-change="upload-logo" hidden /></label>
          ${App.$('#brandLogo').hidden ? '' : html`<button type="button" class="btn" data-action="remove-logo">移除</button>`}
        </div>
      </div>

      <div class="card card-pad stack" style="margin-top:12px">
        <b>💾 備份與匯入</b>
        <span class="hint">備份檔包含所有班別、學員、課次、服務人員與流水帳（不含帳號與 PIN）。建議每月下載一次。</span>
        <div class="btn-row">
          <button type="button" class="btn" data-action="download-backup">⬇️ 下載完整備份（JSON）</button>
          <button type="button" class="btn" data-action="import-backup">⬆️ 匯入資料…</button>
          ${gas ? html`<button type="button" class="btn" data-action="rebuild-reports">📊 更新試算表報表</button>` : ''}
        </div>
      </div>

      <div class="card card-pad stack" style="margin-top:12px; border-color:#fca5a5">
        <b>🎊 跨年度結算</b>
        <span class="hint">清空所有分數、出席與課次，保留班別、學員名冊、服務人員與禮品；回收區會永久清除。結算前系統會自動留一份備份，仍建議先下載報表。</span>
        <div class="btn-row">
          <button type="button" class="btn" data-action="export-roster">📤 學員總表 CSV</button>
          <button type="button" class="btn" data-action="export-logs">📤 流水帳 CSV</button>
          <button type="button" class="btn" data-action="export-staff">📤 護持表 CSV</button>
          <button type="button" class="btn btn-danger" data-action="year-reset">進行跨年度結算…</button>
        </div>
      </div>`;
  }

  function saveLogo(logo, message) {
    return App.s.backend.setLogo(logo).then(function (saved) {
      App.showLogo(saved);
      App.render();
      App.toast(message, 'ok');
    }, App.handleError);
  }

  Object.assign(App.actions, {
    'upload-logo': function (el) {
      const file = el.files && el.files[0];
      el.value = '';
      if (!file) return;
      App.resizeLogo(file).then(function (logo) {
        return saveLogo(logo, '🖼️ 已更新 LOGO');
      }, App.handleError);
    },
    'remove-logo': function () {
      App.confirm('確定要移除 LOGO 嗎？', { okLabel: '移除' }).then(function (yes) {
        if (yes) saveLogo('', '已移除 LOGO');
      });
    },
    'save-meta': function () {
      const f = App.formData(App.$('[data-meta-form]'));
      App.run({ type: 'meta.update', templeTitle: f.templeTitle, yearLabel: f.yearLabel }).then(function () { App.toast('已儲存', 'ok'); });
    },
    'download-backup': function () {
      App.s.backend.exportBackup().then(function (json) {
        App.download(`AttendPoint備份_${App.today()}.json`, json, 'application/json');
      }, App.handleError);
    },
    'import-backup': function () {
      App.modal({
        title: '匯入資料',
        body: html`
          <p class="hint" style="margin:0">可以匯入 v3 的備份檔（.json），或舊版（v2）單機版的資料。<b>匯入會整份取代目前的資料</b>，匯入前系統會自動備份目前資料。</p>
          <div class="field"><label>選擇檔案</label><input class="input" type="file" accept=".json,application/json" data-file /></div>
          <div class="field"><label>或貼上 JSON</label><textarea class="textarea" data-text></textarea></div>
          <button type="button" class="btn btn-danger" data-go>取代目前資料並匯入</button>`,
        onMount: function (m, close) {
          const text = m.querySelector('[data-text]');
          m.querySelector('[data-file]').addEventListener('change', function (e) {
            if (e.target.files[0]) App.readFile(e.target.files[0]).then(function (t) { text.value = t; });
          });
          m.querySelector('[data-go]').addEventListener('click', function () {
            if (!text.value.trim()) return App.toast('⚠️ 請先選擇檔案或貼上內容', 'warn');
            App.confirm('確定要用匯入的資料取代目前所有資料嗎？', { danger: true, okLabel: '匯入' }).then(function (yes) {
              if (!yes) return;
              App.s.backend.importState(text.value).then(function (res) {
                close();
                App.loadData(res.state);
                App.render();
                App.toast(res.migratedFrom === 2 ? `📦 已匯入並轉換舊版資料（${res.report.students} 位學員）` : '📦 已匯入資料', 'ok');
              }, App.handleError);
            });
          });
        }
      });
    },
    'rebuild-reports': function () {
      App.toast('📊 更新中…');
      App.s.backend.rebuildReports().then(function (res) {
        App.toast('📊 已更新試算表：' + res.sheets.join('、'), 'ok');
      }, App.handleError);
    },
    'year-reset': function () {
      const meta = App.s.data.meta;
      const year = parseInt(meta.yearLabel, 10);
      const suggested = (year ? year + 1 : new Date().getFullYear() + 1) + ' 年度';
      App.modal({
        title: '跨年度結算',
        body: html`
          <p style="margin:0">將清空 <b>${App.s.data.logs.length}</b> 筆紀錄與 <b>${App.s.data.sessions.length}</b> 堂課次，所有學員分數歸零。</p>
          <form class="stack">
            <div class="field"><label>新年度名稱</label><input class="input" name="yearLabel" value="${suggested}" maxlength="20" /></div>
            <div class="field"><label>請輸入「確認結算」以繼續</label><input class="input" name="confirmText" autocomplete="off" /></div>
            <button type="submit" class="btn btn-danger">執行跨年度結算</button>
          </form>`,
        onMount: function (m, close) {
          m.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            const f = App.formData(m);
            if (f.confirmText.trim() !== '確認結算') return App.toast('⚠️ 請輸入「確認結算」', 'warn');
            App.run({ type: 'year.reset', yearLabel: f.yearLabel }).then(function (res) {
              close();
              App.toast(`🎊 已進入「${f.yearLabel}」${res.backup ? '，備份：' + res.backup : ''}`, 'ok');
            });
          });
        }
      });
    }
  });
})(window.App = window.App || {});
