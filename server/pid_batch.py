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

from .pid_parse import (PID_DIR, PIPE_Y, _apply_dims, _push_apart,
                        _uv_to_scene_pipes, parse_pid)

MERGED_PIPES_PER_SHEET = None  # None=全收（渲染端已合併幾何，扛得住）
BRIDGE_Y = 8.0     # 橋接管線高度（跨圖島，飛越一般管線與多數設備）
BRIDGE_R = 0.16


def _short_name(stem: str) -> str | None:
    """圖檔名 → 接續標記使用的短圖名：C12070-1 → 070-1（PFD 無短名）。"""
    m = re.match(r"^C12(\d{3}-\d{1,2})$", stem.upper())
    return m.group(1) if m else None


def _match_connectors(results: dict, order: list[str]) -> tuple[list, dict]:
    """跨圖接續標記雙向配對 → [(stemA, uvA, stemB, uvB)] 橋接清單＋統計。

    配對鍵＝(兩圖短名排序, 接點編號)：A 圖上的「070-2/01」與 C12070-2 圖上
    的「070-1/01」互指（C12070-1↔C12070-2 實測成對）。單側缺漏（對側 OCR
    沒抓到）不畫橋，只記統計。
    """
    by_short = {s: stem for stem in order if (s := _short_name(stem))}
    sides: dict[tuple, dict] = {}
    total = 0
    for stem in order:
        a_short = _short_name(stem)
        if not a_short:
            continue
        for c in results[stem]["geom"].get("connectors", []):
            if c["tgt"] not in by_short:   # 接到集外圖（他單元）
                continue
            total += 1
            key = (*sorted((a_short, c["tgt"])), c["cid"])
            sides.setdefault(key, {})[a_short] = (stem, c["u"], c["v"])
    bridges = []
    for key, ends in sides.items():
        if len(ends) == 2:
            (sa, ua, va), (sb, ub, vb) = ends.values()
            bridges.append((sa, (ua, va), sb, (ub, vb)))
    return bridges, {"refs": total, "paired": len(bridges) * 2}


def _optimize_slots(order: list[str], edges: list[tuple], cols: int,
                    slot_w: float, slot_h: float, sweeps: int = 20) -> list[str]:
    """slot 交換爬山：讓有橋接的圖島盡量相鄰（初始＝製程流向序，保流向大局）。"""
    def center(idx):
        return ((idx % cols) * slot_w, (idx // cols) * slot_h)

    pos = {stem: i for i, stem in enumerate(order)}
    pair_w: dict[tuple, int] = {}
    for sa, _, sb, _ in edges:
        k = tuple(sorted((sa, sb)))
        pair_w[k] = pair_w.get(k, 0) + 1

    def cost():
        c = 0.0
        for (sa, sb), w in pair_w.items():
            (xa, za), (xb, zb) = center(pos[sa]), center(pos[sb])
            c += w * ((xa - xb) ** 2 + (za - zb) ** 2)
        return c

    cur = cost()
    stems = list(order)
    for _ in range(sweeps):
        improved = False
        for i in range(len(stems)):
            for j in range(i + 1, len(stems)):
                a, b = stems[i], stems[j]
                pos[a], pos[b] = pos[b], pos[a]
                nc = cost()
                if nc < cur - 1e-9:
                    cur = nc
                    improved = True
                else:
                    pos[a], pos[b] = pos[b], pos[a]
        if not improved:
            break
    return sorted(stems, key=lambda s: pos[s])

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
    保真映射站在圖面自己的位置上（可直接對圖清草稿）。

    完成度原則：**圖上有什麼就放什麼**——同一設備繪於多張圖時每張都放
    （位號重複以「·2」後綴唯一化），不做跨圖去重；圖面去重會讓地毯上
    明明有符號的位置空著，直接被讀成「缺漏」。
    """
    # 圖紙地毯群聚：整張圖按頁面比例縮成 tile，設備像素座標仿射映射
    TILE_W = 44.0  # 整廠模式單張圖紙寬（比單圖 56 略小，30 張才排得開）
    sheets = sorted(results)
    sheet_tags: dict[str, list] = {
        stem: [eq["tag"] for eq in results[stem]["scene"]["plant"]["units"][0]["equipment"]]
        for stem in sheets
    }

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

    # 製程流向排序：階段 → 圖號（＝縫合佈局的初始解，保流向大局）
    order = sorted(sheets, key=lambda s: (_sheet_stage(s, sheet_tags[s]), s))

    # 跨圖接續標記配對 → 連通性驅動佈局（有橋接的圖島拉相鄰）
    bridges, conn_stat = _match_connectors(results, order)
    cols = max(1, math.ceil(math.sqrt(len(order) * 1.6)))
    gap = 6.0
    slot_w = TILE_W + gap
    slot_h = max(sh for _, sh in spans.values()) + gap
    order = _optimize_slots(order, bridges, cols, slot_w, slot_h)

    # 均勻 slot 佈局（等寬等高格）
    origins: dict[str, tuple] = {}
    for i, stem in enumerate(order):
        origins[stem] = ((i % cols) * slot_w + TILE_W / 2,
                         (i // cols) * slot_h + spans[stem][1] / 2)
    rows = math.ceil(len(order) / cols)
    total_w = min(len(order), cols) * slot_w - gap
    total_h = rows * slot_h - gap
    off_x, off_z = -total_w / 2, -total_h / 2  # 全場置中

    # 跨圖尺寸註冊表：任一張圖標題挖到的實尺寸，套用到所有圖的同位號實例
    dims_reg: dict[str, tuple] = {}
    for stem in sheets:
        for tag, v in results[stem]["geom"].get("dims_mm", {}).items():
            dims_reg.setdefault(tag, tuple(v))

    units = []
    underlays = []
    pipes = []
    instruments: dict[str, dict] = {}
    seen_tags: dict[str, int] = {}   # 位號唯一化（同設備多圖繪製）
    for stem in order:
        ox, oz = origins[stem][0] + off_x, origins[stem][1] + off_z
        stage = STAGES[_sheet_stage(stem, sheet_tags[stem])]
        geom = results[stem]["geom"]
        sheet_scene = results[stem]["scene"]
        eq_by_tag = {e["tag"]: e for e in sheet_scene["plant"]["units"][0]["equipment"]}
        rename: dict[str, str] = {}
        equipment = []
        for tag in sorted(clusters[stem]):
            eq = dict(eq_by_tag[tag])
            n = seen_tags.get(tag, 0) + 1
            seen_tags[tag] = n
            uniq = tag if n == 1 else f"{tag}·{n}"
            rename[tag] = uniq
            x, _, z = clusters[stem][tag]
            eq["tag"] = uniq
            eq["pos"] = [round(x + ox, 2), 0, round(z + oz, 2)]
            eq["pid_ref"] = stem
            # 本圖沒挖到尺寸但他圖有 → 套跨圖註冊表
            if tag in dims_reg and "尺寸來源" not in eq.get("design", {}):
                _apply_dims(eq, *dims_reg[tag])
            equipment.append(eq)
        # 儀錶：本圖掛載、世界座標標記位置；跨圖同位號取先見（同一迴路重繪）
        for itag, inst in sheet_scene.get("instruments", {}).items():
            if itag in instruments:
                continue
            u, v = geom["inst_uv"].get(itag, (0.5, 0.5))
            instruments[itag] = {
                **inst,
                "equipment": rename.get(inst.get("equipment", ""), inst.get("equipment", "")),
                "pos": [round((u - 0.5) * spans[stem][0] + ox, 2),
                        round((v - 0.5) * spans[stem][1] + oz, 2)],
            }
        units.append({"id": stem.upper(),
                      "name": f"{stage}｜{stem.upper()}", "equipment": equipment})
        underlays.append({"image": tiles[stem], "x": round(ox, 2), "z": round(oz, 2),
                          "w": spans[stem][0], "h": spans[stem][1]})
        # 管線 3D 化（extract_pipes 已按長度降冪；None=全收）
        pipes += _uv_to_scene_pipes(
            results[stem]["geom"].get("pipes_uv", []),
            spans[stem][0], spans[stem][1], ox, oz,
            limit=MERGED_PIPES_PER_SHEET)

    # 跨圖橋接管線：接續標記配對點之間，高空跨接（縫合成一張廠區的「線」）
    def world(stem, uv):
        ox = origins[stem][0] + off_x
        oz = origins[stem][1] + off_z
        return ((uv[0] - 0.5) * spans[stem][0] + ox,
                (uv[1] - 0.5) * spans[stem][1] + oz)

    for sa, uva, sb, uvb in bridges:
        (xa, za), (xb, zb) = world(sa, uva), world(sb, uvb)
        pipes.append({"pts": [
            [round(xa, 2), PIPE_Y, round(za, 2)],
            [round(xa, 2), BRIDGE_Y, round(za, 2)],
            [round(xb, 2), BRIDGE_Y, round(zb, 2)],
            [round(xb, 2), PIPE_Y, round(zb, 2)],
        ], "r": BRIDGE_R, "bridge": True})

    return {
        "plant": {"id": "TA32-FULL", "name": MERGED_NAME, "units": units},
        "pipes": pipes,
        "instruments": instruments,
        "underlays": underlays,
        "stitch": {"bridges": len(bridges), **conn_stat},
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
            "stitch": merged.get("stitch", {}) if merged else {},
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
