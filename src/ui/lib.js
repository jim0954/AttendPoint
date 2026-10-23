/* 介面共用工具：HTML 跳脫、對話框、提示、音效、CSV、下載 */
(function (App) {
  'use strict';

  // ---------- 安全的 HTML 樣板 ----------
  // html`...${value}...` 會自動跳脫內容，避免名字裡的 < > 破壞畫面或被注入程式；
  // 已經是 html`` 產生的片段（Raw）或陣列則原樣組合。
  function Raw(s) { this.s = s; }
  Raw.prototype.toString = function () { return this.s; };

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) {
    return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  function fmt(v) {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(fmt).join('');
    if (v === undefined || v === null || v === false) return '';
    return esc(v);
  }

  App.esc = esc;
  App.raw = function (s) { return new Raw(String(s)); };
  App.html = function (strings) {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i + 1 < arguments.length) out += fmt(arguments[i + 1]);
    }
    return new Raw(out);
  };

  App.$ = function (sel, root) { return (root || document).querySelector(sel); };
  App.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  App.setHtml = function (el, content) {
    if (typeof el === 'string') el = App.$(el);
    if (el) el.innerHTML = fmt(content);
  };

  // ---------- 日期 ----------
  App.today = function () {
    return AttendStore.localIso(new Date()).slice(0, 10);
  };
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  App.weekdayName = function (n) { return n === null || n === undefined ? '' : '星期' + WEEKDAYS[n]; };
  App.dateLabel = function (d) {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return d.slice(5).replace('-', '/') + '（' + WEEKDAYS[dt.getDay()] + '）';
  };
  App.timeRange = function (s) { return s && s.start && s.end ? s.start + '–' + s.end : ''; };

  // ---------- 提示 ----------
  App.toast = function (message, tone) {
    const root = App.$('#toastRoot');
    const el = document.createElement('div');
    el.className = 'toast' + (tone ? ' ' + tone : '');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, tone === 'warn' ? 4500 : 2800);
  };

  // ---------- 對話框 ----------
  // App.modal({ title, body, foot, onMount(el, close), onClose }) → close()
  // 傳入 render() 取代 body 時，資料更新後（App.refreshModals）內容會自動重畫
  const stack = [];
  const live = [];
  App.modal = function (opts) {
    const root = App.$('#modalRoot');
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = fmt(App.html`
      <div class="modal" role="dialog" aria-modal="true" aria-label="${opts.title}">
        <div class="modal-head">
          <h3>${opts.title}</h3>
          <button type="button" class="btn btn-ghost btn-icon" data-close aria-label="關閉">✕</button>
        </div>
        <div class="modal-body">${opts.render ? opts.render() : opts.body}</div>
        ${opts.foot ? App.html`<div class="modal-foot">${opts.foot}</div>` : ''}
      </div>`);
    root.appendChild(wrap);
    let closed = false;
    const liveEntry = opts.render ? { body: wrap.querySelector('.modal-body'), render: opts.render } : null;
    if (liveEntry) live.push(liveEntry);
    function close() {
      if (closed) return;
      closed = true;
      wrap.remove();
      stack.splice(stack.indexOf(close), 1);
      if (liveEntry) live.splice(live.indexOf(liveEntry), 1);
      if (opts.onClose) opts.onClose();
    }
    stack.push(close);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    });
    if (opts.onMount) opts.onMount(wrap.querySelector('.modal'), close);
    const first = wrap.querySelector('[autofocus]');
    if (first) setTimeout(function () { first.focus(); }, 30);
    return close;
  };

  /** 重畫所有以 render() 開啟的對話框（保留捲動位置與正在輸入的欄位） */
  App.refreshModals = function () {
    live.forEach(function (entry) {
      if (entry.body.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      const top = entry.body.scrollTop;
      entry.body.innerHTML = fmt(entry.render());
      entry.body.scrollTop = top;
    });
  };

  App.closeTopModal = function () {
    if (stack.length) stack[stack.length - 1]();
  };

  App.hasModal = function () { return stack.length > 0; };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && stack.length) stack[stack.length - 1]();
  });

  /** 確認對話框，回傳 Promise<boolean> */
  App.confirm = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      let answered = false;
      App.modal({
        title: opts.title || '請確認',
        body: App.html`<p style="margin:0;white-space:pre-line">${message}</p>`,
        foot: App.html`
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-yes>${opts.okLabel || '確定'}</button>`,
        onMount: function (el, close) {
          el.querySelector('[data-yes]').addEventListener('click', function () {
            answered = true;
            close();
            resolve(true);
          });
        },
        onClose: function () { if (!answered) resolve(false); }
      });
    });
  };

  /** 讀取表單欄位：<input name="x"> → { x: value }；checkbox 為 boolean */
  App.formData = function (root) {
    const out = {};
    App.$$('[name]', root).forEach(function (el) {
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    });
    return out;
  };

  // ---------- 音效 ----------
  let audioCtx = null;
  App.sound = function (type) {
    if (!App.prefs.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const tones = {
        ok: ['sine', [523.25, 659.25, 783.99], 0.12, 0.38],
        deduct: ['sawtooth', [330, 261.63], 0.08, 0.32],
        gift: ['triangle', [587.33, 880], 0.12, 0.42]
      };
      const t = tones[type] || tones.ok;
      osc.type = t[0];
      t[1].forEach(function (f, i) { osc.frequency.setValueAtTime(f, now + i * 0.09); });
      gain.gain.setValueAtTime(t[2], now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + t[3]);
      osc.start(now);
      osc.stop(now + t[3]);
    } catch (e) {
      // 瀏覽器不支援或被封鎖時略過
    }
  };

  // ---------- 偏好設定（只存在本機） ----------
  App.prefs = { sound: true };
  App.loadPrefs = function () {
    try { Object.assign(App.prefs, JSON.parse(localStorage.getItem('attendpoint_prefs') || '{}')); } catch (e) {}
  };
  App.savePrefs = function () {
    try { localStorage.setItem('attendpoint_prefs', JSON.stringify(App.prefs)); } catch (e) {}
  };

  // ---------- CSV ----------
  App.parseCsv = function (text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    text = String(text).replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows
      .map(function (r) { return r.map(function (x) { return x.trim(); }); })
      .filter(function (r) { return r.some(function (x) { return x; }); });
  };

  App.toCsv = function (rows) {
    return '﻿' + rows.map(function (r) {
      return r.map(function (v) {
        const s = String(v === undefined || v === null ? '' : v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  };

  App.download = function (filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  App.readFile = function (file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const buf = reader.result;
        let text;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch (e) {
          text = new TextDecoder('big5').decode(buf); // Excel 存的繁中 CSV 常是 Big5
        }
        resolve(text);
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsArrayBuffer(file);
    });
  };
})(window.App = window.App || {});
