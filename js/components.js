// 問題表示と解答UI(演習・模擬試験で共用)

import { KANA } from './engine.js';
import { h, icon, openZoom } from './ui.js';
import { questionTitle } from './data.js';
import { renderTextView } from './textview.js';
import * as store from './store.js';

const NARROW = 760; // これより狭い画面では「自動」でテキスト表示にする

/** 表示方法: 'text'(PDFから組み直した本文) / 'image'(原本の画像) */
export function viewModeFor(q) {
  if (!q.tv) return 'image';
  const pref = store.settings().qView || 'auto';
  if (pref === 'text' || pref === 'image') return pref;
  return window.innerWidth < NARROW ? 'text' : 'image';
}

/**
 * 問題文。スマホなど狭い画面ではテキスト表示、広い画面では原本の画像を出す。
 * どちらの表示でも、ボタンでもう一方に切り替えられる(切り替えた方を次の問題からも使う)。
 */
export function questionFigure(q) {
  const title = questionTitle(q);
  const open = () => openZoom(q.images, title);
  const wrap = h('figure.qfig');
  const draw = (mode) => {
    const tools = h('div.fig-tools');
    let body;
    if (mode === 'text') {
      body = renderTextView(q, '', title);
      tools.append(
        h('span.fig-note', 'PDFから組み直した表示です'),
        h('button.zoom-btn', { type: 'button', onclick: () => switchTo('image') }, icon('exam'), h('span', '原本を表示')));
    } else {
      const imgs = q.images.map((im, i) =>
        h('img.qimg', {
          src: im.src, width: im.w, height: im.h, decoding: 'async',
          alt: `${title}${q.images.length > 1 ? `（${i + 1}/${q.images.length}）` : ''} の問題文`,
        }));
      body = h('div.qimg-wrap', { onclick: open, title: 'タップで拡大' }, imgs);
      if (q.tv) tools.append(h('button.zoom-btn', { type: 'button', onclick: () => switchTo('text') }, icon('list'), h('span', '文字で表示')));
      tools.append(h('button.zoom-btn', { type: 'button', onclick: open, 'aria-label': '問題を拡大表示' }, icon('zoom'), h('span', '拡大')));
    }
    wrap.replaceChildren(body, tools);
  };
  const switchTo = (mode) => {
    store.setSetting('qView', mode);
    draw(mode);
  };
  draw(viewModeFor(q));
  return wrap;
}

/** 次の問題の画像を先読みする */
export function prefetch(q) {
  if (!q) return;
  const mode = viewModeFor(q);
  const srcs = mode === 'text'
    ? q.tv.filter((b) => b.t === 'img').map((b) => b.src)
    : q.images.map((im) => im.src);
  for (const src of srcs) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
  }
}

/**
 * 解答UI。
 * mode='drill': A問題は押した時点で解答確定、B問題は全小設問を選ぶと「解答する」が押せる
 * mode='exam' : 選択を変えるたびに onChange、確定はしない
 */
export function answerUI(q, { mode = 'drill', initial = null, onAnswer, onChange } = {}) {
  let response = initial == null ? (q.kind === 'A' ? null : Array(q.answer.length).fill(null)) : structuredClone(initial);
  let locked = false;
  const root = h('div.answer' + (q.kind === 'A' ? '.answer-a' : '.answer-b'));

  if (q.kind === 'A') {
    const btns = [];
    for (let n = 1; n <= q.choices; n++) {
      const b = h('button.choice', {
        type: 'button', 'data-n': n, 'aria-pressed': String(response === n),
        onclick: () => {
          if (locked) return;
          if (mode === 'drill') {
            response = n;
            onAnswer?.(n);
          } else {
            response = response === n ? null : n;
            sync();
            onChange?.(response);
          }
        },
      }, String(n));
      btns.push(b);
    }
    const sync = () => btns.forEach((b, i) => {
      b.classList.toggle('selected', response === i + 1);
      b.setAttribute('aria-pressed', String(response === i + 1));
    });
    sync();
    root.append(h('div.choice-row', { role: 'group', 'aria-label': '解答番号' }, btns));
    root.reveal = (result) => {
      locked = true;
      btns.forEach((b, i) => {
        const n = i + 1;
        b.disabled = true;
        if (n === q.answer) b.classList.add('is-answer');
        if (n === response && n !== q.answer) b.classList.add('is-wrong');
      });
    };
    root.press = (n) => btns[n - 1]?.click();
  } else {
    const tf = q.bStyle === 'tf';
    const n = q.choices;
    const rows = [];
    const submit = mode === 'drill'
      ? h('button.btn.btn-primary.btn-block.submit-b', { type: 'button', disabled: true, onclick: () => !locked && onAnswer?.(response.slice()) }, '解答する')
      : null;
    q.answer.forEach((_, i) => {
      const btns = [];
      for (let v = 1; v <= n; v++) {
        btns.push(h('button.choice.choice-sm' + (tf ? '.choice-tf' : ''), {
          type: 'button', 'aria-pressed': String(response[i] === v),
          'aria-label': `${KANA[i]} に ${v}${tf ? `（${q.tfLabels?.[v - 1] ?? ''}）` : ''}`,
          onclick: () => {
            if (locked) return;
            response[i] = response[i] === v && mode === 'exam' ? null : v;
            syncRow(i);
            if (submit) submit.disabled = response.some((x) => x == null);
            onChange?.(response.slice());
          },
        }, String(v), tf ? h('small', q.tfLabels?.[v - 1] ?? '') : null));
      }
      const mark = h('span.row-mark');
      rows.push({ btns, mark });
      root.append(h('div.b-row',
        h('span.b-label', KANA[i]),
        h('div.b-choices' + (tf ? '.tf' : ''), { role: 'group', 'aria-label': `${KANA[i]} の解答` }, btns),
        mark));
    });
    const syncRow = (i) => rows[i].btns.forEach((b, j) => {
      b.classList.toggle('selected', response[i] === j + 1);
      b.setAttribute('aria-pressed', String(response[i] === j + 1));
    });
    rows.forEach((_, i) => syncRow(i));
    if (submit) {
      submit.disabled = response.some((x) => x == null);
      root.append(submit);
    }
    root.reveal = (result) => {
      locked = true;
      submit?.remove();
      rows.forEach((row, i) => {
        const ans = q.answer[i];
        row.btns.forEach((b, j) => {
          b.disabled = true;
          if (j + 1 === ans) b.classList.add('is-answer');
          if (j + 1 === response[i] && response[i] !== ans) b.classList.add('is-wrong');
        });
        const ok = result.items[i];
        row.mark.replaceChildren(icon(ok ? 'check' : 'cross'));
        row.mark.className = 'row-mark ' + (ok ? 'ok' : 'ng');
      });
    };
    root.press = () => {};
  }
  root.getResponse = () => (Array.isArray(response) ? response.slice() : response);
  return root;
}

/** 正答の文字列表現 */
export function answerText(q) {
  if (q.kind === 'A') return String(q.answer);
  return q.answer.map((a, i) => `${KANA[i]}${a}`).join(' ');
}

export function responseText(q, r) {
  if (r == null) return '未解答';
  if (q.kind === 'A') return String(r);
  return r.map((a, i) => `${KANA[i]}${a ?? '-'}`).join(' ');
}
