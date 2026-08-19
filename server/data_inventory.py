# 資料盤點 —— 收到的資料在時間上長什麼樣子
#
# 建 ML 之前的第零步：手上這批檔案涵蓋哪段期間、幾分鐘一筆、中間斷過幾次。
# 沒有這一步，不同年份/不同取樣率的檔案混在一起訓練，錯誤不會報錯只會變成
# 爛模型（2023 的 LIMS 手填表和 2026 的 5 秒 DCS 直接 join，時間軸根本對不上）。
#
# 每個資料集算出：時間範圍、取樣間隔（中位數/眾數）、斷點、覆蓋率、年份分布。
# 算完落盤快取（{sid}.timeprofile.json）——170 萬列掃一次要十幾秒，不能每次開頁重算。
from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/data/inventory", tags=["data-inventory"])

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "uploads" / "data"

# 時間欄名的常見寫法（中英）。分開的日期＋時間兩欄也要認得——
# 潤泰的 DCS 匯出就是 `日期`,`時間` 兩欄，合起來才是時間戳。
DATE_PAT = re.compile(r"^(日期|date|dt|ymd|datum)$", re.I)
TIME_PAT = re.compile(r"^(時間|time|hms|clock)$", re.I)
TS_PAT = re.compile(r"(時間戳|timestamp|datetime|date_?time|記錄時間|采集時間|採集時間"
                    r"|ts|time_?stamp|包裝日期|生產日期|取樣時間|檢驗日期)", re.I)


def _profile_path(sid: str) -> Path:
    return DATA_DIR / f"{sid}.timeprofile.json"


def _roc_to_ad(s):
    """民國年 → 西元（112/7/6 0800 → 2023-07-06 08:00）。

    楊梅廠的品管表用民國年，pandas 直接 parse 會得到 0112 年——
    不轉的話整份資料的時間軸會落在兩千年前，甘特圖直接爆掉。
    """
    import pandas as pd

    def conv(v):
        m = re.match(r"^\s*(\d{2,3})[/\-](\d{1,2})[/\-](\d{1,2})(.*)$", str(v))
        if not m:
            return v
        y = int(m.group(1))
        if y > 1911:                     # 已經是西元
            return v
        rest = (m.group(4) or "").strip()
        # 民國合理範圍：60~200 年（1971~2111）。兩位數年份也可能是西元 24 年，
        # 但這個平台的資料不會早於 2000，所以一律當民國解。
        if not (60 <= y <= 200):
            return v
        return f"{y + 1911:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d} {rest}".strip()

    return s.map(conv)


def _find_time(df) -> tuple:
    """回 (時間序列, 來源說明)；找不到回 (None, 原因)。"""
    import pandas as pd

    cols = list(df.columns)
    # ① 日期 + 時間 兩欄
    dcol = next((c for c in cols if DATE_PAT.match(str(c).strip())), None)
    tcol = next((c for c in cols if TIME_PAT.match(str(c).strip())), None)
    if dcol is not None and tcol is not None:
        raw = df[dcol].astype(str).str.strip() + " " + df[tcol].astype(str).str.strip()
        ts = pd.to_datetime(_roc_to_ad(raw), errors="coerce")
        if ts.notna().sum() > len(df) * 0.5:
            return ts, f"「{dcol}」＋「{tcol}」兩欄合併"
    # ② 單一時間戳欄
    for c in cols:
        if TS_PAT.search(str(c)) or DATE_PAT.match(str(c).strip()):
            ts = pd.to_datetime(_roc_to_ad(df[c].astype(str)), errors="coerce")
            if ts.notna().sum() > len(df) * 0.5:
                return ts, f"「{c}」"
    # ③ 硬掃：任何一欄有過半能解析成日期就用（欄名千奇百怪時的保底）
    for c in cols[:40]:
        s = df[c].astype(str)
        if s.str.len().median() < 6:      # 太短的不可能是時間戳
            continue
        ts = pd.to_datetime(_roc_to_ad(s), errors="coerce")
        if ts.notna().sum() > len(df) * 0.7:
            return ts, f"「{c}」（依內容推定）"
    return None, "找不到時間欄——這份資料沒有可辨識的時間戳"


def _fmt_interval(sec: float) -> str:
    if sec < 1:
        return f"{sec * 1000:.0f} 毫秒"
    if sec < 90:
        return f"{sec:.0f} 秒"
    if sec < 5400:
        return f"{sec / 60:.0f} 分鐘"
    if sec < 172800:
        return f"{sec / 3600:.1f} 小時"
    return f"{sec / 86400:.1f} 天"


def build_profile(sid: str) -> dict:
    """掃一份資料集的時間結構。結果落盤快取。"""
    import pandas as pd

    pq = DATA_DIR / f"{sid}.parquet"
    if not pq.exists():
        raise HTTPException(404, "資料集不存在")
    meta_p = DATA_DIR / f"{sid}.meta.json"
    meta = json.loads(meta_p.read_text(encoding="utf-8")) if meta_p.exists() else {}

    df = pd.read_parquet(pq)
    ts, how = _find_time(df)
    base = {"sid": sid, "filename": meta.get("filename", sid),
            "uploaded_at": meta.get("uploaded_at"), "owner": meta.get("owner"),
            "n_rows": int(len(df)), "n_cols": int(df.shape[1]),
            "time_source": how}
    if ts is None:
        return {**base, "ok": False}

    ts = ts.dropna().sort_values()
    if len(ts) < 2:
        return {**base, "ok": False, "time_source": "只有一筆有效時間，無法算間隔"}

    dt = ts.diff().dt.total_seconds().dropna()
    dt = dt[dt > 0]                       # 同秒多筆（重複時間戳）不列入間隔統計
    med = float(dt.median()) if len(dt) else 0.0
    span = float((ts.max() - ts.min()).total_seconds())
    # 斷點＝間隔超過中位數 10 倍且至少 5 分鐘（避免 5 秒資料把 60 秒抖動當斷線）
    gap_th = max(med * 10, 300)
    gaps = dt[dt > gap_th]
    # 覆蓋率＝實際筆數 ÷ 該間隔下的應有筆數
    cov = min(100.0, len(ts) * med / span * 100) if span > 0 and med > 0 else 0.0
    years = {}
    for y, n in ts.dt.year.value_counts().items():
        years[str(int(y))] = int(n)
    # 月粒度直方圖：甘特圖底下的活躍度熱條
    months = {}
    for k, n in ts.dt.to_period("M").astype(str).value_counts().items():
        months[str(k)] = int(n)

    return {**base, "ok": True,
            "start": ts.min().isoformat(timespec="seconds"),
            "end": ts.max().isoformat(timespec="seconds"),
            "span_days": round(span / 86400, 2),
            "interval_sec": round(med, 3),
            "interval_text": _fmt_interval(med) if med else "—",
            "interval_mode_sec": round(float(dt.mode().iloc[0]), 3) if len(dt) else 0,
            "regular": bool(len(dt) and (dt == dt.mode().iloc[0]).mean() > 0.8),
            "n_gaps": int(len(gaps)),
            "max_gap_hours": round(float(gaps.max()) / 3600, 2) if len(gaps) else 0.0,
            "coverage_pct": round(cov, 1),
            "years": years, "months": months}


def get_profile(sid: str, refresh: bool = False) -> dict:
    p = _profile_path(sid)
    if not refresh and p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    prof = build_profile(sid)
    try:
        p.write_text(json.dumps(prof, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return prof


@router.get("")
def inventory(request: Request, refresh: int = 0) -> dict:
    """全資料集的時間盤點（同資料工作台的可見性）。"""
    from .dataprep import list_sessions

    rows = []
    for s in list_sessions(request):
        try:
            rows.append(get_profile(s["sid"], refresh=bool(refresh)))
        except Exception as exc:  # noqa: BLE001
            rows.append({"sid": s["sid"], "filename": s.get("filename", s["sid"]),
                         "ok": False, "n_rows": s.get("n_rows"),
                         "time_source": f"盤點失敗：{str(exc)[:80]}"})
    ok = [r for r in rows if r.get("ok")]
    summary = {
        "n_datasets": len(rows), "n_dated": len(ok),
        "n_rows_total": sum(int(r.get("n_rows") or 0) for r in rows),
        "earliest": min((r["start"] for r in ok), default=None),
        "latest": max((r["end"] for r in ok), default=None),
        "years": sorted({y for r in ok for y in r.get("years", {})}),
        "intervals": sorted({r["interval_text"] for r in ok}),
    }
    rows.sort(key=lambda r: (not r.get("ok"), r.get("start") or ""))
    return {"summary": summary, "datasets": rows}


@router.post("/{sid}/refresh")
def refresh_one(sid: str, request: Request) -> dict:
    from .dataprep import list_sessions

    if not any(s["sid"] == sid for s in list_sessions(request)):
        raise HTTPException(404, "資料集不存在或無權限")
    return get_profile(sid, refresh=True)
