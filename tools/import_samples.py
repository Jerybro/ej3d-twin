"""案例圖匯入：把 Downloads 下的流程圖複製進 uploads/pid。

原本誤把中油大林 HDS11 那批 JPG 當成 P&ID 匯入——那些其實是 PI Vision
的畫面截圖（監控介面），不是工程圖，已移除。
"""
import shutil
from pathlib import Path

DL = Path.home() / "Downloads"
DST = Path(__file__).resolve().parent.parent / "uploads" / "pid"

# 潤泰精材：礦化／造粒／混合／燒結系統流程圖（向量 PDF）
PICKS = [
    "R-M0200-00-000-000-00 礦化及造粒系統流程圖_20260408.pdf",
    "R-M0300-00-000-000-00 混合系統流程圖_20230728.pdf",
    "R-M0400-00-000-000-00 燒結系統流程圖_20260107.pdf",
]

# 先前誤匯入的 PI Vision 畫面截圖，不是工程圖
STALE = "DALIN-"


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    for p in DST.glob(f"{STALE}*"):
        p.unlink()
        print(f"移除誤匯入：{p.name}")
    for rel in PICKS:
        src = DL / rel
        if not src.exists():
            print(f"缺檔：{rel}")
            continue
        out = DST / rel
        shutil.copy2(src, out)
        print(f"{out.name:<52} {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
