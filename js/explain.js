// 解説の表示(解答後・模擬試験の結果で使う)
//   q.exp   … 手書きの解説(段落の HTML)
//   q.fill  … 空欄に正答の字句を入れた文(自動で作ったもの)
//   q.morse … モールス符号を文字に読み下したもの(自動で作ったもの)

import { h, icon } from './ui.js';
import { richText } from './textview.js';

export function hasExplanation(q) {
  return !!(q && (q.exp || q.fill?.length || q.morse?.length));
}

/** 解説のカード。解説がない問題では null */
export function explanationCard(q) {
  if (!hasExplanation(q)) return null;
  const sec = h('section.expl', { 'aria-label': '解説' }, h('h3.expl-title', icon('info'), '解説'));
  if (q.exp) {
    const body = richText(q.exp, '', { block: true });
    body.className = 'expl-body';
    sec.append(body);
  }
  if (q.fill?.length) {
    sec.append(
      h('h4.expl-sub', '正答を入れた文'),
      h('div.expl-fill', q.fill.map((x) => h('p', richText(x)))));
  }
  if (q.morse?.length) {
    sec.append(
      h('h4.expl-sub', 'モールス符号の読み'),
      h('ul.expl-morse', q.morse.map((x) => h('li', richText(x)))));
  }
  return sec;
}
