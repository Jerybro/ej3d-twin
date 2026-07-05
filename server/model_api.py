"""L2 模型 API facade router（發布制模型註冊表對外端點）。

對標 Tukey backstage 的 ``/tukey/agatha/*`` 命名空間：以穩定 ``model_key`` 對外，
把 automl 的暫時 (sid, mid) 模型「發布」成可治理、可統一 predict 的服務。

分層與鐵律（規格 §0、§7）：
  - 本檔為「薄封裝層」：一律轉呼叫 ``registry.py`` + ``automl.py`` 既有推論函式，
    **不改** 任何既有函式簽章、落盤路徑，**不動** ``/api/automl/*`` 與 ``/api/data/*``。
  - 每個模型端點呼叫後經 ``usage.record`` 記帳（usage.py 尚未建立時以 try/except 包住，
    缺 module 不會 crash——與 registry.resolve 的處理一致）。
  - 前綴 ``/agatha``、trailing slash、query 風格對標 Tukey。

底層重用：
  - ``registry.*``：publish / list_models / get / capability / resolve / predict /
    set_enabled / unregister / update_meta。
  - ``automl.*`` 推論端點函式：evaluate / whatif / batch / threshold / optimize /
    optimize2（皆為普通函式，可直接 import 呼叫，非只能經 HTTP）。

Router 變數名：``router``（供 main.py ``from .model_api import router``）。
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Body, File, HTTPException, Query, Request, UploadFile

from . import automl, registry

router = APIRouter(prefix="/agatha", tags=["agatha-model"])


# ══════════════════════════════════════════════════════ 共用 helper

def _yesno(v: str | None, default: bool = False) -> bool:
    """Tukey 風格 ``yes/no`` 字串 → bool。None→default。"""
    if v is None:
        return default
    return str(v).strip().lower() in ("yes", "y", "true", "1", "on")


def _caller(request: Request) -> str | None:
    """取呼叫者 email（auth 關閉時回 None，功能全開）。"""
    try:
        from .auth import current_user
        u = current_user(request)
        return (u or {}).get("email")
    except Exception:  # noqa: BLE001  auth 取用失敗不得影響主流程
        return None


def _record(model_key: str, endpoint: str, *, caller: str | None, source: str,
            n_inputs: int, ok: bool, ms: int, http: int, err: str | None) -> None:
    """委由 usage.py 記帳（缺 module / 記帳失敗皆吞掉，不影響主流程）。

    usage.py 依規格 §8 排在本 facade 之前建立；未建立時此呼叫為 no-op。
    """
    try:
        from . import usage
        usage.record(model_key, endpoint, caller=caller, source=source,
                     n_inputs=n_inputs, ok=ok, ms=ms, http=http, err=err)
    except Exception:  # noqa: BLE001  稽核失敗（含缺 module）不得影響主流程
        pass


def _counters(model_key: str) -> dict | None:
    """取 usage 彙總（缺 module 回 None）。"""
    try:
        from . import usage
        return usage.counters(model_key)
    except Exception:  # noqa: BLE001
        return None


def _audit(model_key: str | None = None, *, limit: int = 200,
           month: str | None = None) -> list:
    """取 usage 稽核（缺 module 回空 list）。"""
    try:
        from . import usage
        return usage.audit(model_key=model_key, limit=limit, month=month)
    except Exception:  # noqa: BLE001
        return []


def _require_cap(rec: dict, cap: str) -> None:
    """capability 前置檢查：不支援 → 409（避免打到 automl 才被硬擋）。"""
    caps = rec.get("capabilities", [])
    if cap not in caps:
        pt = rec.get("product_type")
        raise HTTPException(409, f"此模型（{pt}）不支援 {cap}")


class _Timer:
    """記錄端點耗時（ms）＋自動 usage.record（含成敗與 http code）。

    以 model_key/endpoint/caller/source/n_inputs 初始化；離開 context 時記一筆。
    HTTPException 也會被記錄（http 取其 status_code），再往上拋。
    """

    def __init__(self, model_key: str, endpoint: str, *, caller: str | None,
                 source: str, n_inputs: int):
        self.model_key = model_key
        self.endpoint = endpoint
        self.caller = caller
        self.source = source
        self.n_inputs = n_inputs
        self._t0 = 0.0

    def __enter__(self):
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, tb):
        ms = int((time.perf_counter() - self._t0) * 1000)
        if exc is None:
            _record(self.model_key, self.endpoint, caller=self.caller,
                    source=self.source, n_inputs=self.n_inputs, ok=True, ms=ms,
                    http=200, err=None)
        else:
            http = getattr(exc, "status_code", 500)
            _record(self.model_key, self.endpoint, caller=self.caller,
                    source=self.source, n_inputs=self.n_inputs, ok=False, ms=ms,
                    http=http, err=str(getattr(exc, "detail", exc)))
        return False  # 不吞例外


# ══════════════════════════════════════════════════════ 1. 發布

@router.post("/model/publish/")
def publish_model(request: Request, body: dict = Body(...)) -> dict:
    """發布：把 automl (dataset_id=sid, model_id=mid) 模型註冊成穩定 model_key。

    body: {dataset_id, model_id, product_type?(覆寫), display_name?, note?}
    """
    sid = (body.get("dataset_id") or "").strip()
    mid = (body.get("model_id") or "").strip()
    if not sid or not mid:
        raise HTTPException(422, "需要 dataset_id 與 model_id")
    rec = registry.publish(
        sid, mid,
        product_type=body.get("product_type"),
        display_name=body.get("display_name"),
        note=body.get("note") or "",
        published_by=_caller(request),
    )
    _record(rec["model_key"], "publish", caller=_caller(request), source="api",
            n_inputs=0, ok=True, ms=0, http=200, err=None)
    return {
        "model_key": rec["model_key"],
        "model_id": rec["model_id"],
        "hash": rec["hash"],
        "product_type": rec["product_type"],
        "task": rec["task"],
        "capabilities": rec["capabilities"],
        "enabled": rec["enabled"],
        "features": rec["features"],
    }


# ══════════════════════════════════════════════════════ 2. 模型清單 / 3. 資料集清單 / 4. target 清單

@router.get("/find_model_list/")
def find_model_list(
    product_type: str | None = Query(None),
    model_type: str | None = Query(None),
    dataset_id: str | None = Query(None),
    only_enabled: str = Query("yes"),
    include_usage: str = Query("no"),
) -> list:
    """模型清單（Tukey ``find_model_list`` 對標）。

    - ``model_type`` 為 ``product_type`` 的大小寫不敏感別名（二選一即可）。
    - ``only_enabled=yes`` 只列啟用中；``include_usage=yes`` 附 usage 彙總。
    """
    pt = (product_type or model_type or "").strip().lower() or None
    rows = registry.list_models(
        product_type=pt,
        dataset_id=(dataset_id or None),
        only_enabled=_yesno(only_enabled, True),
    )
    if _yesno(include_usage, False):
        for r in rows:
            c = _counters(r["model_key"]) or {}
            r["total_calls"] = c.get("total_calls", 0)
            r["last_used_at"] = c.get("last_used_at")
    return rows


@router.get("/find_dataset_list/")
def find_dataset_list() -> list:
    """發布模型所依據的資料集清單（去重）——供 L2 管理台按 dataset 過濾。

    純由註冊表推導（不觸碰 dataprep，避免與 L1 facade 職責重疊）：
    列出所有已發布模型的原始 dataset_id 及其發布模型數。
    """
    seen: dict[str, dict] = {}
    for r in registry.list_models():          # list_models 已附 dataset_id，免 N+1 再讀
        sid = r.get("dataset_id")
        if not sid:
            continue
        d = seen.setdefault(sid, {"dataset_id": sid, "n_models": 0, "model_keys": []})
        d["n_models"] += 1
        d["model_keys"].append(r["model_key"])
    return sorted(seen.values(), key=lambda d: d["dataset_id"])


@router.get("/find_target_list/")
def find_target_list(model_key: str = Query(...)) -> dict:
    """某發布模型的 target 宣告（Tukey ``find_target_list`` 對標）。

    回快照的 target 與 features（脫鉤後仍可回，快照常駐註冊表）。
    """
    rec = registry.get(model_key)
    return {
        "model_key": model_key,
        "task": rec.get("task"),
        "target": rec.get("target"),
        "features": rec.get("features", []),
    }


# ══════════════════════════════════════════════════════ 3'. 單筆資訊 / 4'. capability

@router.get("/model/{model_key}/info/")
def model_info(model_key: str) -> dict:
    """單筆註冊表 record（含 capabilities、features、target、origin 摘要、enabled）。"""
    return registry.get(model_key)


@router.get("/model/{model_key}/capability/")
def model_capability(model_key: str) -> dict:
    """契約宣告（L3 block 綁定前查）：capabilities＋input/output schema。

    即使底層 joblib/record 已被清（脫鉤），此宣告仍可回傳。
    """
    return registry.capability(model_key)


# ══════════════════════════════════════════════════════ 5. 統一 predict（L3 核心）

@router.post("/model/{model_key}/predict/")
def model_predict(model_key: str, request: Request, body: dict = Body(...)) -> dict:
    """統一 predict 契約（規格 §6）：只需 model_key + inputs。

    body: {inputs: {feat:val} | [{...},...], source?}
      - 依 rec.features 對齊；缺 required → 422；多給 key 忽略。
      - enabled=false → 403（仍記 usage）。
      - task 分派（anomaly→門檻/風險值、quality→試算、timeseries→422）由 registry.predict 負責。
    """
    inputs = body.get("inputs")
    source = body.get("source") or "api"
    caller = _caller(request)
    n = len(inputs) if isinstance(inputs, list) else 1
    with _Timer(model_key, "predict", caller=caller, source=source, n_inputs=n):
        return registry.predict(model_key, inputs, check_enabled=True)


# ══════════════════════════════════════════════════════ 6. evaluate（依 task 四形狀）

@router.post("/model/{model_key}/evaluate/")
def model_evaluate(model_key: str, request: Request,
                   body: dict = Body(default={})) -> dict:
    """評估：轉呼 automl.evaluate(sid, mid)。異常/品質/最佳化/時間序列各回其形狀。"""
    source = (body or {}).get("source") or "api"
    caller = _caller(request)
    with _Timer(model_key, "evaluate", caller=caller, source=source, n_inputs=0):
        sid, mid, rec = registry.resolve(model_key)
        _require_cap(rec, "evaluate")
        return automl.evaluate(sid, mid)


# ══════════════════════════════════════════════════════ 7. whatif（品質預測試算 · reg/cls/hybrid）

@router.post("/model/{model_key}/whatif/")
def model_whatif(model_key: str, request: Request, body: dict = Body(...)) -> dict:
    """品質預測試算（what-if）：轉呼 automl.whatif(sid, mid, body)。

    body: {values:{feat:val}}。task 不符（capability 無 whatif）→ 409。
    """
    source = body.get("source") or "api"
    caller = _caller(request)
    with _Timer(model_key, "whatif", caller=caller, source=source, n_inputs=1):
        sid, mid, rec = registry.resolve(model_key)
        _require_cap(rec, "whatif")
        return automl.whatif(sid, mid, body)


# ══════════════════════════════════════════════════════ 8. batch（批次試算）

@router.post("/model/{model_key}/batch/")
async def model_batch(model_key: str, request: Request,
                      file: UploadFile = File(...)) -> dict:
    """批次試算：轉呼 automl.batch_calc(sid, mid, file)（async）。"""
    caller = _caller(request)
    with _Timer(model_key, "batch", caller=caller, source="api", n_inputs=0):
        sid, mid, rec = registry.resolve(model_key)
        _require_cap(rec, "batch")
        return await automl.batch_calc(sid, mid, file)


# ══════════════════════════════════════════════════════ 9. threshold（異常門檻/風險值 · anomaly）

@router.post("/model/{model_key}/threshold/")
def model_threshold(model_key: str, request: Request, body: dict = Body(...)) -> dict:
    """異常門檻試算：轉呼 automl.threshold(sid, mid, body)（僅 anomaly）。

    body: {method, apply?}。非 anomaly（capability 無 threshold）→ 409。
    """
    source = body.get("source") or "api"
    caller = _caller(request)
    with _Timer(model_key, "threshold", caller=caller, source=source, n_inputs=0):
        sid, mid, rec = registry.resolve(model_key)
        _require_cap(rec, "threshold")
        return automl.threshold(sid, mid, body)


# ══════════════════════════════════════════════════════ 10. optimize（配方最佳化 · reg/hybrid）

@router.post("/model/{model_key}/optimize/")
def model_optimize(model_key: str, request: Request, body: dict = Body(...)) -> dict:
    """單模型配方最佳化：轉呼 automl.optimize(sid, mid, body)。

    body: {mode, value?, knobs?}。capability 無 optimize（如 quality-only）→ 409。
    """
    source = body.get("source") or "api"
    caller = _caller(request)
    with _Timer(model_key, "optimize", caller=caller, source=source, n_inputs=0):
        sid, mid, rec = registry.resolve(model_key)
        _require_cap(rec, "optimize")
        return automl.optimize(sid, mid, body)


# ══════════════════════════════════════════════════════ 11. optimize2（多目標多模型配方）

@router.post("/optimize2/")
def model_optimize2(request: Request, body: dict = Body(...)) -> dict:
    """多目標配方最佳化（跨發布模型）：objectives[].model_key → resolve →(sid,mid)。

    - 各目標的 model_key 還原成 automl 內部 mid；本輪限制：所有目標須同一 sid
      （不一致 → 422；跨 sid 特徵對齊留 L3+）。
    - 還原後原封轉呼 automl.optimize2(sid, body)。
    """
    objectives = body.get("objectives") or []
    if not objectives:
        raise HTTPException(422, "至少需要一個最佳化目標")

    caller = _caller(request)
    source = body.get("source") or "api"
    t0 = time.perf_counter()

    resolved_sid: str | None = None
    new_objs: list[dict] = []
    used_keys: list[str] = []
    try:
        for o in objectives:
            mk = (o.get("model_key") or "").strip()
            if not mk:
                raise HTTPException(422, "每個目標都需要 model_key")
            sid, mid, rec = registry.resolve(mk)
            _require_cap(rec, "optimize2")
            if resolved_sid is None:
                resolved_sid = sid
            elif sid != resolved_sid:
                raise HTTPException(422, "optimize2 目前僅支援同資料集發布的模型")
            no = dict(o)
            no.pop("model_key", None)
            no["mid"] = mid          # 還原成 automl 內部 mid
            new_objs.append(no)
            used_keys.append(mk)

        new_body = dict(body)
        new_body["objectives"] = new_objs
        out = automl.optimize2(resolved_sid, new_body)
    except HTTPException as e:
        ms = int((time.perf_counter() - t0) * 1000)
        for mk in (used_keys or [
            (o.get("model_key") or "").strip() for o in objectives
        ]):
            if mk:
                _record(mk, "optimize2", caller=caller, source=source, n_inputs=0,
                        ok=False, ms=ms, http=e.status_code, err=str(e.detail))
        raise

    ms = int((time.perf_counter() - t0) * 1000)
    for mk in used_keys:
        _record(mk, "optimize2", caller=caller, source=source, n_inputs=0,
                ok=True, ms=ms, http=200, err=None)
    return out


# ══════════════════════════════════════════════════════ 12. enable / disable（治理開關）

@router.patch("/model/{model_key}/enabled/")
def model_set_enabled(model_key: str, request: Request,
                      body: dict = Body(...)) -> dict:
    """啟用/停用開關（治理）。body: {enabled: bool}。回 {model_key, enabled}。"""
    if "enabled" not in body:
        raise HTTPException(422, "需要 enabled 欄位")
    out = registry.set_enabled(model_key, bool(body["enabled"]))
    _record(model_key, "enable" if out["enabled"] else "disable",
            caller=_caller(request), source="api", n_inputs=0, ok=True, ms=0,
            http=200, err=None)
    return out


# ══════════════════════════════════════════════════════ 12'. 中繼更新（display_name / note）

@router.patch("/model/{model_key}/meta/")
def model_update_meta(model_key: str, body: dict = Body(...)) -> dict:
    """更新可編輯中繼欄（display_name / note）。回更新後 record。"""
    return registry.update_meta(
        model_key,
        display_name=body.get("display_name"),
        note=body.get("note"),
    )


# ══════════════════════════════════════════════════════ 13. 移除（僅移出註冊表）

@router.delete("/model/{model_key}/")
def model_unregister(model_key: str, request: Request) -> dict:
    """從註冊表移除 model_key（**不刪** automl 底層 joblib/record）。回 {ok:true}。"""
    out = registry.unregister(model_key)
    _record(model_key, "unregister", caller=_caller(request), source="api",
            n_inputs=0, ok=True, ms=0, http=200, err=None)
    return out


# ══════════════════════════════════════════════════════ 14. 單模型 usage 查詢

@router.get("/model/{model_key}/usage/")
def model_usage(model_key: str, limit: int = Query(200)) -> dict:
    """單模型 usage：累積使用次數/最後使用時間/端點分佈 + 稽核紀錄。"""
    registry.get(model_key)  # 404 if missing
    return {
        "model_key": model_key,
        "counters": _counters(model_key) or {
            "total_calls": 0, "last_used_at": None, "by_endpoint": {},
        },
        "audit": _audit(model_key, limit=limit),
    }


# ══════════════════════════════════════════════════════ 15. 全域稽核（所有 API 使用紀錄）

@router.get("/usage/audit_log/")
def usage_audit_log(
    limit: int = Query(200),
    month: str | None = Query(None),
    model_key: str | None = Query(None),
) -> dict:
    """「所有 API 使用紀錄」稽核頁資料（可全域、可依 month / model_key 過濾）。"""
    return {
        "limit": limit,
        "month": month,
        "model_key": model_key,
        "audit": _audit((model_key or None), limit=limit, month=month),
    }
