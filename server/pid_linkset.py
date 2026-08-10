# 跨圖串接 — 把一疊單張圖變成一座廠
#
# 單張 P&ID/PFD 是孤島。真實廠區的物料從 A 圖流到 B 圖，控制訊號從 C 圖
# 拉到 D 圖；只解析單張，永遠回答不了「這條線最後去哪」「這台泵歸誰控」。
# Stage 2 的資料庫要的是整座廠，不是一疊互不相識的圖。
#
# 三種接續證據（互相獨立，可交叉驗證）：
#   ① 跨圖接續標記 OPC：圖上明確標「往 070-2 第 01 接點」
#   ② 圖號序列：同廠同系統的圖號連號（R-M0200 / M0300 / M0400）
#   ③ 共用編號：同一條線號或同一個設備位號出現在兩張圖上
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

# ① OPC 標記。台化格式 070-2/01＝去 C12070-2 圖的第 01 接點。
OPC_SLASH = re.compile(r"^(\d{2,4}-\d{1,2})/(\d{1,2}[A-Z]?)$")
# 中文流向註記：TO: 混合及燒結系統 / FROM 313 / TO TATORAY CHARGE PUMP
OPC_TEXT = re.compile(r"\b(TO|FROM)[:：\s]+([A-Z0-9一-鿿][^\n]{1,28})", re.I)

# ② 圖號序列：R-M0200-00-000-000-00 → 族 R-M, 序 0200
DWG_SERIES = re.compile(r"^([A-Z]+)-?([A-Z]?)(\d{3,5})", re.I)


def parse_dwg_no(stem: str) -> tuple | None:
    """圖號 → (族, 序號)。同族不同序＝同一套圖，可能互相接續。"""
    m = DWG_SERIES.match(stem.strip().upper())
    if not m:
        return None
    return (m.group(1) + m.group(2), m.group(3))


def extract_links(stem: str, words: list) -> dict:
    """單張圖的接續證據抽取。words 為該圖 OCR 出的所有文字。"""
    opc, flow = [], []
    for w in words:
        t = (w or "").replace(" ", "")
        m = OPC_SLASH.match(t)
        if m:
            opc.append({"raw": m.group(0), "target_dwg": m.group(1),
                        "point": m.group(2)})
    blob = " ".join(words)
    for d, tgt in OPC_TEXT.findall(blob):
        flow.append({"dir": d.upper(), "target": tgt.strip()[:28]})
    return {"drawing": stem, "series": parse_dwg_no(stem),
            "opc": opc, "flow_notes": flow}


def build_set(per_drawing: dict) -> dict:
    """多張圖的接續證據 → 圖組關係。

    per_drawing: {stem: {opc, flow_notes, series, tags}}
    回傳圖與圖之間的邊，以及未配對的斷點（斷點本身就是交付價值——
    客戶常不知道自己的圖有缺口）。
    """
    edges, unmatched = [], []

    # ── ① OPC 明確指向 ────────────────────────────────────
    # 建立「圖號片段 → 圖檔」索引，OPC 的 target_dwg 才對得回實際檔案
    by_frag = defaultdict(list)
    for stem in per_drawing:
        up = stem.upper()
        for frag in re.findall(r"\d{2,5}(?:-\d{1,2})?", up):
            by_frag[frag].append(stem)

    for stem, d in per_drawing.items():
        for o in d.get("opc", []):
            tgt = o["target_dwg"]
            cands = [s for s in by_frag.get(tgt, []) if s != stem]
            if cands:
                edges.append({"from": stem, "to": cands[0], "via": o["raw"],
                              "kind": "opc", "confidence": 0.9,
                              "evidence": f"圖上標記「{o['raw']}」指向 {tgt} 第 {o['point']} 接點"})
            else:
                unmatched.append({"from": stem, "target": tgt, "raw": o["raw"],
                                  "reason": "指向的圖面不在本圖組內——可能尚未上傳，"
                                            "或圖號 OCR 誤讀"})

    # ── ② 圖號序列（同族連號）───────────────────────────────
    fam = defaultdict(list)
    for stem, d in per_drawing.items():
        s = d.get("series")
        if s:
            fam[s[0]].append((s[1], stem))
    for f, items in fam.items():
        items.sort()
        for (n1, a), (n2, b) in zip(items, items[1:]):
            edges.append({"from": a, "to": b, "via": f"{f}{n1}→{f}{n2}",
                          "kind": "series", "confidence": 0.5,
                          "evidence": f"圖號同族連號（{f} 系列），研判為同一套圖的相鄰系統，"
                                      "實際物料是否相通仍須以流向註記或線號確認"})

    # ── ③ 共用編號（同位號出現在兩張圖）─────────────────────
    tag_own = defaultdict(set)
    for stem, d in per_drawing.items():
        for t in d.get("tags", []):
            tag_own[t].add(stem)
    shared = {t: sorted(v) for t, v in tag_own.items() if len(v) > 1}
    for t, owners in list(shared.items())[:200]:
        for a, b in zip(owners, owners[1:]):
            edges.append({"from": a, "to": b, "via": t, "kind": "shared_tag",
                          "confidence": 0.6,
                          "evidence": f"位號「{t}」同時出現在兩張圖上——"
                                      "可能是跨圖延續，也可能是不同單元重號，需人工確認"})

    return {"drawings": sorted(per_drawing), "edges": edges,
            "unmatched": unmatched, "shared_tags": len(shared)}
