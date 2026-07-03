# TA32 資料段診斷：目前六條粗閾值之後，還殘留哪些該刪的段？
# 檢查五類：時序 gap（歲修/停車）、停車後暫態、凍結值（儀錶/Lab 卡死）、
#          日跳變（非穩態/進料切換）、平衡商離群（量測錯誤）
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

# 目前的粗閾值（現況基準）
cur = d[(d["mass_bal"].between(0.98, 1.02) | d["mass_bal"].between(98, 102))
        & (d["WHSV"] > 1) & (d["T_in"] > 300) & (d["TOL_A"] > 1)]
print(f"現況清洗後：{len(cur)} 天（原始配對 {len(d)}）\n")

# ---- 1) 時序 gap（歲修/長停車）與停車後暫態
gaps = cur.index.to_series().diff().dt.days
big_gaps = gaps[gaps > 3]
print(f"[1] 時序 gap > 3 天：{len(big_gaps)} 處")
for ts, g in big_gaps.items():
    print(f"    {ts.date()} 前有 {int(g)} 天中斷（歲修/停車 → 重啟後 2-5 天是暫態）")

# ---- 2) 凍結值（Lab/儀錶卡死：連續多天完全相同）
frozen_days = set()
for col in ["TOL_A", "TOL_B", "BZ_B", "XYL_B", "T_in"]:
    same = cur[col].diff().abs() < 1e-9
    run = same.groupby((~same).cumsum()).cumsum()
    frozen = cur.index[run >= 3]  # 連續第 4 天起完全不動
    frozen_days |= set(frozen)
    if len(frozen):
        print(f"[2] {col} 凍結（連續≥4天等值）：{len(frozen)} 天")
print(f"    凍結日聯集：{len(frozen_days)} 天")

# ---- 3) 日跳變（非穩態/進料切換）：核心量的單日變化 z-score
jump_flags = pd.Series(False, index=cur.index)
for col, thr in [("TOL_A", 3.0), ("T_in", 3.0), ("WHSV", 3.0), ("feed_rate", 3.0)]:
    dv = cur[col].diff().abs()
    z = (dv - dv.median()) / (dv.quantile(0.75) - dv.quantile(0.25) + 1e-9)
    jump_flags |= z > 4.5
print(f"[3] 單日跳變（robust z>4.5，任一核心量）：{int(jump_flags.sum())} 天")

# ---- 4) 平衡商離群（量測錯誤/異常工況）
liq = list(FEED)
tot = sum(cur[f"{s}_B"] for s in liq)
x = {s: cur[f"{s}_B"] / tot for s in liq}
Q1 = (x["BZ"] * x["XYL"]) / x["TOL"] ** 2
Q2 = x["XYL"] ** 2 / (x["TOL"] * x["TMB"])
q1_out = (Q1 < Q1.quantile(0.005)) | (Q1 > Q1.quantile(0.995))
q2_out = (Q2 < Q2.quantile(0.005)) | (Q2 > Q2.quantile(0.995))
print(f"[4] 平衡商極端離群（0.5% 雙尾）：Q1 {int(q1_out.sum())} 天、Q2 {int(q2_out.sum())} 天")
print(f"    Q1 全距 {Q1.min():.3f}~{Q1.max():.3f}（中位 {Q1.median():.3f}）")

# ---- 5) 物料衡算分佈（98-102% 是否太寬）
mb = cur["mass_bal"]
mb = mb.where(mb < 10, mb / 100)
print(f"[5] 物料衡算分佈：P1 {mb.quantile(0.01):.4f}｜P50 {mb.median():.4f}｜P99 {mb.quantile(0.99):.4f}")
print(f"    |MB-1|>1% 的天數：{int((abs(mb - 1) > 0.01).sum())}")

# ---- 綜合：若全部套用會剩多少
post_gap = pd.Series(False, index=cur.index)
for ts in big_gaps.index:
    pos = cur.index.get_loc(ts)
    post_gap.iloc[pos:pos + 3] = True  # 重啟後 3 天
mask_bad = post_gap | pd.Series(cur.index.isin(frozen_days), index=cur.index) | jump_flags | q1_out | q2_out | (abs(mb - 1) > 0.01)
print(f"\n綜合：再剔除 {int(mask_bad.sum())} 天 → 穩態資料 {len(cur) - int(mask_bad.sum())} 天")
bad = cur.index[mask_bad]
pd.Series(bad).to_csv(HERE / "dataset" / "bad_days.csv", index=False)
