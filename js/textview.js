// 問題の「テキスト表示」(PDFから組み直した本文)を描画する

import { h, openZoom } from './ui.js';

const ALLOWED = new Set(['SPAN', 'SUB', 'SUP', 'I', 'B', 'IMG']);
const IMG_SRC = /^data\/img\/[A-Za-z0-9_/.-]+\.png$/;

/** 変換スクリプトが作った本文HTMLを、許可したタグ・属性だけ残して要素にする */
function richText(html, base) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED.has(child.tagName)) {
          child.replaceWith(document.createTextNode(child.textContent));
          continue;
        }
        if (child.tagName === 'IMG') {
          const src = child.getAttribute('src') || '';
          if (!IMG_SRC.test(src)) {
            child.remove();
            continue;
          }
          for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
          child.className = 'im';
          child.alt = '式';
          child.src = base + src;
          continue;
        }
        for (const attr of [...child.attributes]) {
          if (!(attr.name === 'class' && attr.value === 'bl')) child.removeAttribute(attr.name);
        }
        clean(child);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    }
  };
  clean(tpl.content);
  const span = document.createElement('span');
  span.append(tpl.content);
  return span;
}

/** 1問分のテキスト表示。base は画像パスの前に付ける文字列(通常は空) */
export function renderTextView(q, base = '', title = '') {
  const root = h('div.tv', { lang: 'ja' });
  for (const b of q.tv || []) {
    if (b.t === 'p') {
      const body = richText(b.h, base);
      body.className = 'tv-c';
      root.append(h('p.tv-p' + (b.m ? '.has-m' : '') + (b.note ? '.tv-note' : ''), b.m ? h('span.tv-m', b.m) : null, body));
    } else if (b.t === 'tbl') {
      root.append(h('div.tv-tblwrap', h('table.tv-tbl',
        h('thead', h('tr', h('th', ''), b.head.map((x) => h('th', x)))),
        h('tbody', b.rows.map((row) => h('tr', h('th', row[0]), row.slice(1).map((cell) => h('td', richText(cell, base)))))))));
    } else if (b.t === 'list') {
      root.append(h('ol.tv-list', b.items.map(([n, html]) => h('li', h('b', n), richText(html, base)))));
    } else if (b.t === 'img') {
      const img = { src: base + b.src, w: b.w, h: b.h };
      root.append(h('figure.tv-fig', { title: 'タップで拡大', onclick: () => openZoom([img], title || '図・式') },
        h('img', { src: img.src, width: b.w, height: b.h, alt: '図・式（タップで拡大）', decoding: 'async', style: { width: `${Math.round(b.pw * 1.45)}px` } })));
    }
  }
  return root;
}
