# P&ID 資產實體層 — 辨識的下一步：框框清單 → 型別化資產物件
#
# 定位（Stage 2 的 L0/L1）：審核通過的標註不該只是一筆筆「bbox＋文字」，
# 而是帶屬性、帶出處、掛上拓撲的資產物件——
#
#   valve      位號?｜尺寸 2"｜狀態 NC｜口徑 FB｜是否接上管網
#   instrument 位號｜ISA 語意｜安裝別｜控制迴路
#   equipment  項次/位號｜名稱規格（PFD 走設備清冊 join）
#   pipe_line  管線編號四段式（尺寸-流體-序號-規格）
#
# 兩條鐵則沿用人工驗證關卡：
#   1. 實體只從「已確認」標註產生——模型輸出不會自己變成資產
#   2. 機器推定的屬性（尺寸、狀態、掛線）一律標注出處與依據，
#      工程師看得到「這個 2" 是從哪裡讀來的」，錯了才改得動
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/pid/model", tags=["pid-model"])

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_DIR = BASE_DIR / "data" / "pid_model"
REGISTRY_DIR = BASE_DIR / "data" / "pid_registry"


# ------------------------------------------------------------- 管線編號解析
# 業界慣例四～五段式：尺寸"-流體代碼-序號-管線等級(-順序號)
# 例：2"-DC-572009-ED200-4、6"-PL-202001。OCR 常把 " 讀成 ''、”、`，
# 破折號也可能黏字，所以分隔全部放寬。
LINE_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*[\"”“'`]{0,2}\s*-\s*"      # 尺寸
    r"([A-Z]{1,4})\s*-\s*"                          # 流體/服務代碼
    r"(\d{4,6})"                                    # 管線序號
    r"(?:\s*-\s*([A-Z]{1,3}\d{2,4}[A-Z0-9]*))?"     # 管線等級（選配）
    r"(?:\s*-\s*(\d{1,2}))?")                       # 順序號（選配）

# 閥件鄰近屬性的詞彙。NC/NO＝常閉/常開、FC/FO＝失效閉/開、
# LO/LC＝鎖開/鎖閉、FB/RB＝全口徑/縮口徑。
STATE_RE = re.compile(r"^(NC|NO|FC|FO|LO|LC)$")
BORE_RE = re.compile(r"^(FB|RB)$")
SIZE_RE = re.compile(r"^[øΦ]?\s*(\d+(?:\.\d+)?)\s*[\"”“'`x×]")


def _parse_line_no(text: str) -> dict | None:
    m = LINE_RE.search((text or "").upper())
    if not m:
        return None
    size, svc, num, spec, seq = m.groups()
    return {"raw": m.group(0), "size_in": float(size), "service": svc,
            "number": num, "spec": spec or "", "seq": seq or ""}


# ------------------------------------------------------------------ 小工具
def _num_key(s: str) -> tuple:
    """項次號排序/比較鍵：'204.4'→(204,4)、'210-1'→(210,1)。
    清冊的連號範圍（204.4~204.6）要能涵蓋掃描抓到的 204.5，
    純字串比對做不到，得轉數值元組。"""
    parts = re.findall(r"\d+", s or "")
    return tuple(int(p) for p in parts) if parts else (0,)


def _registry_of(filename: str) -> dict | None:
    p = REGISTRY_DIR / f"{Path(filename).stem}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _registry_match(item_no: str, rows: list) -> dict | None:
    """掃描項次號對回清冊列：先精確、再落入連號範圍（204.4~204.6 涵蓋 204.5）。"""
    for r in rows:
        if r.get("item") == item_no:
            return r
    k = _num_key(item_no)
    for r in rows:
        rng = r.get("range") or ""
        if "~" not in rng:
            continue
        lo, hi = (x.strip() for x in rng.split("~", 1))
        if _num_key(lo) <= k <= _num_key(hi):
            return r
    return None


def _load_hits(filename: str) -> tuple[list, float, float]:
    """整頁 OCR 命中（scan_all 落地的快取；沒有就現場重跑一次）。"""
    from .pid_vlm import VLM_DIR, _ocr_region, _slug

    hp = VLM_DIR / f"{_slug(Path(filename).stem)}.hits.json"
    if hp.exists():
        try:
            d = json.loads(hp.read_text(encoding="utf-8"))
            return d["hits"], d["w"], d["h"]
        except (json.JSONDecodeError, OSError, KeyError):
            pass
    # 快取缺失 → 與 scan_all 同參數重掃（約 30 秒，只發生在冷啟動）
    TC, TR, OV = 4, 3, 0.06
    hits: list = []
    W = H = 0.0
    for r in range(TR):
        for c in range(TC):
            box = [max(0.0, c / TC - OV), max(0.0, r / TR - OV),
                   min(1.0, (c + 1) / TC + OV), min(1.0, (r + 1) / TR + OV)]
            try:
                h, (W, H) = _ocr_region(filename, box)
                hits += h
            except Exception:  # noqa: BLE001
                continue
    return hits, W, H


def _size_candidate(t: str) -> tuple[str, float] | None:
    """文字 → (尺寸值, 罰分 0~1)。

    吋標「"」在 OCR 常整個消失或誤讀（實測台化：2"→「2」、3/4"→「3/49」「3/4P」），
    只認帶引號的會全軍覆沒。所以分三級收：帶吋標最可信、分數次之、
    裸數字罰分最高——罰分換算成距離加成，愈不確定的形式要愈貼近閥件才採信。
    """
    m = SIZE_RE.match(t)
    if m:
        return m.group(1) + '"', 0.0
    # 3/4"→「3/49」：尾碼 9 是誤讀的引號。管徑分母只有 2/4/8/16，
    # 限制住才不會把誤讀尾碼吃進分母（3/49 要斷成 3/4，不是 3/49）
    m = re.match(r"^(\d{1,2}/(?:16|2|4|8))", t)
    if m:
        return m.group(1) + '"', 0.15
    m = re.match(r"^(\d{1,2})P?$", t)                # 2"→「2」；管徑不會超過 24
    if m and int(m.group(1)) <= 24:
        return m.group(1) + '"', 0.35
    return None


def _near_attrs(cx: float, cy: float, hits: list, radius: float) -> dict:
    """讀元件鄰近的標註文字 → 尺寸/狀態/口徑屬性，各自帶出處。

    圖面慣例：閥件的 2"、NC、FB 就寫在符號旁邊。屬性取「加權最近的一個」，
    並記下讀到的原文與距離——機器推定要能被人一眼查證。
    """
    out: dict = {}
    best: dict = {}
    for hx, hy, text, _cf, _hh in hits:
        d = math.hypot(hx - cx, hy - cy)
        if d > radius:
            continue
        t = (text or "").strip().upper().replace(" ", "")
        for key, rx in (("state", STATE_RE), ("bore", BORE_RE)):
            m = rx.match(t)
            if m and (key not in best or d < best[key][0]):
                best[key] = (d, m.group(1), text.strip(), 0.0, d)
        c = _size_candidate(t)
        if c:
            val, pen = c
            score = d + pen * radius
            if "size" not in best or score < best["size"][0]:
                best["size"] = (score, val, text.strip(), pen, d)
    for key, (_s, val, raw, pen, d) in best.items():
        out[key] = val
        out[f"{key}_src"] = (f"鄰近文字「{raw}」（距 {int(d)}px）"
                             + ("；吋標疑被 OCR 吃掉，請覆核" if pen > 0 else ""))
    return out


# ------------------------------------------------------------------- 建模
def build_model(filename: str) -> dict:
    """把「已確認標註＋清冊＋拓撲」編譯成資產模型並存檔。"""
    from datetime import datetime, timezone

    from .pid_topology import build_graph, control_loops, insert_valves, stats
    from .pid_vlm import _load_annots, _profile_of, _safe_pdf, _slug

    pdf = _safe_pdf(filename)
    annots = _load_annots(filename)
    accepted = annots.get("items", [])
    n_reject = sum(1 for a in annots.get("audit", [])
                   if a.get("action") == "reject")
    is_pfd = _profile_of(filename) == "pfd.json"

    hits, W, H = _load_hits(filename)

    # ---- 儀錶 ----
    instruments = []
    for a in accepted:
        if a.get("kind") != "instrument":
            continue
        tag = a.get("tag", "")
        m = re.search(r"(\d{3,6})[A-Z]?$", tag)
        instruments.append({
            "tag": tag, "function": a.get("symbol", ""),
            "mounting": a.get("mounting", ""), "loop": m.group(1) if m else "",
            "bbox": a.get("bbox"), "note": a.get("user_note", ""),
            "verified_by": a.get("verified_by", ""), "source": "審核確認",
        })

    # ---- 控制迴路（ISA 文法先驗，零視覺推論）----
    loops = control_loops([i["tag"] for i in instruments])

    # ---- 設備（PFD 走清冊 join；P&ID 走位號型別）----
    registry = _registry_of(filename)
    reg_rows = (registry or {}).get("items", [])
    equipment = []
    seen_reg = set()
    for a in accepted:
        if a.get("kind") != "equipment":
            continue
        e = {"tag": a.get("tag", ""), "type": a.get("symbol", ""),
             "bbox": a.get("bbox"), "note": a.get("user_note", ""),
             "verified_by": a.get("verified_by", ""),
             "source": "審核確認", "on_drawing": True}
        row = _registry_match(a.get("tag", ""), reg_rows) if reg_rows else None
        if row:
            seen_reg.add(row["item"])
            e.update({"name": row.get("name", ""), "spec": row.get("spec", ""),
                      "driver": row.get("driver", ""), "qty": row.get("qty"),
                      "remark": row.get("remark", ""), "vfd": row.get("vfd", False),
                      "source": "審核確認＋清冊"})
        equipment.append(e)
    # 清冊有、圖上未確認的也入庫——清冊本來就是圖面自帶的 L0 資料，
    # 缺的是「在圖上被點到」而非「不存在」
    for row in reg_rows:
        if row["item"] in seen_reg:
            continue
        equipment.append({
            "tag": row["item"], "type": "", "name": row.get("name", ""),
            "spec": row.get("spec", ""), "driver": row.get("driver", ""),
            "qty": row.get("qty"), "remark": row.get("remark", ""),
            "vfd": row.get("vfd", False), "bbox": None, "note": "",
            "verified_by": "", "source": "設備清冊", "on_drawing": False})
    equipment.sort(key=lambda e: _num_key(e["tag"]))

    # ---- 拓撲圖＋閥件掛線 ----
    topo: dict = {"ok": False}
    vnodes: list = []           # [(norm_x, norm_y, component_id)]
    try:
        import networkx as nx

        from .pid_parse import detect_valves, pdf_to_norm
        from .pid_vlm import _ensure_base

        _, meta = _ensure_base(filename)
        rot, pw0, ph0 = meta.get("rot", 0), meta.get("pw", 0), meta.get("ph", 0)
        G = build_graph(pdf)
        raw_valves, pw, ph = detect_valves(pdf)
        bridge = insert_valves(G, raw_valves)
        comp_of = {}
        for ci, comp in enumerate(nx.connected_components(G)):
            for n in comp:
                comp_of[n] = ci
        for n, d in G.nodes(data=True):
            if d.get("kind") != "valve":
                continue
            x, y = d["pos"]
            u, v = pdf_to_norm(x, y, pw0 or pw, ph0 or ph, rot)
            vnodes.append((u, v, comp_of.get(n, -1)))
        topo = {"ok": True, "bridge": bridge, "stats": stats(G)}
    except Exception as exc:  # noqa: BLE001
        topo = {"ok": False, "reason": str(exc)[:200]}

    # ---- 閥件（已確認者），屬性充實＋掛線 ----
    valves = []
    vi = 0
    for a in accepted:
        if a.get("kind") != "valve":
            continue
        vi += 1
        b = a.get("bbox") or [0, 0, 0, 0]
        cxn, cyn = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        v = {"id": f"V{vi:02d}", "bbox": b, "note": a.get("user_note", ""),
             "verified_by": a.get("verified_by", ""), "source": "審核確認",
             "net": None}
        # 屬性充實：閥旁的 2"、NC、FB（搜尋半徑＝框寬 4 倍）
        if hits and W:
            r = max((b[2] - b[0]) * W, 30) * 4
            v.update(_near_attrs(cxn * W, cyn * H, hits, r))
        # 拓撲配對：最近的閥節點（正規化距離 < 0.01 才算同一顆）
        bestd, bestc = 1e9, None
        for u, vv, ci in vnodes:
            d = math.hypot(u - cxn, vv - cyn)
            if d < bestd:
                bestd, bestc = d, ci
        if bestc is not None and bestd < 0.01:
            v["net"] = bestc
        valves.append(v)

    # ---- 管線編號（整頁 OCR 撈四段式字串；同號去重取高信心）----
    lines: dict = {}
    for hx, hy, text, cf, hh in hits:
        p = _parse_line_no(text)
        if not p:
            continue
        key = f"{p['service']}-{p['number']}"
        if key not in lines or cf > lines[key]["conf"]:
            lines[key] = {**p, "conf": round(float(cf), 2),
                          "bbox": [round((hx - hh * 4) / W, 4),
                                   round((hy - hh) / H, 4),
                                   round((hx + hh * 4) / W, 4),
                                   round((hy + hh) / H, 4)] if W else None,
                          "source": "OCR（系統推定，未逐條審核）"}

    model = {
        "drawing": Path(filename).name,
        "profile": "pfd" if is_pfd else "isa-5.1",
        "built_at": datetime.now(timezone.utc).astimezone()
                    .isoformat(timespec="seconds"),
        "gate": {"accepted": len(accepted), "rejected": n_reject,
                 "rule": "實體只從已確認標註產生；清冊列與管線編號另標來源"},
        "equipment": equipment,
        "instruments": instruments,
        "valves": valves,
        "lines": sorted(lines.values(), key=lambda x: x["raw"]),
        "loops": [{"loop": k, **v} for k, v in sorted(loops.items())],
        "topology": topo,
        "stats": {
            "equipment": len(equipment),
            "equipment_on_drawing": sum(1 for e in equipment if e["on_drawing"]),
            "instruments": len(instruments), "valves": len(valves),
            "valves_on_net": sum(1 for v in valves if v["net"] is not None),
            "lines": len(lines), "loops": len(loops),
        },
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    (MODEL_DIR / f"{_slug(Path(filename).stem)}.json").write_text(
        json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    return model


# ---------------------------------------------------------------- endpoints
@router.post("/build/{filename}")
def model_build(filename: str) -> dict:
    return build_model(filename)


@router.get("/{filename}")
def model_get(filename: str) -> dict:
    from .pid_vlm import _safe_pdf, _slug

    _safe_pdf(filename)
    p = MODEL_DIR / f"{_slug(Path(filename).stem)}.json"
    if not p.exists():
        raise HTTPException(404, "尚未建立資產模型——先完成審核再按「建立資產模型」")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(500, f"模型檔毀損：{exc}") from exc
