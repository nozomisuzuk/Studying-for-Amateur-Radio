// エントリポイント: 初期化・画面遷移(ハッシュルーティング)・テーマ

import { loadData } from './data.js';
import * as store from './store.js';
import { h, icon, clear } from './ui.js';
import { renderHome } from './views/home.js';
import { renderDrill, startSingle } from './views/drill.js';
import { renderCustom } from './views/custom.js';
import { renderExamList, renderExamRun, renderExamResult } from './views/exam.js';
import { renderList } from './views/list.js';
import { renderStats } from './views/stats.js';
import { renderSettings } from './views/settings.js';

const TABS = [
  { path: '/', label: 'ホーム', icon: 'home' },
  { path: '/list', label: '問題一覧', icon: 'list' },
  { path: '/exam', label: '模擬試験', icon: 'exam' },
  { path: '/stats', label: '記録', icon: 'chart' },
  { path: '/settings', label: '設定', icon: 'gear' },
];

const ROUTES = [
  [/^\/?$/, renderHome],
  [/^\/drill$/, renderDrill],
  [/^\/custom$/, renderCustom],
  [/^\/exam$/, renderExamList],
  [/^\/exam\/run$/, renderExamRun],
  [/^\/exam\/result\/(\d+)$/, renderExamResult],
  [/^\/list$/, renderList],
  [/^\/q\/([A-Z0-9-]+)$/, (view, id) => startSingle(view, id)],
  [/^\/stats$/, renderStats],
  [/^\/settings$/, renderSettings],
];

let cleanup = null;

export function navigate(path, { replace = false } = {}) {
  const hash = '#' + path;
  if (location.hash === hash) route();
  else if (replace) {
    history.replaceState(null, '', hash);
    route();
  } else location.hash = hash;
}

function currentPath() {
  return decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
}

function route() {
  const path = currentPath();
  const view = document.getElementById('view');
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  clear(view);
  document.body.classList.remove('focus-mode');
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      cleanup = fn(view, ...m.slice(1)) || null;
      break;
    }
  }
  if (!view.firstChild) renderHome(view);
  updateTabs(path);
  window.scrollTo(0, 0);
}

function updateTabs(path) {
  for (const a of document.querySelectorAll('.tabbar a')) {
    const p = a.getAttribute('data-path');
    const active = p === '/' ? path === '/' : path.startsWith(p);
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

export function applyTheme() {
  const s = store.settings();
  const root = document.documentElement;
  if (s.theme === 'light' || s.theme === 'dark') root.setAttribute('data-theme', s.theme);
  else root.removeAttribute('data-theme');
  root.classList.toggle('invert-q', !!s.invertInDark);
}

function renderShell() {
  const app = document.getElementById('app');
  clear(app);
  app.append(
    h('main#view', { tabindex: '-1' }),
    h('nav.tabbar', { 'aria-label': 'メインメニュー' },
      TABS.map((t) => h('a', { href: '#' + t.path, 'data-path': t.path }, icon(t.icon), h('span', t.label)))));
}

async function init() {
  store.load();
  applyTheme();
  renderShell();
  const view = document.getElementById('view');
  view.append(h('div.loading', h('div.spinner'), h('p', '問題データを読み込んでいます…')));
  try {
    await loadData();
  } catch (e) {
    clear(view).append(h('div.card.error-card', h('h2', '読み込みに失敗しました'), h('p', String(e.message || e)),
      h('button.btn.btn-primary', { type: 'button', onclick: () => location.reload() }, '再読み込み')));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
