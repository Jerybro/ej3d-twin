# ② 文字碎裂檢查（Kim et al. 2025 的 distance-based text error detection）
#
# 目標錯誤：一串文字被 OCR 切成好幾個框（"204.1" → "204" ＋ "1"）。
# 判準：兩個文字框的最小水平距離 Dt = max(x0_target − x1_query, 0)，
# 小於閾值且在同一條基線上 → 判為碎裂候選。
#
# 兩件跟論文不同、必須寫下來的事：
#
# 1) **我們沒有文字框寬度**。OCR 命中落地時只留了中心點與半高，寬度被丟掉，
#    只能由「字數 × 字高 × 比例」推估。這是本輪已知的誤差來源，比例做成
#    參數並掃描；真要根治得回頭改 OCR 落地格式（那是另一件事，要另外烤）。
#
# 2) **潤泰的圖有文字層，可以當零誤差真值**。向量 PDF 裡的字帶精確座標，
#    凡是同一位置 OCR 讀出不同結果的就是被抓到的 OCR 錯誤——所以②的
#    precision 與 recall 都算得出來，不需要人工標註。台化的圖沒有可用
#    文字層（26 個詞而且都是句點），那邊仍得靠人判。
from __future__ import annotations


def boxes_of(texts: list, img_w: float, img_h: float,
             char_w_ratio: float = 0.55) -> list[dict]:
    """OCR 文字 → 像素框（寬度靠推估，見檔頭第 1 點）。"""
    out = []
    for t in texts:
        h = max(t["half_h"] * 2 * img_h, 1.0)
        w = max(len(t["text"]), 1) * char_w_ratio * h
        cx, cy = t["cx"] * img_w, t["cy"] * img_h
        out.append({**t, "h": h, "w": w, "cx_px": cx, "cy_px": cy,
                    "x0": cx - w / 2, "x1": cx + w / 2})
    return out


def fragment_candidates(texts: list, img_w: float, img_h: float,
                        dist_px: float = 25.0, align_ratio: float = 0.6,
                        char_w_ratio: float = 0.55) -> list[dict]:
    """碎裂候選：水平相鄰、基線對齊的兩個文字框。

    align 用「字高的比例」而不是論文的絕對 px（45/55px）——圖的 DPI 不同，
    絕對值不可移植，用相對字高才跨圖有意義。
    """
    bs = sorted(boxes_of(texts, img_w, img_h, char_w_ratio), key=lambda b: b["cx_px"])
    out = []
    for i, q in enumerate(bs):
        for t in bs[i + 1:]:
            gap = t["x0"] - q["x1"]
            if gap > dist_px:
                break                      # 已按 x 排序，再往右只會更遠
            if max(gap, 0.0) > dist_px:
                continue
            if abs(t["cy_px"] - q["cy_px"]) > align_ratio * max(q["h"], t["h"]):
                continue
            out.append({
                "left": q["text"], "right": t["text"],
                "merged": q["text"] + t["text"],
                "gap_px": round(max(gap, 0.0), 2),
                "dy_px": round(abs(t["cy_px"] - q["cy_px"]), 2),
                "cx": round((q["cx"] + t["cx"]) / 2, 4),
                "cy": round((q["cy"] + t["cy"]) / 2, 4),
            })
    return out


# ------------------------------------------------------------ 文字層當真值
def _hits_in(box: list, texts: list, pad: float = 0.002) -> list:
    x0, y0, x1, y1 = box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad
    return [t for t in texts if x0 <= t["cx"] <= x1 and y0 <= t["cy"] <= y1]


def truth_pairs(layer: list, ocr: list) -> dict:
    """用文字層算出「OCR 真的把哪些字切碎了」與「哪些字讀錯了」。

    一個文字層的詞框內若落進 2 個以上 OCR 命中 → 那個詞被 OCR 切碎了；
    只落進 1 個但字串不同 → 讀錯（不同的錯誤類別，順手一起量）。
    """
    frags, misread, ok, uncovered = [], [], 0, 0
    for w in layer:
        hs = _hits_in(w["box"], ocr)
        if not hs:
            uncovered += 1
            continue
        if len(hs) >= 2:
            frags.append({"truth": w["text"], "box": w["box"],
                          "parts": [h["text"] for h in hs],
                          "cx": w["cx"], "cy": w["cy"]})
        elif hs[0]["text"] == w["text"]:
            ok += 1
        else:
            misread.append({"truth": w["text"], "ocr": hs[0]["text"],
                            "cx": w["cx"], "cy": w["cy"]})
    return {"fragmented": frags, "misread": misread,
            "exact": ok, "no_ocr": uncovered, "layer_words": len(layer)}


def evaluate(cands: list, truth: dict, tol: float = 0.01) -> dict:
    """候選清單 vs 文字層真值 → precision / recall。

    命中判定用位置而非字串：碎裂的兩片合起來未必等於真值字串
    （OCR 可能同時漏字），位置對上就算抓到同一個目標。
    """
    tru = truth["fragmented"]
    hit = set()
    tp = 0
    for c in cands:
        m = None
        for i, f in enumerate(tru):
            if abs(f["cx"] - c["cx"]) <= tol and abs(f["cy"] - c["cy"]) <= tol:
                m = i
                break
        if m is None:
            continue
        tp += 1
        hit.add(m)
    n_c, n_t = len(cands), len(tru)
    prec = tp / n_c if n_c else 0.0
    rec = len(hit) / n_t if n_t else 0.0
    return {"candidates": n_c, "truth_fragmented": n_t,
            "true_positive": tp, "caught": len(hit),
            "precision": round(prec, 3), "recall": round(rec, 3),
            "f1": round(2 * prec * rec / (prec + rec), 3) if (prec + rec) else 0.0}


def sweep(ocr: list, layer: list, img_w: float, img_h: float,
          dists: tuple = (10.0, 25.0, 50.0, 80.0),
          ratios: tuple = (0.45, 0.55, 0.7)) -> list[dict]:
    truth = truth_pairs(layer, ocr)
    rows = []
    for d in dists:
        for r in ratios:
            c = fragment_candidates(ocr, img_w, img_h, dist_px=d, char_w_ratio=r)
            rows.append({"dist_px": d, "char_w_ratio": r, **evaluate(c, truth)})
    return rows
