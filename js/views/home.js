import { db, questionsOf, subjectLabel, practice } from '../data.js';
import * as store from '../store.js';
import { genreSummary, pickSmart, pickReview, isDue, dayKey, DAY, weakness } from '../engine.js';
import { h, icon, pct, fmtDate } from '../ui.js';
import { startSession } from './drill.js';
import { navigate } from '../app.js';

export function smartSession(subject) {
  const qs = questionsOf(subject);
  const st = store.stats();
  const gi = genreSummary(qs, st, allGenres(subject));
  const size = store.settings().sessionSize;
  const label = subject === 'both' ? '' : `（${subjectLabel(subject)}）`;
  startSession({
    mode: 'smart',
    title: `おまかせ演習${label}`,
    ids: pickSmart(qs, st, gi, { count: size }).map((q) => q.id),
    refill: () => pickSmart(questionsOf(subject), store.stats(), genreSummary(questionsOf(subject), store.stats(), allGenres(subject)), { count: size }).map((q) => q.id),
  });
}

export function reviewSession(includeAll = false) {
  const ids = pickReview(practice(), store.stats(), { includeAll }).map((q) => q.id);
  startSession({
    mode: 'review',
    title: includeAll ? '要復習の問題（すべて）' : '今日の復習',
    ids,
    refill: () => pickReview(practice(), store.stats(), { includeAll }).map((q) => q.id),
  });
}

/** 1つまたは複数のジャンルを集中演習(期日の来た復習 → 未解答・誤答 → その他) */
export function genreSession(genreIds, title) {
  const set = new Set(genreIds);
  const pick = () => {
    const qs = practice().filter((q) => set.has(q.genre));
    const st = store.stats();
    const gi = genreSummary(qs, st, [...set].map((id) => db().genreById.get(id)));
    return pickSmart(qs, st, gi, { count: store.settings().sessionSize }).map((q) => q.id);
  };
  startSession({ mode: 'genre', title, ids: pick(), refill: pick });
}

export function allGenres(subject) {
  const g = db().genres;
  if (subject === 'kogaku' || subject === 'hoki') return g[subject];
  return [...g.kogaku, ...g.hoki];
}

function streakDays(daily) {
  let n = 0;
  let t = Date.now();
  if (!daily[dayKey(t)]?.n) t -= DAY; // 今日まだ解いていなくても昨日までの連続は数える
  while (daily[dayKey(t)]?.n) {
    n += 1;
    t -= DAY;
  }
  return n;
}

function segmented(options, value, onChange) {
  const wrap = h('div.segmented', { role: 'radiogroup' });
  for (const [v, label] of options) {
    wrap.append(h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '',
      onclick: () => {
        for (const b of wrap.children) {
          b.classList.remove('on');
          b.setAttribute('aria-checked', 'false');
        }
        const btn = [...wrap.children][options.findIndex((o) => o[0] === v)];
        btn.classList.add('on');
        btn.setAttribute('aria-checked', 'true');
        onChange(v);
      },
    }, label));
  }
  return wrap;
}
export { segmented };

export function genreBar(g) {
  const m = g.mastery;
  const cls = m == null ? 'none' : m >= 0.85 ? 'good' : m >= 0.7 ? 'ok' : 'bad';
  return h('div.meter', { title: `直近正答率 ${pct(m)} / 解答済み ${g.attempted}/${g.total}問` },
    h('div.meter-fill.' + cls, { style: { width: `${Math.round((m ?? 0) * 100)}%` } }),
    h('div.meter-line', { style: { left: '70%' }, title: '合格ライン 70%' }));
}

export function renderHome(view) {
  const D = db();
  const st = store.stats();
  const s = store.settings();
  const now = Date.now();
  const all = practice();
  const attempted = all.filter((q) => st[q.id]?.a > 0);
  const lastOk = attempted.filter((q) => st[q.id].lr === 1).length;
  const reviewAll = all.filter((q) => st[q.id]?.rv);
  const reviewDue = reviewAll.filter((q) => isDue(st[q.id], now));
  const daily = store.daily();
  const today = daily[dayKey(now)] || { n: 0, c: 0 };

  // ---- ヘッダー
  const header = h('header.page-head',
    h('div',
      h('h1.app-title', '1アマ過去問ドリル'),
      h('p.sub', `第一級アマチュア無線技士 / ${D.sessions.length}回分 ${D.questions.length}問`)));
  if (s.examDate) {
    const days = Math.ceil((new Date(s.examDate + 'T00:00:00').getTime() - new Date(dayKey(now) + 'T00:00:00').getTime()) / DAY);
    if (days >= 0) header.append(h('div.countdown', h('span', '試験まで'), h('strong', String(days)), h('span', '日')));
  }

  // ---- 概況
  const tiles = h('section.tiles', { 'aria-label': '学習状況' },
    tile('解いた問題', `${attempted.length}`, `/ ${all.length}問`),
    tile('直近の正答率', pct(attempted.length ? lastOk / attempted.length : null), '各問の最新の結果'),
    tile('今日', `${today.n}`, `問 / 正解 ${today.c}`),
    tile('連続学習', `${streakDays(daily)}`, '日'));

  // ---- おまかせ演習
  let subject = s.subject || 'both';
  const smart = h('section.card.hero',
    h('div.hero-text',
      h('h2', icon('play'), 'おまかせ演習'),
      h('p', '復習期日が来た問題 → 苦手ジャンル → まだ解いていない問題 の順に自動で選んで出題します。間違えた問題はセットの中でもう一度出て、翌日以降にも復習に回ります。')),
    segmented([['both', '両方'], ['kogaku', '無線工学'], ['hoki', '法規']], subject, (v) => {
      subject = v;
      store.setSetting('subject', v);
    }),
    h('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', onclick: () => smartSession(subject) },
      `${s.sessionSize}問 解く`));

  // ---- 復習
  const nextDue = reviewAll.filter((q) => !isDue(st[q.id], now)).map((q) => st[q.id].due).sort((a, b) => a - b)[0];
  const review = h('section.card.review-card',
    h('div.card-row',
      h('div',
        h('h2', icon('repeat'), '間違えた問題の復習'),
        h('p.muted', reviewAll.length
          ? `要復習 ${reviewAll.length}問 / 今日の復習 ${reviewDue.length}問`
          : 'まだ要復習の問題はありません。間違えた問題がここにたまります。'),
        reviewAll.length && !reviewDue.length && nextDue ? h('p.muted.small', `次の復習: ${fmtDate(nextDue)}〜`) : null),
      h('div.big-num' + (reviewDue.length ? '.warn' : ''), String(reviewDue.length))),
    h('div.btn-row',
      h('button.btn.btn-primary', { type: 'button', disabled: !reviewDue.length, onclick: () => reviewSession(false) }, '今日の復習をする'),
      reviewAll.length > reviewDue.length
        ? h('button.btn', { type: 'button', onclick: () => reviewSession(true) }, `期日前も含めて全部（${reviewAll.length}問）`)
        : null));

  // ---- 苦手ジャンル
  const gsAll = genreSummary(all, st, allGenres('both'));
  const weak = gsAll.filter((g) => g.weak).sort((a, b) => weakness(b) - weakness(a));
  const weakCard = h('section.card',
    h('h2', icon('target'), '苦手ジャンル'),
    weak.length
      ? [
        h('ul.genre-list.compact', weak.slice(0, 5).map((g) => genreRow(g, true))),
        h('button.btn.btn-block', {
          type: 'button',
          onclick: () => genreSession(weak.slice(0, 3).map((g) => g.id), '苦手ジャンル集中演習'),
        }, `苦手上位${Math.min(3, weak.length)}ジャンルをまとめて解く`),
      ]
      : h('p.muted', '3問以上解いて直近正答率が70%未満のジャンルや、要復習が2問以上あるジャンルがここに出ます。'));

  // ---- ジャンル別
  const genreCards = ['kogaku', 'hoki'].map((subj) => {
    const qs = questionsOf(subj);
    const gs = genreSummary(qs, st, D.genres[subj]);
    return h('section.card',
      h('div.card-head',
        h('h2', subjectLabel(subj), h('span.muted.small', ` ${qs.length}問`)),
        h('span.legend', h('span.legend-line'), '合格ライン70%')),
      h('ul.genre-list', gs.map((g) => genreRow(g, false))));
  });

  const custom = h('section.card.link-card',
    h('button.link-row', { type: 'button', onclick: () => navigate('/custom') },
      icon('filter'),
      h('span', h('strong', '条件を指定して演習'), h('small', '回・ジャンル・未解答／不正解のみ・出題順などを選んで解く')),
      icon('next')));

  if (!store.isPersistent()) {
    view.append(h('div.notice.warn', 'この環境では学習記録を保存できません（プライベートブラウズ等）。ページを閉じると記録が消えます。'));
  }
  view.append(header, tiles, smart, review, weakCard, custom, ...genreCards);
}

function tile(label, value, unit) {
  return h('div.tile', h('div.tile-label', label), h('div.tile-value', value, h('span.tile-unit', unit)));
}

function genreRow(g, showSubject) {
  const subj = db().genreById.get(g.id)?.subject;
  return h('li',
    h('button.genre-row', {
      type: 'button',
      onclick: () => genreSession([g.id], `${g.label}を解く`),
      'aria-label': `${g.label}を解く。直近正答率${pct(g.mastery)}、解答済み${g.attempted}/${g.total}問`,
    },
    h('span.genre-name', g.label, showSubject ? h('small', subjectLabel(subj)) : null),
    genreBar(g),
    h('span.genre-num', pct(g.mastery)),
    h('span.genre-sub', `${g.attempted}/${g.total}`, g.review ? h('em', ` 要復習${g.review}`) : null)));
}
