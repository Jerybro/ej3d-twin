# ① 線段—符號交點檢查（Kim et al. 2025 的 intersection-case inspection）
#
# 判準（論文原文的三種情形）：
#   0 交點：線段整段落在符號框內 → 標記（複合符號除外，那類本來就內含線）
#   1 交點：線段有一端在框內，框內長度超過閾值 → 標記
#   2 交點：線段貫穿符號框 → 一律標記（邊界歸屬有歧義）
#
# 在**我們的資料**上，這個檢查的意義跟論文不完全一樣，得說清楚：
# 我們的 pipes 來自 styled_segments，那是 PDF 裡**所有向量路徑**，包含符號
# 自身的筆劃。論文的 pipeline 在這一步之前已經把線分類過了，我們沒有。
# 所以這裡標出來的多半不是「辨識錯誤」，而是「這條線其實是符號的一部分，
# 不該當管線」——那正是流向圖長出假邊的來源之一（潤泰 27 條邊裡一堆
# 局部亂接）。抓出來的價值在清乾淨拓撲，不在挑 OCR 的錯。
from __future__ import annotations

import math


def _inside(x: float, y: float, b: list) -> bool:
    return b[0] <= x <= b[2] and b[1] <= y <= b[3]


def _clip(p0: tuple, p1: tuple, b: list) -> tuple | None:
    """Liang–Barsky：線段落在框內的參數區間 [t0, t1]，完全在外回 None。"""
    t0, t1 = 0.0, 1.0
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    for p, q in ((-dx, p0[0] - b[0]), (dx, b[2] - p0[0]),
                 (-dy, p0[1] - b[1]), (dy, b[3] - p0[1])):
        if p == 0:
            if q < 0:
                return None            # 平行且在框外
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    return (t0, t1) if t1 > t0 else None


def inspect(pipes: list, symbols: list, aspect: float, img_w: float,
            inside_px: float = 5.0, composite_kinds: tuple = ("equipment",),
            min_seg_px: float = 1.0) -> list[dict]:
    """回傳可疑清單。長度一律換算成底圖像素，閾值才有物理意義。"""
    def _len_px(p0, p1) -> float:
        return math.hypot(p1[0] - p0[0], (p1[1] - p0[1]) * aspect) * img_w

    out = []
    for si, s in enumerate(pipes):
        p0, p1 = (float(s[0]), float(s[1])), (float(s[2]), float(s[3]))
        seg_px = _len_px(p0, p1)
        if seg_px < min_seg_px:
            continue
        for sym in symbols:
            b = sym["box"]
            iv = _clip(p0, p1, b)
            if iv is None:
                continue
            in_px = (iv[1] - iv[0]) * seg_px
            a_in, b_in = _inside(*p0, b), _inside(*p1, b)
            if a_in and b_in:
                case, flag = 0, sym["kind"] not in composite_kinds
                why = "整段落在符號框內"
            elif a_in or b_in:
                case, flag = 1, in_px > inside_px
                why = f"一端在框內，框內長度 {in_px:.1f}px"
            else:
                case, flag = 2, True
                why = f"貫穿符號框（框內 {in_px:.1f}px）"
            if not flag:
                continue
            out.append({
                "seg": si, "case": case, "why": why,
                "seg_px": round(seg_px, 2), "inside_px": round(in_px, 2),
                "sym_kind": sym["kind"], "sym_tag": sym.get("tag", ""),
                "sym_box": [round(v, 4) for v in b],
                "line": [round(v, 4) for v in (p0[0], p0[1], p1[0], p1[1])],
            })
    return out


def sweep(pipes: list, symbols: list, aspect: float, img_w: float,
          values: tuple = (2.0, 5.0, 10.0, 20.0)) -> dict:
    """閾值掃描——論文的 5px 是它們圖的解析度，照抄沒有意義。

    寫死預設值會讓標定變成無效動作（pid_flow 的 PORT_PAD 踩過一次：四個
    半徑跑出完全相同的結果才發現預設參數在函式定義時就求值了）。
    """
    return {str(v): len(inspect(pipes, symbols, aspect, img_w, inside_px=v))
            for v in values}
