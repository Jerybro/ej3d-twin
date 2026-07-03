"""P&ID 批次解析 + 整廠合併 — 全部圖面一鍵建整廠 3D 場景。

工作流：POST /api/pid/parse_all（或離線跑 run_batch()）→ 逐張 OCR 解析
（EasyOCR 模型單次載入，逐張比單張 API 快）→ 各自存單圖草稿場景 →
跨圖去重（同位號多圖出現：實際繪製圖 vs 文字參照圖）→ 分圖群聚佈局
→ 存「整廠」合併場景（每張圖一個 unit，位號全域唯一）。

跨圖去重規則：同一設備位號在多張圖出現時（一張實際繪製、其餘為管線
目的地參照），以「掛載儀錶數多者」為實際繪製圖（設備本體周邊必有儀錶
圈群聚，參照文字沒有），同數時取信心高者。
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
from pathlib import Path

from .pid_parse import PID_DIR, _push_apart, parse_pid

BASE_DIR = Path(__file__).resolve().parent.parent
STATUS_PATH = BASE_DIR / "data" / "pid_batch_status.json"
MERGED_ID = "pid-ta32-full"
MERGED_NAME = "TA32 整廠｜P&ID 批次解析"

_lock = threading.Lock()
_running = False


def _slug(stem: str) -> str:
    return "pid-" + re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


def _write_status(st: dict):
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATUS_PATH.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")


def read_status() -> dict:
    if not STATUS_PATH.exists():
        return {"state": "idle"}
    try:
        return json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"state": "idle"}


def merge_results(results: dict[str, dict]) -> dict:
    """{圖檔 stem: parse_pid 結果} → 整廠合併場景。"""
    # tag → 各圖的候選 (stem, equipment_entry, conf, 掛載儀錶數)
    candidates: dict[str, list] = {}
    for stem, res in results.items():
        conf_of = {it["tag"]: it["conf"] for it in res["stats"]["items"]}
        for eq in res["scene"]["plant"]["units"][0]["equipment"]:
            candidates.setdefault(eq["tag"], []).append(
                (stem, eq, conf_of.get(eq["tag"], 0), len(eq.get("instruments", [])))
            )

    # 每個位號選出「實際繪製」的那張圖：儀錶數 → 信心
    winner_stem: dict[str, str] = {}
    winner_eq: dict[str, dict] = {}
    for tag, cands in candidates.items():
        cands.sort(key=lambda c: (-c[3], -c[2]))
        winner_stem[tag] = cands[0][0]
        winner_eq[tag] = cands[0][1]

    # 儀錶合併：同 tag 掛載到勝出設備（跨圖 union，重複儀錶取先見）
    instruments: dict[str, dict] = {}
    inst_of_eq: dict[str, list] = {t: [] for t in winner_eq}
    for stem, res in results.items():
        for itag, inst in res["scene"].get("instruments", {}).items():
            if itag in instruments:
                continue
            eq_tag = inst.get("equipment", "")
            if eq_tag not in winner_eq:  # 掛載目標整廠去重後不存在 → 略過掛載
                inst = {**inst, "equipment": ""}
            instruments[itag] = inst
            if inst.get("equipment"):
                inst_of_eq[inst["equipment"]].append(itag)

    # 分圖群聚：每張圖的勝出設備保留圖內相對位置，縮到群聚格內
    sheets = sorted({s for s in winner_stem.values()})
    clusters: dict[str, dict] = {}  # stem → {tag: [x,0,z]}
    spans: dict[str, tuple] = {}
    for stem in sheets:
        tags = [t for t, s in winner_stem.items() if s == stem]
        n = len(tags)
        side = max(1, math.ceil(math.sqrt(n)))
        span_x, span_z = 10 + 7 * side, 7 + 5 * side
        pts = {t: list(winner_eq[t]["pos"]) for t in tags}
        xs = [p[0] for p in pts.values()]
        zs = [p[2] for p in pts.values()]
        x0, x1 = min(xs), max(xs)
        z0, z1 = min(zs), max(zs)
        s = min(span_x / max(x1 - x0, 1), span_z / max(z1 - z0, 1), 1.0)
        pos = {
            t: [(p[0] - (x0 + x1) / 2) * s, 0, (p[2] - (z0 + z1) / 2) * s]
            for t, p in pts.items()
        }
        clusters[stem] = _push_apart(pos, min_gap=3.5)
        spans[stem] = (span_x, span_z)

    # 群聚排格：固定欄數 shelf 佈局（依圖號排序，行高取該行最大縱深）
    cols = max(1, math.ceil(math.sqrt(len(sheets) * 1.6)))
    gap = 10.0
    origins: dict[str, tuple] = {}
    row_h = 0.0
    cur_x, cur_z = 0.0, 0.0
    total_w = 0.0
    for i, stem in enumerate(sheets):
        sw, sh = spans[stem]
        if i and i % cols == 0:
            cur_z += row_h + gap
            cur_x, row_h = 0.0, 0.0
        origins[stem] = (cur_x + sw / 2, cur_z + sh / 2)
        cur_x += sw + gap
        row_h = max(row_h, sh)
        total_w = max(total_w, cur_x - gap)
    total_h = cur_z + row_h
    off_x, off_z = -total_w / 2, -total_h / 2  # 全場置中

    units = []
    for stem in sheets:
        ox, oz = origins[stem]
        equipment = []
        for tag in sorted(clusters[stem]):
            eq = dict(winner_eq[tag])
            x, _, z = clusters[stem][tag]
            eq["pos"] = [round(x + ox + off_x, 2), 0, round(z + oz + off_z, 2)]
            eq["instruments"] = inst_of_eq.get(tag, [])
            eq["pid_ref"] = stem
            equipment.append(eq)
        units.append({"id": stem.upper(), "name": f"圖 {stem.upper()}", "equipment": equipment})

    return {
        "plant": {"id": "TA32-FULL", "name": MERGED_NAME, "units": units},
        "pipes": [],
        "instruments": instruments,
    }


def run_batch(files: list[str] | None = None) -> dict:
    """批次解析全部（或指定）圖面 → 單圖場景 ×N + 整廠合併場景。同步執行。"""
    global _running
    from .scenes import SCENES_DIR, _normalize

    with _lock:
        if _running:
            return {"error": "already-running"}
        _running = True
    try:
        pdfs = ([PID_DIR / f for f in files] if files
                else sorted(PID_DIR.glob("*.pdf")))
        total = len(pdfs)
        results: dict[str, dict] = {}
        errors: dict[str, str] = {}
        t0 = time.time()
        for i, p in enumerate(pdfs):
            _write_status({"state": "running", "total": total, "done": i,
                           "current": p.name, "elapsed": round(time.time() - t0)})
            try:
                res = parse_pid(p.name)
            except Exception as e:  # 單張壞檔不擋整批
                errors[p.name] = str(e)
                continue
            results[p.stem] = res
            scene = _normalize(res["scene"])
            (SCENES_DIR / f"{_slug(p.stem)}.json").write_text(
                json.dumps(scene, ensure_ascii=False, indent=2), encoding="utf-8")

        merged = _normalize(merge_results(results)) if results else None
        if merged:
            (SCENES_DIR / f"{MERGED_ID}.json").write_text(
                json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")

        summary = {
            "state": "done", "total": total, "done": total,
            "elapsed": round(time.time() - t0),
            "merged_scene_id": MERGED_ID if merged else None,
            "equipment": sum(len(u["equipment"]) for u in merged["plant"]["units"]) if merged else 0,
            "instruments": len(merged.get("instruments", {})) if merged else 0,
            "sheets": len(results), "errors": errors,
        }
        _write_status(summary)
        return summary
    finally:
        _running = False


def start_batch_thread(files: list[str] | None = None) -> dict:
    """背景執行批次（API 用）；已在跑則回報進行中狀態。"""
    if _running:
        return {"started": False, **read_status()}
    threading.Thread(target=run_batch, args=(files,), daemon=True).start()
    return {"started": True}
