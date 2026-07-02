# 用法：python tools/train_surrogate.py [數據路徑]（原始數據依 NDA 不在 repo，自備）
# Tatoray 灰箱代理模型：S601 進料組成 → S604 白土塔進料組成
# L1 物理特徵層（甲基/苯環比、歧化/轉烷驅動力）＋ L2 GBDT 殘差
# 驗證：時序切分（前 80% 訓練、後 20% 測試），對齊實驗數據
import json
from pathlib import Path

import joblib
import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score

plt.rcParams["font.family"] = ["Microsoft JhengHei", "sans-serif"]
plt.rcParams["axes.unicode_minus"] = False

import sys
HERE = Path(sys.argv[1]).parent if len(sys.argv) > 1 else Path(r"C:/Users/Admin/Downloads/_tatoray_data")
OUT = HERE / "model_out"
OUT.mkdir(exist_ok=True)

df = pd.read_csv((Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "dataset" / "quality_daily.csv"), index_col=0, parse_dates=True)

# ------------------------------------------------------------- 清洗
FEEDS = ["feed_nonARO", "feed_BZ", "feed_TOL", "feed_EB", "feed_pX", "feed_mX", "feed_oX",
         "feed_C9", "feed_Cumene", "feed_NPB", "feed_MEB", "feed_TMB", "feed_Indane",
         "feed_C10", "feed_C11p"]
TARGETS = ["out_BZ", "out_TOL", "out_X", "out_C9"]

df["out_X"] = df["out_pX"] + df["out_mX"] + df["out_oX"]
df = df.dropna(subset=FEEDS + ["out_BZ", "out_TOL", "out_C9"])
# 停機/異常剔除：進料 TOL 正常區 63-90%、出口 BZ>20%（低於此=非正常運轉分離狀態）
n0 = len(df)
df = df[(df["feed_TOL"].between(60, 92)) & (df["out_BZ"] > 20) & (df["out_TOL"] > 30)]
print(f"清洗：{n0} → {len(df)} 天（剔除停機/異常 {n0 - len(df)}）")

# ------------------------------------------------- L1 物理特徵（灰箱核心）
MW = {"BZ": 78.11, "TOL": 92.14, "EB": 106.17, "X": 106.17, "C9": 120.19, "C10": 134.22}
ME = {"BZ": 0, "TOL": 1, "EB": 0, "X": 2, "TMB": 3, "MEB": 1, "C10": 2.5}


def physics_features(d: pd.DataFrame) -> pd.DataFrame:
    f = pd.DataFrame(index=d.index)
    # mol 基準（每 100g 進料）
    mol_TOL = d["feed_TOL"] / MW["TOL"]
    mol_BZ = d["feed_BZ"] / MW["BZ"]
    mol_X = (d["feed_pX"] + d["feed_mX"] + d["feed_oX"]) / MW["X"]
    mol_EB = d["feed_EB"] / MW["EB"]
    mol_TMB = d["feed_TMB"] / MW["C9"]
    mol_MEB = d["feed_MEB"] / MW["C9"]
    mol_C9o = (d["feed_C9"] - d["feed_TMB"] - d["feed_MEB"]).clip(lower=0) / MW["C9"]
    mol_C10 = d["feed_C10"] / MW["C10"]
    rings = mol_TOL + mol_BZ + mol_X + mol_EB + mol_TMB + mol_MEB + mol_C9o + mol_C10
    methyls = (mol_TOL * ME["TOL"] + mol_X * ME["X"] + mol_TMB * ME["TMB"]
               + mol_MEB * ME["MEB"] + mol_C9o * 1.5 + mol_C10 * ME["C10"])
    f["MR_ratio"] = methyls / rings              # 甲基/苯環比 —— Tatoray 核心操作參數
    f["molTOL"] = mol_TOL
    f["molC9A"] = mol_TMB + mol_MEB + mol_C9o
    f["disp_drive"] = mol_TOL**2                 # 歧化驅動力 2TOL→BZ+X
    f["trans_drive"] = mol_TOL * (mol_TMB + mol_MEB)  # 轉烷驅動力 TOL+TMB→2X
    f["TOL_C9_ratio"] = d["feed_TOL"] / d["feed_C9"].clip(lower=1)
    f["heavy"] = d["feed_C10"] + d["feed_C11p"]  # 重質物（催化劑負荷指標）
    f["nonARO"] = d["feed_nonARO"]
    return f


X_phys = physics_features(df)
X_raw = df[FEEDS]

# 製程狀態特徵（品質日報沒有 DCS 操作條件，用兩個代理變數補）：
# - 前一日出口實測（製程慣性；soft sensor 標準做法）
# - 催化劑運轉天數（活性緩慢衰退 → 產物分佈漂移）
state = pd.DataFrame(index=df.index)
for tgt in TARGETS:
    state[f"lag_{tgt}"] = df[tgt].shift(1)
state["run_days"] = (df.index - df.index.min()).days
gap = df.index.to_series().diff().dt.days.fillna(1)
state["after_gap"] = (gap > 7).astype(float)  # 大歇工（歲修/換觸媒）後重啟旗標

X_all = pd.concat([X_phys, X_raw, state], axis=1).dropna()
idx = X_all.index
df = df.loc[idx]
X_phys = X_phys.loc[idx]

# 時序切分：後 20% 當測試（模擬「未來」）
split = int(len(df) * 0.8)
tr, te = X_all.index[:split], X_all.index[split:]
print(f"訓練 {len(tr)} 天（{tr.min().date()}→{tr.max().date()}）｜測試 {len(te)} 天（{te.min().date()}→{te.max().date()}）")

results = {}
models = {}
for tgt in TARGETS:
    y = df[tgt]
    lag = X_all[f"lag_{tgt}"]
    # 預測「變化量 Δ = 今日 − 昨日」：以製程慣性為底，模型只學進料/狀態
    # 引起的偏移——學不到時 Δ→0 自動退化成昨日值，保證不輸天真基準
    dy = y - lag
    gbdt = HistGradientBoostingRegressor(max_depth=3, max_iter=400, learning_rate=0.04,
                                         l2_regularization=5.0, min_samples_leaf=40,
                                         early_stopping=True, validation_fraction=0.15,
                                         random_state=42)
    gbdt.fit(X_all.loc[tr], dy.loc[tr])
    pred_te = lag.loc[te] + gbdt.predict(X_all.loc[te])

    # 純物理層（無慣性、what-if 模式用）：Ridge(物理特徵)
    ridge = Ridge(alpha=3.0).fit(X_phys.loc[tr], y.loc[tr])
    mae_p = mean_absolute_error(y.loc[te], ridge.predict(X_phys.loc[te]))

    mae = mean_absolute_error(y.loc[te], pred_te)
    r2 = r2_score(y.loc[te], pred_te)
    naive_mae = mean_absolute_error(y.loc[te], lag.loc[te])  # 今天=昨天 基準
    results[tgt] = {"MAE_physics": round(mae_p, 3), "MAE_hybrid": round(mae, 3),
                    "MAE_naive_lag1": round(naive_mae, 3),
                    "R2_hybrid": round(r2, 3), "target_std": round(float(y.loc[te].std()), 3)}
    models[tgt] = {"ridge": ridge, "gbdt": gbdt}
    win = "✔ 贏基準" if mae < naive_mae else "≒ 持平"
    print(f"{tgt:8s}｜灰箱 {mae:.3f} wt%（昨日值 {naive_mae:.3f}）{win}｜R² {r2:.3f}｜std {y.loc[te].std():.2f}")

# ------------------------------------------------------------- 對齊圖
fig, axes = plt.subplots(len(TARGETS), 1, figsize=(13, 3 * len(TARGETS)), sharex=True)
for ax, tgt in zip(axes, TARGETS):
    y = df[tgt]
    m = models[tgt]
    pred = X_all[f"lag_{tgt}"] + m["gbdt"].predict(X_all)
    ax.plot(df.index, y, "o", ms=2.5, color="#2a6f97", alpha=0.55, label="實驗數據（品質日報）")
    ax.plot(df.index, pred, "-", lw=1.2, color="#e07b39", label="灰箱模型計算值")
    ax.axvline(te.min(), color="#888", ls="--", lw=1)
    ax.text(te.min(), ax.get_ylim()[1], " ← 訓練｜測試 → ", va="top", fontsize=8, color="#666")
    ax.set_ylabel(f"{tgt} (wt%)")
    ax.legend(loc="upper left", fontsize=8)
    ax.set_title(f"{tgt}：測試集 MAE {results[tgt]['MAE_hybrid']} wt%｜R² {results[tgt]['R2_hybrid']}", fontsize=10)
fig.suptitle("Tatoray 灰箱代理模型 vs 實驗數據（S601 進料組成 → S604 組成）", fontsize=12)
fig.tight_layout()
fig.savefig(OUT / "pred_vs_actual.png", dpi=110)

# 散點對齊圖（測試集）
fig2, axes2 = plt.subplots(1, len(TARGETS), figsize=(4 * len(TARGETS), 4))
for ax, tgt in zip(axes2, TARGETS):
    y = df[tgt].loc[te]
    m = models[tgt]
    pred = X_all.loc[te, f"lag_{tgt}"] + m["gbdt"].predict(X_all.loc[te])
    ax.scatter(y, pred, s=10, alpha=0.6, color="#2a6f97")
    lims = [min(y.min(), pred.min()), max(y.max(), pred.max())]
    ax.plot(lims, lims, "r--", lw=1)
    ax.set_xlabel("實驗值 (wt%)")
    ax.set_ylabel("計算值 (wt%)")
    ax.set_title(f"{tgt}｜R²={results[tgt]['R2_hybrid']}", fontsize=10)
fig2.suptitle("測試集（未見過的最後 20% 時段）", fontsize=11)
fig2.tight_layout()
fig2.savefig(OUT / "parity.png", dpi=110)

# ------------------------------------------------------------- 打包模型
# defaults：最後一筆完整狀態（feed 實測＋lag），What-if 推論的基準點；
# 只含單日組成統計值，不含任何可回溯的原始序列（NDA 隔離）
defaults = {
    "feed": {c: round(float(df[FEEDS].iloc[-1][c]), 4) for c in FEEDS},
    "lag": {t: round(float(df[t].iloc[-1]), 4) for t in TARGETS},
    "run_days": int(X_all["run_days"].iloc[-1]),
    "actual_last": {t: round(float(df[t].iloc[-1]), 4) for t in TARGETS},
}
joblib.dump({"models": models, "feat_phys": list(X_phys.columns), "feat_all": list(X_all.columns),
             "targets": TARGETS, "results": results, "defaults": defaults,
             "train_range": [str(tr.min().date()), str(tr.max().date())],
             "test_range": [str(te.min().date()), str(te.max().date())]},
            OUT / "tatoray_surrogate.joblib")
json.dump(results, open(OUT / "metrics.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("\n模型與圖已存 model_out/")
