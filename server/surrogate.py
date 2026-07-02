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
