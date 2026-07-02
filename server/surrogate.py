"""Tatoray 製程灰箱代理模型 — 分析層推論服務。

模型：S601 進料組成 → S604 白土塔進料組成（BZ/TOL/X/C9 wt%）
- L1 物理特徵：甲基/苯環比（Tatoray 核心操作參數）、歧化/轉烷驅動力
- L2 GBDT 學「變化量 Δ」：以製程慣性（前一日實測）為底，學進料引起的偏移
- 驗證：977 天品質日報、時序切分後 20% 測試，R² 0.79–0.88、MAE 0.02–0.79 wt%

NDA 隔離：本模組只載入訓練產物（models/*.joblib，僅模型權重與單點預設值），
原始品質日報數據不進版控、不經 API 外流。
"""

from __future__ import annotations

from pathlib import Path

MODEL_FILE = Path(__file__).resolve().parent.parent / "models" / "tatoray_surrogate.joblib"
CATALYST_FILE = Path(__file__).resolve().parent.parent / "models" / "tatoray_catalyst.joblib"

MW = {"BZ": 78.11, "TOL": 92.14, "EB": 106.17, "X": 106.17, "C9": 120.19, "C10": 134.22}

_bundle = None


def _load():
    global _bundle
    if _bundle is None:
        import joblib  # lazy：沒裝 sklearn/joblib 時平台其他功能不受影響

        _bundle = joblib.load(MODEL_FILE)
    return _bundle


def available() -> bool:
    try:
        _load()
        return True
    except Exception:  # noqa: BLE001 — 缺套件/缺模型檔都視為未啟用
        return False


def info() -> dict:
    b = _load()
    return {
        "targets": b["targets"],
        "results": b["results"],
        "defaults": b["defaults"],
        "train_range": b.get("train_range"),
        "test_range": b.get("test_range"),
    }


def _physics_row(feed: dict) -> dict:
    mol_TOL = feed["feed_TOL"] / MW["TOL"]
    mol_BZ = feed["feed_BZ"] / MW["BZ"]
    mol_X = (feed["feed_pX"] + feed["feed_mX"] + feed["feed_oX"]) / MW["X"]
    mol_EB = feed["feed_EB"] / MW["EB"]
    mol_TMB = feed["feed_TMB"] / MW["C9"]
    mol_MEB = feed["feed_MEB"] / MW["C9"]
    mol_C9o = max(feed["feed_C9"] - feed["feed_TMB"] - feed["feed_MEB"], 0) / MW["C9"]
    mol_C10 = feed["feed_C10"] / MW["C10"]
    rings = mol_TOL + mol_BZ + mol_X + mol_EB + mol_TMB + mol_MEB + mol_C9o + mol_C10
    methyls = mol_TOL + mol_X * 2 + mol_TMB * 3 + mol_MEB + mol_C9o * 1.5 + mol_C10 * 2.5
    return {
        "MR_ratio": methyls / rings if rings else 0.0,
        "molTOL": mol_TOL,
        "molC9A": mol_TMB + mol_MEB + mol_C9o,
        "disp_drive": mol_TOL**2,
        "trans_drive": mol_TOL * (mol_TMB + mol_MEB),
        "TOL_C9_ratio": feed["feed_TOL"] / max(feed["feed_C9"], 1),
        "heavy": feed["feed_C10"] + feed["feed_C11p"],
        "nonARO": feed["feed_nonARO"],
    }


# ------------------------------------------- 催化劑活性追蹤（v6，三年 DCS）
_cat = None


def _load_cat():
    global _cat
    if _cat is None:
        import joblib

        _cat = joblib.load(CATALYST_FILE)
    return _cat


def catalyst_available() -> bool:
    try:
        _load_cat()
        return True
    except Exception:  # noqa: BLE001
        return False


def catalyst_health(hours_override: float | None = None, eor_temp: float = 370.0) -> dict:
    """催化劑健康：預測維持目標轉化率所需入口溫度＋剩餘壽命外推。

    衰退速率取自三年實績線性層；EOR 預設 370°C（測試期實際頂到的操作上限）。
    """
    b = _load_cat()
    d = dict(b["defaults"])
    if hours_override is not None:
        d["hours"] = hours_override
    x_l1 = [[d[c] for c in b["l1_cols"]]]
    x_all = [[d[c] for c in b["features"]]]
    t_req = float(b["ridge"].predict(x_l1)[0]) + float(b["gbdt"].predict(x_all)[0])
    rate = b["results"]["deact_C_per_1000hr"]  # °C / 1000hr
    headroom = max(0.0, eor_temp - t_req)
    days_left = (headroom / rate * 1000) / 24 if rate > 0 else None
    return {
        "hours_on_stream": d["hours"],
        "required_Tin_C": round(t_req, 1),
        "actual_last_Tin_C": b["actual_last_Tin"],
        "deact_rate_C_per_1000hr": rate,
        "eor_temp_C": eor_temp,
        "est_days_to_EOR": round(days_left) if days_left is not None else None,
        "model": {"MAE_C": b["results"]["MAE_C"], "test_range": b.get("test_range")},
    }


def predict(feed_overrides: dict | None = None, lag_overrides: dict | None = None) -> dict:
    """What-if 推論：以最後實測狀態為基準，套用進料組成覆寫後計算出口組成。"""
    b = _load()
    d = b["defaults"]
    feed = {**d["feed"], **(feed_overrides or {})}
    lag = {**d["lag"], **(lag_overrides or {})}

    row = {**_physics_row(feed), **feed}
    for t in b["targets"]:
        row[f"lag_{t}"] = lag[t]
    row["run_days"] = d["run_days"]
    row["after_gap"] = 0.0

    x = [[row[c] for c in b["feat_all"]]]
    out = {}
    for t in b["targets"]:
        dy = float(b["models"][t]["gbdt"].predict(x)[0])
        out[t] = round(lag[t] + dy, 3)
    return {
        "prediction": out,
        "baseline_actual": d["actual_last"],
        "feed_used": {k: round(v, 4) for k, v in feed.items()},
    }
