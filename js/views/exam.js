// 模擬試験(本番と同じ30問・2時間30分・150点満点/合格105点)

import { db, q as getQ, subjectLabel, genreLabel, examCodes, sessionLabel, practice, isOutdated } from '../data.js';
import * as store from '../store.js';
import { buildSessionExam, buildRandomExam, scoreExam, grade, examPoints, kindOrder } from '../engine.js';
import { h, icon, toast, confirmDialog, fmtDuration, fmtDateTime } from '../ui.js';
import { questionFigure, answerUI, prefetch, answerText, responseText } from '../components.js';
import { explanationCard, outdatedNotice } from '../explain.js';
import { startSession, rememberListPath } from './drill.js';
import { navigate } from '../app.js';

function subjectInfo(subject) {
  return db().subjects[subject]; // {label, full, pass, minutes}
}

async function beginExam(draft) {
  if (store.examDraft()) {
    const ok = await confirmDialog('受験中の模擬試験があります', '新しく始めると、受験中の模擬試験は破棄されます。', '新しく始める', true);
    if (!ok) return;
  }
  store.setExamDraft(draft);
  navigate('/exam/run');
}

function startSessionExam(code, subject) {
  const qs = buildSessionExam(db().questions, code);
  const ses = db().sessionById.get(qs[0].session);
  beginExam({
    kind: 'session', code, subject, title: `${ses.label} ${subjectLabel(subject)}`,
    ids: qs.map((q) => q.id), answers: {}, flags: [], idx: 0,
    startedAt: Date.now(), limitMs: subjectInfo(subject).minutes * 60 * 1000,
  });
}

function startRandomExam(subject) {
  const qs = buildRandomExam(practice(), subject);
  beginExam({
    kind: 'random', code: null, subject, title: `ランダム模試 ${subjectLabel(subject)}`,
    ids: qs.map((q) => q.id), answers: {}, flags: [], idx: 0,
    startedAt: Date.now(), limitMs: subjectInfo(subject).minutes * 60 * 1000,
  });
}

// ---------------------------------------------------------------- 一覧
export function renderExamList(view) {
  const draft = store.examDraft();
  const results = store.exams();
  const best = new Map();
  results.forEach((r) => {
    if (r.code && (!best.has(r.code) || best.get(r.code).score < r.score)) best.set(r.code, r);
  });

  view.append(h('header.page-head', h('div', h('h1', '模擬試験'),
    h('p.sub', '本試験と同じ 30問・2時間30分。150点満点で 105点以上が合格です。途中で閉じても時間は進みます。'))));

  if (draft) {
    const left = draft.startedAt + draft.limitMs - Date.now();
    view.append(h('section.card.hero',
      h('h2', icon('clock'), '受験中'),
      h('p', draft.title, h('br'), h('span.muted', `解答済み ${Object.values(draft.answers).filter((a) => a != null).length} / ${draft.ids.length}問 ・ 残り ${left > 0 ? fmtDuration(left) : '0:00（時間切れ）'}`)),
      h('div.btn-row',
        h('button.btn.btn-primary', { type: 'button', onclick: () => navigate('/exam/run') }, '続きから'),
        h('button.btn', {
          type: 'button',
          onclick: async () => {
            if (await confirmDialog('受験中の模擬試験を破棄しますか？', '解答は記録されません。', '破棄する', true)) {
              store.setExamDraft(null);
              navigate('/exam', { replace: true });
            }
          },
        }, '破棄'))));
  }

  view.append(h('section.card',
    h('h2', icon('repeat'), 'ランダム模試'),
    h('p.muted', '問題番号（A-1, A-2, …）ごとに、過去の各回の同じ番号の問題から1問ずつ選びます。本試験は分野順に並んでいるため、分野の配分が本試験と同じになります。'),
    h('div.btn-row',
      h('button.btn.btn-primary', { type: 'button', onclick: () => startRandomExam('kogaku') }, '無線工学'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => startRandomExam('hoki') }, '法規'))));

  const rows = examCodes().map(({ code, session, subject }) => {
    const b = best.get(code);
    const info = subjectInfo(subject);
    return h('li.exam-row',
      h('span.exam-name', session.label, h('small', subjectLabel(subject))),
      b ? h('span.exam-best.' + (b.score >= info.pass ? 'ok' : 'ng'), `最高 ${b.score}点`) : h('span.exam-best.muted', '未受験'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => startSessionExam(code, subject) }, '解く'));
  });
  view.append(h('section.card', h('h2', icon('exam'), '過去の回をそのまま解く'), h('ul.exam-list', rows)));

  if (results.length) {
    view.append(h('section.card', h('h2', '受験履歴'),
      h('ul.history-list', results.map((r, i) => ({ r, i })).reverse().slice(0, 30).map(({ r, i }) =>
        h('li', h('a', { href: `#/exam/result/${i}` },
          h('span.hist-title', r.title, h('small', fmtDateTime(r.t))),
          h('span.hist-score.' + (r.pass ? 'ok' : 'ng'), `${r.score}/${r.max}`, h('small', r.pass ? '合格' : '不合格'))))))));
  }
}

// ---------------------------------------------------------------- 受験中
export function renderExamRun(view) {
  const draft = store.examDraft();
  if (!draft) {
    navigate('/exam', { replace: true });
    return null;
  }
  document.body.classList.add('focus-mode');
  const qs = draft.ids.map(getQ);
  const timerEl = h('span.timer');
  const answeredCount = () => qs.filter((q) => isAnswered(q, draft.answers[q.id])).length;
  const countEl = h('span.muted.small');

  const nav = h('div.exam-nav', { role: 'navigation', 'aria-label': '問題番号' });
  const stage = h('div.exam-stage');

  const save = () => store.setExamDraft(draft);

  function drawNav() {
    nav.replaceChildren(...qs.map((q, i) => {
      const done = isAnswered(q, draft.answers[q.id]);
      const flagged = draft.flags.includes(q.id);
      return h('button.nav-cell' + (done ? '.done' : '') + (flagged ? '.flag' : '') + (i === draft.idx ? '.cur' : ''), {
        type: 'button', 'aria-label': `${q.label}${done ? ' 解答済み' : ' 未解答'}${flagged ? ' 見直し' : ''}`,
        'aria-current': i === draft.idx ? 'true' : null,
        onclick: () => go(i),
      }, q.label.replace('-', ''));
    }));
    countEl.textContent = `解答 ${answeredCount()}/${qs.length}`;
    nav.querySelector('.cur')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function drawQuestion() {
    const q = qs[draft.idx];
    const flagged = draft.flags.includes(q.id);
    const ans = answerUI(q, {
      mode: 'exam',
      initial: draft.answers[q.id] ?? null,
      onChange: (r) => {
        draft.answers[q.id] = r;
        save();
        drawNav();
      },
    });
    const flagBtn = h('button.btn.btn-sm' + (flagged ? '.on' : ''), {
      type: 'button', 'aria-pressed': String(flagged),
      onclick: () => {
        const i = draft.flags.indexOf(q.id);
        if (i >= 0) draft.flags.splice(i, 1);
        else draft.flags.push(q.id);
        save();
        drawNav();
        flagBtn.classList.toggle('on', i < 0);
        flagBtn.setAttribute('aria-pressed', String(i < 0));
      },
    }, icon('flag'), '見直し');
    stage.replaceChildren(
      h('div.qmeta', h('span.qtitle', `${q.label}`), h('span.muted.small', ` ${draft.kind === 'random' ? sessionLabel(q.session) : ''}`)),
      questionFigure(q),
      ...(isOutdated(q) ? [outdatedNotice()] : []),
      q.kind === 'B'
        ? h('p.b-hint', q.bStyle === 'tf' ? `ア〜オ それぞれ 1（${q.tfLabels?.[0] ?? '正'}）か 2（${q.tfLabels?.[1] ?? '誤'}）` : 'ア〜オ に入る字句の番号（1〜10）')
        : h('p.b-hint', `1〜${q.choices} から1つ選択（もう一度押すと取り消し）`),
      ans,
      h('div.exam-pager',
        h('button.btn', { type: 'button', disabled: draft.idx === 0, onclick: () => go(draft.idx - 1) }, icon('back'), '前'),
        flagBtn,
        draft.idx < qs.length - 1
          ? h('button.btn.btn-primary', { type: 'button', onclick: () => go(draft.idx + 1) }, '次', icon('next'))
          : h('button.btn.btn-primary', { type: 'button', onclick: () => submit(false) }, '提出する')));
    prefetch(qs[draft.idx + 1]);
  }

  function go(i) {
    draft.idx = Math.max(0, Math.min(qs.length - 1, i));
    save();
    drawNav();
    drawQuestion();
    window.scrollTo(0, 0);
  }

  async function submit(timeUp) {
    if (!timeUp) {
      const left = qs.length - answeredCount();
      const ok = await confirmDialog('提出しますか？', left ? `未解答が ${left}問 あります。未解答は0点になり、要復習に入ります。` : '全問解答済みです。', '提出する');
      if (!ok) return;
    }
    finishExam(draft);
  }

  const tick = () => {
    const left = draft.startedAt + draft.limitMs - Date.now();
    timerEl.textContent = fmtDuration(Math.max(0, left));
    timerEl.classList.toggle('warn', left < 10 * 60 * 1000);
    if (left <= 0 && !finished) {
      finished = true;
      clearInterval(timer);
      toast('時間切れです。自動で提出しました。');
      setTimeout(() => finishExam(draft), 0); // 描画中の画面遷移を避ける
    }
  };
  let finished = false;
  const timer = setInterval(tick, 1000);

  view.append(h('div.exam',
    h('header.drill-head',
      h('button.icon-btn', { type: 'button', 'aria-label': '中断して模擬試験メニューへ', title: '中断（時間は進みます）', onclick: () => navigate('/exam') }, icon('close')),
      h('div.drill-title', draft.title),
      h('div.exam-timer', icon('clock'), timerEl),
      h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => submit(false) }, '提出')),
    h('div.exam-navwrap', nav, countEl),
    stage));
  tick();
  drawNav();
  drawQuestion();

  const onKey = (e) => {
    if (e.target.closest('input, textarea, .dialog-wrap, .zoom-wrap')) return;
    if (e.key === 'ArrowRight') go(draft.idx + 1);
    if (e.key === 'ArrowLeft') go(draft.idx - 1);
  };
  document.addEventListener('keydown', onKey);
  return () => {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
  };
}

function isAnswered(q, r) {
  if (r == null) return false;
  return q.kind === 'A' ? true : r.every((x) => x != null);
}

function finishExam(draft) {
  const qs = draft.ids.map(getQ);
  const { score, max, detail } = scoreExam(qs, draft.answers);
  const info = db().subjects[draft.subject];
  // 各問の結果を学習記録に反映(未解答は不正解として要復習へ)
  for (const q of qs) {
    const r = draft.answers[q.id] ?? (q.kind === 'A' ? null : Array(q.answer.length).fill(null));
    store.record(q, grade(q, r), 'exam', r);
  }
  const result = {
    t: Date.now(), kind: draft.kind, code: draft.code, subject: draft.subject, title: draft.title,
    ids: draft.ids, answers: draft.answers, score, max, pass: score >= info.pass,
    durationMs: Math.min(Date.now() - draft.startedAt, draft.limitMs),
    points: Object.fromEntries(detail.map((d) => [d.id, d.points])),
  };
  store.addExamResult(result);
  store.setExamDraft(null);
  navigate(`/exam/result/${store.exams().length - 1}`, { replace: true });
}

// ---------------------------------------------------------------- 結果
export function renderExamResult(view, idxStr) {
  const r = store.exams()[Number(idxStr)];
  if (!r) {
    navigate('/exam', { replace: true });
    return;
  }
  rememberListPath(`/exam/result/${idxStr}`); // 1問解き直した後にこの結果画面へ戻る
  const info = db().subjects[r.subject];
  const qs = r.ids.map(getQ).filter(Boolean);
  const pts = (q) => r.points?.[q.id] ?? examPoints(q, r.answers[q.id]);
  const maxOf = (q) => (q.kind === 'A' ? 5 : q.answer.length);
  const aScore = qs.filter((q) => q.kind === 'A').reduce((s, q) => s + pts(q), 0);
  const bScore = qs.filter((q) => q.kind === 'B').reduce((s, q) => s + pts(q), 0);
  const aMax = qs.filter((q) => q.kind === 'A').reduce((s, q) => s + maxOf(q), 0);
  const bMax = qs.filter((q) => q.kind === 'B').reduce((s, q) => s + maxOf(q), 0);

  // ジャンル別得点
  const byGenre = new Map();
  for (const q of qs) {
    const g = byGenre.get(q.genre) || { p: 0, m: 0 };
    g.p += pts(q);
    g.m += maxOf(q);
    byGenre.set(q.genre, g);
  }

  const detail = h('div.exam-detail');
  const cells = qs.map((q) => {
    const p = pts(q);
    const m = maxOf(q);
    const cls = p === m ? 'ok' : p === 0 ? 'ng' : 'part';
    return h('button.res-cell.' + cls, {
      type: 'button',
      onclick: (e) => {
        for (const c of e.currentTarget.parentElement.children) c.classList.remove('cur');
        e.currentTarget.classList.add('cur');
        detail.replaceChildren(...[
          h('div.qmeta', h('span.qtitle', `${sessionLabel(q.session)} ${q.label}`), h('span.chip', genreLabel(q.genre)),
            h('span.chip' + (p === m ? '.chip-ok' : '.chip-ng'), `${p}/${m}点`)),
          questionFigure(q),
          h('p.answer-compare', `あなたの解答: ${responseText(q, r.answers[q.id])}　／　正答: ${answerText(q)}`),
          q.allCorrect ? h('p.notice.info', `公式発表: ${q.allCorrect}`) : null,
          explanationCard(q),
          h('a.btn.btn-sm', { href: `#/q/${q.id}` }, 'この問題を解き直す'),
        ].filter(Boolean));
        detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }, h('span', q.label.replace('-', '')), h('small', p === m ? '○' : p === 0 ? '×' : `${p}/${m}`));
  });

  const wrongIds = qs.filter((q) => pts(q) < maxOf(q)).map((q) => q.id);
  view.append(
    h('header.page-head',
      h('button.icon-btn', { type: 'button', 'aria-label': '戻る', onclick: () => navigate('/exam') }, icon('back')),
      h('div', h('h1', r.title), h('p.sub', `${fmtDateTime(r.t)} ・ 所要 ${fmtDuration(r.durationMs)}`))),
    h('section.card.result-hero',
      h('div.result-score', h('strong', String(r.score)), h('span', ` / ${r.max}点`)),
      h('div.result-rate.' + (r.pass ? 'ok' : 'ng'), r.pass ? '合格ライン到達' : `不合格（あと ${info.pass - r.score}点）`),
      h('p.muted', `合格点 ${info.pass}点 ・ A問題 ${aScore}/${aMax} ・ B問題 ${bScore}/${bMax}`)),
    h('section.card',
      h('h2', 'ジャンル別の得点'),
      h('ul.genre-list.static', [...byGenre.entries()].map(([gid, g]) => h('li', h('div.genre-row',
        h('span.genre-name', genreLabel(gid)),
        h('div.meter', h('div.meter-fill.' + (g.p / g.m >= 0.7 ? 'ok' : 'bad'), { style: { width: `${(g.p / g.m) * 100}%` } }), h('div.meter-line', { style: { left: '70%' } })),
        h('span.genre-num', `${g.p}/${g.m}`)))))),
    h('section.card',
      h('h2', '問題ごとの結果'),
      h('p.muted.small', 'タップすると問題とあなたの解答・正答を表示します。'),
      h('div.res-grid', cells),
      detail),
    h('div.btn-col',
      wrongIds.length
        ? h('button.btn.btn-primary.btn-block', {
          type: 'button',
          onclick: () => startSession({ mode: 'retry', title: '模擬試験で間違えた問題', ids: wrongIds, backTo: '/exam' }),
        }, icon('repeat'), `間違えた${wrongIds.length}問を解き直す`)
        : null,
      h('button.btn.btn-block', { type: 'button', onclick: () => navigate('/exam') }, '模擬試験メニューへ')));
}

export { kindOrder };
