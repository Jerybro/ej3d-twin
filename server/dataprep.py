"""產品2：資料前處理平台 — 上傳/圈選清洗/規則過濾/相關分析/CoolProp 物性模組。

Session 制：上傳一份數據得一個 sid，DataFrame 存 uploads/data/{sid}.parquet，
遮罩（keep/reason）存 {sid}.mask.json——非破壞性清洗，可復原、可審計。
物性模組（CoolProp）提供物理合理性檢查與物性欄位推算：AI 外插的物理柵欄。
"""

from __future__ import annotations

import io
import json
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "uploads" / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

router = APIRouter(prefix="/api/data", tags=["dataprep"])

MAX_PREVIEW = 50
MAX_SERIES = 5000


def _pq(sid: str) -> Path:
    p = DATA_DIR / f"{sid}.parquet"
    if not p.exists():
        raise HTTPException(404, f"資料 session 不存在: {sid}")
    return p


def _load(sid: str) -> pd.DataFrame:
    return pd.read_parquet(_pq(sid))


def _mask_path(sid: str) -> Path:
    return DATA_DIR / f"{sid}.mask.json"


def _load_mask(sid: str, n: int) -> dict:
    p = _mask_path(sid)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"reason": [""] * n}


def _save_mask(sid: str, mask: dict) -> None:
    _mask_path(sid).write_text(json.dumps(mask, ensure_ascii=False), encoding="utf-8")


def _summary(df: pd.DataFrame) -> dict:
    cols = []
    for c in df.columns:
        s = df[c]
        info = {"name": str(c), "dtype": str(s.dtype), "nonnull_pct": round(float(s.notna().mean()) * 100, 1)}
        if pd.api.types.is_numeric_dtype(s):
            info.update({"min": _f(s.min()), "max": _f(s.max()), "mean": _f(s.mean()), "std": _f(s.std())})
        cols.append(info)
    return {"n_rows": len(df), "columns": cols}


def _f(v) -> float | None:
    try:
        v = float(v)
        return None if np.isnan(v) or np.isinf(v) else round(v, 4)
    except (TypeError, ValueError):
        return None


@router.post("/upload")
async def upload(file: UploadFile = File(...)) -> dict:
    name = (file.filename or "").lower()
    raw = await file.read()
    try:
        if name.endswith((".xlsx", ".xls", ".xlsm")):
            df = pd.read_excel(io.BytesIO(raw))
        else:
            df = pd.read_csv(io.BytesIO(raw), encoding="utf-8-sig")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"解析失敗: {type(e).__name__}") from None
    if df.empty:
        raise HTTPException(422, "檔案無資料")
    # 自動偵測 datetime 欄轉型（首個成功者當索引軸顯示用，不設 index）
    for c in df.columns[:3]:
        if df[c].dtype == object:
            dt = pd.to_datetime(df[c], errors="coerce")
            if dt.notna().mean() > 0.9:
                df[c] = dt
                break
    sid = uuid.uuid4().hex[:8]
    df.to_parquet(DATA_DIR / f"{sid}.parquet")
    _save_mask(sid, {"reason": [""] * len(df)})
    return {"sid": sid, "filename": file.filename, **_summary(df),
            "preview": json.loads(df.head(MAX_PREVIEW).to_json(orient="records", date_format="iso", force_ascii=False))}


@router.get("/{sid}/series")
def series(sid: str, cols: str, max_points: int = MAX_SERIES) -> dict:
    df = _load(sid)
    want = [c for c in cols.split(",") if c in df.columns]
    if not want:
        raise HTTPException(422, "無有效欄位")
    step = max(1, len(df) // max_points)
    sub = df.iloc[::step]
    mask = _load_mask(sid, len(df))
    reasons = mask["reason"][::step]
    # x 軸：datetime 欄或行號
    dt_col = next((c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])), None)
    x = sub[dt_col].astype("int64").floordiv(10**6).tolist() if dt_col else sub.index.tolist()
    out_cols = {}
    for c in want:
        s = pd.to_numeric(sub[c], errors="coerce")
        out_cols[c] = [None if pd.isna(v) else round(float(v), 4) for v in s]
    return {"x": x, "x_is_time": dt_col is not None, "cols": out_cols,
            "row_idx": sub.index.tolist(), "excluded": [bool(r) for r in reasons]}


@router.post("/{sid}/exclude")
def exclude(sid: str, body: dict) -> dict:
    """圈選剔除：body = {rows: [行號], reason: "手動圈選", restore: false}"""
    df = _load(sid)
    mask = _load_mask(sid, len(df))
    rows = body.get("rows", [])
    reason = body.get("reason", "手動圈選")
    restore = body.get("restore", False)
    for r in rows:
        if 0 <= r < len(mask["reason"]):
            mask["reason"][r] = "" if restore else reason
    _save_mask(sid, mask)
    kept = sum(1 for r in mask["reason"] if not r)
    return {"ok": True, "kept": kept, "excluded": len(mask["reason"]) - kept}


@router.post("/{sid}/rules")
def apply_rules(sid: str, body: dict) -> dict:
    """規則式清洗（五級穩態過濾的通用化）：
    body.rules = [
      {kind:'range',    col, lo, hi, label}          值域（停機/冷態閾值）
      {kind:'jump',     col, max_abs, label}         單日跳變（非穩態）
      {kind:'jump_pct', col, max_pct, label}         相對跳變
      {kind:'quantile', col, lo_q, hi_q, label}      分位離群
      {kind:'flatline', col, min_run, label}         凍結值（連續等值）
    ]；reset=true 先清除規則遮罩（保留手動圈選）"""
    df = _load(sid)
    mask = _load_mask(sid, len(df))
    if body.get("reset", True):
        mask["reason"] = ["" if r != "手動圈選" and r else r for r in mask["reason"]]
        mask["reason"] = [r if r == "手動圈選" else "" for r in mask["reason"]]
    counts: dict[str, int] = {}
    for rule in body.get("rules", []):
        col = rule.get("col")
        if col not in df.columns:
            continue
        s = pd.to_numeric(df[col], errors="coerce")
        kind = rule.get("kind")
        label = rule.get("label") or f"{kind}:{col}"
        if kind == "range":
            bad = (s < rule.get("lo", -np.inf)) | (s > rule.get("hi", np.inf))
        elif kind == "jump":
            bad = s.diff().abs() > rule.get("max_abs", np.inf)
        elif kind == "jump_pct":
            bad = s.pct_change().abs() > rule.get("max_pct", np.inf) / 100
        elif kind == "quantile":
            lo, hi = s.quantile(rule.get("lo_q", 0.005)), s.quantile(rule.get("hi_q", 0.995))
            bad = (s < lo) | (s > hi)
        elif kind == "flatline":
            same = s.diff().abs() < 1e-12
            run = same.groupby((~same).cumsum()).cumsum()
            bad = run >= rule.get("min_run", 3)
        else:
            continue
        n = 0
        for i in np.where(bad.fillna(False))[0]:
            if not mask["reason"][i]:
                mask["reason"][i] = label
                n += 1
        counts[label] = counts.get(label, 0) + n
    _save_mask(sid, mask)
    kept = sum(1 for r in mask["reason"] if not r)
    return {"ok": True, "kept": kept, "excluded": len(mask["reason"]) - kept, "by_reason": counts}


@router.get("/{sid}/corr")
def corr(sid: str, cols: str = "") -> dict:
    df = _load(sid)
    mask = _load_mask(sid, len(df))
    keep = [i for i, r in enumerate(mask["reason"]) if not r]
    num = df.iloc[keep].select_dtypes(include="number")
    if cols:
        want = [c for c in cols.split(",") if c in num.columns]
        num = num[want]
    num = num.loc[:, num.std() > 0]
    if num.shape[1] < 2:
        raise HTTPException(422, "至少需要 2 個有變異的數值欄")
    m = num.corr(method="pearson").round(3)
    return {"cols": list(m.columns), "matrix": m.values.tolist(), "n_used": len(keep)}


@router.get("/{sid}/export")
def export(sid: str) -> "PlainTextResponse":
    from fastapi.responses import PlainTextResponse

    df = _load(sid)
    mask = _load_mask(sid, len(df))
    keep = [i for i, r in enumerate(mask["reason"]) if not r]
    csv = df.iloc[keep].to_csv(index=False)
    return PlainTextResponse(csv, media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=cleaned_{sid}.csv"})


# ---------------------------------------------------- CoolProp 物性模組
FLUIDS = ["Water", "Toluene", "Benzene", "p-Xylene", "m-Xylene", "o-Xylene",
          "Methane", "Hydrogen", "Nitrogen", "Ammonia", "CarbonDioxide", "Propane", "IsoButane"]


def _to_K(v: pd.Series, unit: str) -> pd.Series:
    return v + 273.15 if unit == "C" else v


def _to_Pa(v: pd.Series, unit: str) -> pd.Series:
    return {"kPa": v * 1e3, "bar": v * 1e5, "kgcm2": v * 98066.5, "Pa": v}.get(unit, v)


@router.get("/props/fluids")
def fluids() -> list:
    return FLUIDS


@router.post("/{sid}/props/check")
def props_check(sid: str, body: dict) -> dict:
    """物理合理性檢查：T 欄位對照該流體 [三相點, 臨界點] 範圍；
    有 P 欄時再驗 P < P_crit×1.5 與 T>Tsat(P) 的相態一致性提示。
    超界資料點標記進遮罩（reason=物理不合理），治 AI 外插的第一道柵欄。"""
    import CoolProp.CoolProp as CP

    df = _load(sid)
    fluid = body.get("fluid")
    t_col, t_unit = body.get("t_col"), body.get("t_unit", "C")
    p_col, p_unit = body.get("p_col"), body.get("p_unit", "kgcm2")
    if fluid not in FLUIDS or t_col not in df.columns:
        raise HTTPException(422, "需要有效 fluid 與 t_col")
    T = _to_K(pd.to_numeric(df[t_col], errors="coerce"), t_unit)
    Tmin = CP.PropsSI("Tmin", fluid)
    Tcrit = CP.PropsSI("Tcrit", fluid)
    Pcrit = CP.PropsSI("Pcrit", fluid)
    bad = (T < Tmin) | (T > Tcrit)
    findings = {
        "fluid": fluid, "T_range_K": [round(Tmin, 1), round(Tcrit, 1)],
        "out_of_T_range": int(bad.fillna(False).sum()),
    }
    if p_col and p_col in df.columns:
        P = _to_Pa(pd.to_numeric(df[p_col], errors="coerce"), p_unit)
        bad_p = (P <= 0) | (P > Pcrit * 1.5)
        findings["out_of_P_range"] = int(bad_p.fillna(False).sum())
        findings["P_crit_bar"] = round(Pcrit / 1e5, 2)
        bad = bad | bad_p
    if body.get("mark", False):
        mask = _load_mask(sid, len(df))
        n = 0
        for i in np.where(bad.fillna(False))[0]:
            if not mask["reason"][i]:
                mask["reason"][i] = "物理不合理"
                n += 1
        _save_mask(sid, mask)
        findings["marked"] = n
    return findings


@router.post("/{sid}/props/derive")
def props_derive(sid: str, body: dict) -> dict:
    """物性欄位推算：以 T（＋P）為輸入補衍生物性欄位，供下游建模當物理特徵。"""
    import CoolProp.CoolProp as CP

    df = _load(sid)
    fluid = body.get("fluid")
    t_col, t_unit = body.get("t_col"), body.get("t_unit", "C")
    p_col, p_unit = body.get("p_col"), body.get("p_unit", "kgcm2")
    if fluid not in FLUIDS or t_col not in df.columns:
        raise HTTPException(422, "需要有效 fluid 與 t_col")
    T = _to_K(pd.to_numeric(df[t_col], errors="coerce"), t_unit)
    Tmin, Tcrit = CP.PropsSI("Tmin", fluid), CP.PropsSI("Tcrit", fluid)
    Tc = T.clip(Tmin, Tcrit - 0.1)
    new_cols = []

    def _col(name, fn):
        vals = []
        for tv, pv in zip(Tc, P if P is not None else Tc):
            try:
                vals.append(round(float(fn(tv, pv)), 4))
            except Exception:  # noqa: BLE001 — CoolProp 個別點失敗補 NaN
                vals.append(None)
        cname = f"{fluid}_{name}"
        df[cname] = vals
        new_cols.append(cname)

    P = _to_Pa(pd.to_numeric(df[p_col], errors="coerce"), p_unit) if p_col and p_col in df.columns else None
    _col("Psat_bar", lambda t, _: CP.PropsSI("P", "T", t, "Q", 0, fluid) / 1e5)
    if P is not None:
        _col("rho_kgm3", lambda t, p: CP.PropsSI("D", "T", t, "P", max(p, 1e3), fluid))
        _col("cp_Jkg", lambda t, p: CP.PropsSI("C", "T", t, "P", max(p, 1e3), fluid))
    else:
        _col("rho_sat_kgm3", lambda t, _: CP.PropsSI("D", "T", t, "Q", 0, fluid))
    df.to_parquet(DATA_DIR / f"{sid}.parquet")
    return {"ok": True, "new_columns": new_cols, **_summary(df)}
