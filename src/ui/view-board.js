/* 榮譽榜與禮品兌換 */
(function (App) {
  'use strict';
  const html = App.html;

  // ---------- 榮譽榜 ----------

  App.views.board = {
    order: 2,
    icon: '🏆',
    label: '榮譽榜',
    render: function () {
      const cls = App.cls();
      const totals = App.totals();
      const students = App.students(cls.id).slice().sort(function (a, b) {
        return totals[b.id].honor - totals[a.id].honor || totals[b.id].sessionIds.length - totals[a.id].sessionIds.length;
      });
      const teams = cls.teams.map(function (t) {
        const members = students.filter(function (s) { return s.teamId === t.id; });
        const sum = members.reduce(function (n, s) { return n + totals[s.id].honor; }, 0);
        return { name: t.name, count: members.length, sum: sum, avg: members.length ? Math.round(sum / members.length) : 0 };
      }).sort(function (a, b) { return b.avg - a.avg; });
      const maxAvg = Math.max.apply(null, teams.map(function (t) { return t.avg; }).concat([1]));
      let lastScore = null;
      let lastRank = 0;

      return html`
        ${teams.length ? html`<div class="section-title"><h2>🚩 小隊競賽（平均榮譽分）</h2></div>
        <div class="card card-pad stack">
          ${teams.map(function (t, i) {
            return html`
              <div>
                <div class="spread"><b>${i === 0 && t.avg > 0 ? '🥇 ' : ''}${t.name}</b><span class="num"><b>${t.avg}</b> <span class="faint">分・${t.count} 人・總分 ${t.sum}</span></span></div>
                <div class="bar"><i style="width:${Math.round((t.avg / maxAvg) * 100)}%"></i></div>
              </div>`;
          })}
        </div>` : ''}

        <div class="section-title"><h2>🏅 個人榮譽榜</h2><span class="faint">榮譽總分不因兌換而減少</span></div>
        <div class="card list">
          ${students.length ? students.map(function (s, i) {
            const t = totals[s.id];
            if (t.honor !== lastScore) { lastRank = i + 1; lastScore = t.honor; }
            const rank = App.rank(t.honor);
            return html`
              <div class="list-item" data-action="open-student" data-id="${s.id}" style="cursor:pointer">
                <span class="rank-num rank-${lastRank}">${lastRank}</span>
                <div class="grow">
                  <b>${s.name}</b> <span class="faint">${App.teamName(s)}</span>
                  <div><span class="chip ${rank.cls}">${rank.title}</span> <span class="faint">出席 ${t.sessionIds.length} 堂</span></div>
                </div>
                <div class="num" style="text-align:right"><b style="font-size:18px;color:var(--theme)">${t.honor}</b><div class="faint">可用 ${t.balance}</div></div>
              </div>`;
          }) : html`<div class="empty">這個班還沒有學員</div>`}
        </div>`;
    }
  };

  // ---------- 禮品兌換 ----------

  App.views.gifts = {
    order: 3,
    icon: '🎁',
    label: '好禮兌換',
    render: function () {
      const gifts = App.gifts().slice().sort(function (a, b) { return a.cost - b.cost; });
      return html`
        <div class="section-title">
          <h2>🎁 禮品目錄</h2>
          ${App.can({ type: 'gift.create' }) ? html`<button type="button" class="btn btn-sm" data-action="edit-gift">＋ 新增禮品</button>` : ''}
        </div>
        <p class="faint" style="margin-top:0">兌換只扣「可用點數」，「榮譽總分」不會減少。</p>
        ${gifts.length ? html`<div class="gift-grid">${gifts.map(function (g) {
          return html`
            <div class="card gift">
              <div class="spread"><span class="icon">${g.icon || '🎁'}</span><span class="cost num">${g.cost} 點</span></div>
              <b>${g.name}</b>
              ${g.desc ? html`<span class="faint">${g.desc}</span>` : ''}
              ${App.isStaff() ? html`
                <div class="btn-row">
                  <button type="button" class="btn btn-gift btn-sm grow" data-action="redeem-pick" data-id="${g.id}">兌換</button>
                  <button type="button" class="btn btn-sm" data-action="edit-gift" data-id="${g.id}">✏️</button>
                  ${App.can({ type: 'gift.delete', id: g.id }) ? html`<button type="button" class="btn btn-sm" data-action="delete-gift" data-id="${g.id}">🗑️</button>` : ''}
                </div>` : ''}
            </div>`;
        })}</div>` : html`<div class="card empty">還沒有禮品</div>`}`;
    }
  };

  function giftById(id) { return App.s.data.gifts.find(function (g) { return g.id === id; }); }

  Object.assign(App.actions, {
    'redeem-pick': function (el) {
      const gift = giftById(el.dataset.id);
      const cls = App.cls();
      App.modal({
        title: '兌換：' + gift.name,
        render: function () {
          const totals = App.totals();
          const list = App.students(cls.id).slice().sort(function (a, b) { return totals[b.id].balance - totals[a.id].balance; });
          return html`
            <p class="faint" style="margin:0">需要 <b class="cost">${gift.cost}</b> 點。選擇要兌換的學員：</p>
            <div class="card list">
              ${list.map(function (s) {
                const bal = totals[s.id].balance;
                const enough = bal >= gift.cost;
                return html`
                  <div class="list-item">
                    <div class="grow"><b>${s.name}</b> <span class="faint">${App.teamName(s)}</span></div>
                    <span class="num ${enough ? '' : 'faint'}">可用 ${bal}</span>
                    <button type="button" class="btn btn-gift btn-sm" data-action="redeem" data-gift="${gift.id}" data-id="${s.id}" ${enough ? '' : 'disabled'}>兌換</button>
                  </div>`;
              })}
            </div>`;
        }
      });
    },
    redeem: function (el) {
      const gift = giftById(el.dataset.gift);
      const s = App.studentById(el.dataset.id);
      App.confirm(`${s.name} 要兌換「${gift.name}」，扣除 ${gift.cost} 點？`, { okLabel: '確認兌換' }).then(function (yes) {
        if (!yes) return;
        const p = App.run({ type: 'points.redeem', studentId: s.id, giftId: gift.id, date: App.s.date });
        if (p.accepted) {
          App.sound('gift');
          App.toast(`🎁 ${s.name} 兌換「${gift.name}」成功！`, 'gift');
        }
      });
    },
    'edit-gift': function (el) {
      const gift = el.dataset.id ? giftById(el.dataset.id) : null;
      App.modal({
        title: gift ? '編輯禮品' : '新增禮品',
        body: html`
          <form class="form-grid">
            <div class="field full"><label>禮品名稱</label><input class="input" name="name" value="${gift ? gift.name : ''}" maxlength="40" autofocus /></div>
            <div class="field"><label>兌換點數</label><input class="input" name="cost" type="number" min="1" value="${gift ? gift.cost : 50}" /></div>
            <div class="field"><label>圖示（emoji）</label><input class="input" name="icon" value="${gift ? gift.icon : '🎁'}" maxlength="8" /></div>
            <div class="field full"><label>說明</label><input class="input" name="desc" value="${gift ? gift.desc : ''}" maxlength="100" /></div>
            <button type="submit" class="btn btn-primary full">儲存</button>
          </form>`,
        onMount: function (m, close) {
          m.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            const f = App.formData(m);
            const op = gift
              ? { type: 'gift.update', id: gift.id, patch: { name: f.name, cost: Number(f.cost), icon: f.icon, desc: f.desc } }
              : { type: 'gift.create', name: f.name, cost: Number(f.cost), icon: f.icon, desc: f.desc };
            App.run(op).then(function () {
              close();
              App.toast('🎁 已儲存禮品', 'ok');
            });
          });
        }
      });
    },
    'delete-gift': function (el) {
      const gift = giftById(el.dataset.id);
      App.confirm(`確定要刪除禮品「${gift.name}」嗎？\n刪除後會移到回收區，可以還原。`, { danger: true, okLabel: '刪除' }).then(function (yes) {
        if (yes) App.run({ type: 'gift.delete', id: gift.id }).then(function () { App.toast('🗑️ 已移到回收區'); });
      });
    }
  });
})(window.App = window.App || {});
