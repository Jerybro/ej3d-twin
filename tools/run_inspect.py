# 辨識結果自動檢查 —— 評測主程式
#
#   python tools/run_inspect.py                 # 潤泰三張
#   python tools/run_inspect.py --all           # 加上台化
#   python tools/run_inspect.py --rebuild       # 強制重建資產模型
#
# 產出（全部落在 data/pid_inspect/）：
#   {slug}.lines.json / {slug}.text.json   可疑清單（可複算）
#   {slug}.lines.html / {slug}.text.html   判讀表（人逐條打勾、匯出判讀）
#   summary.json                            閾值掃描與比較結果
#
# 台化與潤泰的數字分開報：兩套繪圖慣例混在一起平均，會得到一個誰都不
# 代表的數字。潤泰有文字層可當真值，台化沒有（只有 26 個詞而且都是句點），
# 所以台化那邊②只出清單、不出 precision/recall。
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pid_inspect import common, lines, text, report   # noqa: E402

RUENTEX = [
    "R-M0200-00-000-000-00 礦化及造粒系統流程圖_20260408.pdf",
    "R-M0300-00-000-000-00 混合系統流程圖_20230728.pdf",
    "R-M0400-00-000-000-00 燒結系統流程圖_20260107.pdf",
]
FORMOSA = ["C12070-1.pdf", "C12068-1.pdf"]


def _mark_box(cx: float, cy: float, r: float = 0.012) -> list:
    return [cx - r, cy - r * 1.4, cx + r, cy + r * 1.4]


def run_one(pdf: str, rebuild: bool = False) -> dict:
    meta = common.load_meta(pdf)
    model = common.load_model(pdf, rebuild=rebuild)
    W, H = float(meta["w"]), float(meta["h"])
    aspect = (model.get("geometry") or {}).get("aspect") or (H / W)
    slug = common.slug_of(pdf)

    pipes = common.pipes_of(model)
    syms = common.symbol_boxes(model)
    ocr = common.ocr_texts(model)
    layer = common.pdf_text_boxes(pdf, meta)

    # ---- ① 線段—符號交點 ----
    l_sweep = lines.sweep(pipes, syms, aspect, W)
    l_list = lines.inspect(pipes, syms, aspect, W)
    common.save_json(f"{slug}.lines.json", l_list)
    l_items = [{
        "box": [min(d["line"][0], d["line"][2]), min(d["line"][1], d["line"][3]),
                max(d["line"][0], d["line"][2]), max(d["line"][1], d["line"][3])],
        "title": f"case{d['case']}　{d['sym_kind']} {d['sym_tag']}".strip(),
        "detail": d["why"], "seg": d["seg"],
    } for d in l_list]
    report.build_html(
        common.OUT_DIR / f"{slug}.lines.html", f"①線段交點檢查｜{Path(pdf).stem[:28]}",
        f"../../uploads/pid/_vlm/{slug}.jpg", l_items,
        f"{len(l_items)} 條可疑　鍵盤 1=真錯 2=誤報 ↑↓ 換條")

    # ---- ② 文字碎裂 ----
    t_truth = text.truth_pairs(layer, ocr)
    t_sweep = text.sweep(ocr, layer, W, H)
    t_list = text.fragment_candidates(ocr, W, H)
    t_eval = text.evaluate(t_list, t_truth)
    common.save_json(f"{slug}.text.json",
                     {"candidates": t_list, "truth": t_truth, "eval": t_eval})
    t_items = [{
        "box": _mark_box(d["cx"], d["cy"]),
        "title": f'「{d["left"]}」＋「{d["right"]}」→ {d["merged"]}',
        "detail": f'水平間距 {d["gap_px"]}px　基線差 {d["dy_px"]}px',
    } for d in t_list]
    report.build_html(
        common.OUT_DIR / f"{slug}.text.html", f"②文字碎裂檢查｜{Path(pdf).stem[:28]}",
        f"../../uploads/pid/_vlm/{slug}.jpg", t_items,
        f"{len(t_items)} 對可疑　鍵盤 1=真錯 2=誤報 ↑↓ 換條")

    return {
        "pdf": Path(pdf).name, "slug": slug,
        "geometry": {"segments": len(pipes), "symbols": len(syms),
                     "ocr_texts": len(ocr), "layer_words": len(layer)},
        "lines": {"flagged": len(l_list), "sweep_inside_px": l_sweep,
                  "by_case": {str(c): sum(1 for d in l_list if d["case"] == c)
                              for c in (0, 1, 2)},
                  "by_kind": {k: sum(1 for d in l_list if d["sym_kind"] == k)
                              for k in {d["sym_kind"] for d in l_list}}},
        "text": {"candidates": len(t_list), "truth": {k: (len(v) if isinstance(v, list) else v)
                                                      for k, v in t_truth.items()},
                 "eval": t_eval, "sweep": t_sweep},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="加測台化")
    ap.add_argument("--rebuild", action="store_true", help="強制重建資產模型")
    a = ap.parse_args()

    jobs = [("潤泰", f) for f in RUENTEX]
    if a.all:
        jobs += [("台化", f) for f in FORMOSA]

    out = {}
    for plant, pdf in jobs:
        if not (common.PID_DIR / pdf).exists():
            print(f"  跳過（檔案不存在）：{pdf}")
            continue
        print(f"\n=== {plant}｜{pdf[:40]} ===")
        try:
            r = run_one(pdf, rebuild=a.rebuild)
        except Exception as exc:                      # noqa: BLE001
            print(f"  失敗：{type(exc).__name__}: {exc}")
            continue
        out.setdefault(plant, []).append(r)
        g, ln, tx = r["geometry"], r["lines"], r["text"]
        print(f"  線段 {g['segments']}　符號框 {g['symbols']}　"
              f"OCR文字 {g['ocr_texts']}　文字層 {g['layer_words']}")
        print(f"  ① 可疑 {ln['flagged']}　依情形 {ln['by_case']}　"
              f"閾值掃描 {ln['sweep_inside_px']}")
        t = tx["truth"]
        print(f"  ② 候選 {tx['candidates']}　文字層真值：碎裂 {t['fragmented']}／"
              f"讀錯 {t['misread']}／完全正確 {t['exact']}／無OCR {t['no_ocr']}")
        print(f"     precision {tx['eval']['precision']}　recall {tx['eval']['recall']}"
              f"　F1 {tx['eval']['f1']}")

    common.save_json("summary.json", out)
    print(f"\n產出目錄：{common.OUT_DIR}")


if __name__ == "__main__":
    main()
