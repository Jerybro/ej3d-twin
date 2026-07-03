"""產品2：資料前處理平台 — 對標 Tukey 探索分析與資料清理。

核心架構：**編輯歷程 steps pipeline**（Tukey 專案編輯歷程的對標）——
每個清理動作是一個步驟（可個別啟用/停用/刪除），資料視圖＝base 資料
依序重放啟用中的步驟。同一份資料可以有不同的清理歷程。

Session：上傳得 sid，base 資料存 uploads/data/{sid}.parquet，
歷程存 {sid}.steps.json。物性模組（CoolProp）＝AI 外插的物理柵欄。
"""

from __future__ import annotations

import io
import json
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, PlainTextResponse

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "uploads" / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

router = APIRouter(prefix="/api/data", tags=["dataprep"])

MAX_PREVIEW = 50
MAX_SERIES = 5000


# ------------------------------------------------------------ session 存取
def _pq(sid: str) -> Path:
    p = DATA_DIR / f"{sid}.parquet"
    if not p.exists():
        raise HTTPException(404, f"資料 session 不存在: {sid}")
    return p


def _load_base(sid: str) -> pd.DataFrame:
    return pd.read_parquet(_pq(sid))


def _steps_path(sid: str) -> Path:
    return DATA_DIR / f"{sid}.steps.json"


def _load_steps(sid: str) -> list:
    p = _steps_path(sid)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def _save_steps(sid: str, steps: list) -> None:
    _steps_path(sid).write_text(json.dumps(steps, ensure_ascii=False), encoding="utf-8")


# ------------------------------------------------------ steps pipeline 重放
def _step_mask(df: pd.DataFrame, step: dict) -> pd.Series:
    """回傳該步驟要「剔除」的布林遮罩（True=剔除）。"""
    kind = step["kind"]
    p = step.get("params", {})
    if kind == "manual_exclude":
        return pd.Series(df.index.isin(p.get("rows", [])), index=df.index)
    col = p.get("col")
    if col not in df.columns:
        return pd.Series(False, index=df.index)
    s = pd.to_numeric(df[col], errors="coerce")
    if kind == "extract":
        # 萃取：僅保留條件內 → 條件外剔除（Tukey 四操作之一）
        keep = ((s >= p.get("lo", -np.inf)) & (s <= p.get("hi", np.inf))).fillna(False)
        return ~keep
    if kind == "exclude_range":
        # 排除：刪除選定區間內的資料（Tukey「排除資料」語意）
        return ((s >= p.get("lo", -np.inf)) & (s <= p.get("hi", np.inf))).fillna(False)
    if kind == "range":
        return ((s < p.get("lo", -np.inf)) | (s > p.get("hi", np.inf))).fillna(False)
    if kind == "jump":
        return (s.diff().abs() > p.get("max_abs", np.inf)).fillna(False)
    if kind == "jump_pct":
        return (s.pct_change().abs() > p.get("max_pct", np.inf) / 100).fillna(False)
    if kind == "quantile":
        lo, hi = s.quantile(p.get("lo_q", 0.005)), s.quantile(p.get("hi_q", 0.995))
        return ((s < lo) | (s > hi)).fillna(False)
    if kind == "flatline":
        same = s.diff().abs() < 1e-12
        run = same.groupby((~same).cumsum()).cumsum()
        return (run >= p.get("min_run", 3)).fillna(False)
    if kind == "props_bounds":
        return pd.Series(df.index.isin(p.get("rows", [])), index=df.index)
    return pd.Series(False, index=df.index)


def apply_steps(df: pd.DataFrame, steps: list):
    """重放啟用中的步驟 → (視圖 df, reason series, 每步剔除數, 隱藏欄, 聚合資訊)。

    row-filter 步驟以「先到先標」記 reason；resample 聚合最後套用。
    """
    reason = pd.Series("", index=df.index)
    per_step = {}
    hidden: list[str] = []
    resample = None
    for st in steps:
        if not st.get("enabled", True):
            per_step[st["id"]] = 0
            continue
        if st["kind"] == "hide_columns":
            hidden = [c for c in st["params"].get("cols", []) if c in df.columns]
            per_step[st["id"]] = len(hidden)
            continue
        if st["kind"] == "resample":
            resample = st["params"]
            per_step[st["id"]] = 0
            continue
        bad = _step_mask(df, st)
        fresh = bad & (reason == "")
        reason[fresh] = st.get("label", st["kind"])
        per_step[st["id"]] = int(fresh.sum())
    view = df[reason == ""].copy()
    if resample:
        tcol = resample.get("time_col")
        if tcol in view.columns and pd.api.types.is_datetime64_any_dtype(view[tcol]):
            agg = resample.get("agg", "mean")
            num_cols = view.select_dtypes(include="number").columns
            view = view.set_index(tcol)[num_cols].resample(resample.get("freq", "1D")).agg(agg).reset_index()
    if hidden:
        view = view.drop(columns=[c for c in hidden if c in view.columns])
    return view, reason, per_step, hidden, resample


def _view(sid: str):
    df = _load_base(sid)
    steps = _load_steps(sid)
    return df, steps, *apply_steps(df, steps)


def _f(v):
    try:
        v = float(v)
        return None if np.isnan(v) or np.isinf(v) else round(v, 4)
    except (TypeError, ValueError):
        return None


def _summary(df: pd.DataFrame, hidden: list | None = None) -> dict:
    cols = []
    for c in df.columns:
        s = df[c]
        info = {"name": str(c), "dtype": str(s.dtype),
                "nonnull_pct": round(float(s.notna().mean()) * 100, 1),
                "hidden": bool(hidden and c in hidden)}
        if pd.api.types.is_numeric_dtype(s):
            info.update({"min": _f(s.min()), "max": _f(s.max()), "mean": _f(s.mean()), "std": _f(s.std())})
        cols.append(info)
    return {"n_rows": len(df), "columns": cols}


# ---------------------------------------------------------------- 上傳
FORMAT_SPEC = ("上傳格式規定：CSV（UTF-8）或 Excel，第一列為欄位名稱；"
               "必須包含一個時間欄（建議名為 time，ISO 格式如 2025-06-01 00:00:00）"
               "＋至少一個數值欄（PI 位號等）。範例：time, 8AR1_FIC70005, 8AR1_TIC70016, ...")


@router.post("/upload")
async def upload(file: UploadFile = File(...)) -> dict:
    name = (file.filename or "").lower()
    raw = await file.read()
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(422, f"檔案超過 50MB 上限。{FORMAT_SPEC}")
    try:
        if name.endswith((".xlsx", ".xls", ".xlsm")):
            df = pd.read_excel(io.BytesIO(raw))
        else:
            df = pd.read_csv(io.BytesIO(raw), encoding="utf-8-sig")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"解析失敗（{type(e).__name__}）。{FORMAT_SPEC}") from None
    if df.empty:
        raise HTTPException(422, f"檔案無資料。{FORMAT_SPEC}")

    # 時間欄偵測與驗證：優先名為 time 的欄，否則前 3 欄中找可解析者
    time_col = None
    candidates = [c for c in df.columns if str(c).lower() == "time"] + list(df.columns[:3])
    for c in candidates:
        s = df[c]
        if pd.api.types.is_datetime64_any_dtype(s):
            time_col = c
            break
        if pd.api.types.is_string_dtype(s) or s.dtype == object:
            dt = pd.to_datetime(s, errors="coerce")
            if dt.notna().mean() > 0.9:
                df[c] = dt
                time_col = c
                break
    if time_col is None:
        raise HTTPException(422, f"找不到有效時間欄（ISO 時戳解析成功率需 >90%）。{FORMAT_SPEC}")
    n_numeric = df.select_dtypes(include="number").shape[1]
    if n_numeric < 1:
        raise HTTPException(422, f"至少需要一個數值欄。{FORMAT_SPEC}")

    # 系統欄 __id__（流水號，Tukey 同款）
    if "__id__" not in df.columns:
        df.insert(0, "__id__", range(1, len(df) + 1))

    sid = uuid.uuid4().hex[:8]
    df.to_parquet(DATA_DIR / f"{sid}.parquet")
    _save_steps(sid, [])
    meta = {"filename": file.filename, "time_col": str(time_col),
            "uploaded_at": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")}
    (DATA_DIR / f"{sid}.meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return {"sid": sid, **meta, **_summary(df),
            "preview": json.loads(df.head(MAX_PREVIEW).to_json(orient="records", date_format="iso", force_ascii=False))}


def _load_meta(sid: str) -> dict:
    p = DATA_DIR / f"{sid}.meta.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


@router.get("/{sid}/state")
def state(sid: str) -> dict:
    df, steps, view, reason, per_step, hidden, resample = _view(sid)
    return {
        "n_base": len(df), "n_view": len(view),
        "excluded": int((reason != "").sum()),
        "steps": [{**st, "hits": per_step.get(st["id"], 0)} for st in steps],
        **_load_meta(sid),
        **_summary(df, hidden),
    }


# ------------------------------------------------- 卡片牆資料（Tukey 探索分析）
@router.get("/{sid}/cards")
def cards(sid: str, target: str = "", page: int = 1, per_page: int = 9, bins: int = 24) -> dict:
    """一次回傳一頁卡片的圖資料。
    單維模式（target 空）：每欄直方圖；二維模式：每欄 vs target 散佈抽樣。"""
    df, steps, view, reason, per_step, hidden, _ = _view(sid)
    cols = [c for c in view.columns if c != "__id__"]
    total = len(cols)
    lo, hi = (page - 1) * per_page, page * per_page
    page_cols = cols[lo:hi]
    tgt = view[target] if target and target in view.columns else None

    out = []
    for c in page_cols:
        s = view[c]
        is_time = pd.api.types.is_datetime64_any_dtype(s)
        is_num = pd.api.types.is_numeric_dtype(s)
        card = {"col": str(c), "kind": "time" if is_time else "numeric" if is_num else "string"}
        if tgt is not None and c != target and pd.api.types.is_numeric_dtype(tgt):
            # 二維：c（X）vs target（Y）散佈
            sub = pd.DataFrame({"x": s, "y": tgt}).dropna()
            if len(sub) > 500:
                sub = sub.sample(500, random_state=0).sort_index()
            xs = (sub["x"].astype("int64") // 10**6).tolist() if is_time else \
                 [_f(v) for v in sub["x"]] if is_num else sub["x"].astype(str).tolist()
            card.update({"mode": "scatter", "x": xs, "y": [_f(v) for v in sub["y"]],
                         "x_is_time": is_time})
        elif is_num:
            vals = pd.to_numeric(s, errors="coerce").dropna()
            if len(vals):
                counts, edges = np.histogram(vals, bins=bins)
                card.update({"mode": "hist", "counts": counts.tolist(),
                             "edges": [_f(e) for e in edges]})
            else:
                card.update({"mode": "empty"})
        elif is_time:
            vals = s.dropna().astype("int64") // 10**6
            if len(vals):
                counts, edges = np.histogram(vals, bins=bins)
                card.update({"mode": "hist", "counts": counts.tolist(),
                             "edges": edges.tolist(), "x_is_time": True})
            else:
                card.update({"mode": "empty"})
        else:
            vc = s.astype(str).value_counts().head(10)
            card.update({"mode": "bar", "labels": vc.index.tolist(), "counts": vc.values.tolist()})
        out.append(card)
    return {"cards": out, "total_cols": total, "page": page, "per_page": per_page,
            "n_view": len(view), "target": target or None}


# ------------------------------------------------- 資料萃取樣板（歷程複用）
@router.get("/{sid}/template")
def get_template(sid: str) -> dict:
    return {"steps": _load_steps(sid), "note": "資料萃取樣板：可套用至相同欄位結構的新資料集"}


@router.post("/{sid}/apply_template")
def apply_template(sid: str, body: dict) -> dict:
    """把樣板 steps 套到本 session（覆蓋現有歷程）。body = {steps: [...]}"""
    steps = body.get("steps", [])
    for st in steps:
        st.setdefault("id", uuid.uuid4().hex[:6])
        st.setdefault("enabled", True)
    _save_steps(sid, steps)
    return state(sid)


# ------------------------------------------------- 資料集表格頁
@router.get("/{sid}/rows")
def rows(sid: str, page: int = 1, per_page: int = 15) -> dict:
    _, _, view, *_ = _view(sid)
    lo = (page - 1) * per_page
    sub = view.iloc[lo:lo + per_page]
    return {"rows": json.loads(sub.to_json(orient="records", date_format="iso", force_ascii=False)),
            "n_view": len(view), "page": page, "per_page": per_page,
            "columns": [{"name": str(c),
                         "kind": "time" if pd.api.types.is_datetime64_any_dtype(view[c])
                         else "numeric" if pd.api.types.is_numeric_dtype(view[c]) else "string"}
                        for c in view.columns]}


# ------------------------------------------------------------ 編輯歷程 CRUD
@router.post("/{sid}/steps")
def add_step(sid: str, body: dict) -> dict:
    """新增清理步驟。body = {kind, label, params}"""
    steps = _load_steps(sid)
    step = {"id": uuid.uuid4().hex[:6], "kind": body["kind"],
            "label": body.get("label") or body["kind"],
            "params": body.get("params", {}), "enabled": True}
    steps.append(step)
    _save_steps(sid, steps)
    return state(sid)


@router.patch("/{sid}/steps/{step_id}")
def toggle_step(sid: str, step_id: str, body: dict) -> dict:
    """切換步驟啟用狀態（Tukey：還原任一清理步驟）。body = {enabled}"""
    steps = _load_steps(sid)
    for st in steps:
        if st["id"] == step_id:
            st["enabled"] = bool(body.get("enabled", True))
            break
    else:
        raise HTTPException(404, "步驟不存在")
    _save_steps(sid, steps)
    return state(sid)


@router.delete("/{sid}/steps/{step_id}")
def delete_step(sid: str, step_id: str) -> dict:
    steps = [st for st in _load_steps(sid) if st["id"] != step_id]
    _save_steps(sid, steps)
    return state(sid)


# ------------------------------------------------------------ 序列與圖表
@router.get("/{sid}/series")
def series(sid: str, cols: str, max_points: int = MAX_SERIES) -> dict:
    df, steps, view, reason, *_ = _view(sid)
    want = [c for c in cols.split(",") if c in df.columns]
    if not want:
        raise HTTPException(422, "無有效欄位")
    step = max(1, len(df) // max_points)
    sub = df.iloc[::step]
    reasons = reason.iloc[::step]
    dt_col = next((c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])), None)
    x = sub[dt_col].astype("int64").floordiv(10**6).tolist() if dt_col else sub.index.tolist()
    out_cols = {}
    for c in want:
        s = pd.to_numeric(sub[c], errors="coerce")
        out_cols[c] = [None if pd.isna(v) else round(float(v), 4) for v in s]
    return {"x": x, "x_is_time": dt_col is not None, "cols": out_cols,
            "row_idx": sub.index.tolist(), "excluded": [bool(r) for r in reasons]}


@router.get("/{sid}/hist")
def hist(sid: str, col: str, bins: int = 30) -> dict:
    """單變量：數值→直方圖、字串→值計數（Tukey 自動單變量圖）。"""
    _, _, view, *_ = _view(sid)
    if col not in view.columns:
        raise HTTPException(404, "欄位不存在（可能被隱藏）")
    s = view[col]
    if pd.api.types.is_numeric_dtype(s):
        vals = s.dropna()
        if not len(vals):
            return {"type": "empty"}
        counts, edges = np.histogram(vals, bins=bins)
        return {"type": "hist", "counts": counts.tolist(),
                "edges": [round(float(e), 4) for e in edges],
                "stats": {"mean": _f(vals.mean()), "std": _f(vals.std()),
                          "min": _f(vals.min()), "max": _f(vals.max()),
                          "missing_pct": round(float(s.isna().mean()) * 100, 1)}}
    vc = s.astype(str).value_counts().head(12)
    return {"type": "bar", "labels": vc.index.tolist(), "counts": vc.values.tolist()}


@router.get("/{sid}/bivariate")
def bivariate(sid: str, x: str, y: str, max_points: int = 3000) -> dict:
    """雙變量：數值×數值→散佈、數值×字串→箱型（Tukey 自動選型）。"""
    _, _, view, *_ = _view(sid)
    for c in (x, y):
        if c not in view.columns:
            raise HTTPException(404, f"欄位不存在: {c}")
    sx, sy = view[x], view[y]
    x_num = pd.api.types.is_numeric_dtype(sx) or pd.api.types.is_datetime64_any_dtype(sx)
    y_num = pd.api.types.is_numeric_dtype(sy)
    if x_num and y_num:
        sub = view[[x, y]].dropna()
        if len(sub) > max_points:
            sub = sub.sample(max_points, random_state=0).sort_index()
        xs = (sub[x].astype("int64") // 10**6).tolist() if pd.api.types.is_datetime64_any_dtype(sx) else [round(float(v), 4) for v in sub[x]]
        return {"type": "scatter", "x": xs, "y": [round(float(v), 4) for v in sub[y]],
                "row_idx": sub.index.tolist()}
    # 類別 × 數值 → 箱型
    cat, num = (x, y) if y_num else (y, x)
    groups = []
    for k, grp in view.groupby(view[cat].astype(str))[num]:
        g = pd.to_numeric(grp, errors="coerce").dropna()
        if not len(g):
            continue
        q = g.quantile([0.25, 0.5, 0.75])
        groups.append({"label": str(k)[:20], "min": _f(g.min()), "q1": _f(q[0.25]),
                       "med": _f(q[0.5]), "q3": _f(q[0.75]), "max": _f(g.max()), "n": len(g)})
        if len(groups) >= 15:
            break
    return {"type": "box", "groups": groups, "cat": cat, "num": num}


# ------------------------------------------------------------ 資料健檢（Tukey 同款三規則）
@router.get("/{sid}/health")
def health(sid: str) -> dict:
    _, _, view, *_ = _view(sid)
    n = len(view)
    out = []
    for c in view.columns:
        s = view[c]
        warns = []
        if s.nunique() > n * 0.20 and not pd.api.types.is_float_dtype(s):
            warns.append("ID-ness（不重複值 >20%，類 ID/流水號）")
        if len(s) and (s.value_counts().iloc[0] if len(s.value_counts()) else 0) > n * 0.75:
            warns.append("大量重複值（最多重複 >75%，資訊量過少）")
        if s.isna().mean() > 0.30:
            warns.append("大量遺失值（>30%）")
        if warns:
            out.append({"col": str(c), "warnings": warns})
    return {"n_rows": n, "issues": out,
            "note": "有警告的欄位不建議作為自變數（Tukey 資料健檢同款判準）"}


# ------------------------------------------------------------ 相關分析
@router.get("/{sid}/corr")
def corr(sid: str, cols: str = "", method: str = "pearson") -> dict:
    if method not in ("pearson", "spearman", "kendall"):
        raise HTTPException(422, "method 限 pearson/spearman/kendall")
    _, _, view, *_ = _view(sid)
    num = view.select_dtypes(include="number")
    if cols:
        want = [c for c in cols.split(",") if c in num.columns]
        num = num[want]
    num = num.loc[:, num.std() > 0]
    if num.shape[1] < 2:
        raise HTTPException(422, "至少需要 2 個有變異的數值欄")
    m = num.corr(method=method).round(3)
    return {"cols": list(m.columns), "matrix": m.values.tolist(), "n_used": len(view), "method": method}


# ------------------------------------------------------------ 分析報表（Tukey html 報表輕量版）
@router.get("/{sid}/report")
def report(sid: str) -> HTMLResponse:
    df, steps, view, reason, *_ = _view(sid)
    num = view.select_dtypes(include="number")
    corr_html = ""
    if num.shape[1] >= 2:
        num_v = num.loc[:, num.std() > 0]
        rows = []
        for method in ("pearson", "spearman", "kendall"):
            m = num_v.corr(method=method)
            pairs = m.where(~np.tril(np.ones(m.shape, bool))).stack().sort_values(key=abs, ascending=False).head(10)
            rows.append(f"<h3>{method.title()} 前 10 強相關</h3><table><tr><th>欄位對</th><th>r</th></tr>"
                        + "".join(f"<tr><td>{a} × {b}</td><td>{v:.3f}</td></tr>" for (a, b), v in pairs.items())
                        + "</table>")
        corr_html = "".join(rows)
    var_rows = ""
    for c in view.columns:
        s = view[c]
        if pd.api.types.is_numeric_dtype(s):
            var_rows += (f"<tr><td>{c}</td><td>{s.dtype}</td><td>{s.notna().sum()}</td>"
                         f"<td>{_f(s.mean())}</td><td>{_f(s.std())}</td><td>{_f(s.min())}</td><td>{_f(s.max())}</td></tr>")
        else:
            var_rows += f"<tr><td>{c}</td><td>{s.dtype}</td><td>{s.notna().sum()}</td><td colspan=4>{s.nunique()} 個不重複值</td></tr>"
    miss = view.isna().sum()
    miss_rows = "".join(f"<tr><td>{c}</td><td>{v}</td><td>{v / len(view) * 100:.1f}%</td></tr>"
                        for c, v in miss.items() if v > 0) or "<tr><td colspan=3>無遺漏值</td></tr>"
    steps_rows = "".join(f"<tr><td>{st.get('label')}</td><td>{st['kind']}</td><td>{'啟用' if st.get('enabled') else '停用'}</td></tr>"
                         for st in steps) or "<tr><td colspan=3>無清理步驟</td></tr>"
    html = f"""<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>資料分析報表</title><style>
body{{font-family:'Microsoft JhengHei',sans-serif;margin:32px;color:#1c2733}}
h1{{font-size:22px}} h2{{font-size:17px;border-bottom:2px solid #46c2e0;padding-bottom:4px;margin-top:28px}}
h3{{font-size:14px}} table{{border-collapse:collapse;font-size:13px;margin:8px 0}}
td,th{{border:1px solid #cdd7de;padding:4px 10px;text-align:left}} th{{background:#eef4f7}}
</style></head><body>
<h1>資料分析報表</h1>
<h2>Overview</h2>
<table><tr><td>原始筆數</td><td>{len(df)}</td></tr><tr><td>清理後筆數</td><td>{len(view)}</td></tr>
<tr><td>剔除筆數</td><td>{int((reason != '').sum())}</td></tr><tr><td>欄位數</td><td>{len(view.columns)}</td></tr></table>
<h2>Variables</h2>
<table><tr><th>欄位</th><th>型別</th><th>非空</th><th>均值</th><th>標準差</th><th>最小</th><th>最大</th></tr>{var_rows}</table>
<h2>Correlations</h2>{corr_html or '<p>數值欄不足</p>'}
<h2>Missing Values</h2>
<table><tr><th>欄位</th><th>遺漏數</th><th>比例</th></tr>{miss_rows}</table>
<h2>清理歷程</h2>
<table><tr><th>步驟</th><th>類型</th><th>狀態</th></tr>{steps_rows}</table>
<h2>Sample</h2>
{view.head(8).to_html(index=False)}
</body></html>"""
    return HTMLResponse(html, headers={"Content-Disposition": f"attachment; filename=report_{sid}.html"})


# ------------------------------------------------------------ 匯出
@router.get("/{sid}/export")
def export(sid: str) -> PlainTextResponse:
    _, _, view, *_ = _view(sid)
    return PlainTextResponse(view.to_csv(index=False), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=cleaned_{sid}.csv"})


# ---------------------------------------------------- CoolProp 物性模組
FLUIDS = ["Water", "Toluene", "Benzene", "p-Xylene", "m-Xylene", "o-Xylene",
          "Methane", "Hydrogen", "Nitrogen", "Ammonia", "CarbonDioxide", "Propane", "IsoButane"]


def _to_K(v, unit):
    return v + 273.15 if unit == "C" else v


def _to_Pa(v, unit):
    return {"kPa": v * 1e3, "bar": v * 1e5, "kgcm2": v * 98066.5, "Pa": v}.get(unit, v)


@router.get("/props/fluids")
def fluids() -> list:
    return FLUIDS


@router.post("/{sid}/props/check")
def props_check(sid: str, body: dict) -> dict:
    """物理合理性檢查：超出物性邊界的資料點→新增 props_bounds 清理步驟。"""
    import CoolProp.CoolProp as CP

    df = _load_base(sid)
    fluid, t_col = body.get("fluid"), body.get("t_col")
    t_unit, p_col, p_unit = body.get("t_unit", "C"), body.get("p_col"), body.get("p_unit", "kgcm2")
    if fluid not in FLUIDS or t_col not in df.columns:
        raise HTTPException(422, "需要有效 fluid 與 t_col")
    T = _to_K(pd.to_numeric(df[t_col], errors="coerce"), t_unit)
    Tmin, Tcrit, Pcrit = CP.PropsSI("Tmin", fluid), CP.PropsSI("Tcrit", fluid), CP.PropsSI("Pcrit", fluid)
    bad = (T < Tmin) | (T > Tcrit)
    findings = {"fluid": fluid, "T_range_K": [round(Tmin, 1), round(Tcrit, 1)],
                "out_of_T_range": int(bad.fillna(False).sum())}
    if p_col and p_col in df.columns:
        P = _to_Pa(pd.to_numeric(df[p_col], errors="coerce"), p_unit)
        bad_p = (P <= 0) | (P > Pcrit * 1.5)
        findings["out_of_P_range"] = int(bad_p.fillna(False).sum())
        findings["P_crit_bar"] = round(Pcrit / 1e5, 2)
        bad = bad | bad_p
    if body.get("mark", False):
        rows = df.index[bad.fillna(False)].tolist()
        if rows:
            steps = _load_steps(sid)
            steps.append({"id": uuid.uuid4().hex[:6], "kind": "props_bounds",
                          "label": f"物理不合理（{fluid} 物性邊界）",
                          "params": {"rows": rows}, "enabled": True})
            _save_steps(sid, steps)
        findings["marked"] = len(rows)
    return findings


@router.post("/{sid}/props/derive")
def props_derive(sid: str, body: dict) -> dict:
    """物性欄位推算：T（＋P）→ Psat/密度/cp 衍生特徵。"""
    import CoolProp.CoolProp as CP

    df = _load_base(sid)
    fluid, t_col = body.get("fluid"), body.get("t_col")
    t_unit, p_col, p_unit = body.get("t_unit", "C"), body.get("p_col"), body.get("p_unit", "kgcm2")
    if fluid not in FLUIDS or t_col not in df.columns:
        raise HTTPException(422, "需要有效 fluid 與 t_col")
    T = _to_K(pd.to_numeric(df[t_col], errors="coerce"), t_unit)
    Tmin, Tcrit = CP.PropsSI("Tmin", fluid), CP.PropsSI("Tcrit", fluid)
    Tc = T.clip(Tmin, Tcrit - 0.1)
    P = _to_Pa(pd.to_numeric(df[p_col], errors="coerce"), p_unit) if p_col and p_col in df.columns else None
    new_cols = []

    def _col(name, fn):
        vals = []
        for tv, pv in zip(Tc, P if P is not None else Tc):
            try:
                vals.append(round(float(fn(tv, pv)), 4))
            except Exception:  # noqa: BLE001
                vals.append(None)
        cname = f"{fluid}_{name}"
        df[cname] = vals
        new_cols.append(cname)

    _col("Psat_bar", lambda t, _: CP.PropsSI("P", "T", t, "Q", 0, fluid) / 1e5)
    if P is not None:
        _col("rho_kgm3", lambda t, p: CP.PropsSI("D", "T", t, "P", max(p, 1e3), fluid))
        _col("cp_Jkg", lambda t, p: CP.PropsSI("C", "T", t, "P", max(p, 1e3), fluid))
    else:
        _col("rho_sat_kgm3", lambda t, _: CP.PropsSI("D", "T", t, "Q", 0, fluid))
    df.to_parquet(DATA_DIR / f"{sid}.parquet")
    return {"ok": True, "new_columns": new_cols, **_summary(df)}
