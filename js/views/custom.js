// 条件を指定して演習

import { db, subjectLabel } from '../data.js';
import * as store from '../store.js';
import { pickCustom, genreSummary } from '../engine.js';
import { h, icon } from '../ui.js';
import { startSession } from './drill.js';
import { navigate } from '../app.js';

// 画面を離れても条件を覚えておく(メモリ上)
const form = {
  subjects: new Set(['kogaku', 'hoki']),
  sessions: null, // null = すべて
  genres: null,   // null = すべて
  kinds: new Set(['A', 'B']),
  status: 'all',
  order: 'random',
  count: 20,
};

const STATUS = [
  ['all', 'すべて'],
  ['fresh', '未解答のみ'],
  ['notMastered', '未解答＋前回不正解'],
  ['lastWrong', '前回不正解'],
  ['wrong', '要復習'],
  ['bookmarked', '★ブックマーク'],
];
const ORDER = [['random', 'ランダム'], ['exam', '出題順'], ['weak', '苦手な問題から']];
const COUNTS = [[10, '10問'], [20, '20問'], [30, '30問'], [50, '50問'], [0, '全部']];

function filtered() {
  const D = db();
  const sess = form.sessions;
  const gen = form.genres;
  return D.questions.filter((q) => form.subjects.has(q.subject) && form.kinds.has(q.kind)
    && (!sess || sess.has(q.session)) && (!gen || gen.has(q.genre)));
}

export function renderCustom(view) {
  const D = db();
  if (!form.sessions) form.sessions = new Set(D.sessions.map((s) => s.id));
  if (!form.genres) form.genres = new Set(D.questions.map((q) => q.genre));

  const countEl = h('strong');
  const startBtn = h('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', onclick: start }, 'この条件で解く');
  const update = () => {
    const base = filtered();
    const n = pickCustom(base, store.stats(), { status: form.status, order: 'exam', count: 0 }).length;
    countEl.textContent = `${n}問`;
    startBtn.disabled = n === 0;
    startBtn.textContent = n === 0 ? '該当する問題がありません' : `この条件で解く（${form.count && form.count < n ? form.count : n}問）`;
  };

  function checks(items, set, onToggle) {
    return h('div.check-grid', items.map(([value, label, sub]) => {
      const input = h('input', { type: 'checkbox', checked: set.has(value) });
      input.addEventListener('change', () => {
        if (input.checked) set.add(value);
        else set.delete(value);
        onToggle?.();
        update();
      });
      return h('label.check', input, h('span', label, sub ? h('small', sub) : null));
    }));
  }

  function radios(name, items, key) {
    return h('div.chips', { role: 'radiogroup' }, items.map(([value, label]) => {
      const input = h('input', { type: 'radio', name, checked: form[key] === value });
      input.addEventListener('change', () => {
        form[key] = value;
        update();
      });
      return h('label.chip-radio', input, h('span', label));
    }));
  }

  const st = store.stats();
  const genreBlocks = ['kogaku', 'hoki'].map((subj) => {
    const gs = genreSummary(D.questions.filter((q) => q.subject === subj), st, D.genres[subj]);
    const box = h('div.genre-checks');
    const draw = () => box.replaceChildren(checks(gs.map((g) => [g.id, g.label, `${g.total}問${g.weak ? '・苦手' : ''}`]), form.genres));
    draw();
    return h('fieldset.field',
      h('legend', subjectLabel(subj), ' のジャンル'),
      h('div.mini-actions',
        h('button.link-btn', { type: 'button', onclick: () => { gs.forEach((g) => form.genres.add(g.id)); draw(); update(); } }, 'すべて'),
        h('button.link-btn', { type: 'button', onclick: () => { gs.forEach((g) => form.genres.delete(g.id)); draw(); update(); } }, 'なし'),
        h('button.link-btn', {
          type: 'button',
          onclick: () => { gs.forEach((g) => (g.weak ? form.genres.add(g.id) : form.genres.delete(g.id))); draw(); update(); },
        }, '苦手だけ')),
      box);
  });

  function start() {
    const list = pickCustom(filtered(), store.stats(), { status: form.status, order: form.order, count: form.count });
    const snapshot = { ...form, subjects: new Set(form.subjects), sessions: new Set(form.sessions), genres: new Set(form.genres), kinds: new Set(form.kinds) };
    startSession({
      mode: 'custom',
      title: '条件指定の演習',
      ids: list.map((q) => q.id),
      refill: () => {
        const D2 = db();
        const base = D2.questions.filter((q) => snapshot.subjects.has(q.subject) && snapshot.kinds.has(q.kind)
          && snapshot.sessions.has(q.session) && snapshot.genres.has(q.genre));
        return pickCustom(base, store.stats(), { status: snapshot.status, order: snapshot.order, count: snapshot.count }).map((q) => q.id);
      },
      backTo: '/custom',
    });
  }

  view.append(
    h('header.page-head',
      h('button.icon-btn', { type: 'button', 'aria-label': '戻る', onclick: () => navigate('/') }, icon('back')),
      h('h1', '条件を指定して演習')),
    h('section.card.form',
      h('fieldset.field', h('legend', '科目'), checks([['kogaku', '無線工学'], ['hoki', '法規']], form.subjects)),
      h('fieldset.field', h('legend', '試験の回'), checks(D.sessions.slice().reverse().map((s) => [s.id, s.label]), form.sessions)),
      h('fieldset.field', h('legend', '問題の種類'), checks([['A', 'A問題', '5択・4択'], ['B', 'B問題', '穴埋め・正誤']], form.kinds)),
      ...genreBlocks,
      h('fieldset.field', h('legend', '出題する問題'), radios('status', STATUS, 'status')),
      h('fieldset.field', h('legend', '出題の順番'), radios('order', ORDER, 'order')),
      h('fieldset.field', h('legend', '問題数'), radios('count', COUNTS, 'count'))),
    h('div.sticky-cta', h('p.muted', '該当: ', countEl), startBtn));
  update();
}
