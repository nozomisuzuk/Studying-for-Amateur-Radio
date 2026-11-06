"""問題PDFの1問分の領域 → スマホでも読める「テキスト表示」用のブロック列に変換する。

PDF の文字情報(座標つき)から段落・選択肢・組合せの表・B問題の語群・空欄の枠を組み立て直す。
文字に直すと崩れる部分は画像として切り出して埋め込む:
  - 図(線画・埋め込み画像)、罫線つきの表 … 図の範囲をまとめて1枚
  - 分数などを含む数式の選択肢・モールス符号 … その行のまとまり(帯)を1枚
  - 本文中の短い数式(√2 など) … その部分だけを文字と同じ高さの小さな画像にして文中に埋め込む

組み立てに自信が持てない問題(表の行や語群の番号がそろわない等)は Uncertain を送出し、
アプリ側は問題全体の画像だけを表示する。

出力ブロック:
  {"t": "p", "m": 記号(任意), "h": 本文HTML, "note": True(注記のとき)}
  {"t": "tbl", "head": [列見出し...], "rows": [[番号, セルHTML...], ...]}
  {"t": "list", "items": [[番号, HTML], ...]}
  {"t": "img", "src": 画像パス, "w": px, "h": px, "pw": PDF上の幅(pt)}
本文HTMLに含まれるタグ: <span class="bl">(空欄の枠) <sub> <sup> <i> <img class="im">(文中の数式)
"""
from __future__ import annotations

import html
import re
import statistics
from dataclasses import dataclass, field

import numpy as np
import pymupdf
from PIL import Image

IMG_ZOOM = 3.2           # 部分画像のレンダリング倍率
INLINE_ASCENT = 1.02     # 文中の数式画像: ベースラインから上に文字サイズの何倍まで切り出すか
INLINE_DESCENT = 0.40    # 同じく下側
CIRCLED = {chr(c) for c in range(0x2460, 0x2474)}
KANA = "アイウエオカキクケコ"
HEAD_LETTERS = {"A", "B", "C", "D", "E"}
MORSE = set("－・")
DIGITS = set("0123456789")


class Uncertain(Exception):
    """テキスト表示を作れない(作ると誤解を招くおそれがある)問題"""


def fw2hw(s: str) -> str:
    out = []
    for ch in s:
        o = ord(ch)
        if 0xFF10 <= o <= 0xFF19 or 0xFF21 <= o <= 0xFF3A or 0xFF41 <= o <= 0xFF5A:
            out.append(chr(o - 0xFEE0))
        else:
            out.append(ch)
    return "".join(out)


def is_garbled(ch: str) -> bool:
    o = ord(ch)
    return ch in "□�" or 0xE000 <= o <= 0xF8FF


def is_ascii_word(ch: str) -> bool:
    return ch.isascii() and (ch.isalnum() or ch in ".,%+-/=()[]<>'\"")


@dataclass(eq=False)
class Ch:
    c: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    font: str
    base: float

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return self.base - self.size * 0.35

    @property
    def italic(self):
        return "Italic" in self.font

    @property
    def math(self):
        return "Math" in self.font or is_garbled(self.c)


@dataclass(eq=False)
class Row:
    chars: list
    base: float = 0.0
    size: float = 10.5
    boxes: list = field(default_factory=list)
    imgs: list = field(default_factory=list)  # 文中の数式画像 {"x0","x1","src"}
    col_right: float | None = None            # 2段組みの左段にある行の右端(段の境目)

    def finish(self):
        self.chars.sort(key=lambda c: c.x0)
        ink = [c for c in self.chars if c.c.strip()]
        sizes = [c.size for c in ink if not c.math] or [c.size for c in ink] or [10.5]
        self.size = statistics.median(sizes)
        main = [c.base for c in ink if c.size >= self.size * 0.85 and not c.math] or [c.base for c in ink] or [0]
        self.base = statistics.median(main)
        return self

    @property
    def ink(self):
        return [c for c in self.chars if c.c.strip()]

    @property
    def x0(self):
        xs = [c.x0 for c in self.ink] + [b["r"].x0 for b in self.boxes] + [m["x0"] for m in self.imgs]
        return min(xs) if xs else 0

    @property
    def x1(self):
        xs = [c.x1 for c in self.ink] + [b["r"].x1 for b in self.boxes] + [m["x1"] for m in self.imgs]
        return max(xs) if xs else 0

    @property
    def top(self):
        return self.base - self.size * 0.95

    @property
    def bottom(self):
        return self.base + self.size * 0.3

    def rect(self):
        return pymupdf.Rect(self.x0, self.top, self.x1, self.bottom)

    @property
    def text(self):
        return "".join(c.c for c in self.chars)

    def is_morse(self):
        tokens = [t for t in re.split(r"[\s　]+", "".join(c.c for c in self.chars)) if t]
        pure = [t for t in tokens if set(t) <= MORSE]
        if len(pure) >= 2 or any(len(t) >= 2 for t in pure):
            return True
        # 「３ ・」のように番号の後がモールス符号だけの行
        mk = row_marker(self)
        rest = [c for c in (mk[2] if mk else []) if c.c.strip()]
        return bool(mk) and bool(rest) and all(c.c in MORSE for c in rest)

    def complexity(self):
        """None: 普通の文字 / 'morse': モールス符号(間隔を保って文字で表示) /
        'band': 行ごと画像にする / 'inline': 数式部分だけ文中に画像で埋め込む"""
        if self.is_morse():
            return "morse"
        ink = self.ink
        math = [c for c in ink if c.math]
        if not math:
            return None
        mk = row_marker(self)
        if len(math) >= 0.5 * len(ink) or (mk and mk[0] == "num"):
            return "band"
        return "inline"


# ---------------------------------------------------------------- 図形

def _item_rects(d) -> list[pymupdf.Rect]:
    rs = []
    for it in d["items"]:
        kind = it[0]
        if kind == "re":
            rs.append(pymupdf.Rect(it[1]))
        elif kind == "qu":
            rs.append(it[1].rect)
        else:
            pts = [p for p in it[1:] if isinstance(p, pymupdf.Point)]
            if pts:
                xs = [p.x for p in pts]
                ys = [p.y for p in pts]
                rs.append(pymupdf.Rect(min(xs), min(ys), max(xs), max(ys)))
    return rs


def _cluster(rects: list[pymupdf.Rect], gap: float) -> list[list[int]]:
    n = len(rects)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    grown = [pymupdf.Rect(r.x0 - gap, r.y0 - gap, r.x1 + gap, r.y1 + gap) for r in rects]
    order = sorted(range(n), key=lambda i: rects[i].x0)
    for ii, i in enumerate(order):
        for j in order[ii + 1:]:
            if rects[j].x0 - gap > grown[i].x1:
                break
            if grown[i].intersects(grown[j]):
                parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def _union(rs) -> pymupdf.Rect:
    r = pymupdf.Rect(rs[0])
    for x in rs[1:]:
        r |= x
    return r


def _is_box_size(r: pymupdf.Rect) -> bool:
    return 10 <= r.width <= 110 and 8 <= r.height <= 24


def _pair_edges(items: list[pymupdf.Rect]) -> tuple[list[pymupdf.Rect], set[int]]:
    """上下の横線と左右の縦線がそろった四角形(空欄の枠)を探す。
    上下に並んだ枠の辺が接していても、別々の枠として見つけられる。"""
    hs = [i for i, r in enumerate(items) if r.height <= 1.6 and r.width >= 8]
    vs = [i for i, r in enumerate(items) if r.width <= 1.6 and r.height >= 6]
    boxes, used = [], set()
    for i in hs:
        t = items[i]
        for j in hs:
            if j == i or j in used or i in used:
                continue
            b = items[j]
            if not (8 <= b.y0 - t.y0 <= 24 and abs(b.x0 - t.x0) < 2.5 and abs(b.x1 - t.x1) < 2.5):
                continue
            left = [k for k in vs if k not in used and abs(items[k].x0 - t.x0) < 2.5
                    and items[k].y0 <= t.y1 + 2 and items[k].y1 >= b.y0 - 2]
            right = [k for k in vs if k not in used and abs(items[k].x1 - t.x1) < 2.5
                     and items[k].y0 <= t.y1 + 2 and items[k].y1 >= b.y0 - 2]
            if left and right:
                box = t | b | items[left[0]] | items[right[0]]
                if _is_box_size(box):
                    boxes.append(box)
                    used.update({i, j, left[0], right[0]})
    # 枠の角に描かれた小さな点も枠の一部
    for k, r in enumerate(items):
        if k not in used and r.width <= 1.6 and r.height <= 1.6:
            if any((bx + (-1, -1, 1, 1)).contains(r) for bx in boxes):
                used.add(k)
    return boxes, used


def find_boxes_and_figures(page: pymupdf.Page, clip: pymupdf.Rect):
    items = []
    boxes = []
    for d in page.get_drawings():
        if not d["rect"].intersects(clip):
            continue
        fill = d.get("fill")
        if fill is not None and min(fill) > 0.97 and (d.get("color") is None or not d.get("width")):
            continue  # 白塗りだけの図形(テキスト枠の背景など)は見えないので無視
        rects = _item_rects(d)
        # 線で描いた四角形1つだけの図形が枠の大きさなら、それが空欄の枠
        if fill is None and d.get("color") is not None and len(d["items"]) == 1 and d["items"][0][0] == "re" \
                and _is_box_size(rects[0]) and clip.contains(rects[0]):
            boxes.append({"r": pymupdf.Rect(rects[0]), "label": ""})
            continue
        for r in rects:
            if clip.contains(pymupdf.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)):
                items.append(pymupdf.Rect(r.x0, r.y0, max(r.x1, r.x0 + 0.1), max(r.y1, r.y0 + 0.1)))
    fig_rects = []
    if items:
        paired, used = _pair_edges(items)
        boxes += [{"r": b, "label": ""} for b in paired]
        rest = [r for k, r in enumerate(items) if k not in used]
        # 辺と角が接して描かれた枠(上の方法で見つからなかったもの)
        for grp in (_cluster(rest, 0.3) if rest else []):
            rs = [rest[i] for i in grp]
            u = _union(rs)
            thin = all(min(r.width, r.height) <= 1.6 for r in rs)
            if thin and len(rs) >= 2 and _is_box_size(u):
                boxes.append({"r": u, "label": ""})
            else:
                fig_rects.extend(rs)
    for info in page.get_image_info():
        r = pymupdf.Rect(info["bbox"])
        if r.intersects(clip):
            fig_rects.append(r & clip)
    figures = [_union([fig_rects[i] for i in grp]) for grp in _cluster(fig_rects, 9)] if fig_rects else []
    # 根号(√)の上の横線・分数の線など、文字に付属する短い線だけのものは図ではない。
    # 横線は分数の線の候補として返す
    bars = [f for f in figures if f.height <= 3 and 4 <= f.width <= 150]
    figures = [f for f in figures if not ((f.height <= 3 and f.width <= 150) or (f.width <= 3 and f.height <= 20))]
    # 分数・根号などの小さな線画の断片も図ではなく「式がある印」(その行は式として画像にする)
    small = [f for f in figures if f.width <= 40 and f.height <= 16]
    bars += small
    figures = [f for f in figures if f not in small]
    return boxes, figures, bars


# ---------------------------------------------------------------- 文字

def page_chars(page: pymupdf.Page, clip: pymupdf.Rect) -> list[Ch]:
    out = []
    raw = page.get_text("rawdict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_LIGATURES)
    for b in raw["blocks"]:
        if b.get("type") != 0:
            continue
        for ln in b["lines"]:
            for s in ln["spans"]:
                for c in s["chars"]:
                    x0, y0, x1, y1 = c["bbox"]
                    ch = Ch(c["c"], x0, y0, x1, y1, s["size"], s["font"], c["origin"][1])
                    if clip.contains(pymupdf.Point(ch.cx, ch.cy)):
                        out.append(ch)
    return out


def group_rows(chars: list[Ch]) -> list[Row]:
    rows: list[Row] = []
    for c in sorted(chars, key=lambda c: c.base):
        if rows:
            cur = rows[-1]
            bases = [x.base for x in cur.chars if x.c.strip()] or [cur.chars[0].base]
            if abs(c.base - statistics.median(bases)) <= 4.2:
                cur.chars.append(c)
                continue
        rows.append(Row([c]))
    return [r.finish() for r in rows if r.ink or r.boxes]


# ---------------------------------------------------------------- インライン(本文)

def render_inline(chars: list[Ch], boxes: list[dict], size: float, base: float, imgs: list[dict] | None = None,
                  morse: bool = False) -> str:
    tokens = [("c", c.x0, c) for c in chars if c.c.strip()] + [("b", b["r"].x0, b) for b in boxes]
    tokens += [("m", m["x0"], m) for m in (imgs or [])]
    tokens.sort(key=lambda t: t[1])
    out = []
    prev = None  # (kind, ch, x1)
    style = None

    def gap_space(x0):
        """離れて置かれた語(表の列・モールス符号の文字の区切り)の間に全角空白を入れる"""
        if prev is None:
            return
        gap = x0 - prev[2]
        if morse and gap > size * 0.4:
            out.append("　")
        elif gap > size * 1.6:
            out.append("　　")

    def close():
        nonlocal style
        if style:
            out.append(f"</{style}>")
            style = None

    for kind, _, obj in tokens:
        if kind == "b":
            close()
            out.append(f'<span class="bl">{html.escape(fw2hw(obj["label"]))}</span>')
            prev = ("b", None, obj["r"].x1)
            continue
        if kind == "m":
            close()
            out.append(f'<img class="im" src="{html.escape(obj["src"])}" alt="式">')
            prev = ("m", None, obj["x1"])
            continue
        c = obj
        ch = fw2hw(c.c)
        if prev and prev[0] == "c" and (morse or c.x0 - prev[2] > size * 1.6):
            close()
            gap_space(c.x0)
        elif prev and prev[0] == "c" and is_ascii_word(prev[1]) and is_ascii_word(ch) and c.x0 - prev[2] > size * 0.22:
            out.append(" ")
        st = None
        if c.size < size * 0.8:
            if c.base > base + 0.8:
                st = "sub"
            elif c.base < base - 0.8:
                st = "sup"
        if st is None and c.italic and ch.isascii() and ch.isalpha():
            st = "i"
        if st != style:
            close()
            if st:
                out.append(f"<{st}>")
            style = st
        out.append(html.escape(ch))
        prev = ("c", ch, c.x1)
    close()
    return "".join(out)


# ---------------------------------------------------------------- 構造の判定

def _digits_at(ink: list[Ch], k: int, size: float) -> tuple[str, int]:
    """ink[k] から始まる、すき間なく続く数字列とその最後のインデックス"""
    d = fw2hw(ink[k].c)
    if d not in DIGITS:
        return "", k
    j = k
    while j + 1 < len(ink) and fw2hw(ink[j + 1].c) in DIGITS and ink[j + 1].x0 - ink[j].x1 < size * 0.2:
        j += 1
        d += fw2hw(ink[j].c)
    return d, j


def row_marker(row: Row):
    """行頭の記号を返す: (種類, 表示文字列, 記号を除いた文字のリスト) または None"""
    ink = row.ink
    if not ink:
        return None
    first = ink[0]

    def after(k):
        return [c for c in row.chars if c.x0 > ink[k].x0 + 0.1]

    if first.c in CIRCLED:
        return ("circle", first.c, after(0))
    t = fw2hw("".join(c.c for c in ink[:5]))
    m = re.match(r"^[(（](\d{1,2})[)）]", t)
    if m:
        return ("paren", f"({m.group(1)})", after(len(m.group(0)) - 1))
    digits, j = _digits_at(ink, 0, row.size)
    if digits and int(digits) <= 10:
        nxt = ink[j + 1] if len(ink) > j + 1 else None
        if nxt is None or nxt.x0 - ink[j].x1 > row.size * 0.3:
            return ("num", digits, after(j))
    if first.c in KANA:
        nxt = ink[1] if len(ink) > 1 else None
        if nxt is None or nxt.x0 - first.x1 > row.size * 0.3:
            return ("kana", first.c, after(0))
    if first.c == "注":
        return ("note", "注", after(0))
    return None


def is_header_row(row: Row) -> list[Ch] | None:
    """組合せの表の列見出し「A  B  C」の行"""
    ink = row.ink
    if len(ink) < 2 or row.boxes or row.imgs:
        return None
    if all(fw2hw(c.c) in HEAD_LETTERS for c in ink):
        gaps = [b.x0 - a.x1 for a, b in zip(ink, ink[1:])]
        if all(g > row.size * 1.5 for g in gaps):
            return ink
    return None


def is_header_like(row: Row) -> bool:
    """表の見出しらしい短い行(離れた語が2つ以上、記号なし)"""
    if is_header_row(row):
        return True
    ink = row.ink
    if not ink or len(ink) > 24 or row_marker(row):
        return False
    segs = 1 + sum(1 for a, b in zip(ink, ink[1:]) if b.x0 - a.x1 > row.size * 2)
    return segs >= 2


def list_markers(row: Row) -> list[tuple[int, int, int]]:
    """B問題の語群「1 電圧  2 周波数…」の番号: (開始インデックス, 終了インデックス, 番号) のリスト"""
    ink = row.ink
    out = []
    k = 0
    while k < len(ink):
        digits, j = _digits_at(ink, k, row.size)
        if digits:
            gap_before = ink[k].x0 - ink[k - 1].x1 if k > 0 else 99
            gap_after = ink[j + 1].x0 - ink[j].x1 if j + 1 < len(ink) else 0
            if gap_before > row.size * 1.4 and gap_after > row.size * 0.3 and int(digits) <= 10:
                out.append((k, j, int(digits)))
        k = j + 1
    return out


# ---------------------------------------------------------------- 組み立て

def build_text_blocks(rows: list[Row], right_edge: float, label_re: re.Pattern | None):
    blocks = []
    i = 0
    first = label_re is not None
    while i < len(rows):
        row = rows[i]
        head = is_header_row(row)
        if head:
            tbl, j = parse_table(rows, i, head)
            blocks.append((row.top, tbl))
            i = j
            continue
        marks = list_markers(row)
        nxt_marks = list_markers(rows[i + 1]) if i + 1 < len(rows) else []
        if len(marks) >= 2 or (marks and marks[0][0] == 0 and marks[0][2] == 1 and len(nxt_marks) >= 2):
            lst, j = parse_list(rows, i)
            blocks.append((row.top, lst))
            i = j
            continue
        chars = row.chars
        mk = row_marker(row)
        marker = None
        is_note = row.size < 8.6
        if first:
            # 先頭行の「A－1」などの問題番号を除く
            txt = fw2hw("".join(c.c for c in row.ink[:8]))
            m = label_re.match(txt)
            if m:
                cut = row.ink[len(m.group(0)) - 1].x1
                chars = [c for c in row.chars if c.x0 >= cut - 0.1]
            mk = None
        elif mk:
            marker = mk[1]
            chars = mk[2]
        first = False
        morse = row.complexity() == "morse"
        kept = {id(c) for c in chars}
        # 記号(「(3)」「1」など)や問題番号より右にある枠・式だけを本文に含める
        lead_end = max((c.x1 for c in row.ink if id(c) not in kept), default=row.x0 - 1)
        imgs = [m for m in row.imgs if m["x0"] >= lead_end - 1]
        boxes = [b for b in row.boxes if b["r"].x0 >= lead_end - 1]
        parts = [render_inline(chars, boxes, row.size, row.base, imgs, morse=morse)]
        start_x = min([c.x0 for c in chars if c.c.strip()] + [b["r"].x0 for b in boxes] + [m["x0"] for m in imgs],
                      default=row.x0)
        indent = start_x
        prev = row
        prev_prev_x1 = 0.0
        cont_x = None
        j = i + 1
        while j < len(rows) and not morse:
            nxt = rows[j]
            if nxt.base - prev.base > max(prev.size, nxt.size) * 1.9:
                break
            if row_marker(nxt) or is_header_row(nxt) or len(list_markers(nxt)) >= 2 or nxt.complexity() == "morse":
                break
            if (nxt.size < 8.6) != is_note:
                break
            # 前の行が(前後の行に比べて)行末まで届いていない → その行で段落が終わっている
            ref = max(nxt.x1, prev_prev_x1, prev.col_right or 0)
            if prev.x1 < ref - prev.size * 2.0:
                break
            # 続きの行より深く字下げされた行は新しい段落
            if cont_x is not None and nxt.x0 > cont_x + nxt.size * 0.7:
                break
            if cont_x is None and (nxt.x0 > indent + nxt.size * 1.5 or nxt.x0 < indent - nxt.size * 1.2
                                   and prev.x1 < right_edge - prev.size * 1.5):
                break
            if cont_x is None:
                cont_x = nxt.x0
            parts.append(render_inline(nxt.chars, nxt.boxes, nxt.size, nxt.base, nxt.imgs))
            prev_prev_x1 = prev.x1
            prev = nxt
            j += 1
        blk = {"t": "p", "h": "".join(parts)}
        if marker:
            blk["m"] = fw2hw(marker)
        if is_note:
            blk["note"] = True
        if morse:
            blk["morse"] = True
        blocks.append((row.top, blk))
        i = j
    return blocks


def _row_gaps(r: Row) -> list[tuple[float, float]]:
    spans = sorted([(c.x0, c.x1) for c in r.ink] + [(b["r"].x0, b["r"].x1) for b in r.boxes]
                   + [(m["x0"], m["x1"]) for m in r.imgs])
    return [(a1, b0) for (_, a1), (b0, _) in zip(spans, spans[1:]) if b0 - a1 > r.size * 2.5]


def _split_row(r: Row, x: float) -> tuple[Row | None, Row | None]:
    def part(pred):
        nr = Row([c for c in r.chars if pred(c.cx)], boxes=[b for b in r.boxes if pred(b["r"].x0)],
                 imgs=[m for m in r.imgs if pred(m["x0"])])
        if not (nr.ink or nr.boxes or nr.imgs):
            return None
        nr.base, nr.size = r.base, r.size
        nr.chars.sort(key=lambda c: c.x0)
        return nr
    return part(lambda v: v < x), part(lambda v: v >= x)


def split_columns(rows: list[Row]) -> list[Row]:
    """左に本文・右に選択肢の表、のような2段組みの部分を「左段 → 右段」の順に並べ替える"""
    out = []
    i = 0
    while i < len(rows):
        found = None
        for gx0, gx1 in _row_gaps(rows[i]):
            lo, hi = gx0, gx1
            j = i + 1
            while j < len(rows) and rows[j].base - rows[j - 1].base < rows[j].size * 1.9:
                ov = [(max(lo, a), min(hi, b)) for a, b in _row_gaps(rows[j]) if min(hi, b) - max(lo, a) > rows[j].size]
                if not ov:
                    break
                lo, hi = ov[0]
                j += 1
            if j - i >= 2:
                gx = (lo + hi) / 2
                lefts = [_split_row(r, gx)[0] for r in rows[i:j]]
                # 左段が本文らしい(番号で始まらず、1行あたり平均12文字以上)ときだけ2段組みとみなす
                # (組合せの表の列や、B問題の語群を割らないため)
                textlike = all(lefts) and sum(len(lp.ink) for lp in lefts) / len(lefts) >= 12
                if textlike and not any(len(list_markers(r)) >= 2 for r in rows[i:j]) \
                        and not any((row_marker(lp) or ("",))[0] == "num" for lp in lefts):
                    found = (j, gx, lo)
                    break
        if not found:
            out.append(rows[i])
            i += 1
            continue
        j, gx, col_edge = found
        k = j
        while k < len(rows) and rows[k].x1 < gx and rows[k].base - rows[k - 1].base < rows[k].size * 1.9:
            k += 1
        left, right = [], []
        for r in rows[i:j]:
            lp, rp = _split_row(r, gx)
            if lp:
                lp.col_right = col_edge
                left.append(lp)
            if rp:
                right.append(rp)
        for r in rows[j:k]:
            r.col_right = col_edge
            left.append(r)
        out.extend(left)
        out.extend(right)
        i = k
    return out


def _col_index(x: float, cols: list[float], size: float) -> int:
    k = 0
    for idx, cx in enumerate(cols):
        if x >= cx - size * 0.6:
            k = idx
    return k


def parse_table(rows: list[Row], i: int, head: list[Ch]):
    cols = [c.x0 for c in head]
    size = rows[i].size
    trs = []
    j = i + 1
    prev = rows[i]
    while j < len(rows):
        r = rows[j]
        if r.base - prev.base > max(size, r.size) * 2.6:
            break
        mk = row_marker(r)
        if mk and mk[0] == "num" and r.x0 < cols[0] - size * 0.3:
            cells = [[] for _ in cols]
            for c in mk[2]:
                if c.c.strip():
                    cells[_col_index(c.x0, cols, size)].append(c)
            trs.append({"n": mk[1], "cells": [cells], "rows": [r]})
        elif trs and not mk and r.x0 >= cols[0] - size * 0.6:
            cells = [[] for _ in cols]
            for c in r.ink:
                cells[_col_index(c.x0, cols, size)].append(c)
            trs[-1]["cells"].append(cells)
            trs[-1]["rows"].append(r)
        else:
            break
        if r.boxes or r.imgs:
            raise Uncertain("組合せの表に枠や式がある")
        prev = r
        j += 1
    nums = [int(fw2hw(t["n"])) for t in trs]
    if len(trs) < 2 or nums != list(range(1, len(trs) + 1)):
        raise Uncertain("組合せの表の行番号がそろわない")
    out_rows = []
    for t in trs:
        cells_html = []
        for k in range(len(cols)):
            # モールス符号のセルは文字の区切り(すき間)を全角空白で残す
            segs = [render_inline(cl[k], [], r.size, r.base, morse=r.complexity() == "morse")
                    for cl, r in zip(t["cells"], t["rows"]) if cl[k]]
            if not segs:
                raise Uncertain("組合せの表に空のセルがある")
            cells_html.append("".join(segs))
        out_rows.append([t["n"]] + cells_html)
    return {"t": "tbl", "head": [fw2hw(c.c) for c in head], "rows": out_rows}, j


def parse_list(rows: list[Row], i: int):
    items = []
    j = i
    prev = None
    while j < len(rows):
        r = rows[j]
        if prev is not None and r.base - prev.base > max(prev.size, r.size) * 2.6:
            break
        marks = list_markers(r)
        ink = r.ink
        if marks and marks[0][0] == 0:
            for n, (_, k1, num) in enumerate(marks):
                end = marks[n + 1][0] if n + 1 < len(marks) else len(ink)
                items.append([num, ink[k1 + 1:end], r])
        elif items and not marks:
            items[-1][1] = items[-1][1] + ink
        else:
            break
        if r.boxes or r.imgs:
            raise Uncertain("語群に枠や式がある")
        prev = r
        j += 1
    nums = [it[0] for it in items]
    if nums != list(range(1, len(items) + 1)) or len(items) < 4:
        raise Uncertain("語群の番号がそろわない")
    return {"t": "list", "items": [[str(n), render_inline(body, [], r.size, r.base)] for n, body, r in items]}, j


# ---------------------------------------------------------------- 画像として切り出す領域

def render_region(page: pymupdf.Page, rect: pymupdf.Rect, trim: bool = True,
                  mask: list[pymupdf.Rect] | None = None) -> Image.Image | None:
    """領域を画像にする。mask の範囲(テキストとして別に表示する文字)は白で塗りつぶす"""
    pix = page.get_pixmap(matrix=pymupdf.Matrix(IMG_ZOOM, IMG_ZOOM), clip=rect, colorspace=pymupdf.csGRAY, alpha=False)
    img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    if mask:
        a = np.array(img)
        for m in mask:
            x0 = int(max(0, (m.x0 - rect.x0) * IMG_ZOOM))
            y0 = int(max(0, (m.y0 - rect.y0) * IMG_ZOOM))
            x1 = int(min(a.shape[1], (m.x1 - rect.x0) * IMG_ZOOM + 1))
            y1 = int(min(a.shape[0], (m.y1 - rect.y0) * IMG_ZOOM + 1))
            if x1 > x0 and y1 > y0:
                a[y0:y1, x0:x1] = 255
        img = Image.fromarray(a)
    if not trim:
        return img
    a = np.asarray(img)
    mask = a < 200
    if not mask.any():
        return None
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    pad = 6
    return img.crop((max(cols[0] - pad, 0), max(rows[0] - pad, 0), min(cols[-1] + pad + 1, a.shape[1]),
                     min(rows[-1] + pad + 1, a.shape[0])))


def _segments(chars: list[Ch]) -> list[list[Ch]]:
    """同じ行で近接している文字のまとまり"""
    segs = []
    for r in group_rows(chars):
        cur = []
        for c in r.ink:
            if cur and c.x0 - cur[-1].x1 > r.size * 1.2:
                segs.append(cur)
                cur = []
            cur.append(c)
        if cur:
            segs.append(cur)
    return segs


def _attach_figure_text(chars: list[Ch], figures: list[pymupdf.Rect]):
    """図の中のラベルと、図のすぐ横(18pt以内)の短いラベルを図に含める。図に属さない文字と図の範囲を返す"""
    figs = [pymupdf.Rect(f) for f in figures]
    taken: set[int] = set()
    # 図形(線画)の範囲の中にある文字は図のラベル。範囲を広げた後の再判定はしない
    # (広げた範囲で隣の本文の文字まで取り込まないため)
    for c in chars:
        if not c.c.strip():
            continue
        for fi, f in enumerate(figures):
            if f.x0 - 1.5 <= c.cx <= f.x1 + 1.5 and f.y0 - 1.5 <= c.cy <= f.y1 + 1.5:
                taken.add(id(c))
                figs[fi] = figs[fi] | pymupdf.Rect(c.x0, c.base - c.size, c.x1, c.base + c.size * 0.3)
                break
    for _ in range(4):
        changed = False
        free = [c for c in chars if id(c) not in taken and c.c.strip()]
        segs = _segments(free)
        rows_free = group_rows(free)
        for seg in segs:
            sr = pymupdf.Rect(min(c.x0 for c in seg), min(c.base - c.size for c in seg),
                              max(c.x1 for c in seg), max(c.base + c.size * 0.3 for c in seg))
            row = next((r for r in rows_free if seg[0] in r.chars), None)
            size = row.size if row else 10.5
            # 同じ行のほかの文字から十分に離れている(=本文の一部ではない)まとまりか
            others = [c for c in (row.ink if row else []) if c not in seg]
            isolated = all(c.x1 < sr.x0 - size * 3 or c.x0 > sr.x1 + size * 3 for c in others)
            starts_marker = row_marker(Row(list(seg)).finish()) is not None
            # 組合せの表の列見出し(A B C)は図の説明ではない
            if row is not None and is_header_row(row):
                continue
            for fi, f in enumerate(figs):
                # 図のすぐ左右にある短いラベル(「直流電源」「C1 = 5〔μF〕」など)
                dist_x = max(sr.x0 - f.x1, f.x0 - sr.x1)  # 重なっていれば負
                near_x = dist_x < 18
                over_y = sr.y1 > f.y0 - 2 and sr.y0 < f.y1 + 2
                side_label = near_x and over_y and len(seg) <= 14
                # 図のすぐ上下にあって図の幅に収まる見出し・寸法・説明文(「6〔m〕」「(イメージ図)」など)
                gap_y = max(sr.y0 - f.y1, f.y0 - sr.y1)
                within = sr.x0 >= f.x0 - 40 and sr.x1 <= f.x1 + 40
                caption = -2 < gap_y < size * 1.3 and within and isolated and len(seg) <= 30 and not starts_marker
                if side_label or caption:
                    taken.update(id(c) for c in seg)
                    figs[fi] = f | sr
                    changed = True
                    break
        if not changed:
            break
    return [c for c in chars if id(c) not in taken], _merge_figures(figs)


def _merge_figures(figs: list[pymupdf.Rect]) -> list[pymupdf.Rect]:
    """重なる図や、上下に近く(20pt以内)横位置がそろった図(回路図とその凡例など)を1枚にまとめる"""
    figs = [pymupdf.Rect(f) for f in figs]
    merged = True
    while merged and len(figs) > 1:
        merged = False
        for i in range(len(figs)):
            for j in range(i + 1, len(figs)):
                a, b = figs[i], figs[j]
                ov_x = min(a.x1, b.x1) - max(a.x0, b.x0)
                ov_y = min(a.y1, b.y1) - max(a.y0, b.y0)
                gap_x = max(a.x0 - b.x1, b.x0 - a.x1)
                gap_y = max(a.y0 - b.y1, b.y0 - a.y1)
                touching = (a + (-2, -2, 2, 2)).intersects(b)
                stacked = ov_x > 0.3 * min(a.width, b.width) and gap_y < 20
                # 主な図のすぐ横にある小さな図(凡例・記号の説明など)
                small_side = (ov_y > 0.5 * min(a.height, b.height) and gap_x < 60
                              and min(a.get_area(), b.get_area()) < 0.25 * max(a.get_area(), b.get_area()))
                if touching or stacked or small_side:
                    figs[i] = a | b
                    del figs[j]
                    merged = True
                    break
            if merged:
                break
    return figs


def build(doc: pymupdf.Document, parts, label_re: re.Pattern, save_image) -> list[dict]:
    """1問分のテキスト表示ブロックを返す。作れない場合は Uncertain を送出する。

    save_image(img, name) -> (src, w, h)  画像を保存してパスと大きさを返す関数
    """
    out = []
    n_fig = 0
    n_inline = 0
    first_part = True
    image_markers: set = set()  # 画像(式の帯・図)の中に入った選択肢の番号
    for pno, clip in parts:
        page = doc[pno]
        chars = page_chars(page, clip)
        boxes, figures, bars = find_boxes_and_figures(page, clip)
        # 根号(√)の上の横線は分数の線ではない
        roots = [c for c in chars if c.c == "√"]
        bars = [b for b in bars if not any(abs(b.x0 - c.x1) < 3 and c.base - c.size * 1.5 <= b.y0 <= c.base - c.size * 0.4
                                           for c in roots)]
        # 枠の中の文字(空欄の記号 A, B, ア …)を枠に移す
        rest = []
        for c in chars:
            box = next((b for b in boxes if b["r"].x0 - 0.5 <= c.cx <= b["r"].x1 + 0.5
                        and b["r"].y0 - 0.5 <= c.cy <= b["r"].y1 + 0.5), None)
            if box is None:
                rest.append(c)
            elif c.c.strip():
                box["label"] += c.c
        # ルビ(とても小さい文字)は除く
        chars = [c for c in rest if c.size >= 6.2 or not c.c.strip()]
        chars, figs = _attach_figure_text(chars, figures)
        # 図の中にある枠(図中の記号)は図の一部として画像に残す
        boxes = [b for b in boxes if not any((f + (-2, -2, 2, 2)).contains(b["r"]) for f in figs)]

        rows = group_rows(chars)
        for b in boxes:
            cy = (b["r"].y0 + b["r"].y1) / 2

            def near(r):
                # 同じ高さで、行の文字から横に離れすぎていない行にだけ割り当てる
                return (abs((r.base - r.size * 0.35) - cy) <= r.size
                        and (not r.ink or min(abs(b["r"].x0 - c.x1) for c in r.ink) < r.size * 4
                             or min(abs(c.x0 - b["r"].x1) for c in r.ink) < r.size * 4))
            cands = [r for r in rows if near(r)]
            best = min(cands, key=lambda r: abs((r.base - r.size * 0.35) - cy), default=None)
            if best is None:
                nr = Row([], base=b["r"].y1 - 2.5, size=10.5)
                nr.boxes.append(b)
                rows.append(nr)
            else:
                best.boxes.append(b)
        rows.sort(key=lambda r: r.base)

        # 分数の線の上下にある行(分子・分母・式の行)は、行ごと画像にする
        forced = set()
        for b in bars:
            ybar = (b.y0 + b.y1) / 2
            for r in rows:
                if r.x0 < b.x1 and r.x1 > b.x0 and r.top - r.size * 1.2 <= ybar <= r.bottom + r.size * 1.2:
                    forced.add(id(r))

        def kind(r):
            return "band" if id(r) in forced else r.complexity()

        # 文中の短い数式 → 文字と同じ高さの小さな画像
        for r in rows:
            if kind(r) != "inline":
                continue
            maths = sorted((c for c in r.ink if c.math), key=lambda c: c.x0)
            runs, cur = [], []
            for c in maths:
                if cur and c.x0 - cur[-1].x1 > r.size * 0.6:
                    runs.append(cur)
                    cur = []
                cur.append(c)
            if cur:
                runs.append(cur)
            for run in runs:
                x0 = min(c.x0 for c in run) - 0.6
                x1 = max(c.x1 for c in run) + 0.6
                rect = pymupdf.Rect(x0, r.base - r.size * INLINE_ASCENT, x1, r.base + r.size * INLINE_DESCENT)
                img = render_region(page, rect, trim=False)
                n_inline += 1
                src, _, _ = save_image(img, f"m{n_inline}")
                r.imgs.append({"x0": x0, "x1": x1, "src": src})
            ids = {id(c) for c in maths}
            r.chars = [c for c in r.chars if id(c) not in ids]

        # 分数の式を含む選択肢やモールス符号の行 → 隣り合う行をまとめた「帯」を1枚の画像に
        bands: list[list] = []
        for r in rows:
            if kind(r) == "band":
                rr = r.rect()
                if bands and rr.y0 - bands[-1][0].y1 < r.size * 0.9:
                    bands[-1][0] |= rr
                    bands[-1][1].append(r)
                else:
                    bands.append([rr, [r]])
        in_band = {id(r) for b in bands for r in b[1]}
        changed = True
        while changed and bands:
            changed = False
            for r in rows:
                if id(r) in in_band:
                    continue
                for band in bands:
                    br = band[0]
                    h = r.bottom - r.top
                    ov = min(r.bottom, br.y1) - max(r.top, br.y0)
                    gap_x = max(r.x0 - br.x1, br.x0 - r.x1)  # 横に離れた別の段の行は取り込まない
                    header_above = is_header_like(r) and 0 <= br.y0 - r.bottom < r.size * 1.6 and gap_x < r.size * 3
                    if (ov > h * 0.4 and gap_x < r.size * 3) or header_above:
                        band[0] = br | r.rect()
                        band[1].append(r)
                        in_band.add(id(r))
                        changed = True
                        break
        regions = [pymupdf.Rect(f) for f in figs] + [b[0] for b in bands]
        if regions:
            regions = [_union([regions[i] for i in grp]) for grp in _cluster(regions, 1)]
        text_rows = []
        for r in rows:
            if id(r) in in_band:
                image_markers.update(_marker_key(r))
                continue
            # 行のすべての文字・枠が図の範囲に入っているときだけ図の一部とみなす(文字の取りこぼし防止)
            pts = [pymupdf.Point(c.cx, c.cy) for c in r.ink] + \
                  [pymupdf.Point((b["r"].x0 + b["r"].x1) / 2, (b["r"].y0 + b["r"].y1) / 2) for b in r.boxes]
            if pts and any(all((reg + (-2, -2, 2, 2)).contains(p) for p in pts) for reg in regions):
                image_markers.update(_marker_key(r))
                continue
            text_rows.append(r)

        right_edge = max((r.x1 for r in text_rows), default=clip.x1)
        text_rows = split_columns(text_rows)
        blocks = build_text_blocks(text_rows, right_edge, label_re if first_part else None)
        first_part = False
        # 文章のブロックは読み順のまま、図や式の画像はその上端の位置に差し込む
        for reg in sorted(regions, key=lambda r: r.y0):
            area = pymupdf.Rect(reg.x0 - 3, reg.y0 - 3, reg.x1 + 3, reg.y1 + 3) & page.rect
            # 図の範囲に少しかかっている本文の文字は、図の画像に写り込まないよう消す
            mask = [pymupdf.Rect(c.x0, c.base - c.size * 0.95, c.x1, c.base + c.size * 0.3)
                    for r in text_rows for c in r.ink]
            mask += [b["r"] + (-0.6, -0.6, 0.6, 0.6) for r in text_rows for b in r.boxes]
            mask = [m for m in mask if m.intersects(area)]
            img = render_region(page, area, mask=mask)
            if img is None:
                continue
            n_fig += 1
            src, w, h = save_image(img, f"t{n_fig}")
            blk = {"t": "img", "src": src, "w": w, "h": h, "pw": round(reg.width + 6, 1)}
            # 図と同じ高さから始まる文章(図の左に並んだ選択肢など)より前に図を置く
            idx = next((k for k, (top, b) in enumerate(blocks) if b["t"] != "img" and top > reg.y0 - 14), len(blocks))
            blocks.insert(idx, (reg.y0, blk))
        out.extend(b for _, b in blocks)
    if not any(b["t"] != "img" for b in out):
        raise Uncertain("テキストにできる部分がない")
    return out, image_markers


def _marker_key(r: Row) -> set:
    mk = row_marker(r)
    if mk and mk[0] == "num":
        return {int(mk[1])}
    if mk and mk[0] == "kana":
        return {mk[1]}
    return set()
