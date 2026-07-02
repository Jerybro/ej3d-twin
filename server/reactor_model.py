"""R611 約束平衡反應器模型 — 解析化的 Aspen 替代。

給定進料組成 A（wt% 或 mol），封閉式計算反應器出口組成 B。無 Aspen、無黑箱：

    未知：出口 n_BZ, n_TOL, n_XYL, n_TMB（kmol，以 100 kg 進料為基準）
    方程（4×4，牛頓法）：
      [環守恆]   n_BZ + n_TOL + n_XYL + n_TMB = R_feed + δR·n_TOL,feed
      [甲基守恆] n_TOL + 2·n_XYL + 3·n_TMB   = M_feed + δM·n_TOL,feed
      [歧化平衡商]   x_BZ·x_XYL / x_TOL²      = K1
      [轉烷平衡商]   x_XYL² / (x_TOL·x_TMB)   = K2
    副產物（EB/MEB/PB/Indane/C10+/nonARO）：出口 = 進口 + δ_s·n_TOL,feed

    參數（models/reactor_params.json，1004 天實測識別）：
      K1 = 0.2255、K2 = 2.6659（三年漂移 ±8% → 平衡商為反應器不變量）
      δR = +0.0518、δM = +0.0394（EB/MEB 脫乙基等副反應的守恆修正）

    驗證（測試段 2023-01~09，觸媒末期，模型未見）：
      BZ MAE 0.87 wt%｜TOL 0.41｜XYL 0.62｜TMB 0.18｜甲苯轉化率 MAE 0.54%

    機理依據：Tatoray 甲基轉移反應族近熱中性（實測表觀 ΔH −4.5/−10.7 kJ/mol）
    → K 不隨溫度顯著變化；van't Hoff／drift 修正實測皆輸常數（見訓練紀錄）。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

PARAMS_FILE = Path(__file__).resolve().parent.parent / "models" / "reactor_params.json"

_params = None


def _load() -> dict:
    global _params
    if _params is None:
        _params = json.loads(PARAMS_FILE.read_text(encoding="utf-8"))
    return _params


def available() -> bool:
    try:
        _load()
        return True
    except Exception:  # noqa: BLE001
        return False


def info() -> dict:
    p = _load()
    return {k: p[k] for k in ("description", "K1_disproportionation", "K2_transalkylation",
                              "ring_gain_per_molTOLfeed", "methyl_gain_per_molTOLfeed", "validation")}


SPECIES = ["BZ", "TOL", "EB", "XYL", "PB", "MEB", "TMB", "Indane", "C10p", "nonARO"]


def solve(feed_wt: dict) -> dict:
    """輸入進料組成（wt%，鍵同 SPECIES，可部分提供），回傳出口組成與轉化率。

    計算基準：100 kg 進料。缺鍵補 0；組成自動正規化到 100%。
    """
    p = _load()
    mw = p["MW"]
    wt = {s: max(float(feed_wt.get(s, 0.0)), 0.0) for s in SPECIES}
    tot = sum(wt.values())
    if tot <= 0:
        raise ValueError("進料組成全零")
    wt = {s: v / tot * 100.0 for s, v in wt.items()}

    n_in = {s: wt[s] / mw[s] for s in SPECIES}  # kmol / 100kg

    # 副產物出口（與主平衡解耦的經驗比例）
    side = p["side_delta_per_molTOLfeed"]
    n_out_side = {s: max(n_in[s] + side[s] * n_in["TOL"], 0.0) for s in side}
    others_mol = sum(n_out_side.values())

    # 守恆右端
    R = n_in["BZ"] + n_in["TOL"] + n_in["XYL"] + n_in["TMB"] + p["ring_gain_per_molTOLfeed"] * n_in["TOL"]
    M = n_in["TOL"] + 2 * n_in["XYL"] + 3 * n_in["TMB"] + p["methyl_gain_per_molTOLfeed"] * n_in["TOL"]
    K1, K2 = p["K1_disproportionation"], p["K2_transalkylation"]

    n = np.array([max(n_in["BZ"], 1e-3), max(n_in["TOL"], 1e-3),
                  max(n_in["XYL"], 1e-3), max(n_in["TMB"], 1e-3)])

    def residual(nv):
        x = nv / (nv.sum() + others_mol)
        return np.array([
            nv.sum() - R,
            nv[1] + 2 * nv[2] + 3 * nv[3] - M,
            x[0] * x[2] / x[1] ** 2 - K1,
            x[2] ** 2 / (x[1] * x[3]) - K2,
        ])

    for _ in range(80):
        f = residual(n)
        if np.abs(f).max() < 1e-10:
            break
        J = np.zeros((4, 4))
        for j in range(4):
            d = max(n[j] * 1e-6, 1e-9)
            n2 = n.copy()
            n2[j] += d
            J[:, j] = (residual(n2) - f) / d
        try:
            n = np.clip(n - np.linalg.solve(J, f), 1e-6, None)
        except np.linalg.LinAlgError:
            raise ValueError("牛頓法奇異（進料組成極端）") from None

    n_out = {"BZ": n[0], "TOL": n[1], "XYL": n[2], "TMB": n[3], **n_out_side}
    mass_out = {s: n_out[s] * mw[s] for s in n_out}
    tot_mass = sum(mass_out.values())
    wt_out = {s: round(float(mass_out[s] / tot_mass * 100), 3) for s in n_out}
    conv = float((n_in["TOL"] - n_out["TOL"]) / n_in["TOL"] * 100) if n_in["TOL"] > 0 else 0.0

    return {
        "outlet_wt_pct": wt_out,
        "toluene_conversion_pct": round(conv, 2),
        "feed_wt_pct_normalized": {s: round(v, 3) for s, v in wt.items()},
        "equations": {
            "K1": K1, "K2": K2,
            "ring_balance": round(R, 4), "methyl_balance": round(M, 4),
        },
    }
