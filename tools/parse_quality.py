# 用法：python tools/parse_quality.py [數據路徑]（原始數據依 NDA 不在 repo，自備）
# 解析品質日報六檔 → S601(進料) / S604(反應器流出液相) 日資料長表
# 格式：col0=採樣點區塊起點、col1=分析項目、row1=日期橫列
import re
from pathlib import Path

import pandas as pd

import sys
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:/Users/Admin/Downloads/_tatoray_data/品管檢驗數據報表")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(r"C:/Users/Admin/Downloads/_tatoray_data/dataset")
OUT.mkdir(exist_ok=True)

# 要抽的欄位（區塊關鍵字 → {輸出欄名: 項目名 regex}）
WANT = {
    "S601": {
        "feed_nonARO": r"non-ARO\(早\)",
        "feed_BZ": r"^BZ\(早\)",
        "feed_TOL": r"^TOL\(早\)",
        "feed_EB": r"^EB\(早\)",
        "feed_pX": r"^p-X\(早\)",
        "feed_mX": r"^m-X\(早\)",
        "feed_oX": r"^o-X\(早\)",
        "feed_C9": r"^C9\(早\)",
        "feed_Cumene": r"^Cumene\(早\)",
        "feed_NPB": r"^NPB\(早\)",
        "feed_MEB": r"^MEB\(早\)",
        "feed_TMB": r"^TMB\(早\)",
        "feed_Indane": r"^Indane\(早\)",
        "feed_C10": r"^C10\(早\)",
        "feed_C11p": r"^C11\+\(早\)",
    },
    "S604": {
        "out_nonARO": r"^non-ARO",
        "out_BZ": r"^BZ\(",
        "out_TOL": r"^TOL\(",
        "out_EB": r"^EB\(",
        "out_pX": r"^p-X\(",
        "out_mX": r"^m-X\(",
        "out_oX": r"^o-X\(",
        "out_C9": r"^C9\(",
        "out_C10p": r"^C10\+\(",
    },
}


def parse_file(path: Path) -> pd.DataFrame:
    df = pd.ExcelFile(path).parse(0, header=None)
    # 有的檔多一欄 TagName：以 row1 中「項目」所在欄推偏移
    row1 = [str(v).strip() for v in df.iloc[1, :4].values]
    off = row1.index("項目") if "項目" in row1 else 0
    col_block, col_item = off, off + 1
    dates = pd.to_datetime(df.iloc[1, col_item + 2 :], errors="coerce")
    valid_cols = [c for c, d in zip(dates.index, dates) if pd.notna(d)]
    date_map = {c: dates[c] for c in valid_cols}

    # 區塊定位
    blocks = {}  # key -> (start_row, end_row)
    starts = [(i, str(df.iloc[i, col_block])) for i in range(len(df)) if pd.notna(df.iloc[i, col_block])]
    for idx, (row, label) in enumerate(starts):
        for key in WANT:
            if key in label:
                end = starts[idx + 1][0] if idx + 1 < len(starts) else len(df)
                blocks[key] = (row, end)

    records = {}
    for key, fields in WANT.items():
        if key not in blocks:
            continue
        r0, r1 = blocks[key]
        for out_name, pat in fields.items():
            for i in range(r0, r1):
                item = df.iloc[i, col_item]
                if pd.isna(item):
                    continue
                if re.search(pat, str(item).strip()):
                    for c in valid_cols:
                        v = pd.to_numeric(df.iloc[i, c], errors="coerce")
                        records.setdefault(date_map[c], {})[out_name] = v
                    break

    out = pd.DataFrame.from_dict(records, orient="index").sort_index()
    out.index.name = "date"
    return out


frames = []
for f in sorted(SRC.glob("*.xls")):
    d = parse_file(f)
    print(f"{f.name}: {len(d)} 天, {d.notna().sum().sum()} 值")
    frames.append(d)

full = pd.concat(frames)
full = full[~full.index.duplicated(keep="last")].sort_index()
print("\n合併：", full.shape, "|", full.index.min(), "→", full.index.max())
print("各欄非空率：")
print((full.notna().mean() * 100).round(1).to_string())
full.to_csv(OUT / "quality_daily.csv", encoding="utf-8-sig")
print("\n已存 dataset/quality_daily.csv")
