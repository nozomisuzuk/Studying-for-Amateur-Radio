// node --test tests/  で実行
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  grade, examPoints, applyResult, emptyStat, DAY, startOfDay, pickSmart, pickReview, pickCustom,
  genreSummary, buildRandomExam, buildSessionExam, scoreExam, makeRng, isDue,
} from '../js/engine.js';

const data = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url), 'utf8'));
const Q = data.questions;
const qA = { id: 'X-A01', kind: 'A', answer: 3, choices: 5 };
const qB = { id: 'X-B01', kind: 'B', answer: [2, 1, 2, 2, 1], bStyle: 'tf', choices: 2 };

test('A問題の採点', () => {
  assert.deepEqual(grade(qA, 3), { correct: true, points: 5, max: 5, items: null });
  assert.equal(grade(qA, 2).correct, false);
  assert.equal(grade(qA, null).points, 0);
});

test('B問題は小設問ごとに1点、全問正解でのみ正解扱い', () => {
  const r = grade(qB, [2, 1, 1, 2, 1]);
  assert.equal(r.points, 4);
  assert.equal(r.correct, false);
  assert.deepEqual(r.items, [true, true, false, true, true]);
  assert.equal(grade(qB, [2, 1, 2, 2, 1]).correct, true);
  assert.equal(grade(qB, [null, null, null, null, null]).points, 0);
});

test('全員正解の問題は模試で満点扱い', () => {
  assert.equal(examPoints({ ...qA, allCorrect: '※' }, 1), 5);
  assert.equal(examPoints({ ...qA, allCorrect: '※' }, null), 5);
  assert.equal(examPoints(qA, null), 0);
});

test('不正解 → 当日の再挑戦で1回目、翌日以降の正解で克服(連続2回)', () => {
  const t0 = new Date(2026, 10, 6, 10, 0).getTime();
  let s = applyResult(emptyStat(), false, t0);
  assert.equal(s.rv, true);
  assert.equal(s.due, t0);
  assert.equal(isDue(s, t0), true);
  s = applyResult(s, true, t0 + 60_000); // 同じセット内で再挑戦して正解
  assert.equal(s.rv, true);
  assert.equal(s.st, 1);
  assert.equal(s.due, startOfDay(t0) + DAY); // 翌日0時から
  const before = applyResult(s, true, t0 + 2 * 3600_000); // 期日前の正解は数えない
  assert.equal(before.st, 1);
  assert.equal(before.rv, true);
  s = applyResult(s, true, startOfDay(t0) + DAY + 9 * 3600_000); // 翌日に正解
  assert.equal(s.rv, false);
  assert.ok(s.cleared);
  assert.equal(s.a, 3);
  assert.equal(s.c, 2);
  assert.equal(s.h, '011');
});

test('要復習中に間違えると連続正解数がリセットされる', () => {
  const t0 = Date.now();
  let s = applyResult(emptyStat(), false, t0);
  s = applyResult(s, true, t0 + 1);
  s = applyResult(s, false, t0 + 2);
  assert.equal(s.st, 0);
  assert.equal(s.rv, true);
  assert.equal(s.w, 2);
});

test('克服に3回必要な設定では 1日後→3日後 と間隔が伸びる', () => {
  const t0 = new Date(2026, 10, 6, 10, 0).getTime();
  let s = applyResult(emptyStat(), false, t0, 3);
  s = applyResult(s, true, t0 + 1, 3);
  assert.equal(s.due, startOfDay(t0) + DAY);
  s = applyResult(s, true, startOfDay(t0) + DAY + 1, 3);
  assert.equal(s.st, 2);
  assert.equal(s.due, startOfDay(t0) + 4 * DAY);
  s = applyResult(s, true, startOfDay(t0) + 4 * DAY + 1, 3);
  assert.equal(s.rv, false);
});

test('データ: 全回が 30問、正答が選択肢の範囲内', () => {
  const byCode = new Map();
  for (const q of Q) byCode.set(q.code, (byCode.get(q.code) || 0) + 1);
  for (const [code, n] of byCode) assert.equal(n, 30, code);
  for (const q of Q) {
    if (q.kind === 'A') {
      assert.ok(Number.isInteger(q.answer) && q.answer >= 1 && q.answer <= q.choices, q.id);
      assert.ok(q.choices === 4 || q.choices === 5, q.id);
    } else {
      assert.equal(q.answer.length, 5, q.id);
      assert.ok(q.answer.every((a) => a >= 1 && a <= q.choices), q.id);
    }
    assert.ok(q.images.length >= 1, q.id);
    assert.ok(data.genres[q.subject].some((g) => g.id === q.genre), `${q.id} genre ${q.genre}`);
  }
});

test('おまかせ演習: 期日の来た復習を優先し、重複なく指定数を選ぶ', () => {
  const now = Date.now();
  const stats = {};
  const due = Q.slice(0, 5).map((q) => q.id);
  for (const id of due) stats[id] = applyResult(emptyStat(), false, now - 1000);
  const gi = genreSummary(Q, stats, [...data.genres.kogaku, ...data.genres.hoki]);
  const picked = pickSmart(Q, stats, gi, { count: 20, now, rng: makeRng(1) });
  assert.equal(picked.length, 20);
  assert.equal(new Set(picked.map((q) => q.id)).size, 20);
  for (const id of due) assert.ok(picked.some((q) => q.id === id), `due ${id} should be picked`);
});

test('復習: 期日前のものは includeAll のときだけ', () => {
  const now = Date.now();
  const stats = {};
  stats[Q[0].id] = applyResult(emptyStat(), false, now - 10);
  stats[Q[1].id] = applyResult(applyResult(emptyStat(), false, now - 10), true, now - 5); // 明日が期日
  assert.deepEqual(pickReview(Q, stats, { now }).map((q) => q.id), [Q[0].id]);
  assert.equal(pickReview(Q, stats, { now, includeAll: true }).length, 2);
});

test('条件指定: 未解答のみ / 出題順', () => {
  const stats = { [Q[0].id]: applyResult(emptyStat(), true, Date.now()) };
  const fresh = pickCustom(Q, stats, { status: 'fresh', count: 0 });
  assert.equal(fresh.length, Q.length - 1);
  const ordered = pickCustom(Q.filter((q) => q.code === 'HZ711'), {}, { order: 'exam', count: 0 });
  assert.deepEqual(ordered.slice(0, 2).map((q) => q.label), ['A-1', 'A-2']);
  assert.equal(ordered[29].label, 'B-5');
});

test('模擬試験: 回の30問 / ランダム模試は番号ごとに1問', () => {
  const ex = buildSessionExam(Q, 'HY711');
  assert.equal(ex.length, 30);
  assert.equal(ex[0].label, 'A-1');
  const rnd = buildRandomExam(Q, 'kogaku', makeRng(42));
  assert.equal(rnd.length, 30);
  assert.deepEqual(rnd.map((q) => q.label), buildSessionExam(Q, 'HZ711').map((q) => q.label));
  const full = Object.fromEntries(ex.map((q) => [q.id, q.answer]));
  assert.equal(scoreExam(ex, full).score, 150);
  assert.equal(scoreExam(ex, {}).score, ex.filter((q) => q.allCorrect).length * 5);
});
