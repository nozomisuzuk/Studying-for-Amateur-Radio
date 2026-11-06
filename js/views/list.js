// 問題一覧(絞り込み・検索)

import { db, subjectLabel, genreLabel, sessionLabel, isOutdated } from '../data.js';
import * as store from '../store.js';
import { kindOrder } from '../engine.js';
import { h, icon, historyDots } from '../ui.js';
import { startSession, rememberListPath } from './drill.js';

const filt = { subject: 'all', session: 'all', genre: 'all', status: 'all', text: '' };

const STATUS = [
  ['all', 'すべて'],
  ['fresh', '未解答'],
  ['review', '要復習'],
  ['lastWrong', '前回不正解'],
  ['lastOk', '前回正解'],
  ['bookmarked', '★ブックマーク'],
  ['memo', 'メモあり'],
];

function norm(s) {
  return (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function matches(q, st) {
  if (filt.subject !== 'all' && q.subject !== filt.subject) return false;
  if (filt.session !== 'all' && q.session !== filt.session) return false;
  if (filt.genre !== 'all' && q.genre !== filt.genre) return false;
  switch (filt.status) {
    case 'fresh': if (st?.a) return false; break;
    case 'review': if (!st?.rv) return false; break;
    case 'lastWrong': if (st?.lr !== 0) return false; break;
    case 'lastOk': if (st?.lr !== 1) return false; break;
    case 'bookmarked': if (!st?.bm) return false; break;
    case 'memo': if (!st?.memo) return false; break;
    default: break;
  }
  if (filt.text) {
    const t = norm(filt.text);
    if (!norm(q.text).includes(t) && !norm(st?.memo).includes(t) && !norm(q.label).includes(t)) return false;
  }
  return true;
}

export function renderList(view) {
  rememberListPath('/list');
  const D = db();
  const listEl = h('ul.q-list');
  const countEl = h('span.muted');
  const solveBtn = h('button.btn.btn-primary.btn-sm', { type: 'button' }, icon('play'), 'この一覧を順に解く');

  const select = (label, key, options) => {
    const el = h('select', { 'aria-label': label },
      options.map(([v, l]) => h('option', { value: v, selected: filt[key] === v }, l)));
    el.addEventListener('change', () => {
      filt[key] = el.value;
      if (key === 'subject') {
        filt.genre = 'all';
        genreSel.replaceWith((genreSel = genreSelect()));
      }
      draw();
    });
    return h('label.sel', h('span', label), el);
  };
  const genreSelect = () => {
    const gs = filt.subject === 'all' ? [...D.genres.kogaku, ...D.genres.hoki] : D.genres[filt.subject];
    return select('ジャンル', 'genre', [['all', 'すべて'], ...gs.map((g) => [g.id, g.label])]);
  };
  let genreSel = genreSelect();

  const search = h('input.search', { type: 'search', placeholder: 'キーワード（問題文・メモ）', value: filt.text, 'aria-label': 'キーワード検索' });
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      filt.text = search.value.trim();
      draw();
    }, 200);
  });

  function draw() {
    const st = store.stats();
    const items = D.questions.filter((q) => matches(q, st))
      .sort((a, b) => b.session.localeCompare(a.session) || a.subject.localeCompare(b.subject) || kindOrder(a) - kindOrder(b));
    countEl.textContent = `${items.length}問`;
    solveBtn.disabled = !items.length;
    solveBtn.onclick = () => startSession({ mode: 'list', title: '一覧の問題', ids: items.map((q) => q.id), backTo: '/list' });
    const frag = document.createDocumentFragment();
    for (const q of items.slice(0, 400)) {
      const s = st[q.id];
      const status = !s?.a ? h('span.badge.new', '未') : s.rv ? h('span.badge.ng', '復習') : s.lr === 1 ? h('span.badge.ok', '○') : h('span.badge.ng', '×');
      frag.append(h('li', h('a.q-row', { href: `#/q/${q.id}` },
        status,
        h('span.q-main',
          h('span.q-title', `${sessionLabel(q.session)} ${subjectLabel(q.subject)} ${q.label}`),
          h('span.q-sub', genreLabel(q.genre), isOutdated(q) ? h('span.badge.old', '法改正') : null,
            s?.memo ? h('span.memo-mark', icon('memo')) : null, s?.bm ? h('span.star-mark', icon('star')) : null)),
        s?.a ? historyDots(s.h, 5) : null,
        h('span.q-rate.muted', s?.a ? `${s.c}/${s.a}` : ''))));
    }
    listEl.replaceChildren(frag);
  }

  view.append(
    h('header.page-head', h('div', h('h1', '問題一覧'), h('p.sub', 'タップで1問ずつ解けます。'))),
    h('section.card.filters',
      h('div.filter-grid',
        select('科目', 'subject', [['all', 'すべて'], ['kogaku', '無線工学'], ['hoki', '法規']]),
        select('回', 'session', [['all', 'すべて'], ...D.sessions.slice().reverse().map((s) => [s.id, s.label])]),
        genreSel,
        select('状態', 'status', STATUS)),
      search,
      h('div.filter-foot', countEl, solveBtn)),
    h('section.card.list-card', listEl));
  draw();
}
