// DOM ユーティリティと共通 UI 部品(トースト・確認ダイアログ・拡大ビューア)

/** hyperscript: h('div.card#id', {onclick, class, ...}, child, ...) */
export function h(sel, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs !== undefined && attrs !== null) children.unshift(attrs);
    attrs = {};
  }
  const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v; // 自前の固定文字列(アイコンSVG)にだけ使う
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------------------------------------------------------------- アイコン(インラインSVG)
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  exam: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  next: '<path d="M9 18l6-6-6-6"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  memo: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6 6l12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon ' + cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

// ---------------------------------------------------------------- トースト
let toastTimer = null;
export function toast(message, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div#toast', { role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2600);
}

// ---------------------------------------------------------------- ダイアログ
export function dialog({ title, body, actions }) {
  return new Promise((resolve) => {
    const close = (v) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    const box = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2.dialog-title', title),
      body ? h('div.dialog-body', body) : null,
      h('div.dialog-actions', actions.map((a) =>
        h('button.btn' + (a.primary ? '.btn-primary' : '') + (a.danger ? '.btn-danger' : ''),
          { type: 'button', onclick: () => close(a.value) }, a.label))));
    const wrap = h('div.dialog-wrap', { onclick: (e) => { if (e.target === wrap) close(null); } }, box);
    document.body.append(wrap);
    document.addEventListener('keydown', onKey);
    setTimeout(() => box.querySelector('.btn-primary, .btn')?.focus(), 30);
  });
}

export function confirmDialog(title, body, okLabel = 'OK', danger = false) {
  return dialog({
    title, body,
    actions: [{ label: 'キャンセル', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  });
}

export function promptText(title, value = '', placeholder = '') {
  const ta = h('textarea.memo-input', { rows: 6, placeholder });
  ta.value = value;
  setTimeout(() => ta.focus(), 50);
  return dialog({
    title, body: ta,
    actions: [{ label: 'キャンセル', value: null }, { label: '保存', value: 'save', primary: true }],
  }).then((v) => (v === 'save' ? ta.value : null));
}

// ---------------------------------------------------------------- 画像の拡大ビューア
export function openZoom(images, title) {
  let scale = 1;
  const imgs = images.map((im) => h('img', { src: im.src, alt: title, draggable: false, width: im.w, height: im.h }));
  const canvas = h('div.zoom-canvas', imgs);
  const scroller = h('div.zoom-scroller', canvas);
  const maxW = Math.max(...images.map((im) => im.w));
  const fit = () => {
    const avail = scroller.clientWidth - 16;
    return Math.min(1, avail / maxW);
  };
  const apply = () => {
    for (const [i, img] of imgs.entries()) {
      img.style.width = `${Math.round(images[i].w * scale)}px`;
      img.style.height = 'auto';
    }
    label.textContent = `${Math.round(scale * 100)}%`;
  };
  const setScale = (s) => {
    const cx = (scroller.scrollLeft + scroller.clientWidth / 2) / (canvas.scrollWidth || 1);
    const cy = (scroller.scrollTop + scroller.clientHeight / 2) / (canvas.scrollHeight || 1);
    scale = Math.max(0.2, Math.min(2.5, s));
    apply();
    scroller.scrollLeft = cx * canvas.scrollWidth - scroller.clientWidth / 2;
    scroller.scrollTop = cy * canvas.scrollHeight - scroller.clientHeight / 2;
  };
  const label = h('span.zoom-label', '100%');
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === '+' || e.key === '=') setScale(scale * 1.25);
    if (e.key === '-') setScale(scale / 1.25);
  };
  const bar = h('div.zoom-bar',
    h('span.zoom-title', title),
    h('button.icon-btn', { type: 'button', 'aria-label': '縮小', onclick: () => setScale(scale / 1.25) }, icon('minus')),
    label,
    h('button.icon-btn', { type: 'button', 'aria-label': '拡大', onclick: () => setScale(scale * 1.25) }, icon('plus')),
    h('button.icon-btn', { type: 'button', 'aria-label': '画面に合わせる', onclick: () => setScale(fit()) }, icon('fit')),
    h('button.icon-btn', { type: 'button', 'aria-label': '閉じる', onclick: close }, icon('close')));
  const wrap = h('div.zoom-wrap', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '問題の拡大表示' }, bar, scroller);
  document.body.append(wrap);
  document.addEventListener('keydown', onKey);
  // 初期倍率: スマホでは文字が読める大きさ(原寸の約60%)、広い画面では全体が収まる大きさ
  requestAnimationFrame(() => {
    scale = Math.max(fit(), Math.min(0.6, 1));
    apply();
  });
  // ダブルタップで 等倍 ⇔ 全体
  let lastTap = 0;
  scroller.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 300) setScale(Math.abs(scale - fit()) < 0.01 ? 0.75 : fit());
    lastTap = now;
  });
}

// ---------------------------------------------------------------- 書式
export function pct(x) {
  return x == null ? '—' : `${Math.round(x * 100)}%`;
}

export function fmtDate(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtDateTime(t) {
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

/** 直近の解答履歴を ○× のドットで表す */
export function historyDots(hist, n = 6) {
  const s = (hist || '').slice(-n);
  return h('span.dots', { title: '直近の解答（右が最新）', 'aria-label': `直近の解答 ${[...s].map((c) => (c === '1' ? '正' : '誤')).join('')}` },
    [...s].map((c) => h('span.dot' + (c === '1' ? '.ok' : '.ng'))));
}
