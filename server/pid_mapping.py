# 點位對照 —— 歷史數據欄位 ↔ P&ID 資產，數位孿生綁定之前的前處理對照
#
# 工廠數位轉型建 ML 的前幾步：上傳資料（資料工作台）→ 判讀 P&ID（資產模型）→
# **這裡把兩邊對起來** → 之後才是綁定孿生。沒有這一步，孿生只是把數字亂貼在圖上。
#
# 粒度（grilling 拍板）：設備＝資產；量測點掛在設備底下。潤泰的欄名是
# 「盤號_迴路號_量測項_統計」（314_20_amp_mean），同一台設備底下多個馬達迴路——
# 迴路是子部件標籤（M20），不在 P&ID 資產樹上長節點。
#
# 每個量測點人要確認的：設備、量測項、單位、子部件、合理範圍。
# 統計（count／缺值率／mean／min／max／p1／p99）由資料算，給人看、不要人填；
# 合理範圍預設帶 p1/p99 標「系統推定」，人改了標「人工設定」——同一條鐵則：
# 系統給的東西要能被查證、要看得出是誰定的。
#
# 資料落在 data/pid_mapping/{domain}/{sid}.json：一份資料集一份對照，
# 可對多張圖（drawing 欄位記這個量測點對到哪張圖的哪台設備）。
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/pid/mapping", tags=["pid-mapping"])

BASE_DIR = Path(__file__).resolve().parent.parent
MAP_DIR = BASE_DIR / "data" / "pid_mapping"
_LOCK = threading.Lock()

# 量測項猜測：欄名裡的縮寫 → 中文量測項＋預設單位。
# 只給預設，人要確認；猜不到就留空讓人填。
MEASURE_HINTS = [
    (r"(^|_)(hz|freq|frequency)(_|$)", "頻率", "Hz"),
    (r"(^|_)(amp|amps|current|cur|ia|ib|ic)(_|$)", "電流", "A"),
    (r"(^|_)(kw|power)(_|$)", "功率", "kW"),
    (r"(^|_)(kwh|energy)(_|$)", "電度", "kWh"),
    (r"(^|_)(volt|vol|v)(_|$)", "電壓", "V"),
    (r"(^|_)(load_frac|load|loading)(_|$)", "負載率", "%"),
    (r"(^|_)(rpm|speed|spd)(_|$)", "轉速", "rpm"),
    (r"(^|_)(temp|tmp|t|ti|te)(_|$)", "溫度", "°C"),
    (r"(^|_)(pres|press|pressure|pi|pt|p)(_|$)", "壓力", "kPa"),
    (r"(^|_)(flow|fi|ft|f)(_|$)", "流量", "t/h"),
    (r"(^|_)(level|lvl|li|lt)(_|$)", "液位", "%"),
    (r"(^|_)(vib|vibration)(_|$)", "振動", "mm/s"),
    (r"(^|_)(set|sp|setpoint)(_|$)", "設定值", ""),
    (r"(^|_)(run|on|status|state)(_|$)", "運轉狀態", ""),
]
STAT_HINTS = {"mean": "平均", "avg": "平均", "max": "最大", "min": "最小",
              "std": "標準差", "sum": "加總", "frac": "比例", "count": "計數"}


# ------------------------------------------------------------------ storage
def _path(sid: str, domain: str) -> Path:
    d = MAP_DIR / (re.sub(r"[^a-z0-9.-]+", "-", (domain or "").lower()) or "_")
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{re.sub(r'[^A-Za-z0-9_-]', '', sid)}.json"


def _load(sid: str, domain: str) -> dict:
    p = _path(sid, domain)
    if not p.exists():
        return {"sid": sid, "drawings": [], "points": {}, "ignored": []}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"sid": sid, "drawings": [], "points": {}, "ignored": []}
    d.setdefault("drawings", [])
    d.setdefault("points", {})
    d.setdefault("ignored", [])
    return d


def _save(sid: str, domain: str, d: dict) -> None:
    p = _path(sid, domain)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


# ------------------------------------------------------------------ 統計
def _num_key(s: str) -> tuple:
    parts = re.findall(r"\d+", s or "")
    return tuple(int(p) for p in parts) if parts else (0,)


def column_stats(sid: str) -> tuple[list, dict]:
    """每一欄的統計＋資料集 meta。只算數值欄；時間欄與非數值欄另列。"""
    import numpy as np
    import pandas as pd

    from .dataprep import DATA_DIR, _load_base, _load_meta

    meta = _load_meta(sid) or {}
    if not (DATA_DIR / f"{sid}.parquet").exists():
        raise HTTPException(404, "資料集不存在或尚未轉檔")
    df = _load_base(sid)
    tcol = meta.get("time_col")
    span = None
    if tcol and tcol in df.columns:
        try:
            t = pd.to_datetime(df[tcol], errors="coerce")
            span = {"start": str(t.min())[:16], "end": str(t.max())[:16]}
        except Exception:  # noqa: BLE001
            span = None
    out = []
    n = len(df)
    for c in df.columns:
        if c == tcol or c == "__id__":
            continue
        s = pd.to_numeric(df[c], errors="coerce")
        valid = int(s.notna().sum())
        row = {"col": c, "n": n, "valid": valid,
               "missing_pct": round((1 - valid / n) * 100, 2) if n else 0.0,
               "numeric": valid > 0}
        if valid > 0:
            v = s.dropna().to_numpy(dtype=float)
            q = np.percentile(v, [1, 50, 99]) if len(v) else [None, None, None]
            row.update({
                "mean": float(np.mean(v)), "std": float(np.std(v)),
                "min": float(np.min(v)), "max": float(np.max(v)),
                "p1": float(q[0]), "p50": float(q[1]), "p99": float(q[2]),
                "n_unique": int(min(len(np.unique(v)), 10 ** 6)),
            })
            # 迷你直方圖（16 桶）給前端畫 sparkline
            try:
                hist, edges = np.histogram(v, bins=16)
                row["hist"] = [int(x) for x in hist]
                row["hist_range"] = [float(edges[0]), float(edges[-1])]
            except Exception:  # noqa: BLE001
                pass
        out.append(row)
    return out, {"sid": sid, "filename": meta.get("filename"), "n_rows": n,
                 "time_col": tcol, "span": span}


# ------------------------------------------------------------------ 自動猜
def _guess_measure(col: str) -> tuple[str, str, str]:
    """欄名 → (量測項, 單位, 統計)。猜不到回空字串。"""
    low = col.lower()
    stat = ""
    for k, zh in STAT_HINTS.items():
        if re.search(rf"(^|_){k}(_|$)", low):
            stat = zh
            break
    for pat, name, unit in MEASURE_HINTS:
        if re.search(pat, low):
            return name, unit, stat
    return "", "", stat


def _guess_equipment(col: str, tags: list) -> tuple[str, str, float]:
    """欄名 → (位號, 子部件, 信心)。

    潤泰慣例：`314_20_amp_mean`＝盤 314、迴路 20。盤號對得到位號就用；
    第二段數字若不是位號的一部分就當子部件（M20）。找不到回空。
    """
    low = col.lower()
    parts = re.split(r"[_\-\s]+", low)
    tagset = {t.lower(): t for t in tags}
    # ① 前綴精確命中位號（含 313.4 這種帶點的、315-2 這種帶橫的）
    for n in (3, 2, 1):
        head = "_".join(parts[:n])
        for sep in ("_", ".", "-"):
            cand = head.replace("_", sep)
            if cand in tagset:
                sub = parts[n] if len(parts) > n and re.fullmatch(r"\d+", parts[n]) else ""
                return tagset[cand], (f"M{sub}" if sub else ""), 0.9
    # ② 第一段是位號
    if parts and parts[0] in tagset:
        sub = parts[1] if len(parts) > 1 and re.fullmatch(r"\d+", parts[1]) else ""
        return tagset[parts[0]], (f"M{sub}" if sub else ""), 0.85
    # ③ 欄名任一段等於位號
    for p in parts:
        if p in tagset:
            return tagset[p], "", 0.6
    return "", "", 0.0


def _asset_tags(drawings: list, request: Request) -> tuple[list, dict]:
    """多張圖的設備位號（含候選）＋名稱。"""
    from .pid_model import model_get

    tags: list = []
    names: dict = {}
    for fn in drawings:
        try:
            m = model_get(fn, request)
        except HTTPException:
            continue
        for e in m.get("equipment", []):
            t = e.get("tag", "")
            if not t or t in names:
                continue
            tags.append(t)
            names[t] = {"name": e.get("name") or e.get("type") or "",
                        "drawing": fn, "on_drawing": bool(e.get("bbox") or e.get("candidate_bbox"))}
    return tags, names


# ------------------------------------------------------------------ endpoints
class DrawingsReq(BaseModel):
    drawings: list


class PointReq(BaseModel):
    col: str
    tag: str = ""            # 設備位號；空＝未歸戶
    drawing: str = ""
    sub: str = ""            # 子部件（M20）
    measure: str = ""        # 量測項
    unit: str = ""
    stat: str = ""           # 統計（平均／最大…）
    lo: float | None = None  # 合理範圍
    hi: float | None = None
    range_by: str = "system" # system | manual
    note: str = ""
    confirmed: bool = False


@router.get("/datasets")
def mapping_datasets(request: Request) -> list:
    """可對照的資料集＝資料工作台裡的（同一份清單、同一套可見性）。"""
    from .dataprep import list_sessions

    rows = list_sessions(request)
    from .auth import current_domain

    dom = current_domain(request)
    for r in rows:
        d = _load(r["sid"], dom)
        r["mapped"] = sum(1 for p in d["points"].values() if p.get("tag"))
        r["confirmed"] = sum(1 for p in d["points"].values() if p.get("confirmed"))
        r["drawings"] = d["drawings"]
    return rows


@router.get("/{sid}")
def mapping_get(sid: str, request: Request) -> dict:
    """對照全貌：欄位統計＋既有對照＋自動猜（只對還沒對過的欄）＋設備覆蓋率。"""
    from .auth import current_domain

    dom = current_domain(request)
    d = _load(sid, dom)
    cols, meta = column_stats(sid)
    tags, names = _asset_tags(d["drawings"], request)
    ignored = set(d.get("ignored", []))
    rows = []
    for c in cols:
        col = c["col"]
        pt = d["points"].get(col)
        if pt is None:
            tag, sub, conf = _guess_equipment(col, tags) if tags else ("", "", 0.0)
            meas, unit, stat = _guess_measure(col)
            pt = {"col": col, "tag": tag, "sub": sub, "measure": meas, "unit": unit,
                  "stat": stat, "drawing": names.get(tag, {}).get("drawing", ""),
                  "lo": c.get("p1"), "hi": c.get("p99"), "range_by": "system",
                  "confirmed": False, "guess": True, "guess_conf": conf}
        else:
            pt = {**pt, "guess": False}
        pt["ignored"] = col in ignored
        pt["stats"] = c
        pt["tag_name"] = names.get(pt.get("tag", ""), {}).get("name", "")
        rows.append(pt)
    # 設備覆蓋率：每台設備底下掛了幾個點（含猜的、分開算）
    cover = {}
    for t in tags:
        cover[t] = {"tag": t, "name": names[t]["name"], "drawing": names[t]["drawing"],
                    "on_drawing": names[t]["on_drawing"], "points": 0, "confirmed": 0, "guessed": 0}
    for r in rows:
        t = r.get("tag")
        if t in cover and not r["ignored"]:
            cover[t]["points"] += 1
            if r.get("confirmed"):
                cover[t]["confirmed"] += 1
            elif r.get("guess"):
                cover[t]["guessed"] += 1
    return {
        "meta": meta, "drawings": d["drawings"], "points": rows,
        "equipment": sorted(cover.values(), key=lambda x: _num_key(x["tag"])),
        "summary": {
            "columns": len(rows),
            "confirmed": sum(1 for r in rows if r.get("confirmed")),
            "guessed": sum(1 for r in rows if r.get("guess") and r.get("tag") and not r["ignored"]),
            "unassigned": sum(1 for r in rows if not r.get("tag") and not r["ignored"]),
            "ignored": len(ignored),
            "equipment_total": len(tags),
            "equipment_covered": sum(1 for c in cover.values() if c["points"] > 0),
        },
    }


@router.put("/{sid}/drawings")
def mapping_set_drawings(sid: str, req: DrawingsReq, request: Request) -> dict:
    from .auth import current_domain
    from .pid_vlm import _safe_pdf

    for fn in req.drawings:
        _safe_pdf(fn)
    dom = current_domain(request)
    with _LOCK:
        d = _load(sid, dom)
        d["drawings"] = list(dict.fromkeys(req.drawings))
        _save(sid, dom, d)
    return {"ok": True, "drawings": d["drawings"]}


@router.put("/{sid}/point")
def mapping_put_point(sid: str, req: PointReq, request: Request) -> dict:
    """存一個量測點的對照（人確認過或改過）。"""
    from datetime import datetime, timezone

    from .auth import current_actor, current_domain

    dom = current_domain(request)
    rec = req.model_dump()
    rec["by"] = current_actor(request)
    rec["at"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    with _LOCK:
        d = _load(sid, dom)
        d["points"][req.col] = rec
        if req.col in d["ignored"]:
            d["ignored"].remove(req.col)
        _save(sid, dom, d)
    return {"ok": True}


class BulkReq(BaseModel):
    cols: list
    action: str            # confirm | ignore | unignore | clear


@router.post("/{sid}/bulk")
def mapping_bulk(sid: str, req: BulkReq, request: Request) -> dict:
    """批次：把一批（通常是高信心猜中的）直接確認／忽略／清除。

    確認時把當下的猜測寫進 points（帶 by/at），之後就不再重猜。
    """
    from datetime import datetime, timezone

    from .auth import current_actor, current_domain

    dom = current_domain(request)
    who = current_actor(request)
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    n = 0
    with _LOCK:
        d = _load(sid, dom)
        if req.action in ("confirm",):
            # 需要當下的猜測 → 重算一次
            cols, _ = column_stats(sid)
            tags, names = _asset_tags(d["drawings"], request)
            stat_of = {c["col"]: c for c in cols}
            for col in req.cols:
                if col in d["points"]:
                    d["points"][col]["confirmed"] = True
                    d["points"][col]["by"] = who
                    d["points"][col]["at"] = now
                    n += 1
                    continue
                if col not in stat_of:
                    continue
                tag, sub, _c = _guess_equipment(col, tags) if tags else ("", "", 0.0)
                meas, unit, stat = _guess_measure(col)
                c = stat_of[col]
                d["points"][col] = {"col": col, "tag": tag, "sub": sub, "measure": meas,
                                    "unit": unit, "stat": stat,
                                    "drawing": names.get(tag, {}).get("drawing", ""),
                                    "lo": c.get("p1"), "hi": c.get("p99"),
                                    "range_by": "system", "note": "",
                                    "confirmed": True, "by": who, "at": now}
                n += 1
        elif req.action == "ignore":
            for col in req.cols:
                if col not in d["ignored"]:
                    d["ignored"].append(col)
                    n += 1
        elif req.action == "unignore":
            d["ignored"] = [c for c in d["ignored"] if c not in req.cols]
            n = len(req.cols)
        elif req.action == "clear":
            for col in req.cols:
                if col in d["points"]:
                    del d["points"][col]
                    n += 1
        else:
            raise HTTPException(422, "action 需為 confirm / ignore / unignore / clear")
        _save(sid, dom, d)
    return {"ok": True, "n": n}


@router.get("/{sid}/series")
def mapping_series(sid: str, col: str, n: int = 400) -> dict:
    """單欄降採樣時序（給對照面板看趨勢，判斷這欄像不像那個量測）。"""
    import numpy as np
    import pandas as pd

    from .dataprep import _load_base, _load_meta

    meta = _load_meta(sid) or {}
    df = _load_base(sid)
    if col not in df.columns:
        raise HTTPException(404, "欄位不存在")
    s = pd.to_numeric(df[col], errors="coerce")
    tcol = meta.get("time_col")
    t = df[tcol] if tcol and tcol in df.columns else pd.Series(range(len(df)))
    step = max(1, len(df) // max(n, 10))
    idx = np.arange(0, len(df), step)
    return {"t": [str(x)[:16] for x in t.iloc[idx]],
            "v": [None if pd.isna(x) else float(x) for x in s.iloc[idx]]}
