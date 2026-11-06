// 問題データ(data/questions.json)の読み込みと索引

let DB = null;

export async function loadData() {
  const res = await fetch('data/questions.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`問題データを読み込めませんでした (${res.status})`);
  const raw = await res.json();
  const byId = new Map(raw.questions.map((q) => [q.id, q]));
  const sessionById = new Map(raw.sessions.map((s) => [s.id, s]));
  const genreById = new Map();
  for (const [subject, list] of Object.entries(raw.genres)) {
    for (const g of list) genreById.set(g.id, { ...g, subject });
  }
  DB = { ...raw, byId, sessionById, genreById };
  return DB;
}

export const db = () => DB;
export const q = (id) => DB.byId.get(id);
export const subjectLabel = (s) => DB.subjects[s]?.label ?? s;
export const genreLabel = (id) => DB.genreById.get(id)?.label ?? '未分類';
export const sessionLabel = (id) => DB.sessionById.get(id)?.label ?? id;

export function questionsOf(subject) {
  if (!subject || subject === 'both') return DB.questions;
  return DB.questions.filter((q) => q.subject === subject);
}

/** 「令和7年11月期 無線工学 A-5」のような表示名 */
export function questionTitle(q) {
  return `${sessionLabel(q.session)} ${subjectLabel(q.subject)} ${q.label}`;
}

export function examCodes() {
  // 新しい回から順に [{code, session, subject}]
  const out = [];
  for (const s of DB.sessions.slice().reverse()) {
    for (const subject of ['kogaku', 'hoki']) {
      if (s.codes[subject]) out.push({ code: s.codes[subject], session: s, subject });
    }
  }
  return out;
}
