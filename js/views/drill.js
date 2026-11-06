// 演習画面(1問ずつ解いて即採点)と結果画面

import { q as getQ, questionTitle, genreLabel } from '../data.js';
import * as store from '../store.js';
import { grade, remainingToClear } from '../engine.js';
import { h, icon, toast, confirmDialog, promptText, historyDots, fmtDuration, fmtDate } from '../ui.js';
import { questionFigure, answerUI, prefetch, answerText, responseText } from '../components.js';
import { explanationCard } from '../explain.js';
import { navigate } from '../app.js';

let session = null;

/**
 * 演習セットを開始する。
 * ids: 出題する問題IDの配列 / refill: 「続けて解く」で次のセットを作る関数
 */
export function startSession({ mode, title, ids, refill = null, backTo = '/' }) {
  if (!ids || !ids.length) {
    toast('条件に合う問題がありません');
    return;
  }
  session = {
    mode, title, refill, backTo,
    queue: ids.map((id) => ({ id, retry: false })),
    idx: 0,
    results: [],
    retried: new Set(),
    startedAt: Date.now(),
    answered: null, // 現在の問題の採点結果
  };
  navigate('/drill');
}

export function startSingle(view, id) {
  if (!getQ(id)) {
    navigate('/list', { replace: true });
    return null;
  }
  // 結果画面から開いた場合は、閉じたら結果画面に戻れるようにしておく
  const parent = session && session.mode !== 'single' && session.idx >= session.queue.length ? session : null;
  const backTo = parent ? '/drill' : lastListOrHome();
  session = {
    mode: 'single', title: '1問演習', refill: null, backTo, parent,
    queue: [{ id, retry: false }], idx: 0, results: [], retried: new Set(), startedAt: Date.now(), answered: null,
  };
  return renderDrill(view);
}

export function renderDrill(view) {
  if (!session) {
    navigate('/', { replace: true });
    return null;
  }
  document.body.classList.add('focus-mode');
  if (session.idx >= session.queue.length) {
    renderSummary(view);
    return null;
  }
  const item = session.queue[session.idx];
  const q = getQ(item.id);
  const s = store.settings();
  const st = store.getStat(q.id);

  // ---- ヘッダー
  const total = session.queue.length;
  const head = h('header.drill-head',
    h('button.icon-btn', { type: 'button', 'aria-label': '演習をやめる', onclick: quit }, icon('close')),
    h('div.drill-title', session.title),
    h('div.drill-count', `${session.idx + 1} / ${total}`),
    h('div.progress', h('div.progress-fill', { style: { width: `${(session.idx / total) * 100}%` } })));

  // ---- 問題の情報
  const meta = h('div.qmeta',
    h('span.qtitle', questionTitle(q)),
    h('span.chip', genreLabel(q.genre)),
    item.retry ? h('span.chip.chip-warn', '再出題') : null,
    st?.rv ? h('span.chip.chip-ng', '要復習') : null,
    st?.a ? historyDots(st.h) : h('span.chip.chip-new', '初出題'));

  const fig = questionFigure(q);
  const notes = h('div.qnotes');
  if (q.allCorrect) notes.append(h('p.notice.info', icon('info'), `公式発表: ${q.allCorrect}（本アプリでは公表された正答を正解として扱います）`));

  const dock = h('div.dock');
  const feedback = h('div.feedback-slot', { 'aria-live': 'polite' });

  const answer = answerUI(q, {
    mode: 'drill',
    onAnswer: (response) => submit(q, item, response, answer, dock, feedback, body),
  });

  const body = h('div.drill-body', meta, fig, notes);
  if (q.kind === 'A') {
    dock.append(h('p.dock-hint', q.choices === 4 ? '1〜4 から選択' : `1〜${q.choices} から選択`), answer);
  } else {
    body.append(h('p.b-hint', q.bStyle === 'tf'
      ? `ア〜オ それぞれ 1（${q.tfLabels?.[0] ?? '正'}）か 2（${q.tfLabels?.[1] ?? '誤'}）を選んでください`
      : 'ア〜オ それぞれに入る字句の番号（1〜10）を選んでください'), answer);
  }
  dock.append(feedback);

  view.append(h('div.drill', head, body, dock));
  prefetch(getQ(session.queue[session.idx + 1]?.id));

  if (session.answered && session.answered.id === q.id) {
    // 再描画(取り消し後など)で状態を保つ必要はないので通常はここに来ない
    session.answered = null;
  }

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, .dialog-wrap, .zoom-wrap')) return;
    if (!session || session.answered == null) {
      if (q.kind === 'A' && /^[1-9]$/.test(e.key)) {
        const n = Number(e.key);
        if (n <= q.choices) answer.press(n);
      }
    } else if (e.key === 'Enter' || e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      next();
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

function submit(q, item, response, answer, dock, feedback, body) {
  if (session.answered) return;
  const result = grade(q, response);
  const { prev, next: stat } = store.record(q, result, session.mode, response);
  session.answered = { id: q.id, result, prev };
  session.results.push({ id: q.id, correct: result.correct, points: result.points, max: result.max, retry: item.retry, response });
  answer.reveal(result);

  // 間違えたらセットの少し後でもう一度出す
  let retryAdded = false;
  if (!result.correct && store.settings().retryWrong && session.mode !== 'single' && !session.retried.has(q.id)) {
    const pos = Math.min(session.idx + 4, session.queue.length);
    session.queue.splice(pos, 0, { id: q.id, retry: true });
    session.retried.add(q.id);
    retryAdded = true;
  }

  const cs = store.settings().clearStreak;
  let note;
  if (!result.correct) {
    note = retryAdded ? '要復習に追加しました。このセットの少し後と、明日以降の復習でもう一度出ます。' : '要復習に追加しました。';
  } else if (prev?.rv && !stat.rv) {
    note = '克服！ 要復習リストから外れました。';
    toast('克服しました 🎉', 'ok');
  } else if (stat.rv && stat.st > (prev?.st ?? 0)) {
    note = `あと ${remainingToClear(stat, cs)} 回正解で克服（次の復習は ${fmtDate(stat.due)} 以降）`;
  } else if (stat.rv) {
    note = '要復習の問題です（復習の期日前なので、克服までの回数には数えません）。';
  }

  const ok = result.correct;
  const head = q.kind === 'A'
    ? h('div.fb-answer', `正答 ${q.answer}`, ok ? null : h('span.muted', ` ／ あなた ${response}`))
    : h('div.fb-answer', `${result.points}/${result.max}点 ・ 正答 ${answerText(q)}`);
  const bm = h('button.icon-btn' + (stat.bm ? '.on' : ''), {
    type: 'button', 'aria-label': 'ブックマーク', 'aria-pressed': String(!!stat.bm), title: 'ブックマーク（★）',
    onclick: () => {
      const on = !store.getStat(q.id)?.bm;
      store.setBookmark(q.id, on);
      bm.classList.toggle('on', on);
      bm.setAttribute('aria-pressed', String(on));
      toast(on ? 'ブックマークしました' : 'ブックマークを外しました');
    },
  }, icon('star'));
  const memoBtn = h('button.icon-btn' + (stat.memo ? '.on' : ''), {
    type: 'button', 'aria-label': 'メモ', title: 'メモ',
    onclick: async () => {
      const text = await promptText(`メモ: ${questionTitle(q)}`, store.getStat(q.id)?.memo || '', '間違えた理由や覚え方など');
      if (text != null) {
        store.setMemo(q.id, text);
        memoBtn.classList.toggle('on', !!text);
        toast('メモを保存しました');
      }
    },
  }, icon('memo'));
  const undoBtn = h('button.icon-btn', {
    type: 'button', 'aria-label': '解答を取り消す', title: '押し間違えたときに取り消す',
    onclick: () => undoCurrent(q, retryAdded),
  }, icon('undo'));
  // 解説は問題文の下に出し、解答欄からはボタンで移動できるようにする
  const expl = explanationCard(q);
  if (expl) body.append(expl);
  const explBtn = expl
    ? h('button.btn.btn-sm.expl-btn', {
      type: 'button', title: '解説へ移動',
      onclick: () => expl.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, icon('info'), '解説')
    : null;
  const nextLabel = session.mode === 'single' ? '戻る' : session.idx + 1 >= session.queue.length ? '結果を見る' : '次へ';
  const nextBtn = h('button.btn.btn-primary.next-btn', { type: 'button', onclick: next }, nextLabel, icon('next'));

  feedback.replaceChildren(h('div.feedback.' + (ok ? 'ok' : 'ng'),
    h('div.fb-top',
      h('span.fb-mark', icon(ok ? 'check' : 'cross')),
      h('strong.fb-label', ok ? '正解' : (q.kind === 'B' && result.points > 0 ? '惜しい' : '不正解')),
      head),
    note ? h('p.fb-note', note) : null,
    stat.memo ? h('p.fb-memo', icon('memo'), stat.memo) : null,
    h('div.fb-actions', undoBtn, bm, memoBtn, explBtn, nextBtn)));
  dock.classList.add('answered');
  if (q.kind === 'B') feedback.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => nextBtn.focus({ preventScroll: true }), 50);
}

function undoCurrent(q, retryAdded) {
  const a = session.answered;
  if (!a) return;
  store.undo(q.id, a.prev);
  session.results.pop();
  if (retryAdded) {
    const i = session.queue.findIndex((it, k) => k > session.idx && it.id === q.id && it.retry);
    if (i >= 0) session.queue.splice(i, 1);
    session.retried.delete(q.id);
  }
  session.answered = null;
  toast('解答を取り消しました');
  navigate('/drill');
}

let lastList = '/list';
/** 問題一覧から1問演習に入ったときの戻り先を覚えておく */
export function rememberListPath(path) {
  lastList = path;
}
function lastListOrHome() {
  return lastList;
}

function leaveSingle() {
  const parent = session.parent;
  const back = session.backTo || '/list';
  session = parent || null;
  navigate(parent ? '/drill' : back);
}

function next() {
  if (!session) return;
  if (session.mode === 'single') return leaveSingle();
  session.answered = null;
  session.idx += 1;
  navigate('/drill');
}

async function quit() {
  if (!session) return navigate('/');
  if (session.mode === 'single') return leaveSingle();
  if (session.results.length && session.idx < session.queue.length) {
    session.queue = session.queue.slice(0, session.idx + (session.answered ? 1 : 0));
    session.idx = session.queue.length;
    session.answered = null;
    navigate('/drill');
    return;
  }
  const back = session.backTo || '/';
  session = null;
  navigate(back);
}

function renderSummary(view) {
  const r = session.results;
  const firstTry = r.filter((x) => !x.retry);
  const ok = firstTry.filter((x) => x.correct).length;
  const wrongIds = [...new Set(r.filter((x) => !x.correct).map((x) => x.id))];
  const stillWrong = wrongIds.filter((id) => store.getStat(id)?.lr === 0);
  const dur = Date.now() - session.startedAt;
  const rate = firstTry.length ? ok / firstTry.length : 0;
  const done = session;

  const list = h('ol.result-list', r.map((x) => {
    const q = getQ(x.id);
    return h('li',
      h('a', { href: `#/q/${q.id}` },
        h('span.res-mark.' + (x.correct ? 'ok' : 'ng'), icon(x.correct ? 'check' : 'cross')),
        h('span.res-title', questionTitle(q), x.retry ? h('small', ' 再出題') : null),
        h('span.res-genre', genreLabel(q.genre)),
        q.kind === 'B' ? h('span.res-pts', `${x.points}/${x.max}`) : null));
  }));

  view.append(h('div.drill.summary',
    h('header.drill-head',
      h('button.icon-btn', { type: 'button', 'aria-label': '閉じる', onclick: () => { session = null; navigate(done.backTo || '/'); } }, icon('close')),
      h('div.drill-title', `${done.title} の結果`)),
    h('section.card.result-hero',
      h('div.result-score', h('strong', `${ok}`), h('span', ` / ${firstTry.length}問 正解`)),
      h('div.result-rate.' + (rate >= 0.7 ? 'ok' : 'ng'), `正答率 ${Math.round(rate * 100)}%`),
      h('p.muted', `所要時間 ${fmtDuration(dur)}${r.length > firstTry.length ? ` ・ 再出題 ${r.length - firstTry.length}問を含む` : ''}`),
      stillWrong.length ? h('p.muted', `最後まで正解できなかった問題 ${stillWrong.length}問は「間違えた問題の復習」に入っています。`) : null),
    h('div.btn-col',
      wrongIds.length
        ? h('button.btn.btn-primary.btn-block', {
          type: 'button',
          onclick: () => startSession({ mode: 'retry', title: '間違えた問題をもう一度', ids: wrongIds, refill: null, backTo: done.backTo }),
        }, icon('repeat'), `間違えた${wrongIds.length}問をもう一度`)
        : null,
      done.refill
        ? h('button.btn.btn-block' + (wrongIds.length ? '' : '.btn-primary'), {
          type: 'button',
          onclick: () => startSession({ mode: done.mode, title: done.title, ids: done.refill(), refill: done.refill, backTo: done.backTo }),
        }, icon('play'), '続けて次のセットを解く')
        : null,
      h('button.btn.btn-block', { type: 'button', onclick: () => { session = null; navigate(done.backTo || '/'); } },
        done.backTo === '/list' ? '問題一覧へ戻る' : 'ホームへ戻る')),
    h('section.card', h('h2', '解いた問題'), list)));
}

export { responseText };
