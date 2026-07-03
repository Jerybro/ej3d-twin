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

from .pid_parse import PID_DIR, _push_apart, _uv_to_scene_pipes, parse_pid

MERGED_PIPES_PER_SHEET = 80  # 整廠模式每張圖取最長 N 條（30 張全收會塞爆）

BASE_DIR = Path(__file__).resolve().parent.parent
STATUS_PATH = BASE_DIR / "data" / "pid_batch_status.json"
MERGED_ID = "pid-ta32-full"
MERGED_NAME = "TA32 整廠｜P&ID 批次解析"

# ------------------------------------------------- 製程流向排序（進料→產品）
# 錨定設備 → 製程階段。圖紙群聚依「圖上優先級最高的錨定設備」的階段排序，
# 同階段依圖號。錨定表是 TA32（Tatoray）製程知識：進料泵→合併進料換熱→
# 加熱爐→反應器→冷凝分離→循環壓縮→汽提→苯塔→甲苯塔→重芳烴塔。
STAGES = ["總覽", "進料", "加熱", "反應", "分離", "汽提", "分餾", "公用/其他"]
ANCHOR_STAGE = {
    "P632": 1,           # 進料泵
    "E651": 2, "F601": 2, "F602": 2,   # 合併進料換熱＋加熱爐
    "R611": 3,           # Tatoray 反應器
    "E652": 4, "V613": 4, "B631": 4,   # 出口冷凝＋分離槽＋循環氣壓縮
    "C614": 5,           # 汽提塔
    "C617": 6, "C618": 6, "C620": 6,   # 苯塔/甲苯塔/重芳烴塔
}
# 同圖多錨定時取「設備類型優先級」最高者（塔/反應器/爐 > 槽/壓縮機 > 換熱/泵）
ANCHOR_PRIO = {"C": 0, "R": 1, "F": 2, "B": 3, "V": 4, "S": 5, "E": 6, "P": 7, "T": 8}


def _sheet_stage(stem: str, tags: list[str]) -> int:
    """圖 → 製程階段。PFD 總覽排最前；無錨定圖排公用/其他。"""
    if not stem.upper().startswith("C12"):  # PFD（ARO-1 600）當總覽
        return 0
    hits = []
    for tag in tags:
        for anchor, stage in ANCHOR_STAGE.items():
            if tag.startswith(anchor):
                hits.append((ANCHOR_PRIO.get(tag[0], 9), stage))
    if not hits:
        return len(STAGES) - 1
    hits.sort()
    return hits[0][1]

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
    """{圖檔 stem: parse_pid 結果} → 整廠合併場景。

    佈局＝「圖紙地毯」：每張圖的 P&ID 渲染圖鋪在群聚底下，設備以像素
    保真映射站在圖面自己的位置上（可直接對圖清草稿）；群聚依製程流向
    排序（總覽→進料→加熱→反應→分離→汽提→分餾→公用）。
    """
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

    # 圖紙地毯群聚：整張圖按頁面比例縮成 tile，設備像素座標仿射映射
    TILE_W = 44.0  # 整廠模式單張圖紙寬（比單圖 56 略小，30 張才排得開）
    sheet_tags: dict[str, list] = {}
    for tag, stem in winner_stem.items():
        sheet_tags.setdefault(stem, []).append(tag)
    sheets = sorted(sheet_tags)

    clusters: dict[str, dict] = {}   # stem → {tag: [x,0,z]}（tile 內局部座標）
    spans: dict[str, tuple] = {}     # stem → (tile_w, tile_h)
    tiles: dict[str, str] = {}       # stem → lo-res 底圖 URL
    for stem in sheets:
        geom = results[stem]["geom"]
        pw, ph = geom["page_w"], geom["page_h"]
        tile_h = TILE_W * ph / pw
        pos = {}
        for tag in sheet_tags[stem]:
            px, py = geom["px"][tag]
            pos[tag] = [round((px / pw - 0.5) * TILE_W, 2), 0,
                        round((py / ph - 0.5) * tile_h, 2)]
        clusters[stem] = _push_apart(pos, min_gap=2.2)
        spans[stem] = (TILE_W, round(tile_h, 2))
        tiles[stem] = geom["tile_lo"]

    # 製程流向排序：階段 → 圖號
    order = sorted(sheets, key=lambda s: (_sheet_stage(s, sheet_tags[s]), s))

    # shelf 佈局（tile 等寬，行高取該行最大縱深）
    cols = max(1, math.ceil(math.sqrt(len(order) * 1.6)))
    gap = 6.0
    origins: dict[str, tuple] = {}
    row_h = 0.0
    cur_x, cur_z = 0.0, 0.0
    total_w = 0.0
    for i, stem in enumerate(order):
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
    underlays = []
    pipes = []
    for stem in order:
        ox, oz = origins[stem][0] + off_x, origins[stem][1] + off_z
        stage = STAGES[_sheet_stage(stem, sheet_tags[stem])]
        equipment = []
        for tag in sorted(clusters[stem]):
            eq = dict(winner_eq[tag])
            x, _, z = clusters[stem][tag]
            eq["pos"] = [round(x + ox, 2), 0, round(z + oz, 2)]
            eq["instruments"] = inst_of_eq.get(tag, [])
            eq["pid_ref"] = stem
            equipment.append(eq)
        units.append({"id": stem.upper(),
                      "name": f"{stage}｜{stem.upper()}", "equipment": equipment})
        underlays.append({"image": tiles[stem], "x": round(ox, 2), "z": round(oz, 2),
                          "w": spans[stem][0], "h": spans[stem][1]})
        # 管線 3D 化（extract_pipes 已按長度降冪，取前 N=保主幹）
        pipes += _uv_to_scene_pipes(
            results[stem]["geom"].get("pipes_uv", []),
            spans[stem][0], spans[stem][1], ox, oz,
            limit=MERGED_PIPES_PER_SHEET)

    return {
        "plant": {"id": "TA32-FULL", "name": MERGED_NAME, "units": units},
        "pipes": pipes,
        "instruments": instruments,
        "underlays": underlays,
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
