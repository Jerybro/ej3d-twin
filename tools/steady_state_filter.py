# TA32 穩態過濾器（正式版）——每一天標記「保留」或「剔除+原因」
# 規則（工程準則，非黑箱統計）：
#   R0 基本有效：mass_bal 可算、WHSV>1、T_in>300、TOL 進料>1 kmol/hr
#   R1 重啟暫態：時序中斷 >3 天後的前 3 個運轉日（觸媒床未達穩態）
#   R2 物料衡算：|MB−1| ≤ 1%（超過＝量測/重構不可信）
#   R3 非穩態日：T_in 日變 >3°C、或 WHSV/進料量日相對變化 >10%（調度/切換中）
#   R4 平衡商離群：Q1、Q2 落在 0.5% 雙尾外（Lab 或流量量測錯誤）
# 輸出：dataset/steady_state_mask.csv（date, keep, reason）＋前後對比報告
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
HERE = Path(__file__).parent

df = pd.ExcelFile(HERE / "TA32操作資料.xlsm").parse("TA32", header=None)
dates = pd.to_datetime(df.iloc[7, 1:], errors="coerce")


def row(i):
    s = pd.to_numeric(df.iloc[i, 1:], errors="coerce")
    s.index = dates
    return s[dates.notna().values]


FEED = {"BZ": 114, "TOL": 115, "EB": 116, "XYL": 117, "PB": 118, "MEB": 119, "TMB": 120,
        "Indane": 121, "C10p": 122, "nonARO": 113}
EFF = {"BZ": 342, "TOL": 343, "EB": 344, "XYL": 345, "PB": 346, "MEB": 347, "TMB": 348,
       "Indane": 349, "C10p": 350, "nonARO": 341}
A = pd.DataFrame({k: row(v) for k, v in FEED.items()})
B = pd.DataFrame({k: row(v) for k, v in EFF.items()})
ops = pd.DataFrame({"T_in": row(12), "WHSV": row(11), "hours": row(8),
                    "mass_bal": row(427), "feed_rate": row(20)})
d = A.join(B, lsuffix="_A", rsuffix="_B").join(ops)
d = d[~d.index.duplicated(keep="first")].dropna().sort_index()

reason = pd.Series("", index=d.index)

# R0 基本有效
mb = d["mass_bal"].where(d["mass_bal"] < 10, d["mass_bal"] / 100)
r0 = (d["WHSV"] <= 1) | (d["T_in"] <= 300) | (d["TOL_A"] <= 1)
reason[r0 & (reason == "")] = "R0 停車/冷態/無進料"

# R1 重啟暫態：停車段（R0 或時序中斷）結束後的前 3 個運轉日
gaps = d.index.to_series().diff().dt.days.fillna(1)
down = r0 | (gaps > 3)  # 停車日（有記錄但低負荷）或無記錄中斷
r1 = pd.Series(False, index=d.index)
prev_down = False
count = 0
for i in range(len(d)):
    if down.iloc[i]:
        prev_down = True
        count = 0
    elif prev_down:
        r1.iloc[i] = True
        count += 1
        if count >= 3:
            prev_down = False
            count = 0
reason[r1 & (reason == "")] = "R1 重啟暫態(復機後3日)"

# R2 物料衡算
r2 = (mb - 1).abs() > 0.01
reason[r2 & (reason == "")] = "R2 物料衡算>1%"

# R3 非穩態（工程閾值）
r3 = (d["T_in"].diff().abs() > 3.0) \
     | (d["WHSV"].pct_change().abs() > 0.10) \
     | (d["feed_rate"].pct_change().abs() > 0.10)
reason[r3 & (reason == "")] = "R3 非穩態(溫度/負荷跳變)"

# R4 平衡商離群（在通過 R0-R3 的母體上定分位）
liq = list(FEED)
tot = sum(d[f"{s}_B"] for s in liq)
x = {s: d[f"{s}_B"] / tot for s in liq}
Q1 = (x["BZ"] * x["XYL"]) / x["TOL"] ** 2
Q2 = x["XYL"] ** 2 / (x["TOL"] * x["TMB"])
base = reason == ""
q1lo, q1hi = Q1[base].quantile([0.005, 0.995])
q2lo, q2hi = Q2[base].quantile([0.005, 0.995])
r4 = (Q1 < q1lo) | (Q1 > q1hi) | (Q2 < q2lo) | (Q2 > q2hi)
reason[r4 & (reason == "")] = "R4 平衡商離群"

keep = reason == ""
print("剔除統計：")
print(reason[reason != ""].value_counts().to_string())
print(f"\n保留穩態：{int(keep.sum())} / {len(d)} 天")

mask = pd.DataFrame({"keep": keep, "reason": reason})
mask.to_csv(HERE / "dataset" / "steady_state_mask.csv", encoding="utf-8-sig")

# ------------------------------------------- 前後對比：K 識別與測試段驗證
def run_model(data):
    split = int(len(data) * 0.8)
    tr, te = data.index[:split], data.index[split:]
    tot = sum(data[f"{s}_B"] for s in liq)
    xx = {s: data[f"{s}_B"] / tot for s in liq}
    K1 = float(((xx["BZ"] * xx["XYL"]) / xx["TOL"] ** 2).loc[tr].median())
    K2 = float((xx["XYL"] ** 2 / (xx["TOL"] * xx["TMB"])).loc[tr].median())
    CORE = ["BZ", "TOL", "XYL", "TMB"]
    dR = float(((sum(data[f"{s}_B"] for s in CORE) - sum(data[f"{s}_A"] for s in CORE)) / data["TOL_A"]).loc[tr].median())
    Mo = data["TOL_B"] + 2 * data["XYL_B"] + 3 * data["TMB_B"]
    Mi = data["TOL_A"] + 2 * data["XYL_A"] + 3 * data["TMB_A"]
    dM = float(((Mo - Mi) / data["TOL_A"]).loc[tr].median())

    def solve(r):
        R = r["BZ_A"] + r["TOL_A"] + r["XYL_A"] + r["TMB_A"] + dR * r["TOL_A"]
        M = r["TOL_A"] + 2 * r["XYL_A"] + 3 * r["TMB_A"] + dM * r["TOL_A"]
        others = sum(r[f"{s}_B"] for s in ["EB", "PB", "MEB", "Indane", "C10p", "nonARO"])
        n = np.array([max(r["BZ_A"], 1e-3), max(r["TOL_A"], 1e-3), max(r["XYL_A"], 1e-3), max(r["TMB_A"], 1e-3)])
        for _ in range(60):
            xt = n / (n.sum() + others)
            f = np.array([n.sum() - R, n[1] + 2 * n[2] + 3 * n[3] - M,
                          xt[0] * xt[2] / xt[1] ** 2 - K1, xt[2] ** 2 / (xt[1] * xt[3]) - K2])
            if np.abs(f).max() < 1e-9:
                break
            J = np.zeros((4, 4))
            for j in range(4):
                dd = max(n[j] * 1e-6, 1e-9)
                n2 = n.copy(); n2[j] += dd
                x2 = n2 / (n2.sum() + others)
                f2 = np.array([n2.sum() - R, n2[1] + 2 * n2[2] + 3 * n2[3] - M,
                               x2[0] * x2[2] / x2[1] ** 2 - K1, x2[2] ** 2 / (x2[1] * x2[3]) - K2])
                J[:, j] = (f2 - f) / dd
            try:
                n = np.clip(n - np.linalg.solve(J, f), 1e-6, None)
            except np.linalg.LinAlgError:
                return None
        return n

    from sklearn.metrics import mean_absolute_error
    convP, convA = [], []
    tolP, tolA = [], []
    for day in te:
        r = data.loc[day]
        n = solve(r)
        if n is None:
            continue
        convP.append((r["TOL_A"] - n[1]) / r["TOL_A"] * 100)
        convA.append((r["TOL_A"] - r["TOL_B"]) / r["TOL_A"] * 100)
        tolP.append(n[1]); tolA.append(r["TOL_B"])
    return {"K1": K1, "K2": K2, "n_test": len(convP),
            "conv_MAE": mean_absolute_error(convA, convP),
            "TOL_MAE_kmol": mean_absolute_error(tolA, tolP)}

# 現況（舊六條）vs 穩態版
old = d[(mb.between(0.98, 1.02)) & (d["WHSV"] > 1) & (d["T_in"] > 300) & (d["TOL_A"] > 1)]
new = d[keep]
ro = run_model(old)
rn = run_model(new)
print(f"\n{'':14s}{'舊清洗(1004天)':>18s}{'穩態版(' + str(len(new)) + '天)':>18s}")
print(f"{'K1':14s}{ro['K1']:>18.4f}{rn['K1']:>18.4f}")
print(f"{'K2':14s}{ro['K2']:>18.4f}{rn['K2']:>18.4f}")
print(f"{'轉化率 MAE %':14s}{ro['conv_MAE']:>18.3f}{rn['conv_MAE']:>18.3f}")
print(f"{'TOL MAE kmol':14s}{ro['TOL_MAE_kmol']:>18.3f}{rn['TOL_MAE_kmol']:>18.3f}")
print(f"{'測試天數':14s}{ro['n_test']:>18d}{rn['n_test']:>18d}")
