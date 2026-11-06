// 設定・データ管理・このアプリについて

import { db } from '../data.js';
import * as store from '../store.js';
import { h, icon, toast, confirmDialog, fmtDateTime } from '../ui.js';
import { applyTheme, navigate } from '../app.js';

export const IMG_CACHE = 'ama1-img-v1';
export const APP_VERSION = '1.0.0';

function row(label, control, help) {
  return h('div.set-row', h('div.set-label', h('span', label), help ? h('small', help) : null), h('div.set-control', control));
}

function selectCtl(key, options, onChange) {
  const el = h('select', { 'aria-label': key }, options.map(([v, l]) => h('option', { value: String(v), selected: String(store.settings()[key]) === String(v) }, l)));
  el.addEventListener('change', () => {
    const raw = el.value;
    const v = typeof options[0][0] === 'number' ? Number(raw) : raw;
    store.setSetting(key, v);
    onChange?.(v);
    toast('保存しました');
  });
  return el;
}

function toggleCtl(key, onChange) {
  const el = h('input', { type: 'checkbox', role: 'switch', checked: !!store.settings()[key] });
  el.addEventListener('change', () => {
    store.setSetting(key, el.checked);
    onChange?.(el.checked);
  });
  return h('label.switch', el, h('span.slider'));
}

async function cachedCount(urls) {
  if (!('caches' in window)) return null;
  const cache = await caches.open(IMG_CACHE);
  const keys = await cache.keys();
  const set = new Set(keys.map((r) => new URL(r.url).pathname.replace(/^.*?(data\/img\/)/, '$1')));
  return urls.filter((u) => set.has(u)).length;
}

async function cacheAll(urls, onProgress) {
  const cache = await caches.open(IMG_CACHE);
  let done = 0;
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      if (!(await cache.match(u))) {
        const res = await fetch(u);
        if (res.ok) await cache.put(u, res);
      }
      done += 1;
      onProgress(done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

export function renderSettings(view) {
  const D = db();
  const s = store.settings();
  const urls = [...new Set(D.questions.flatMap((q) => [
    ...q.images.map((im) => im.src),
    ...(q.tv || []).flatMap((b) => (b.t === 'img' ? [b.src]
      : [...JSON.stringify(b).matchAll(/data\/img\/[A-Za-z0-9_/.-]+\.png/g)].map((m) => m[0]))),
  ]))];

  // ---- オフライン
  const offStatus = h('span.muted');
  const offBtn = h('button.btn', { type: 'button' }, icon('download'), '全問題の画像を端末に保存');
  const refreshOffline = async () => {
    const n = await cachedCount(urls);
    offStatus.textContent = n == null ? 'このブラウザは対応していません' : `${n} / ${urls.length} 枚保存済み`;
    if (n === urls.length) offBtn.textContent = '保存済み（再確認）';
  };
  offBtn.addEventListener('click', async () => {
    if (!('caches' in window)) return;
    offBtn.disabled = true;
    try {
      await cacheAll(urls, (d, t) => (offStatus.textContent = `保存中… ${d} / ${t}`));
      toast('オフラインでも問題を表示できるようになりました', 'ok');
    } catch (e) {
      toast('保存に失敗しました。通信状態を確認してください。', 'ng');
    }
    offBtn.disabled = false;
    refreshOffline();
  });
  refreshOffline();

  // ---- 受験予定日
  const dateInput = h('input', { type: 'date', value: s.examDate || '' });
  dateInput.addEventListener('change', () => {
    store.setSetting('examDate', dateInput.value || null);
    toast(dateInput.value ? 'ホームに試験までの日数を表示します' : '受験予定日を消しました');
  });

  // ---- データ
  const exportBtn = h('button.btn', {
    type: 'button',
    onclick: () => {
      const blob = new Blob([store.exportData()], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `1ama-drill-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    },
  }, icon('download'), '書き出す');
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      if (!(await confirmDialog('記録を読み込みますか？', '今の端末の学習記録は、読み込んだファイルの内容で置き換わります。', '読み込む', true))) return;
      store.importData(text);
      applyTheme();
      toast('読み込みました', 'ok');
      navigate('/', { replace: true });
    } catch (e) {
      toast(`読み込めませんでした: ${e.message}`, 'ng');
    } finally {
      fileInput.value = '';
    }
  });
  const importBtn = h('button.btn', { type: 'button', onclick: () => fileInput.click() }, icon('upload'), '読み込む');
  const resetBtn = h('button.btn.btn-danger', {
    type: 'button',
    onclick: async () => {
      if (await confirmDialog('学習記録をすべて消しますか？', '解答履歴・要復習・模擬試験の結果・メモが消え、元に戻せません。必要なら先に「書き出す」でバックアップしてください。', 'すべて消す', true)) {
        store.resetAll();
        toast('学習記録を消しました');
        navigate('/', { replace: true });
      }
    },
  }, icon('trash'), 'すべて消す');

  view.append(
    h('header.page-head', h('div', h('h1', '設定'))),
    h('section.card',
      h('h2', '演習'),
      row('1セットの問題数', selectCtl('sessionSize', [[10, '10問'], [20, '20問'], [30, '30問'], [50, '50問']])),
      row('間違えた問題をセット内で再出題', toggleCtl('retryWrong'), '間違えると3問ほど後にもう一度出ます'),
      row('「克服」に必要な連続正解数', selectCtl('clearStreak', [[2, '2回'], [3, '3回'], [4, '4回']]),
        '不正解の後、日を空けてこの回数だけ続けて正解すると要復習から外れます（1回目は当日、2回目は翌日以降、3回目は3日後以降…）'),
      row('受験予定日', dateInput, 'ホームに試験までの日数を表示')),
    h('section.card',
      h('h2', '表示'),
      row('問題文の表示', selectCtl('qView', [['auto', '自動（スマホは文字・PCは原本）'], ['text', '常に文字で表示'], ['image', '常に原本（画像）']]),
        '「文字」はPDFから組み直した表示で、図や数式は画像のまま入ります。問題ごとにボタンでも切り替えられます'),
      row('テーマ', selectCtl('theme', [['auto', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']], applyTheme)),
      row('ダークテーマで問題を白黒反転', toggleCtl('invertInDark', applyTheme), '問題画像を暗い背景・白い文字で表示')),
    h('section.card',
      h('h2', 'オフライン'),
      h('p.muted', `アプリ本体は一度開くと自動で保存されます。問題の画像（${urls.length}枚）も保存しておくと、電波のない場所でも全問題を解けます。`),
      h('div.btn-row', offBtn, offStatus)),
    h('section.card',
      h('h2', '学習記録のバックアップ'),
      h('p.muted', '記録はこの端末のブラウザ内にだけ保存されます。機種変更や別の端末で続けるときは、書き出したファイルを読み込んでください。'),
      h('div.btn-row', exportBtn, importBtn, fileInput),
      h('div.btn-row.danger-zone', resetBtn)),
    h('section.card.about',
      h('h2', 'このアプリについて'),
      h('p', '第一級アマチュア無線技士の国家試験の過去問を解き、間違えた問題と苦手なジャンルを繰り返し解き直すための学習アプリです。'),
      h('dl',
        h('dt', '収録'), h('dd', `${D.sessions.map((x) => x.label).join('、')}（各回 無線工学・法規 30問ずつ、計${D.questions.length}問）`),
        h('dt', '問題と正答の出典'), h('dd', h('a', { href: D.source.url, target: '_blank', rel: 'noopener' }, D.source.name)),
        h('dt', '利用条件'), h('dd', D.source.terms),
        h('dt', 'データ作成'), h('dd', fmtDateTime(Date.parse(D.generatedAt))),
        h('dt', 'バージョン'), h('dd', APP_VERSION)),
      h('p.muted.small', 'ジャンル分類は本アプリが問題文（法規は引用条文）から自動で付けたもので、公式の分類ではありません。')));
}
