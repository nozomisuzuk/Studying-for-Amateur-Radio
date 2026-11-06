"""解説データの生成。

1. 自動「正しい文」(fill) … 空欄補充の問題で、正答の字句を空欄に入れた文を作る
2. 自動「符号の読み」(morse) … モールス符号の問題で、各符号を文字に読み下す
3. 手書きの解説(exp) … explanations/<試験コード>.md に書いた解説を取り込む
4. 法改正の注記(outdated) … explanations/outdated.md に書いた、出題後の法改正で
   現在の規定と食い違う問題の一覧と説明を取り込む

手書きの解説ファイルの書式:
    ## A-1
    解説の本文(空行で段落を分ける。**強調** が使える)

    ## A-2 = HZ612-A03
    (「=」の後に問題IDを書くと、その問題の解説を共有する)

法改正の注記ファイル(explanations/outdated.md)の書式:
    ## HY209-A04 | 令和7年法律第27号（令和8年4月1日施行） | major
    何がどう変わったかの説明
  major … 正答や記述の内容が現在の規定と食い違う(演習から既定で外す)
  minor … 用語・条番号などが変わったが、答えは変わらない(解説に注記するだけ)
"""
from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import Path

KANA = "アイウエオ"

MORSE_TABLE = {
    "・－": "A", "－・・・": "B", "－・－・": "C", "－・・": "D", "・": "E", "・・－・": "F", "－－・": "G",
    "・・・・": "H", "・・": "I", "・－－－": "J", "－・－": "K", "・－・・": "L", "－－": "M", "－・": "N",
    "－－－": "O", "・－－・": "P", "－－・－": "Q", "・－・": "R", "・・・": "S", "－": "T", "・・－": "U",
    "・・・－": "V", "・－－": "W", "－・・－": "X", "－・－－": "Y", "－－・・": "Z",
    "・－－－－": "1", "・・－－－": "2", "・・・－－": "3", "・・・・－": "4", "・・・・・": "5",
    "－・・・・": "6", "－－・・・": "7", "－－－・・": "8", "－－－－・": "9", "－－－－－": "0",
    # 記号・略符号(無線局運用規則 別表第1号の欧文の記号)
    "・－・－・－": "．", "－－・・－－": "，", "－－－・・・": "：", "・・－－・・": "？",
    "・－－－－・": "’", "－・・・・－": "－", "－・－－・": "（", "－・－－・－": "）",
    "－・・－・": "／", "－・・・－": "BT（＝）", "・－・－・": "AR（＋）", "・－・・－・": "”",
    "・－－・－・": "＠", "・－・・・": "AS", "・・・－・－": "VA", "・・・・・・・・": "HH（訂正符号）",
}


def _strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s)


def decode_morse(seq: str) -> str:
    """全角空白などで区切られたモールス符号の並びを文字に読み下す"""
    out = []
    for tok in re.split(r"[\s　]+", seq.strip()):
        if tok:
            out.append(MORSE_TABLE.get(tok, "?"))
    # 1文字ずつなら続けて書き、略符号(BT・AR など)を含むときは空白で区切る
    return "".join(out) if all(len(c) == 1 for c in out) else " ".join(out)


# ---------------------------------------------------------------- 正しい文(空欄補充)

BL_RE = re.compile(r'<span class="bl">([^<]*)</span>')
MORSE_TOKEN = re.compile(r"^[－・]+$")


def fill_sentences(q: dict) -> list[str] | None:
    """空欄に正答の字句を入れた文(HTML)のリスト。作れない場合は None"""
    tv = q.get("tv")
    if not tv:
        return None
    values: dict[str, str] = {}
    if q["kind"] == "A":
        tbl = next((b for b in tv if b["t"] == "tbl"), None)
        if not tbl:
            return None
        row = next((r for r in tbl["rows"] if r[0] == str(q["answer"])), None)
        if not row:
            return None
        for label, cell in zip(tbl["head"], row[1:]):
            values[label] = cell
    elif q.get("bStyle") == "select":
        lst = next((b for b in tv if b["t"] == "list"), None)
        if not lst:
            return None
        items = {n: h for n, h in lst["items"]}
        for k, a in zip(KANA, q["answer"]):
            if str(a) not in items:
                return None
            values[k] = items[str(a)]
    else:
        return None
    out = []
    used = set()
    for b in tv:
        if b["t"] != "p":
            continue
        labels = [m for m in BL_RE.findall(b["h"]) if m]
        if not labels:
            continue
        if any(m not in values for m in labels):
            return None
        used.update(labels)

        def rep(m):
            v = values.get(m.group(1))
            if v is None:
                return ""
            plain = _strip_tags(html.unescape(v)).strip()
            # モールス符号の字句には読みを添える
            if plain and all(MORSE_TOKEN.match(t) for t in re.split(r"[\s　]+", plain) if t):
                return f'<b class="fl">{v}</b>（{html.escape(decode_morse(plain))}）'
            return f'<b class="fl">{v}</b>'
        text = BL_RE.sub(rep, b["h"])
        out.append((f"{html.escape(b['m'])} " if b.get("m") else "") + text)
    if not out:
        return None
    # 表にしか出てこない空欄(図の中の空欄など)があれば、組合せも添える
    missing = [k for k in values if k not in used]
    if q["kind"] == "A" and missing:
        out.append("正しい組合せ: " + "、".join(f"{k} = {values[k]}" for k in values))
    return out


# ---------------------------------------------------------------- モールス符号の読み

def morse_notes(q: dict) -> list[str] | None:
    tv = q.get("tv")
    if not tv:
        return None
    notes = []
    for b in tv:
        if b["t"] == "p" and b.get("morse"):
            txt = _strip_tags(html.unescape(b["h"])).strip()
            toks = re.split(r"[\s　]+", txt)
            label = [t for t in toks if not MORSE_TOKEN.match(t)]
            codes = [t for t in toks if MORSE_TOKEN.match(t)]
            if not codes:
                continue
            dec = decode_morse(" ".join(codes))
            head = f"{b['m']}　" if b.get("m") else ""
            plain = "".join(label)
            if plain:
                # 字句と符号の読みを1文字ずつ比べ、食い違いを示す
                if dec == plain:
                    notes.append(f"{head}{html.escape(plain)}：符号の読みは字句と一致")
                else:
                    diff = [f"{i + 1}文字目 {a}→{c}" for i, (a, c) in enumerate(zip(plain, dec)) if a != c]
                    if len(plain) != len(dec):
                        diff.append(f"文字数 {len(plain)}→{len(dec)}")
                    notes.append(f"{head}{html.escape(plain)}：符号を読むと {html.escape(dec)}（{html.escape('、'.join(diff))}）")
            else:
                notes.append(f"{head}{html.escape(' '.join(codes))} ＝ {html.escape(dec)}")
        elif b["t"] == "tbl":
            for row in b["rows"]:
                cells = [_strip_tags(html.unescape(c)).strip() for c in row[1:]]
                if not cells or not all(all(MORSE_TOKEN.match(t) for t in re.split(r"[\s　]+", c) if t) for c in cells):
                    continue
                parts = [f"{lab} {html.escape(c)} ＝ {html.escape(decode_morse(c))}" for lab, c in zip(b["head"], cells)]
                notes.append(f"{html.escape(row[0])}　" + "／".join(parts))
    return notes or None


# ---------------------------------------------------------------- 手書きの解説

def md_to_html(text: str) -> str:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    out = []
    for p in paras:
        h = html.escape(p)
        h = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", h)
        h = h.replace("\n", "<br>")
        out.append(f"<p>{h}</p>")
    return "".join(out)


HEAD_RE = re.compile(r"^##\s*([AB])\s*-\s*(\d+)\s*(?:=\s*(H[ZY]\d{3}-[AB]\d{2}))?\s*$")


def load_manual(directory: Path) -> tuple[dict[str, str], dict[str, str]]:
    """explanations/*.md を読み、{問題ID: HTML} と {問題ID: 参照先ID} を返す"""
    exps, refs = {}, {}
    for f in sorted(directory.glob("H[ZY][0-9][0-9][0-9].md")):
        code = f.stem
        cur, buf = None, []

        def flush():
            if cur and "\n".join(buf).strip():
                exps[cur] = md_to_html("\n".join(buf))
        for line in f.read_text(encoding="utf-8").splitlines():
            m = HEAD_RE.match(line)
            if m:
                flush()
                cur = f"{code}-{m.group(1)}{int(m.group(2)):02d}"
                buf = []
                if m.group(3):
                    refs[cur] = m.group(3)
            elif line.startswith("# "):
                continue
            else:
                buf.append(line)
        flush()
    return exps, refs


OLD_HEAD = re.compile(r"^##\s*(H[ZY]\d{3}-[AB]\d{2})\s*\|\s*(.+?)\s*(?:\|\s*(major|minor)\s*)?$")


def load_outdated(directory: Path) -> dict[str, dict]:
    """explanations/outdated.md を読み、{問題ID: {"law": 改正, "note": HTML}} を返す"""
    f = directory / "outdated.md"
    if not f.exists():
        return {}
    res, cur, law, level, buf = {}, None, "", "major", []

    def flush():
        if cur:
            res[cur] = {"law": law, "level": level, "note": md_to_html("\n".join(buf))}
    for line in f.read_text(encoding="utf-8").splitlines():
        m = OLD_HEAD.match(line)
        if m:
            flush()
            cur, law, level, buf = m.group(1), m.group(2), m.group(3) or "major", []
        elif line.startswith("# "):
            continue
        else:
            buf.append(line)
    flush()
    return res


def dup_key(q: dict) -> str:
    """まったく同じ問題(本文と正答が同一)を見分けるキー"""
    t = re.sub(r"\s+", "", q["text"])
    t = re.sub(r"^[AB]-?\d+", "", t)
    raw = json.dumps([q["subject"], q["kind"], t, q["answer"]], ensure_ascii=False)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def attach(questions: list[dict], directory: Path) -> dict:
    """各問題に fill / morse / exp を付ける。集計を返す"""
    exps, refs = load_manual(directory)
    old = load_outdated(directory)
    by_id = {q["id"]: q for q in questions}
    unknown = [k for k in list(exps) + list(refs) + list(old) if k not in by_id]
    for k, v in refs.items():
        if v in exps and k not in exps:
            exps[k] = exps[v]
    # 本文と正答がまったく同じ問題には、同じ解説を使う
    groups: dict[str, list[str]] = {}
    for q in questions:
        groups.setdefault(dup_key(q), []).append(q["id"])
    for ids in groups.values():
        src = next((i for i in ids if i in exps), None)
        if src:
            for i in ids:
                exps.setdefault(i, exps[src])
    stats = {"fill": 0, "morse": 0, "exp": 0, "none": 0, "outdated": 0, "amended": 0}
    for q in questions:
        for k in ("fill", "morse", "exp", "outdated"):
            q.pop(k, None)
        if q["id"] in old:
            q["outdated"] = old[q["id"]]
            stats["outdated" if q["outdated"]["level"] == "major" else "amended"] += 1
        f = fill_sentences(q)
        m = morse_notes(q)
        if f:
            q["fill"] = f
            stats["fill"] += 1
        if m:
            q["morse"] = m
            stats["morse"] += 1
        if q["id"] in exps:
            q["exp"] = exps[q["id"]]
            stats["exp"] += 1
        if not (f or m or q["id"] in exps):
            stats["none"] += 1
    stats["unknown_ids"] = unknown
    return stats
