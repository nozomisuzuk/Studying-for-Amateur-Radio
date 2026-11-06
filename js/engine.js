// 学習ロジック(採点・復習スケジュール・出題選択・集計)。DOM に依存しない純粋関数だけを置く。

export const DAY = 24 * 60 * 60 * 1000;
export const KANA = ['ア', 'イ', 'ウ', 'エ', 'オ'];

/** 「克服」までに必要な連続正解数ごとの次回出題までの日数 */
export const INTERVAL_DAYS = [0, 1, 3, 7, 14];

export function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayKey(t) {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function emptyStat() {
  // a: 解答回数, c: 正解回数, h: 直近の結果(1=正解,0=不正解), lr: 最後の結果, lt: 最後に解いた時刻
  // rv: 要復習, st: 不正解後の連続正解数, due: 次に復習する時刻, w: 不正解回数
  return { a: 0, c: 0, h: '', lr: null, lt: 0, rv: false, st: 0, due: 0, w: 0 };
}

// ---------------------------------------------------------------- 採点

/**
 * 解答を採点する。
 * A問題: response は選んだ番号(1始まり)。B問題: response は ア〜オ の番号の配列。
 * 返り値: { correct, points, max, items }  (items は B問題の小設問ごとの正誤)
 */
export function grade(q, response) {
  if (q.kind === 'A') {
    const correct = response === q.answer;
    return { correct, points: correct ? 5 : 0, max: 5, items: null };
  }
  const items = q.answer.map((a, i) => response?.[i] === a);
  const points = items.filter(Boolean).length;
  return { correct: points === q.answer.length, points, max: q.answer.length, items };
}

/** 模擬試験の採点(公式に「全員正解」とされた問題は満点扱い) */
export function examPoints(q, response) {
  if (q.allCorrect) return q.kind === 'A' ? 5 : q.answer.length;
  if (response == null) return 0;
  return grade(q, response).points;
}

// ---------------------------------------------------------------- 復習スケジュール

/**
 * 1回の解答結果を問題ごとの記録に反映する(新しいオブジェクトを返す)。
 * 不正解 → 要復習にして、すぐ復習対象に。
 * 要復習の問題に「期日以降」正解 → 連続正解数+1、次回は INTERVAL_DAYS 日後。clearStreak 回で克服。
 * 期日前に正解しても記録はするが連続正解数は増やさない(短期記憶での正解を克服とみなさない)。
 */
export function applyResult(stat, correct, now, clearStreak = 2) {
  const s = { ...emptyStat(), ...stat };
  s.a += 1;
  if (correct) s.c += 1;
  s.h = (s.h + (correct ? '1' : '0')).slice(-12);
  s.lr = correct ? 1 : 0;
  s.lt = now;
  if (!correct) {
    s.rv = true;
    s.st = 0;
    s.due = now;
    s.w = (s.w || 0) + 1;
  } else if (s.rv && now >= s.due) {
    s.st += 1;
    if (s.st >= clearStreak) {
      s.rv = false;
      s.due = 0;
      s.cleared = now;
    } else {
      const days = INTERVAL_DAYS[Math.min(s.st, INTERVAL_DAYS.length - 1)];
      s.due = startOfDay(now) + days * DAY;
    }
  }
  return s;
}

export function isDue(stat, now) {
  return !!stat && stat.rv && stat.due <= now;
}

/** 克服まであと何回正解が必要か */
export function remainingToClear(stat, clearStreak = 2) {
  if (!stat || !stat.rv) return 0;
  return Math.max(clearStreak - stat.st, 1);
}

// ---------------------------------------------------------------- 乱数

export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- 集計

/**
 * ジャンルごとの集計。
 * mastery = 解いたことのある問題のうち「最後の解答が正解」の割合(今の実力の目安)
 * weak    = 3問以上解いていて mastery が合格ライン(70%)未満、または要復習が2問以上
 */
export function genreSummary(questions, stats, genres) {
  const out = genres.map((g) => ({ ...g, total: 0, attempted: 0, lastOk: 0, review: 0, a: 0, c: 0 }));
  const idx = new Map(out.map((g) => [g.id, g]));
  for (const q of questions) {
    const g = idx.get(q.genre);
    if (!g) continue;
    g.total += 1;
    const s = stats[q.id];
    if (s && s.a > 0) {
      g.attempted += 1;
      if (s.lr === 1) g.lastOk += 1;
      if (s.rv) g.review += 1;
      g.a += s.a;
      g.c += s.c;
    }
  }
  for (const g of out) {
    g.mastery = g.attempted ? g.lastOk / g.attempted : null;
    g.coverage = g.total ? g.attempted / g.total : 0;
    g.weak = (g.attempted >= 3 && g.mastery < 0.7) || g.review >= 2;
  }
  return out;
}

/** 苦手度(大きいほど苦手)。未着手のジャンルは中程度に扱う */
export function weakness(g) {
  if (!g.attempted) return 0.5;
  return (1 - g.mastery) + Math.min(g.review, 5) * 0.05;
}

// ---------------------------------------------------------------- 出題選択

/**
 * おまかせ演習: 復習期日の来た問題 → 苦手ジャンルの未解答・誤答 → 未解答 → 久しく解いていない問題 の順に混ぜる。
 */
export function pickSmart(questions, stats, genreInfo, { count = 20, now = Date.now(), rng = Math.random } = {}) {
  const weakScore = new Map(genreInfo.map((g) => [g.id, weakness(g)]));
  const due = [];
  const fresh = [];
  const wrongNotDue = [];
  const done = [];
  for (const q of questions) {
    const s = stats[q.id];
    if (!s || s.a === 0) fresh.push(q);
    else if (s.rv && s.due <= now) due.push(q);
    else if (s.rv) wrongNotDue.push(q);
    else done.push(q);
  }
  due.sort((a, b) => stats[a.id].due - stats[b.id].due);
  // 未解答はジャンルの苦手度で重み付けしたランダム順
  const freshOrdered = fresh
    .map((q) => ({ q, k: rng() * (0.6 + (weakScore.get(q.genre) ?? 0.5)) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.q);
  // 解いたことのある問題は、苦手ジャンルほど・前回から日が空いているほど優先
  const doneOrdered = done
    .map((q) => {
      const s = stats[q.id];
      const age = Math.min((now - s.lt) / (14 * DAY), 1);
      return { q, k: age + (weakScore.get(q.genre) ?? 0.5) + rng() * 0.3 };
    })
    .sort((a, b) => b.k - a.k)
    .map((x) => x.q);

  const picked = [];
  const take = (list, n) => {
    for (const q of list) {
      if (picked.length >= count || n <= 0) break;
      if (!picked.includes(q)) {
        picked.push(q);
        n -= 1;
      }
    }
  };
  take(due, Math.ceil(count * 0.5));
  const rest = count - picked.length;
  take(freshOrdered, Math.ceil(rest * 0.7));
  take(doneOrdered, count - picked.length);
  take(freshOrdered, count - picked.length);
  take(due, count - picked.length);
  take(wrongNotDue, count - picked.length);
  return shuffle(picked, rng);
}

/** 復習: 期日の来た要復習問題(古い順)。includeAll なら期日前のものも含める */
export function pickReview(questions, stats, { now = Date.now(), includeAll = false } = {}) {
  return questions
    .filter((q) => stats[q.id]?.rv && (includeAll || stats[q.id].due <= now))
    .sort((a, b) => stats[a.id].due - stats[b.id].due);
}

/**
 * 条件指定の演習。
 * status: all | fresh(未解答) | wrong(要復習) | lastWrong(前回不正解) | notMastered(未解答+前回不正解) | bookmarked
 * order : random | exam(出題順) | weak(苦手順)
 */
export function pickCustom(questions, stats, { status = 'all', order = 'random', count = 20, rng = Math.random } = {}) {
  let list = questions.filter((q) => {
    const s = stats[q.id];
    switch (status) {
      case 'fresh':
        return !s || s.a === 0;
      case 'wrong':
        return !!s?.rv;
      case 'lastWrong':
        return s?.lr === 0;
      case 'notMastered':
        return !s || s.a === 0 || s.lr === 0 || s.rv;
      case 'bookmarked':
        return !!s?.bm;
      default:
        return true;
    }
  });
  if (order === 'exam') {
    list = list.slice().sort((a, b) => a.code.localeCompare(b.code) || kindOrder(a) - kindOrder(b));
  } else if (order === 'weak') {
    const acc = (q) => {
      const s = stats[q.id];
      if (!s || !s.a) return 0.5;
      return s.c / s.a - (s.rv ? 0.5 : 0);
    };
    list = shuffle(list, rng).sort((a, b) => acc(a) - acc(b));
  } else {
    list = shuffle(list, rng);
  }
  return count > 0 ? list.slice(0, count) : list;
}

export function kindOrder(q) {
  return (q.kind === 'A' ? 0 : 100) + q.num;
}

// ---------------------------------------------------------------- 模擬試験

/** 過去のある回をそのまま出題 */
export function buildSessionExam(questions, code) {
  return questions.filter((q) => q.code === code).sort((a, b) => kindOrder(a) - kindOrder(b));
}

/**
 * ランダム模試: 問題番号(A-1, A-2, …)ごとに、過去の各回の同じ番号の問題から1問ずつ選ぶ。
 * 本試験は分野順に並ぶので、番号をそろえると分野の配分が本試験と同じになる。
 */
export function buildRandomExam(questions, subject, rng = Math.random) {
  const slots = new Map();
  for (const q of questions) {
    if (q.subject !== subject) continue;
    const key = `${q.kind}${q.num}`;
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(q);
  }
  return [...slots.values()]
    .map((list) => list[Math.floor(rng() * list.length)])
    .sort((a, b) => kindOrder(a) - kindOrder(b));
}

export function scoreExam(examQs, answers) {
  let score = 0;
  let max = 0;
  const detail = examQs.map((q) => {
    const m = q.kind === 'A' ? 5 : q.answer.length;
    const p = examPoints(q, answers[q.id]);
    score += p;
    max += m;
    return { id: q.id, points: p, max: m };
  });
  return { score, max, detail };
}
