# P&ID 繪製慣例自動判定
#
# 為什麼需要：台灣沒有普遍採用的 CNS P&ID 國家標準，實務順序是
# 業主標準 > EPC 標準 > 授權商標準。中油、台塑、台聚、長春各有內部規範，
# 日商建的廠留下 JIS 風格，中小廠常是設備商各畫各的。
#
# 一份 rules 打天下會在第二個客戶就破功。先判出這張圖走哪套慣例，
# 才知道該套哪份規範——而且要自動判，不是每個客戶手動設定。
# （產品化的定義：第十個客戶要比第一個客戶便宜十倍。）
from __future__ import annotations

import re
from collections import Counter

# 標題欄常見字樣 → 慣例線索
_TITLE_HINTS = [
    (r"PIPING\s*&?\s*INSTRUMENT", "圖名採 Piping & Instrument Diagram/Flow Diagram"),
    (r"PROCESS\s*FLOW", "此圖為 PFD 而非 P&ID，符號集較簡略"),
    (r"UOP|LUMMUS|EXXON|SHELL|KBR|FLUOR|BECHTEL", "美系授權商／EPC"),
    (r"JGC|CHIYODA|TOYO|MITSUBISHI|MITSUI", "日系 EPC"),
    (r"LINDE|TECHNIP|BASF|THYSSEN", "歐系 EPC"),
]

# 單位制線索（P&ID 上的口徑標註）
_IMPERIAL = re.compile(r'\d+\s*(?:\d+/\d+)?\s*"|\bNPS\b|\bSCH\s*\d+')
_METRIC = re.compile(r"\bDN\s*\d+|\d+\s*mm\b")


def detect(tags: list, equips: list, title_text: str = "",
           notes_text: str = "", bubble_kinds: dict | None = None) -> dict:
    """依位號結構、設備編碼、標題欄與單位標註判定繪製慣例。

    回傳 {profile, confidence, findings[]}；每條 finding 都附證據，
    沿用 evidence 格式讓判定可稽核、可被工程師推翻。
    """
    f: list = []
    blob = (title_text + " " + notes_text).upper()

    # ── 儀錶位號結構：字母數＋迴路號位數 ───────────────────────────
    shape = Counter()
    for t in tags:
        m = re.match(r"^([A-Z]{1,5})[\s-]?(\d{2,6})([A-Z]?)$", (t or "").strip().upper())
        if m:
            shape[(len(m.group(1)), len(m.group(2)))] += 1
    loop_digits = 0
    if shape:
        (_letters, loop_digits), n = shape.most_common(1)[0]
        f.append({
            "stage": "儀錶位號結構", "ok": True, "score": min(1.0, n / max(len(tags), 1)),
            "detail": f"主流形式為「功能字母＋{loop_digits} 位迴路號」（{n}/{len(tags)} 項）"
                      + ("，5 位數多見於大型石化廠的單元＋序號複合編碼"
                         if loop_digits >= 5 else "，3 位數為中小型裝置常見")})

    # ── 功能字母是否符合 ISA 5.1 ────────────────────────────────
    from .pid_vlm import ISA_FN, ISA_VAR

    ok_letters = bad = 0
    for t in tags:
        m = re.match(r"^([A-Z]{1,5})", (t or "").upper())
        if not m:
            continue
        s = m.group(1)
        if s[0] in ISA_VAR and all(c in ISA_FN or c in "HL" for c in s[1:]):
            ok_letters += 1
        else:
            bad += 1
    tot = ok_letters + bad
    if tot:
        ratio = ok_letters / tot
        f.append({
            "stage": "ISA 5.1 位號文法", "ok": ratio >= 0.85, "score": round(ratio, 2),
            "detail": f"{ok_letters}/{tot}（{ratio:.0%}）的功能字母符合 ISA 5.1 量測變數＋"
                      f"功能字母組合" + ("，可判定採 ISA 位號文法" if ratio >= 0.85
                                       else "，比例偏低，可能採自訂或他系文法")})

    # ── 設備位號編碼 ─────────────────────────────────────────
    if equips:
        pfx = Counter(t[0] for t in equips if t)
        fam = Counter(re.search(r"(\d)\d{2}$", t).group(1)
                      for t in equips if re.search(r"(\d)\d{2}$", t))
        f.append({
            "stage": "設備編碼", "ok": True, "score": 0.8,
            "detail": f"首字母分布 {dict(pfx)}；序號族 {dict(fam)}"
                      + ("，同族集中代表單一單元編碼" if len(fam) <= 2 else
                         "，多族並存可能跨單元或含誤讀")})

    # ── 氣泡形狀（ISA 5.1 的執行位置語意）──────────────────────
    if bubble_kinds:
        has_sq = bubble_kinds.get("盤面/DCS", 0)
        has_hex = bubble_kinds.get("DCS運算", 0)
        f.append({
            "stage": "氣泡符號集", "ok": bool(has_sq or has_hex), "score": 0.9,
            "detail": (f"出現方框圓（DCS 共用顯示）{has_sq} 個、六角（電腦功能）{has_hex} 個"
                       "，屬 ISA 5.1 (2009) 執行位置符號體系"
                       if (has_sq or has_hex) else
                       "未見方框圓或六角，可能為 1984 舊版 ISA 或簡化圖")})

    # ── 單位制 ──────────────────────────────────────────────
    imp = len(_IMPERIAL.findall(blob))
    met = len(_METRIC.findall(blob))
    if imp or met:
        f.append({
            "stage": "單位制", "ok": True, "score": 0.7,
            "detail": (f"英制標註 {imp} 處、公制 {met} 處 → "
                       + ("英制為主（美系設計慣例）" if imp > met else "公制為主（歐日系慣例）"))})

    # ── 標題欄／註記線索 ────────────────────────────────────
    for pat, why in _TITLE_HINTS:
        if re.search(pat, blob):
            f.append({"stage": "標題欄線索", "ok": True, "score": 0.6, "detail": why})

    if re.search(r"[一-鿿]", notes_text):
        f.append({"stage": "註記語言", "ok": True, "score": 0.8,
                  "detail": "圖面註記為中文 → 在地業主自行維護的圖，"
                            "註記常含 MOC 變更履歷，判讀時務必納入"})

    # ── 綜合 ────────────────────────────────────────────────
    # PFD 判定：沒有 ISA 儀錶位號、但有大量純數字項次號 → 製程流程圖而非 P&ID。
    # 這兩類要用完全不同的規範：P&ID 靠 ISA 字母碼解碼語意，
    # PFD 的項次號本身不帶語意，語意在圖面的設備清單表裡。
    item_no = sum(1 for t in tags if re.fullmatch(r"\d{3}(\.\d)?", (t or "").strip()))
    if not tags and item_no == 0:
        # 連候選 tag 都沒有時，用原始文字再看一次有沒有項次號樣態
        item_no = sum(1 for w in re.findall(r"\b\d{3}(?:\.\d)?\b", blob))

    isa = next((x for x in f if x["stage"] == "ISA 5.1 位號文法"), None)
    isa_ok = bool(isa and isa["score"] >= 0.85)

    if not isa_ok and item_no >= 8:
        f.append({"stage": "圖種判定", "ok": True, "score": 0.8,
                  "detail": f"未見 ISA 功能字母位號，但有 {item_no} 個純數字項次號樣態"
                            "（3 碼可帶小數分項）→ 研判為 PFD 製程流程圖，"
                            "語意須由圖面設備清單表對照，不可套用 ISA 字母碼解碼"})
        return {"profile": "PFD 製程流程圖（設備項次號 ＋ 清單表對照）",
                "rules_file": "pfd.json", "confidence": 0.75,
                "loop_digits": loop_digits, "findings": f}

    if isa_ok:
        profile = "ISA 5.1 位號文法 ＋ 業主自訂編碼"
        rules, conf = "default.json", round(min(0.95, 0.5 + isa["score"] * 0.5), 2)
    elif isa:
        profile = "非 ISA 主流（自訂或他系文法），建議人工指定規範"
        rules, conf = "", 0.4
    else:
        profile = "資訊不足，無法判定"
        rules, conf = "", 0.2
    return {"profile": profile, "rules_file": rules, "confidence": conf,
            "loop_digits": loop_digits, "findings": f}
