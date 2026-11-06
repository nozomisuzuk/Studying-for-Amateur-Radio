"""ジャンル(分野)の定義と自動分類ルール。

無線工学: 問題文の主題部分のキーワードで分類し、該当がなければ出題番号(試験は分野順に並ぶ)で推定する。
法規    : 問題文に必ず引用される条文(「電波法(第28条)」など)から分類する。
分類を手で直したい問題は OVERRIDES に問題ID → ジャンルIDで書く。
"""
from __future__ import annotations

import re

GENRES = {
    "kogaku": [
        {"id": "k-butsuri", "label": "電気物理"},
        {"id": "k-kairo", "label": "電気回路"},
        {"id": "k-handotai", "label": "半導体・電子部品"},
        {"id": "k-denshi", "label": "電子回路"},
        {"id": "k-soshin", "label": "送信機・変調"},
        {"id": "k-jushin", "label": "受信機・復調"},
        {"id": "k-dengen", "label": "電源"},
        {"id": "k-antenna", "label": "空中線・給電線"},
        {"id": "k-denpa", "label": "電波伝搬"},
        {"id": "k-sokutei", "label": "測定"},
        {"id": "k-shogai", "label": "電波障害・電波防護"},
    ],
    "hoki": [
        {"id": "h-soku", "label": "総則・用語の定義"},
        {"id": "h-menkyo", "label": "無線局の免許"},
        {"id": "h-setsubi", "label": "無線設備"},
        {"id": "h-jujisha", "label": "無線従事者"},
        {"id": "h-unyo", "label": "運用"},
        {"id": "h-morse", "label": "無線電信・モールス符号"},
        {"id": "h-kantoku", "label": "監督・罰則・電波利用料"},
        {"id": "h-kokusai", "label": "国際法規"},
    ],
}

# 自動分類が不適切だった問題の手動補正 (問題ID → ジャンルID)
OVERRIDES: dict[str, str] = {
    "HZ805-A11": "k-soshin",   # 電力増幅器の利得(整合器の挿入損失を含む)
    "HZ805-A21": "k-antenna",  # 半波長ダイポールと八木アンテナの相対利得
    "HZ808-A21": "k-antenna",  # 1/4波長垂直接地アンテナの放射電力
}

# ---------------------------------------------------------------- 無線工学
# 上から順に判定し、最初に当たったジャンルにする(主題部分の文字列に対して)
KOGAKU_RULES: list[tuple[str, str]] = [
    ("k-shogai", r"電波障害|高調波発射を防止|不要な発射と対策|電波の強度に対する安全|電波防護|TVI|BCI"),
    ("k-sokutei", r"測定(方法|法|原理|回路|器|の|する|した|につ|範囲)|計器|電流計|電圧計|周波数計|周波数カウンタ|"
                  r"標準信号発生器|オシロスコープ|リサジュー|電力計|ブリッジ|指示値"),
    ("k-denpa", r"伝搬|電離層|見通し距離|等価地球半径|フェージング|デリンジャ|MUF|臨界周波数|電界強度|電波雑音|"
                r"跳躍距離|対流圏|ダクト"),
    ("k-antenna", r"アンテナ|空中線|給電線|バラン|平衡-不平衡|整合回路|整合器|導波管|定在波比|反射係数|放射抵抗|"
                  r"同軸ケーブル|特性インピーダンス|スタック"),
    ("k-dengen", r"整流|定電圧|蓄電池|太陽電池|スイッチング電源|DC-DC|チョッパ|平滑回路|浮動充電|電源回路|"
                 r"電圧安定化|リプル"),
    ("k-jushin", r"受信機|復調|検波|中間周波|影像周波数|AGC|混変調|相互変調|感度抑圧|スレッショルド|振幅制限器|"
                 r"SDR|信号対雑音比|雑音指数|スケルチ|RTTY|高周波増幅部"),
    ("k-soshin", r"送信機|変調|周波数偏移|SSB|側波帯|スプリアス|電力増幅|π形結合|占有周波数帯幅|デジタル通信|"
                 r"デジタル信号|標本化|量子化|搬送波"),
    ("k-denshi", r"増幅回路|増幅器|演算増幅|オペアンプ|発振回路|発振器|論理回路|真理値表|タイムチャート|PLL|"
                 r"位相同期|エミッタホロワ|帰還|フリップフロップ|電圧利得"),
    ("k-handotai", r"ダイオード|トランジスタ|FET|電界効果|サイリスタ|サーミスタ|半導体|電子管|マグネトロン|"
                   r"クライストロン|進行波管|サージ防護"),
    ("k-kairo", r"直流回路|交流回路|共振|過渡現象|フィルタ|デシベル|ブリッジ回路|RLC|力率|皮相電力|有効電力|"
                r"交流電圧|交流電流"),
    ("k-butsuri", r"磁気|磁束|磁界|電磁誘導|静電|電界|コンデンサ|コイル|インダクタンス|抵抗器|電気現象|法則|"
                  r"電荷|導体|ホール効果|ゼーベック|ペルチエ"),
    ("k-kairo", r"回路において|インピーダンス|抵抗R"),
]

# 出題番号による推定(キーワードに該当しないとき)
KOGAKU_POSITION_A = (
    ["k-butsuri"] * 3 + ["k-kairo"] * 3 + ["k-handotai"] * 2 + ["k-denshi"] * 2 + ["k-soshin"] * 3
    + ["k-jushin"] * 2 + ["k-dengen"] * 3 + ["k-antenna"] * 3 + ["k-denpa"] * 2 + ["k-sokutei"] * 2
)
KOGAKU_POSITION_B = ["k-butsuri", "k-denshi", "k-jushin", "k-antenna", "k-sokutei"]


def topic_part(text: str) -> str:
    """問題文から主題部分(「下の番号から選べ」等の指示より前)を取り出す。"""
    t = re.sub(r"\s+", "", text)
    t = re.sub(r"^[AB]-?\d+", "", t)
    for stop in ("内に入れる", "このうち", "下の番号", "下の1から", "として、正しい", "として、最も",
                 "として、誤", "の値として"):
        i = t.find(stop)
        if i > 10:
            t = t[:i]
            break
    return t[:160]


def classify_kogaku(kind: str, num: int, text: str) -> str:
    topic = topic_part(text)
    for gid, pat in KOGAKU_RULES:
        if re.search(pat, topic):
            return gid
    # 主題部分で決まらなければ本文全体の先頭部分でもう一度
    head = re.sub(r"\s+", "", text)[:300]
    for gid, pat in KOGAKU_RULES:
        if re.search(pat, head):
            return gid
    table = KOGAKU_POSITION_A if kind == "A" else KOGAKU_POSITION_B
    return table[min(num, len(table)) - 1]


# ---------------------------------------------------------------- 法規
LAW_RE = re.compile(
    r"(電波法施行規則|無線設備規則|無線局運用規則|無線局免許手続規則|無線従事者規則|無線通信規則|"
    r"国際電気通信連合憲章|国際電気通信連合条約|電波法)\s*[\(（]\s*第\s*(\d+)\s*条")


def _denpaho(article: int) -> str:
    if article <= 3:
        return "h-soku"
    if article <= 27:
        return "h-menkyo"
    if article <= 38:
        return "h-setsubi"
    if article <= 51:
        return "h-jujisha"
    if article <= 70:
        return "h-unyo"
    return "h-kantoku"  # 71〜82 監督, 99の11〜104 雑則(電波利用料), 105〜 罰則


def _sekoukisoku(article: int) -> str:
    if article <= 2:
        return "h-soku"
    if article <= 9:
        return "h-menkyo"  # 無線局の限界・免許を要しない無線局など
    if article <= 33:
        return "h-setsubi"  # 周波数測定装置・安全施設など
    return "h-menkyo"     # 免許状・業務書類など


def classify_hoki(kind: str, num: int, text: str) -> str:
    t = re.sub(r"\s+", "", text)
    head = t[:260]
    # 主題部分 = 「〜の規定に照らし」より前(選択肢の文言に引きずられないように)
    i = head.find("規定に照らし")
    topic = head[:i] if i > 0 else head[:150]
    if re.search(r"モールス符号|略符号|Q符号|無線電信", topic):
        return "h-morse"
    if re.search(r"無線通信規則|国際電気通信連合", topic):
        return "h-kokusai"
    if re.search(r"無線従事者規則", topic) or re.match(r"[AB]-?\d+(次の記述は、)?無線従事者の(免許|選解任)", head):
        return "h-jujisha"
    if re.search(r"指向特性|電波の型式", topic):
        return "h-setsubi"
    if re.search(r"検査の結果について", topic):
        return "h-kantoku"
    for law, art in LAW_RE.findall(head):
        a = int(art)
        if law == "電波法":
            return _denpaho(a)
        if law == "電波法施行規則":
            return _sekoukisoku(a)
        if law == "無線設備規則":
            return "h-setsubi"
        if law == "無線局運用規則":
            return "h-unyo"
        if law == "無線局免許手続規則":
            return "h-menkyo"
    return "h-unyo"


def classify(subject: str, kind: str, num: int, text: str, qid: str | None = None) -> str:
    if qid and qid in OVERRIDES:
        return OVERRIDES[qid]
    if subject == "kogaku":
        return classify_kogaku(kind, num, text)
    return classify_hoki(kind, num, text)
