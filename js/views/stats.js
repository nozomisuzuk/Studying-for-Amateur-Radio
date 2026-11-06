// 学習記録(日別の解答数・ジャンル別・回別・模擬試験の推移)

import { db, subjectLabel, examCodes } from '../data.js';
import * as store from '../store.js';
import { genreSummary, dayKey, DAY } from '../engine.js';
import { h, pct, fmtDateTime } from '../ui.js';
import { genreBar } from './home.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** 直近30日の解答数(棒の濃い部分が正解) */
function dailyChart(daily) {
  const days = 30;
  const today = Date.now();
  const data = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = today - i * DAY;
    const d = daily[dayKey(t)] || { n: 0, c: 0 };
    data.push({ t, ...d });
  }
  const max = Math.max(10, ...data.map((d) => d.n));
  const W = 600;
  const H = 160;
  const padL = 28;
  const padB = 22;
  const bw = (W - padL) / days;
  const y = (v) => H - padB - (v / max) * (H - padB - 8);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': '直近30日の解答数' });
  // 目盛り
  for (const v of [0, Math.round(max / 2), max]) {
    g.append(svg('line', { x1: padL, x2: W, y1: y(v), y2: y(v), class: 'grid' }));
    const tx = svg('text', { x: padL - 4, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' });
    tx.textContent = String(v);
    g.append(tx);
  }
  data.forEach((d, i) => {
    const x = padL + i * bw + bw * 0.15;
    const w = bw * 0.7;
    if (d.n) {
      const title = svg('title');
      title.textContent = `${new Date(d.t).getMonth() + 1}/${new Date(d.t).getDate()}: ${d.n}問中 ${d.c}問正解`;
      const grp = svg('g', {}, title,
        svg('rect', { x, y: y(d.n), width: w, height: y(0) - y(d.n), rx: 2, class: 'bar-all' }),
        svg('rect', { x, y: y(d.c), width: w, height: y(0) - y(d.c), rx: 2, class: 'bar-ok' }));
      g.append(grp);
    }
    if (i % 5 === 4 || i === days - 1) {
      const dt = new Date(d.t);
      const tx = svg('text', { x: x + w / 2, y: H - 6, class: 'axis', 'text-anchor': 'middle' });
      tx.textContent = `${dt.getMonth() + 1}/${dt.getDate()}`;
      g.append(tx);
    }
  });
  return g;
}

/** 模擬試験の得点推移(科目ごと) */
function examChart(results, subject) {
  const rs = results.filter((r) => r.subject === subject).slice(-20);
  if (rs.length < 2) return null;
  const info = db().subjects[subject];
  const W = 600;
  const H = 150;
  const padL = 32;
  const padB = 10;
  const x = (i) => padL + (i / (rs.length - 1)) * (W - padL - 12);
  const y = (v) => H - padB - (v / info.full) * (H - padB - 10);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${subjectLabel(subject)}の模擬試験の得点推移` });
  for (const v of [0, info.pass, info.full]) {
    g.append(svg('line', { x1: padL, x2: W, y1: y(v), y2: y(v), class: v === info.pass ? 'passline' : 'grid' }));
    const tx = svg('text', { x: padL - 4, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' });
    tx.textContent = String(v);
    g.append(tx);
  }
  g.append(svg('polyline', { points: rs.map((r, i) => `${x(i)},${y(r.score)}`).join(' '), class: 'line' }));
  rs.forEach((r, i) => {
    const t = svg('title');
    t.textContent = `${r.title} ${r.score}点`;
    g.append(svg('circle', { cx: x(i), cy: y(r.score), r: 4, class: r.pass ? 'pt-ok' : 'pt-ng' }, t));
  });
  return g;
}

export function renderStats(view) {
  const D = db();
  const st = store.stats();
  const daily = store.daily();
  const all = D.questions;
  const attempted = all.filter((q) => st[q.id]?.a);
  const totalA = attempted.reduce((s, q) => s + st[q.id].a, 0);
  const totalC = attempted.reduce((s, q) => s + st[q.id].c, 0);
  const review = all.filter((q) => st[q.id]?.rv).length;
  const cleared = all.filter((q) => st[q.id]?.cleared && !st[q.id]?.rv).length;
  const days = Object.values(daily).filter((d) => d.n).length;

  view.append(h('header.page-head', h('div', h('h1', '学習記録'), h('p.sub', 'この端末のブラウザに保存されています。'))));
  view.append(h('section.tiles',
    tile('のべ解答数', String(totalA), '回'),
    tile('のべ正答率', pct(totalA ? totalC / totalA : null), ''),
    tile('克服した問題', String(cleared), '問'),
    tile('学習した日', String(days), '日')));

  view.append(h('section.card', h('h2', '直近30日の解答数'),
    h('div.legend-row', h('span.lg.lg-ok', '正解'), h('span.lg.lg-all', '不正解')),
    dailyChart(daily)));

  for (const subj of ['kogaku', 'hoki']) {
    const qs = all.filter((q) => q.subject === subj);
    const gs = genreSummary(qs, st, D.genres[subj]);
    view.append(h('section.card',
      h('h2', `${subjectLabel(subj)} ジャンル別`),
      h('table.stat-table',
        h('thead', h('tr', h('th', 'ジャンル'), h('th', '直近正答率'), h('th', '解答済'), h('th', 'のべ正答率'), h('th', '要復習'))),
        h('tbody', gs.map((g) => h('tr' + (g.weak ? '.weak' : ''),
          h('th', g.label),
          h('td', h('div.cell-meter', genreBar(g), h('span', pct(g.mastery)))),
          h('td', `${g.attempted}/${g.total}`),
          h('td', pct(g.a ? g.c / g.a : null)),
          h('td', g.review ? String(g.review) : '—')))))));
  }

  // 回ごとの進み具合
  const rows = examCodes().map(({ code, session, subject }) => {
    const qs = all.filter((q) => q.code === code);
    const done = qs.filter((q) => st[q.id]?.a);
    const ok = done.filter((q) => st[q.id].lr === 1).length;
    return h('tr', h('th', session.label, h('small', ` ${subjectLabel(subject)}`)),
      h('td', `${done.length}/${qs.length}`), h('td', pct(done.length ? ok / done.length : null)));
  });
  view.append(h('section.card', h('h2', '試験の回ごとの進み具合'),
    h('table.stat-table', h('thead', h('tr', h('th', '回'), h('th', '解答済'), h('th', '直近正答率'))), h('tbody', rows))));

  const results = store.exams();
  if (results.length) {
    const charts = ['kogaku', 'hoki'].map((s) => {
      const c = examChart(results, s);
      return c ? h('div', h('h3', subjectLabel(s)), c) : null;
    }).filter(Boolean);
    view.append(h('section.card', h('h2', '模擬試験の得点'),
      charts.length ? charts : null,
      h('ul.history-list', results.map((r, i) => ({ r, i })).reverse().slice(0, 10).map(({ r, i }) =>
        h('li', h('a', { href: `#/exam/result/${i}` },
          h('span.hist-title', r.title, h('small', fmtDateTime(r.t))),
          h('span.hist-score.' + (r.pass ? 'ok' : 'ng'), `${r.score}/${r.max}`, h('small', r.pass ? '合格' : '不合格'))))))));
  }
}

function tile(label, value, unit) {
  return h('div.tile', h('div.tile-label', label), h('div.tile-value', value, h('span.tile-unit', unit)));
}
