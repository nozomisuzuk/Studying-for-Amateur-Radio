#!/usr/bin/env python3
"""第一級アマチュア無線技士 過去問PDF → 問題画像 + data/questions.json 変換スクリプト

使い方:
  python3 tools/build_data.py --download   # 公式サイトの最新PDFを source-pdf/ に追加取得してから変換
  python3 tools/build_data.py              # source-pdf/ にあるPDFだけで変換

入力 (source-pdf/):
  HZ711.pdf / HZ711-kaito.pdf  … 無線工学 (HZ + 令和の年1桁 + 月2桁)
  HY711.pdf / HY711-kaito.pdf  … 法規

出力:
  data/img/<コード>/<A01|B01>[_2].png   1問ずつ切り出した問題画像
  data/questions.json                   問題メタデータ・正答・ジャンル
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from genres import GENRES, classify  # noqa: E402
import textview  # noqa: E402
import explain  # noqa: E402

LABEL_RE = re.compile(r"^[AB][-－−‐―ー]?\d{1,2}")

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = ROOT / "source-pdf"
DATA_DIR = ROOT / "data"
EXPL_DIR = ROOT / "explanations"
IMG_DIR = DATA_DIR / "img"

OFFICIAL_PAGE = "https://www.nichimu.or.jp/kshiken/siken/index.html"
OFFICIAL_PDF = "https://www.nichimu.or.jp/vc-files/kshiken/pdf/siken/{slot}/{name}.pdf"
OFFICIAL_SLOTS = range(1, 7)  # 公式サイトは siken/1〜4 程度を入れ替えながら公開している

SUBJECTS = {
    "kogaku": {"label": "無線工学", "prefix": "HZ", "file": "ama-1-kogaku",
               "full": 150, "pass": 105, "minutes": 150},
    "hoki": {"label": "法規", "prefix": "HY", "file": "ama-1-hoki",
             "full": 150, "pass": 105, "minutes": 150},
}
PREFIX_TO_SUBJECT = {v["prefix"]: k for k, v in SUBJECTS.items()}

# 臨時試験など、コードからは分からない注記
SESSION_NOTES = {"808": "臨時"}

ZOOM = 2.4            # レンダリング倍率 (72dpi × 2.4 ≒ 173dpi)
WHITE_THRESHOLD = 200  # これより暗い画素を「内容あり」とみなす
PAD = 10               # トリミング後の余白(px)

HEADER_RE = re.compile(r"^\s*([AB])\s*[-−‐―ー]\s*(\d+)")
FOOTER_RE = re.compile(r"^\s*\(\s*H[ZY]\s*\d+\s*[-−‐―ー]\s*\d+\s*\)\s*$")
CODE_RE = re.compile(r"H\s*([ZY])\s*(\d)\s*(\d)\s*(\d)")


# PDFの中に、見た目は同じでも別の文字(キリル文字の А・В など)で組まれた問題番号がある
HOMOGLYPHS = str.maketrans({"А": "A", "В": "B", "а": "a"})


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s).translate(HOMOGLYPHS)


# ---------------------------------------------------------------------------
# ダウンロード
# ---------------------------------------------------------------------------

def fetch(url: str) -> bytes | None:
    req = urllib.request.Request(url, headers={"User-Agent": "ama1-drill-builder/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except Exception as e:  # noqa: BLE001
        print(f"  skip {url}: {e}")
        return None
    if not data.startswith(b"%PDF"):
        print(f"  skip {url}: PDFではありません")
        return None
    return data


def detect_code(pdf_bytes: bytes) -> str | None:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    text = nfkc(doc[0].get_text())
    m = CODE_RE.search(text)
    if not m:
        return None
    return "H" + m.group(1) + m.group(2) + m.group(3) + m.group(4)


def download_official() -> None:
    PDF_DIR.mkdir(exist_ok=True)
    for slot in OFFICIAL_SLOTS:
        for subj in SUBJECTS.values():
            q = fetch(OFFICIAL_PDF.format(slot=slot, name=subj["file"]))
            if not q:
                continue
            code = detect_code(q)
            if not code:
                print(f"  slot {slot}: 試験コードを検出できませんでした")
                continue
            a = fetch(OFFICIAL_PDF.format(slot=slot, name=subj["file"] + "-kaito"))
            if not a or detect_code(a) != code:
                print(f"  {code}: 正答PDFが見つからないか、コードが一致しません")
                continue
            qp, ap = PDF_DIR / f"{code}.pdf", PDF_DIR / f"{code}-kaito.pdf"
            if qp.exists() and ap.exists():
                print(f"  {code}: 取得済み")
                continue
            qp.write_bytes(q)
            ap.write_bytes(a)
            print(f"  {code}: 保存しました")


# ---------------------------------------------------------------------------
# PDF 解析ユーティリティ
# ---------------------------------------------------------------------------

def page_lines(page: pymupdf.Page) -> list[dict]:
    """ページ内のテキスト行を読み順(ベースラインの上から、同じ高さなら左から)で返す。

    数式フォントを含む行は bbox が縦に大きく広がるため、並べ替えには bbox ではなく
    文字のベースライン(origin の y)を使う。
    """
    out = []
    for b in page.get_text("dict")["blocks"]:
        if b.get("type") != 0:
            continue
        for ln in b["lines"]:
            text = "".join(s["text"] for s in ln["spans"])
            if not text.strip():
                continue
            ys = sorted(s["origin"][1] for s in ln["spans"] if s["text"].strip())
            out.append({"bbox": pymupdf.Rect(ln["bbox"]), "text": text, "spans": ln["spans"],
                        "base": ys[len(ys) // 2]})
    out.sort(key=lambda l: l["base"])
    # ベースラインが 2pt 以内の行は同じ行とみなし、左から並べる
    grouped, cur = [], []
    for ln in out:
        if cur and ln["base"] - cur[0]["base"] > 2:
            grouped.extend(sorted(cur, key=lambda l: l["bbox"].x0))
            cur = []
        cur.append(ln)
    grouped.extend(sorted(cur, key=lambda l: l["bbox"].x0))
    return grouped


def is_page_furniture(line: dict, page_h: float) -> bool:
    t = nfkc(line["text"]).strip()
    y = line["bbox"].y0
    if FOOTER_RE.match(t):
        return True
    if y < 140 and (re.fullmatch(r"H[ZY]\s*\d+", t) or "答案用紙記入上の注意" in t
                    or "試験問題" in t or re.match(r"^\d+\s*問\s*\d+\s*時間", t)):
        return True
    return y > page_h - 40


def render_clip(page: pymupdf.Page, clip: pymupdf.Rect) -> Image.Image:
    pix = page.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=clip, colorspace=pymupdf.csGRAY,
                          alpha=False)
    return Image.frombytes("L", (pix.width, pix.height), pix.samples)


def trim(img: Image.Image) -> Image.Image | None:
    a = np.asarray(img)
    mask = a < WHITE_THRESHOLD
    if not mask.any():
        return None
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    y0, y1 = max(rows[0] - PAD, 0), min(rows[-1] + PAD + 1, a.shape[0])
    x0, x1 = max(cols[0] - PAD, 0), min(cols[-1] + PAD + 1, a.shape[1])
    return img.crop((x0, y0, x1, y1))


def has_ink(page: pymupdf.Page, clip: pymupdf.Rect) -> bool:
    """領域に意味のある内容(1行分以上の高さ)があるか。罫線のかけら等は無視する。"""
    if clip.height < 4:
        return False
    img = trim(render_clip(page, clip))
    return img is not None and img.height - 2 * PAD > 10 * ZOOM


def save_png(img: Image.Image, path: Path) -> None:
    # 白黒原稿なので16階調パレットに減色して容量を抑える
    q = img.quantize(colors=16, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    path.parent.mkdir(parents=True, exist_ok=True)
    q.save(path, optimize=True)


# ---------------------------------------------------------------------------
# 問題PDF → 1問ずつの領域
# ---------------------------------------------------------------------------

def find_questions(doc: pymupdf.Document) -> list[dict]:
    heads = []
    pages_info = []
    for pno, page in enumerate(doc):
        lines = page_lines(page)
        ph = page.rect.height
        footer_top = ph - 45
        for ln in lines:
            if FOOTER_RE.match(nfkc(ln["text"]).strip()):
                footer_top = min(footer_top, ln["bbox"].y0)
        furniture_bottom = 30.0
        for ln in lines:
            if is_page_furniture(ln, ph) and ln["bbox"].y0 < 140:
                furniture_bottom = max(furniture_bottom, ln["bbox"].y1)
        pages_info.append({"lines": lines, "footer_top": footer_top, "top": furniture_bottom})
        for ln in lines:
            m = HEADER_RE.match(nfkc(ln["text"]))
            if m and ln["bbox"].x0 < 75:
                # 数式フォントは行の bbox を縦に広げるので、通常フォントの文字から行の上端を求める
                tops = [s["bbox"][1] for s in ln["spans"] if s["text"].strip() and "Math" not in s["font"]]
                ltop = min(tops) if tops else ln["bbox"].y0
                # 見出し行の漢字に付いたルビ(行の直上の小さい文字)も問題に含める
                top = ltop
                for other in lines:
                    ob = other["bbox"]
                    if ob.y0 < ltop and ob.y1 > ltop - 2 and ob.y1 <= ln["bbox"].y1:
                        top = min(top, ob.y0)
                heads.append({"page": pno, "y": top - 1, "kind": m.group(1),
                              "num": int(m.group(2))})
    heads.sort(key=lambda h: (h["page"], h["y"]))

    questions = []
    for i, h in enumerate(heads):
        nxt = heads[i + 1] if i + 1 < len(heads) else None
        page = doc[h["page"]]
        info = pages_info[h["page"]]
        left, right = 36.0, page.rect.width - 30.0
        if nxt and nxt["page"] == h["page"]:
            bottom = nxt["y"] - 3
        else:
            bottom = info["footer_top"] - 3
        parts = [(h["page"], pymupdf.Rect(left, h["y"] - 4, right, bottom))]
        # 次ページ以降へのはみ出し(次の問題見出しより上に内容がある場合)
        last_page = nxt["page"] if nxt else doc.page_count - 1
        for p in range(h["page"] + 1, last_page + 1):
            pinfo = pages_info[p]
            stop = (nxt["y"] - 3) if (nxt and nxt["page"] == p) else pinfo["footer_top"] - 3
            clip = pymupdf.Rect(left, pinfo["top"] + 2, right, stop)
            if has_ink(doc[p], clip):
                parts.append((p, clip))
        questions.append({"kind": h["kind"], "num": h["num"], "parts": parts})
    return questions


def question_text(doc: pymupdf.Document, parts) -> tuple[str, list[dict]]:
    texts, lines_out = [], []
    for pno, clip in parts:
        page = doc[pno]
        for ln in page_lines(page):
            if ln["bbox"].intersects(clip) and not is_page_furniture(ln, page.rect.height):
                if clip.y0 <= ln["base"] <= clip.y1 + 2:
                    texts.append(ln["text"])
                    lines_out.append(ln)
    return "\n".join(texts), lines_out


GOTHIC_HINTS = ("\x83S\x83V\x83b\x83N", "Gothic", "ゴシック")

# 自動判定できない/誤る問題の選択肢数 (問題ID → 選択肢数)。画像を目視確認して記入する。
CHOICE_OVERRIDES = {
    "HZ808-A09": 4,  # 選択肢番号が図のラベルになっている
    "HZ705-A23": 5,  # 同上
    "HZ209-A08": 4,  # 選択肢が真理値表(図)
    "HZ404-A10": 4,  # 同上
}


def _consecutive(nums: set[int]) -> int:
    n = 0
    while n + 1 in nums:
        n += 1
    return n


def count_a_choices(qid: str, text: str, lines: list[dict]) -> tuple[int, str]:
    """A問題の選択肢の数と判定方法を返す。"""
    if qid in CHOICE_OVERRIDES:
        return CHOICE_OVERRIDES[qid], "override"
    t = re.sub(r"\s+", "", nfkc(text))  # 「か\nら」のように語の途中で改行されることがある
    m = re.search(r"下の(?:表の)?1から([3-9])まで", t)
    if m:
        return int(m.group(1)), "text"
    # 無線工学: 選択肢番号は太字(ゴシック体)の数字1文字のスパン
    gothic = set()
    for ln in lines:
        for s in ln["spans"]:
            st = nfkc(s["text"]).strip()
            if re.fullmatch(r"[1-9]", st) and any(g in s["font"] for g in GOTHIC_HINTS):
                gothic.add(int(st))
    n = _consecutive(gothic)
    if n >= 3:
        return n, "gothic"
    return 5, "default"


def b_style(text: str) -> str:
    t = re.sub(r"\s+", "", nfkc(text))
    if re.search(r"(正しいもの|適合するもの|該当するもの|正しい記述)を1", t) or re.search(
            r"(誤っているもの|適合しないもの|該当しないもの|誤った記述)を2", t):
        return "tf"
    return "select"


def check_text_view(item: dict, tv: list[dict], in_images: set) -> None:
    """テキスト表示に選択肢の番号が欠けなく現れているか検査する(取りこぼしの検出)。

    選択肢が式などの画像に入っている場合は文字の番号が1つも現れないので、それは許す。
    一部だけ現れる場合は組み立てに失敗しているので Uncertain にする。
    """
    nums, kana, items = set(), set(), set()
    for b in tv:
        if b["t"] == "p" and b.get("m"):
            m = b["m"]
            if re.fullmatch(r"[0-9]+", m):
                nums.add(int(m))
            elif m in "アイウエオ":
                kana.add(m)
        elif b["t"] == "tbl":
            nums.update(int(r[0]) for r in b["rows"])
        elif b["t"] == "list":
            items.update(int(n) for n, _ in b["items"])
    nums |= {m for m in in_images if isinstance(m, int)} if nums else set()
    kana |= {m for m in in_images if isinstance(m, str)} if kana else set()
    if item["kind"] == "A":
        if nums and nums != set(range(1, item["choices"] + 1)):
            raise textview.Uncertain(f"選択肢番号が欠けている {sorted(nums)}")
    else:
        if kana and kana != set("アイウエオ"):
            raise textview.Uncertain(f"ア〜オの一部が欠けている {sorted(kana)}")
        if item.get("bStyle") == "select" and items and items != set(range(1, 11)):
            raise textview.Uncertain(f"語群の番号が欠けている {sorted(items)}")


def tf_labels(text: str) -> list[str]:
    """正誤式B問題で「1」「2」が何を表すか(ボタンの補助表示用)"""
    t = re.sub(r"\s+", "", nfkc(text))
    if "適合するものを1" in t or "適合しないものを2" in t:
        return ["適合", "不適合"]
    if "該当するものを1" in t or "該当しないものを2" in t:
        return ["該当", "非該当"]
    return ["正", "誤"]


# ---------------------------------------------------------------------------
# 正答PDF
# ---------------------------------------------------------------------------

def parse_answers(path: Path) -> dict:
    doc = pymupdf.open(path)
    page = doc[0]
    rows = []
    for ln in page_lines(page):
        rows.append((ln["bbox"], nfkc(ln["text"]).strip()))
    title = next((t for _, t in rows if re.search(r"令和\s*\d+\s*年\s*\d+\s*月期", t)), "")

    def same_row(a: pymupdf.Rect, b: pymupdf.Rect) -> bool:
        return abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) < 4

    nums = [(r, t) for r, t in rows if re.fullmatch(r"\d{1,2}", t)]
    a_ans, a_rows = {}, {}
    for r, t in rows:
        m = re.fullmatch(r"〔\s*A\s*-\s*(\d+)\s*〕", t)
        if not m:
            continue
        cands = [(nr.x0 - r.x1, int(nt)) for nr, nt in nums if same_row(nr, r) and nr.x0 > r.x1
                 and nr.x0 - r.x1 < 150]
        if not cands:
            raise ValueError(f"{path.name}: A-{m.group(1)} の正答が見つかりません")
        a_ans[int(m.group(1))] = min(cands)[1]
        a_rows[int(m.group(1))] = r

    kana_rows = []
    for r, t in rows:
        if t in ("ア", "イ", "ウ", "エ", "オ"):
            cands = [(nr.x0 - r.x1, int(nt)) for nr, nt in nums if same_row(nr, r) and nr.x0 > r.x1
                     and nr.x0 - r.x1 < 150]
            if not cands:
                raise ValueError(f"{path.name}: B問題 {t} の正答が見つかりません")
            kana_rows.append((r.y0, t, min(cands)[1]))
    kana_rows.sort()
    b_labels = sorted(int(re.fullmatch(r"〔\s*B\s*-\s*(\d+)\s*〕", t).group(1))
                      for _, t in rows if re.fullmatch(r"〔\s*B\s*-\s*(\d+)\s*〕", t))
    if len(kana_rows) != 5 * len(b_labels):
        raise ValueError(f"{path.name}: B問題の行数が合いません ({len(kana_rows)} / {len(b_labels)})")
    b_ans = {}
    for i, bn in enumerate(b_labels):
        chunk = kana_rows[i * 5:(i + 1) * 5]
        if [k for _, k, _ in chunk] != ["ア", "イ", "ウ", "エ", "オ"]:
            raise ValueError(f"{path.name}: B-{bn} の小設問の並びが不正です")
        b_ans[bn] = [v for _, _, v in chunk]

    # 「※誤植により全員正解とした。」等の注記: ※ 記号と同じ行の A 問題を対象とする
    all_correct = {}
    note = next((t for _, t in rows if t.startswith("※") and len(t) > 2), None)
    for r, t in rows:
        if t == "※":
            for n, ar in a_rows.items():
                if same_row(ar, r):
                    all_correct[n] = note or "※ 全員正解として処理"
    return {"title": title, "A": a_ans, "B": b_ans, "allCorrect": all_correct}


# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

def session_of(code: str) -> dict:
    y, mm = int(code[2]), int(code[3:5])
    note = SESSION_NOTES.get(code[2:5])
    label = f"令和{y}年{mm}月期" + (f"（{note}）" if note else "")
    return {"id": f"R{y}-{mm:02d}", "label": label, "reiwa": y, "year": 2018 + y, "month": mm,
            "sort": (2018 + y) * 100 + mm}


def norm_for_compare(text: str) -> str:
    t = nfkc(text)
    t = re.sub(r"^\s*[AB]\s*-\s*\d+", "", t)
    return re.sub(r"\s+", "", t)


def build(clean: bool) -> None:
    codes = sorted({p.stem for p in PDF_DIR.glob("H[ZY][0-9][0-9][0-9].pdf")})
    if not codes:
        sys.exit("source-pdf/ にPDFがありません。--download を付けて実行してください。")
    if clean and IMG_DIR.exists():
        for f in IMG_DIR.rglob("*.png"):
            f.unlink()

    sessions, questions = {}, []
    tv_skipped: list[tuple[str, str]] = []
    for code in codes:
        kp = PDF_DIR / f"{code}-kaito.pdf"
        if not kp.exists():
            print(f"{code}: 正答PDFがないためスキップ")
            continue
        subject = PREFIX_TO_SUBJECT[code[:2]]
        ses = session_of(code)
        sessions.setdefault(ses["id"], {**ses, "codes": {}})["codes"][subject] = code
        doc = pymupdf.open(PDF_DIR / f"{code}.pdf")
        ans = parse_answers(kp)
        qs = find_questions(doc)
        n_a = sum(1 for q in qs if q["kind"] == "A")
        n_b = sum(1 for q in qs if q["kind"] == "B")
        if (n_a, n_b) != (len(ans["A"]), len(ans["B"])):
            raise ValueError(f"{code}: 問題数({n_a}/{n_b})と正答数({len(ans['A'])}/{len(ans['B'])})が不一致")
        print(f"{code} {ses['label']} {SUBJECTS[subject]['label']}: A{n_a}問 B{n_b}問")

        for q in qs:
            qid = f"{code}-{q['kind']}{q['num']:02d}"
            images = []
            for idx, (pno, clip) in enumerate(q["parts"]):
                img = trim(render_clip(doc[pno], clip))
                if img is None:
                    continue
                name = f"{q['kind']}{q['num']:02d}" + (f"_{idx + 1}" if idx else "") + ".png"
                rel = f"data/img/{code}/{name}"
                save_png(img, ROOT / rel)
                images.append({"src": rel, "w": img.width, "h": img.height})
            text, lines = question_text(doc, q["parts"])
            item = {
                "id": qid, "session": ses["id"], "subject": subject, "code": code,
                "kind": q["kind"], "num": q["num"], "label": f"{q['kind']}-{q['num']}",
                "images": images, "text": nfkc(text),
            }
            if q["kind"] == "A":
                n, how = count_a_choices(qid, text, lines)
                if how == "default":
                    print(f"  要確認 {qid}: 選択肢数を判定できないため5としました"
                          "(CHOICE_OVERRIDES で指定できます)")
                answer = ans["A"][q["num"]]
                if answer > n:
                    print(f"  注意 {qid}: 選択肢数 {n} < 正答 {answer} → {answer} に補正")
                    n = max(n, answer)
                item.update({"choices": n, "answer": answer})
                if q["num"] in ans["allCorrect"]:
                    item["allCorrect"] = ans["allCorrect"][q["num"]]
            else:
                style = b_style(text)
                answers = ans["B"][q["num"]]
                if style == "tf" and max(answers) > 2:
                    raise ValueError(f"{qid}: 正誤式と判定したが正答に3以上がある {answers}")
                item.update({"bStyle": style, "choices": 2 if style == "tf" else 10,
                             "answer": answers})
                if style == "tf":
                    item["tfLabels"] = tf_labels(text)
            item["genre"] = classify(subject, q["kind"], q["num"], item["text"], qid)

            # スマホ向けのテキスト表示(作れない問題は画像表示のみ)
            def save_tv(img, tag, code=code, q=q):
                name = f"{q['kind']}{q['num']:02d}_{tag}.png"
                rel = f"data/img/{code}/{name}"
                save_png(img, ROOT / rel)
                return rel, img.width, img.height
            try:
                tv, in_images = textview.build(doc, q["parts"], LABEL_RE, save_tv)
                check_text_view(item, tv, in_images)
                item["tv"] = tv
            except textview.Uncertain as e:
                tv_skipped.append((qid, str(e)))
            questions.append(item)

    # 類似問題(過去の別の回に同じ/ほぼ同じ問題がある)を検出
    by_subj: dict[str, list[dict]] = {}
    for q in questions:
        by_subj.setdefault(q["subject"], []).append(q)
    for subj_qs in by_subj.values():
        normed = [norm_for_compare(q["text"]) for q in subj_qs]
        for i, qi in enumerate(subj_qs):
            sims = []
            for j, qj in enumerate(subj_qs):
                if i == j or qi["session"] == qj["session"] or qi["kind"] != qj["kind"]:
                    continue
                a, b = normed[i], normed[j]
                if abs(len(a) - len(b)) > 0.25 * max(len(a), len(b), 1):
                    continue
                r = difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()
                if r >= 0.85:
                    sims.append(qj["id"])
            if sims:
                qi["similar"] = sims

    sess_list = sorted(sessions.values(), key=lambda s: s["sort"])
    out = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "name": "公益財団法人日本無線協会「試験問題と解答」",
            "url": OFFICIAL_PAGE,
            "terms": "英語の科目を除き、国家試験の受験など試験制度の意義に反しない場合に限り、公表されている過去の試験問題を無償で問題集等に使用することができる（同協会ウェブサイトより）。",
        },
        "subjects": {k: {kk: v[kk] for kk in ("label", "full", "pass", "minutes")}
                     for k, v in SUBJECTS.items()},
        "genres": GENRES,
        "sessions": [{k: s[k] for k in ("id", "label", "year", "month", "codes")} for s in sess_list],
        "questions": questions,
    }
    print_explain_stats(explain.attach(questions, EXPL_DIR))
    write_json(out)
    n_tv = sum(1 for q in questions if q.get("tv"))
    print(f"→ data/questions.json: {len(sess_list)}回分 {len(questions)}問（テキスト表示あり {n_tv}問）")
    for qid, why in tv_skipped:
        print(f"  テキスト表示なし {qid}: {why}")


def write_json(out: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    questions = out["questions"]
    # 1問1行で書き出す(容量を抑えつつ git の差分を読みやすくする)
    qs_json = ",\n".join(json.dumps(q, ensure_ascii=False, separators=(",", ":")) for q in questions)
    head = {k: v for k, v in out.items() if k != "questions"}
    body = json.dumps(head, ensure_ascii=False, separators=(",", ":"))[:-1]
    (DATA_DIR / "questions.json").write_text(f'{body},"questions":[\n{qs_json}\n]}}\n', encoding="utf-8")
    json.loads((DATA_DIR / "questions.json").read_text(encoding="utf-8"))  # 書式の自己検証


def print_explain_stats(st: dict) -> None:
    print(f"解説: 正しい文(自動) {st['fill']}問 / 符号の読み(自動) {st['morse']}問 / "
          f"手書き {st['exp']}問 / 解説なし {st['none']}問")
    print(f"法改正で現在の規定と食い違う問題: {st['outdated']}問 / 用語などが改正された問題(答えは同じ): {st['amended']}問")
    for k in st["unknown_ids"]:
        print(f"  注意: explanations にある {k} に対応する問題がありません")


def refresh_explanations() -> None:
    """画像は作り直さず、解説だけを data/questions.json に入れ直す"""
    out = json.loads((DATA_DIR / "questions.json").read_text(encoding="utf-8"))
    print_explain_stats(explain.attach(out["questions"], EXPL_DIR))
    write_json(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download", action="store_true", help="公式サイトから最新のPDFを取得する")
    ap.add_argument("--no-clean", action="store_true", help="既存の画像を削除せずに上書きする")
    ap.add_argument("--explain-only", action="store_true", help="解説(explanations/)だけを取り込み直す")
    args = ap.parse_args()
    if args.explain_only:
        refresh_explanations()
        return
    if args.download:
        print("公式サイトからPDFを取得します…")
        download_official()
    build(clean=not args.no_clean)


if __name__ == "__main__":
    main()
