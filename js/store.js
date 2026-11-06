// 学習記録の保存(localStorage)。保存できない環境ではメモリ上だけで動く。

import { applyResult, dayKey, emptyStat } from './engine.js';

const KEY = 'ama1drill:v1';
const LOG_LIMIT = 8000;

export const DEFAULT_SETTINGS = {
  theme: 'auto',          // auto | light | dark
  invertInDark: true,     // ダークモードで問題画像を反転表示
  sessionSize: 20,        // 1セットの問題数
  clearStreak: 2,         // 要復習 → 克服 に必要な連続正解数
  retryWrong: true,       // 間違えた問題をセット内で少し後にもう一度出す
  subject: 'both',        // おまかせ演習の科目: both | kogaku | hoki
  showTimer: true,
  qView: 'auto',          // 問題文: auto(狭い画面は文字・広い画面は原本) | text | image
};

function blank() {
  return { v: 1, q: {}, log: [], exams: [], daily: {}, settings: { ...DEFAULT_SETTINGS }, examDraft: null };
}

let state = blank();
let persistent = true;
let saveTimer = null;

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = { ...blank(), ...parsed, settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) } };
    }
    // 書き込めるか確認
    localStorage.setItem(KEY + ':probe', '1');
    localStorage.removeItem(KEY + ':probe');
  } catch (e) {
    persistent = false;
  }
  return state;
}

export function isPersistent() {
  return persistent;
}

export function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!persistent) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    // 容量超過: 古いログを削って再試行
    state.log = state.log.slice(-Math.floor(LOG_LIMIT / 4));
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e2) {
      persistent = false;
    }
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 300);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
}

export const stats = () => state.q;
export const getStat = (id) => state.q[id] || null;
export const settings = () => state.settings;

export function setSetting(key, value) {
  state.settings[key] = value;
  save();
}

/** 1問の解答を記録する */
export function record(q, result, mode, response) {
  const now = Date.now();
  const prev = state.q[q.id] || emptyStat();
  const next = applyResult(prev, result.correct, now, state.settings.clearStreak);
  next.bm = prev.bm;
  next.memo = prev.memo;
  if (q.kind === 'B') next.lb = result.items.map((ok) => (ok ? 1 : 0)).join('');
  state.q[q.id] = next;
  state.log.push({ t: now, id: q.id, ok: result.correct ? 1 : 0, p: result.points, m: mode, r: response });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  const dk = dayKey(now);
  const d = state.daily[dk] || { n: 0, c: 0 };
  d.n += 1;
  if (result.correct) d.c += 1;
  state.daily[dk] = d;
  save();
  return { prev, next };
}

/** 直前の記録を取り消す(押し間違い対策) */
export function undo(id, prevStat) {
  const last = state.log[state.log.length - 1];
  if (!last || last.id !== id) return false;
  state.log.pop();
  const dk = dayKey(last.t);
  const d = state.daily[dk];
  if (d) {
    d.n = Math.max(0, d.n - 1);
    if (last.ok) d.c = Math.max(0, d.c - 1);
  }
  if (prevStat && prevStat.a > 0) state.q[id] = prevStat;
  else {
    const cur = state.q[id];
    if (cur && (cur.bm || cur.memo)) state.q[id] = { ...emptyStat(), bm: cur.bm, memo: cur.memo };
    else delete state.q[id];
  }
  save();
  return true;
}

export function setBookmark(id, on) {
  const s = state.q[id] || emptyStat();
  s.bm = !!on;
  state.q[id] = s;
  save();
}

export function setMemo(id, text) {
  const s = state.q[id] || emptyStat();
  s.memo = text;
  state.q[id] = s;
  save();
}

/** 要復習リストから手動で外す */
export function markCleared(id) {
  const s = state.q[id];
  if (!s) return;
  s.rv = false;
  s.st = 0;
  s.due = 0;
  s.cleared = Date.now();
  save();
}

export const daily = () => state.daily;
export const log = () => state.log;
export const exams = () => state.exams;

export function addExamResult(r) {
  state.exams.push(r);
  if (state.exams.length > 200) state.exams.shift();
  save();
}

export const examDraft = () => state.examDraft;
export function setExamDraft(d) {
  state.examDraft = d;
  saveNow();
}

export function exportData() {
  return JSON.stringify({ app: 'ama1drill', exportedAt: new Date().toISOString(), ...state });
}

export function importData(text) {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object' || !obj.q || obj.v !== 1) throw new Error('このアプリの記録データではありません');
  state = { ...blank(), ...obj, settings: { ...DEFAULT_SETTINGS, ...(obj.settings || {}) } };
  delete state.app;
  delete state.exportedAt;
  saveNow();
}

export function resetAll() {
  const keep = state.settings;
  state = blank();
  state.settings = keep;
  saveNow();
}
