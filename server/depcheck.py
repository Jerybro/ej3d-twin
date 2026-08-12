"""啟動期相依套件體檢——缺什麼在啟動當下講清楚，不留到使用者點功能才爆。

血淚教訓（2026-08-12 換筆電重建環境實測）：requirements 漏列＋延遲載入的組合，
讓「pip 裝完、伺服器正常啟動」與「功能真的能用」變成兩回事——缺 websockets 時
/ws 握手默默退化成一般 GET 回 404（孿生即時數據全斷、日誌只有一行無害的 404）；
缺 pypdfium2 時 P&ID 上傳成功、開圖面才「圖面載入失敗」。

此模組用 find_spec 掃描（只查安裝、不真正 import，不拖慢啟動）：
- 核心缺件 → 直接拒絕啟動，列出缺什麼與修復指令——半殘上線只會在別人面前壞
- 功能缺件 → 印出警告後照常啟動，讓「能跑的部分」不被「沒裝的部分」擋住
"""
from __future__ import annotations

import importlib.util
import sys

# (import 名, pip 套件名, 缺了的症狀)
CORE = [
    ("fastapi", "fastapi", "伺服器無法啟動"),
    ("multipart", "python-multipart", "FastAPI 啟動時就會因上傳端點報錯"),
    ("itsdangerous", "itsdangerous", "SessionMiddleware 匯入即失敗，伺服器起不來"),
    ("websockets", "websockets", "/ws 默默退化成 404，孿生檢視收不到即時數據"),
    ("numpy", "numpy", "資料工作台／AutoML 全滅"),
    ("pandas", "pandas", "資料工作台／AutoML 全滅"),
    ("sklearn", "scikit-learn", "AutoML 無法建模、代理模型無法推論"),
    ("pyarrow", "pyarrow", "資料上傳 500（資料集以 parquet 存放）"),
    ("openpyxl", "openpyxl", "Excel 上傳／匯出失敗"),
]
FEATURE = [
    ("pypdfium2", "pypdfium2", "P&ID 圖面渲染——上傳後「圖面載入失敗」"),
    ("easyocr", "easyocr", "P&ID 位號辨識與倒置轉正（首次使用會下載模型）"),
    ("networkx", "networkx", "管網拓撲／製程順序圖／資產模型"),
    ("statsmodels", "statsmodels", "AutoML 時序統計模型"),
    ("asyncua", "asyncua", "OPC UA 真實數據源（用內建模擬器則不需要）"),
]

_FIX = "修復：pip install -r requirements.txt（記得用同一個 venv）"


def _missing(rows: list[tuple[str, str, str]]) -> list[tuple[str, str, str]]:
    return [r for r in rows if importlib.util.find_spec(r[0]) is None]


def check_deps() -> None:
    core, feat = _missing(CORE), _missing(FEATURE)
    # 不用 ⚠✗✓ 等符號：Windows 傳統主控台（cp950）印不出來，
    # stdout 會直接 UnicodeEncodeError，體檢自己先炸就本末倒置了。
    if feat and not core:
        print("[警告] 缺少功能套件——伺服器會啟動，但下列功能一點就壞：", file=sys.stderr)
        for _, pkg, sym in feat:
            print(f"    {pkg}：{sym}", file=sys.stderr)
        print(f"  {_FIX}", file=sys.stderr)
    if core:
        lines = ["[錯誤] 缺少核心套件，拒絕以半殘狀態啟動："]
        lines += [f"    {pkg}：{sym}" for _, pkg, sym in core]
        if feat:
            lines += ["  另缺功能套件：" + "、".join(pkg for _, pkg, _ in feat)]
        lines.append(f"  {_FIX}")
        raise SystemExit("\n".join(lines))


check_deps()   # import 即檢查：必須搶在其他第三方 import 炸出深層 traceback 之前
