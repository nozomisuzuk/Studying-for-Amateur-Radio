#!/usr/bin/env python3
"""法規の問題が引用している条文が、出題後に改正されていないかを調べる。

e-Gov 法令API v2 から「試験の月に施行されていた版」と「現行版」の法令本文を取り寄せ、
各問題の「電波法（第24条、第78条及び第113条）」のような引用から条文を取り出して比べる。
改正があった問題について、改正前後の文を並べたレポートを書き出す。
レポートを読んで、答えや記述に影響するものを explanations/outdated.md に書く(手作業)。

使い方:
    python3 tools/lawcheck.py [キャッシュディレクトリ(既定: .lawcache)] [レポート(既定: lawcheck.txt)]

国際法規(無線通信規則・国際電気通信連合憲章)は e-Gov に無いので対象外。
"""
from __future__ import annotations

import base64
import difflib
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://laws.e-gov.go.jp/api/2"
LAWS = {  # 問題文での法令名: (キャッシュ名, 法令ID)
    "電波法施行規則": ("sekokisoku", "325M50080000014"),
    "電波法施行令": ("sekorei", "413CO0000000245"),
    "電波法": ("denpa", "325AC0000000131"),
    "無線局運用規則": ("unyo", "325M50080000017"),
    "無線設備規則": ("setsubi", "325M50080000018"),
    "無線従事者規則": ("jujisha", "402M50001000018"),
    "無線局免許手続規則": ("menkyo", "325M50080000015"),
    "開設の根本的基準": ("konpon", "325M50080000012"),
    "登録検査等事業者等規則": ("toroku", "409M50001000076"),
}
DIGITS = "〇一二三四五六七八九"


def fetch_json(url: str) -> dict:
    for k in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ama1-drill-lawcheck/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            print("  再試行", k + 1, e)
            time.sleep(2 ** (k + 1))
    raise RuntimeError(f"取得できません: {url}")


def kanji_num(n: int) -> str:
    s = ""
    if n >= 100:
        h, n = divmod(n, 100)
        s += ("" if h == 1 else DIGITS[h]) + "百"
    if n >= 10:
        t, n = divmod(n, 10)
        s += ("" if t == 1 else DIGITS[t]) + "十"
    if n:
        s += DIGITS[n]
    return s


def article_key(a: int, sub: str | None = None, sub2: str | None = None) -> str:
    k = f"第{kanji_num(a)}条"
    if sub:
        k += f"の{kanji_num(int(sub))}"
    if sub2:
        k += f"の{kanji_num(int(sub2))}"
    return k


def session_date(session_id: str) -> str:
    """「R7-11」→ 試験の月の1日(この日に施行されていた版を出題時点の法令とみなす)"""
    m = re.fullmatch(r"R(\d+)-(\d+)", session_id)
    return f"{2018 + int(m.group(1))}-{int(m.group(2)):02d}-01"


def parse_articles(xml: str) -> dict[str, str]:
    root = ET.fromstring(xml)
    body = root.find("LawBody")
    res = {}
    for art in body.find("MainProvision").iter("Article"):
        title = art.find("ArticleTitle")
        lines = []
        for el in art.iter():
            if el.tag in ("ParagraphSentence", "ItemSentence", "Subitem1Sentence", "Subitem2Sentence",
                          "Subitem3Sentence", "TableStruct"):
                lines.append("".join(el.itertext()).strip())
            elif el.tag in ("ParagraphNum", "ItemTitle", "Subitem1Title", "Subitem2Title"):
                t = "".join(el.itertext()).strip()
                if t:
                    lines.append(f"[{t}]")
        res["".join(title.itertext()) if title is not None else "?"] = "\n".join(lines)
    for i, ap in enumerate(body.findall("AppdxTable")):
        title = ap.find("AppdxTableTitle")
        res["別表:" + ("".join(title.itertext()) if title is not None else str(i))] = "".join(ap.itertext())
    return res


def load_versions(cache: Path, sessions: list[str]) -> dict:
    """{キャッシュ名: {試験回 or "current": 条文の辞書}}"""
    cache.mkdir(parents=True, exist_ok=True)
    out = {}
    for name, lid in LAWS.values():
        revs = [r for r in fetch_json(f"{API}/law_revisions/{lid}")["revisions"] if r.get("amendment_enforcement_date")]
        revs.sort(key=lambda r: r["amendment_enforcement_date"])
        pick = {}
        for s in sessions:
            before = [r for r in revs if r["amendment_enforcement_date"] <= session_date(s)]
            if before:
                pick[s] = before[-1]["law_revision_id"]
        cur = [r for r in revs if r.get("current_revision_status") == "CurrentEnforced"]
        pick["current"] = (cur[-1] if cur else revs[-1])["law_revision_id"]
        texts = {}
        for rid in set(pick.values()):
            f = cache / f"{rid}.json"
            if not f.exists():
                data = fetch_json(f"{API}/law_data/{rid}?law_full_text_format=xml")
                xml = base64.b64decode(data["law_full_text"]).decode("utf-8")
                f.write_text(json.dumps(parse_articles(xml), ensure_ascii=False), encoding="utf-8")
                print("取得", rid)
                time.sleep(1)
            texts[rid] = json.loads(f.read_text(encoding="utf-8"))
        out[name] = {s: (rid, texts[rid]) for s, rid in pick.items()}
    return out


def citations(text: str) -> list[tuple[str, str]]:
    t = re.sub(r"\s+", "", text)
    names = "|".join(sorted(LAWS, key=len, reverse=True))
    out = []
    for m in re.finditer(rf"({names})[（(]([^）)]*)[）)]", t):
        law = LAWS[m.group(1)][0]
        inner = m.group(2)
        for r in re.finditer(r"第(\d+)条(?:の(\d+))?(?:の(\d+))?(?:から第(\d+)条まで)?", inner):
            if r.group(4):
                out += [(law, article_key(x)) for x in range(int(r.group(1)), int(r.group(4)) + 1)]
            else:
                out.append((law, article_key(int(r.group(1)), r.group(2), r.group(3))))
        for r in re.finditer(r"別表第(\d+)号", inner):
            out.append((law, f"別表第{kanji_num(int(r.group(1)))}号"))
    return list(dict.fromkeys(out))


def article(texts: dict, key: str) -> str | None:
    if key in texts:
        return texts[key]
    if key.startswith("別表"):
        return next((v for k, v in texts.items() if k.startswith("別表:" + key)), None)
    return None


def sentences(t: str) -> list[str]:
    return [s for s in re.split(r"(?<=。)|\n", t or "") if s.strip()]


def main() -> None:
    cache = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".lawcache"
    report = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "lawcheck.txt"
    data = json.loads((ROOT / "data" / "questions.json").read_text(encoding="utf-8"))
    sessions = sorted({q["session"] for q in data["questions"] if q["subject"] == "hoki"})
    versions = load_versions(cache, sessions)
    lines, changed, nocite = [], [], []
    for q in data["questions"]:
        if q["subject"] != "hoki":
            continue
        cites = citations(q["text"])
        if not cites:
            nocite.append(q["id"])
            continue
        diffs = []
        for law, key in cites:
            if q["session"] not in versions[law]:
                continue
            old_rid, old_texts = versions[law][q["session"]]
            cur_rid, cur_texts = versions[law]["current"]
            old, new = article(old_texts, key), article(cur_texts, key)
            if old is None or new is None or re.sub(r"\s+", "", old) == re.sub(r"\s+", "", new):
                continue
            d = [x for x in difflib.unified_diff(sentences(old), sentences(new), lineterm="", n=0)
                 if not x.startswith(("---", "+++", "@@"))]
            diffs.append(f"--- {law} {key}  [{old_rid.split('_')[1]} → {cur_rid.split('_')[1]}]")
            diffs += ["  " + x[:400] for x in d]
        if diffs:
            changed.append(q["id"])
            lines += ["=" * 80, f"{q['id']} ({q['session']}) 正答 {q['answer']}"] + diffs
    report.write_text("\n".join(lines), encoding="utf-8")
    print(f"引用条文が改正された問題: {len(changed)}問 → {report}")
    print(f"国内法令の引用がない問題(国際法規など、対象外): {len(nocite)}問")


if __name__ == "__main__":
    main()
