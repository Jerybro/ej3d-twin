"""L1 資料 API facade（對標 Tukey backstage `/tukey/agatha/*` 的資料命名空間）。

把既有 `/api/data/*`（dataprep.py）以 Tukey query 風格重新曝露：
- 路徑一律 **trailing slash**、query 參數（`dataset_id` 即 ej3d 的 `sid`，8-hex）。
- 核心價值：**補上底層端點缺的 `_visible()` 擁有權閘**——每個端點先過 `_guard()`
  取 meta＋驗擁有權，再轉呼叫既有 dataprep 函式。
- `yes/no` ↔ `bool` 轉換一律在本 facade 層做（對標 Tukey `only_success=yes` 字串風格）。

非破壞性：本檔只 **import 呼叫** 既有 `dataprep` 函式，不改其簽章/回傳/例外，
不改既有 `/api/data/*` 路徑與無閘行為（既有前端仍照舊工作）。前綴 `/agatha`
與既有 `/api/*` 完全不重疊。掛載見 main.py 末端（本檔不動 main.py）。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from . import dataprep
from .dataprep import _load_meta, _visible

# 對外 router：前綴 /agatha（L1 資料命名空間）。變數名 router，供 main.py
# `from .data_api import router as facade_data_router` 掛載。
router = APIRouter(prefix="/agatha/data", tags=["agatha-data (L1 facade)"])


# ------------------------------------------------------------ 共用工具
def _yn(v: str | bool | None, default: bool = False) -> bool:
    """Tukey 風格 yes/no 字串 → bool（大小寫不敏感；已是 bool 直接回）。"""
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    return str(v).strip().lower() in ("yes", "y", "1", "true", "on")


def _guard(dataset_id: str, request: Request) -> dict:
    """擁有權閘：補上底層 20 個端點缺的 `_visible()` 檢查。

    dataset 不存在 → 404；本人/admin 以外 → 403。回傳該 dataset 的 meta。
    """
    meta = _load_meta(dataset_id)
    if not meta:
        raise HTTPException(404, "dataset 不存在")
    from .auth import current_user
    u = current_user(request)
    if not _visible(meta, u):
        raise HTTPException(403, "無權存取此 dataset")
    return meta


# ------------------------------------------------------------ 資料集清單
@router.get("/find_dataset_list/")
def find_dataset_list(request: Request, owner_only: str = "no") -> list:
    """可見資料集清單。底層 `list_sessions` 已內建 `_visible` 過濾；
    `owner_only=yes` 時再收斂為「本人擁有」（無 owner 的公共舊資料在此模式下排除）。
    """
    from .auth import current_user
    rows = dataprep.list_sessions(request)  # 已經 _visible 過濾
    out = [{"dataset_id": r["sid"], "filename": r.get("filename"), "owner": r.get("owner"),
            "uploaded_at": r.get("uploaded_at"), "n_rows": r.get("n_rows"),
            "n_models": r.get("n_models")} for r in rows]
    if _yn(owner_only):
        u = current_user(request)
        email = (u or {}).get("email")
        out = [r for r in out if r.get("owner") and r.get("owner") == email]
    return out


# ------------------------------------------------------------ 欄位/目標清單
@router.get("/find_target_list/")
def find_target_list(request: Request, dataset_id: str) -> dict:
    """可選目標欄清單（供 model 發布/whatif 選 target 用）。取自 dataset state 的欄位摘要。"""
    _guard(dataset_id, request)
    st = dataprep.state(dataset_id)
    cols = [{"name": c["name"], "kind": c.get("dtype")} for c in st.get("columns", [])]
    return {"dataset_id": dataset_id, "columns": cols}


# ------------------------------------------------------------ dataset state
@router.get("/dataset_state/")
def dataset_state(request: Request, dataset_id: str) -> dict:
    _guard(dataset_id, request)
    return dataprep.state(dataset_id)


# ------------------------------------------------------------ 卡片牆
@router.get("/dataset_cards/")
def dataset_cards(request: Request, dataset_id: str, target: str = "",
                  page: int = 1, per_page: int = 9, bins: int = 24) -> dict:
    _guard(dataset_id, request)
    return dataprep.cards(dataset_id, target=target, page=page, per_page=per_page, bins=bins)


# ------------------------------------------------------------ 資料列
@router.get("/dataset_rows/")
def dataset_rows(request: Request, dataset_id: str, page: int = 1, per_page: int = 15) -> dict:
    _guard(dataset_id, request)
    return dataprep.rows(dataset_id, page=page, per_page=per_page)


# ------------------------------------------------------------ 序列
@router.get("/dataset_series/")
def dataset_series(request: Request, dataset_id: str, cols: str,
                   max_points: int = 5000) -> dict:
    _guard(dataset_id, request)
    return dataprep.series(dataset_id, cols=cols, max_points=max_points)


# ------------------------------------------------------------ 直方圖
@router.get("/dataset_hist/")
def dataset_hist(request: Request, dataset_id: str, col: str, bins: int = 30) -> dict:
    _guard(dataset_id, request)
    return dataprep.hist(dataset_id, col=col, bins=bins)


# ------------------------------------------------------------ 相關
@router.get("/dataset_corr/")
def dataset_corr(request: Request, dataset_id: str, cols: str = "",
                 method: str = "pearson") -> dict:
    _guard(dataset_id, request)
    return dataprep.corr(dataset_id, cols=cols, method=method)


# ------------------------------------------------------------ 健檢
@router.get("/dataset_health/")
def dataset_health(request: Request, dataset_id: str) -> dict:
    _guard(dataset_id, request)
    return dataprep.health(dataset_id)


# ------------------------------------------------------------ 匯出（CSV）
@router.get("/dataset_export/")
def dataset_export(request: Request, dataset_id: str, raw: str = "no"):
    """CSV 匯出。`raw=yes` → 原始資料集；預設 `no` → 篩選後視圖。
    回傳既有 `export` 的 PlainTextResponse（text/csv）。
    """
    _guard(dataset_id, request)
    return dataprep.export(dataset_id, raw=_yn(raw))
