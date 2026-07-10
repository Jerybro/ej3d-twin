"""發布制模型註冊表（L2 模型 API 後端核心）。

對標 Tukey backstage 的模型 API 名稱制：把 automl 的暫時 (sid, mid) 模型「發布」成
一個穩定、對外唯一的 ``model_key = {hash}_{model_id}``，與 data session（sid）脫鉤。

設計要點（Peter 約束）：
  1. 脫鉤/失聯：發布時把 joblib/record 路徑與 features/target/task/product_type/algo
     快照進註冊表；``resolve()`` 以 joblib_path 為主、sid/mid 為輔。joblib 遺失 → 409，
     不 crash、不亂猜（並記一筆稽核）。
  2. 啟用/停用開關：``set_enabled()``；停用即擋（呼叫端仍應記 usage）。
  4. usage 計數＋最後使用時間＋呼叫稽核：委由 ``usage.py`` 持久化（本檔只呼叫 record）。
  5. model_key 即 3D block 綁定 key：``predict()`` 只需 model_key + inputs。

本檔為「純資料層 + 薄推論封裝」，**無 FastAPI 路由**（路由在 facade_model.py）。
一律重用 automl 既有原語（_load / _load_pipe / _predict_any / _anomaly_score …），
不改任何既有函式簽章與落盤路徑。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import HTTPException

# 重用 automl 既有原語（不改其簽章）——落盤路徑、record 讀取、統一推論、異常評分
from .automl import (
    DATA_DIR,
    THRESH_METHODS,
    _anomaly_score,
    _health_from_risk,
    _load,
    _load_pipe,
    _pipe_path,
)
# 重用 dataprep 既有「以 sid 載入現行視圖 DataFrame」原語（feature_stats 用；不自己重刻讀 parquet）
from .dataprep import _load_base, _load_steps, apply_steps

# ------------------------------------------------------ 落盤位置
REGISTRY_DIR = DATA_DIR / "registry"           # uploads/data/registry/
REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
MODELS_PATH = REGISTRY_DIR / "models.json"     # 單一 JSON 註冊表

_LOCK = threading.Lock()                        # 註冊表讀改寫鎖（與 automl 訓練鎖隔離）
_INITIAL_MODEL_ID = 10001

# ------------------------------------------------------ product_type ↔ task ↔ capability
# task → 預設 product_type（發布時未指定 product_type 時的落點）
_DEFAULT_PT = {
    "anomaly": "occ",
    "timeseries": "timeseries",
    "regression": "quality",
    "classification": "quality",
    "hybrid": "quality",
}

# (task, product_type) → 允許的 capabilities（照抄規格 §3 矩陣，一律推導、不接受手填）
_CAP_MATRIX = {
    ("anomaly", "occ"): ["predict", "evaluate", "threshold"],
    ("regression", "quality"): ["predict", "evaluate", "whatif", "batch"],
    ("classification", "quality"): ["predict", "evaluate", "whatif", "batch"],
    ("hybrid", "quality"): ["predict", "evaluate", "whatif", "batch", "optimize"],
    ("regression", "optimize"): ["predict", "evaluate", "whatif", "optimize", "optimize2"],
    ("hybrid", "optimize"): ["predict", "evaluate", "whatif", "optimize", "optimize2"],
    ("timeseries", "timeseries"): ["evaluate"],  # 單點 predict 對時序無語意（predict() 會 422），故不宣告
}

# task → 該 task 相容的 product_type 集合（發布覆寫時檢查）
_COMPAT_PT = {
    "anomaly": {"occ"},
    "timeseries": {"timeseries"},
    "regression": {"quality", "optimize"},
    "hybrid": {"quality", "optimize"},
    "classification": {"quality"},
}


def product_type_of(task: str) -> str:
    """由 automl rec.task 反推預設 product_type。"""
    return _DEFAULT_PT.get(task, "quality")


def _capabilities_of(task: str, product_type: str) -> list:
    """由 (task, product_type) 推導 capabilities；查無對應回空 list。"""
    return list(_CAP_MATRIX.get((task, product_type), []))


# ------------------------------------------------------ 註冊表 I/O（原子換檔）
def _blank() -> dict:
    return {"next_model_id": _INITIAL_MODEL_ID, "models": {}}


def _read() -> dict:
    """讀註冊表（不加鎖；呼叫端持鎖或僅讀）。損毀/不存在回空表。"""
    if not MODELS_PATH.exists():
        return _blank()
    try:
        data = json.loads(MODELS_PATH.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return _blank()
    if not isinstance(data, dict) or "models" not in data:
        return _blank()
    data.setdefault("next_model_id", _INITIAL_MODEL_ID)
    data.setdefault("models", {})
    return data


def _write(data: dict) -> None:
    """temp 檔 + os.replace 原子換檔（呼叫端須持 _LOCK）。"""
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    tmp = MODELS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, MODELS_PATH)


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _rel(p: Path) -> str:
    """對 BASE_DIR 的相對路徑字串（存進註冊表；resolve 時再拼回絕對）。"""
    base = DATA_DIR.parent.parent            # uploads/data → 專案根
    try:
        return str(Path(p).resolve().relative_to(base)).replace("\\", "/")
    except ValueError:
        return str(Path(p)).replace("\\", "/")


def _abs(rel: str) -> Path:
    """把註冊表存的相對路徑拼回絕對路徑。"""
    base = DATA_DIR.parent.parent
    p = Path(rel)
    return p if p.is_absolute() else (base / p)


# ------------------------------------------------------ feature_stats（守門員統計快照）
def _compute_feature_stats(sid: str, features: list, target: str | None) -> dict | None:
    """對 origin sid 的現行視圖，算 features（含 target，若該欄存在）的分布統計快照。

    重用 dataprep 既有「以 sid 載入現行視圖」原語（_load_base + apply_steps），
    不自己重刻讀 parquet 邏輯。每欄回 {min, p1, p50, p99, max, mean, std}（float, round 6）。
    任何一步失敗（資料被清、欄位對不上等）→ 回 None，由呼叫端（publish）靜默略過。
    """
    try:
        df = _load_base(sid)
        view, *_ = apply_steps(df, _load_steps(sid))
    except Exception:  # noqa: BLE001  資料 session 已清等，不得中斷發布主流程
        return None

    cols = list(dict.fromkeys([*features, *([target] if target else [])]))  # 去重，保序
    out: dict[str, dict] = {}
    for col in cols:
        if col not in view.columns:
            continue
        s = np.asarray(pd.to_numeric(view[col], errors="coerce").dropna(), dtype=float)
        if s.size == 0:
            continue
        out[col] = {
            "min": round(float(np.min(s)), 6),
            "p1": round(float(np.percentile(s, 1)), 6),
            "p50": round(float(np.percentile(s, 50)), 6),
            "p99": round(float(np.percentile(s, 99)), 6),
            "max": round(float(np.max(s)), 6),
            "mean": round(float(np.mean(s)), 6),
            "std": round(float(np.std(s)), 6),
        }
    return out or None


def feature_stats(model_key: str) -> dict | None:
    """查已發布模型的 feature_stats 快照（供 flowsheet 守門員用）。

    從註冊表 record 讀（發布時已算好快照，非即時重算）；
    無此模型 → 404（沿用 get() 的行為）；有此模型但無快照（算失敗或舊發布）→ None。
    """
    rec = get(model_key)
    return rec.get("feature_stats")


# ------------------------------------------------------ 發布
def publish(
    sid: str,
    mid: str,
    *,
    product_type: str | None = None,
    display_name: str | None = None,
    note: str = "",
    published_by: str | None = None,
) -> dict:
    """把 automl 的 (sid, mid) 模型發布成穩定 model_key。

    - 讀 automl rec（`_load`，不存在→404），要求 status=done。
    - product_type：未給→由 task 反推；有給→須與 task 相容（否則 422）。
    - 分配 model_id（遞增）與 hash（sha1(sid|mid|created) 前 8 碼）。
    - capabilities 由 (task, product_type) 推導。
    - 快照 features/target/task/algo 與 joblib/record 路徑（脫鉤後仍可宣告契約）。

    回發布後的 record（完整 dict）。
    """
    rec = _load(sid, mid)                     # 404 if missing
    if rec.get("status") != "done":
        raise HTTPException(422, "模型尚未完成訓練，無法發布")
    task = rec.get("task", "regression")

    pt = (product_type or "").strip().lower() or product_type_of(task)
    if pt not in _COMPAT_PT.get(task, {product_type_of(task)}):
        raise HTTPException(
            422, f"product_type={pt} 與模型 task={task} 不相容（相容值：{sorted(_COMPAT_PT.get(task, []))}）"
        )
    caps = _capabilities_of(task, pt)
    if not caps:
        raise HTTPException(422, f"無法為 (task={task}, product_type={pt}) 推導 capabilities")

    created = rec.get("created") or _now()
    h = hashlib.sha1(f"{sid}|{mid}|{created}".encode("utf-8")).hexdigest()[:8]

    features = list(rec.get("features") or [])
    target = rec.get("target") if rec.get("target") is not None else "（無監督）"

    with _LOCK:
        data = _read()
        model_id = int(data["next_model_id"])
        data["next_model_id"] = model_id + 1
        model_key = f"{h}_{model_id}"
        now = _now()

        # 脫鉤關鍵：把成品 joblib 複製進註冊表自有目錄，predict 從此不再依賴原 (sid,mid) 檔。
        # 之後即使 dataprep.delete_session rmtree automl/{sid} 或 automl.delete_model 刪掉原 joblib，
        # 這個 model_key 的 predict 仍可用（pin 的副本還在）。timeseries 無 joblib，略過。
        artifact_rel = None
        src = _pipe_path(sid, mid)
        if task != "timeseries" and src.exists():
            adir = REGISTRY_DIR / model_key
            adir.mkdir(parents=True, exist_ok=True)
            dst = adir / "model.joblib"
            shutil.copy2(src, dst)
            artifact_rel = _rel(dst)
        # 異常門檻也在發布時快照（predict 不再回頭讀原 record）
        threshold = (rec.get("metrics_cv") or {}).get("threshold")

        record = {
            "model_key": model_key,
            "hash": h,
            "model_id": model_id,
            "display_name": (display_name or "").strip() or rec.get("name") or model_key,
            "product_type": pt,
            "task": task,
            "origin": {
                "sid": sid,
                "mid": mid,
                "joblib_path": _rel(_pipe_path(sid, mid)),
                "record_path": _rel(DATA_DIR / "automl" / sid / f"{mid}.json"),
            },
            "artifact_path": artifact_rel,           # 註冊表 pin 的成品副本（脫鉤主依據）
            "threshold": threshold,                  # anomaly 門檻快照（缺則 predict 時退回本批 P99）
            "features": features,
            "target": target,
            "algo": rec.get("algo"),
            "sim_col": rec.get("sim_col"),           # hybrid 用；其餘為 None
            "capabilities": caps,
            "enabled": True,
            "published_at": now,
            "published_by": published_by,
            "updated_at": now,
            "note": note or "",
        }
        # feature_stats：盡力算（供 flowsheet 守門員用）。失敗（資料被清等）靜默略過，
        # record 不帶此欄，發布照常成功——不得因統計快照失敗而擋住發布主流程。
        stats_target = target if task != "anomaly" else None
        try:
            fs = _compute_feature_stats(sid, features, stats_target)
        except Exception:  # noqa: BLE001  絕不因統計快照失敗擋住發布
            fs = None
        if fs:
            record["feature_stats"] = fs
        data["models"][model_key] = record
        _write(data)
    return record


# ------------------------------------------------------ 查詢
def get(model_key: str) -> dict:
    """取單筆註冊表 record（不存在→404）。"""
    data = _read()
    rec = data["models"].get(model_key)
    if not rec:
        raise HTTPException(404, "model_key 不存在")
    return rec


def exists(model_key: str) -> bool:
    return model_key in _read()["models"]


def list_models(
    *,
    product_type: str | None = None,
    dataset_id: str | None = None,
    only_enabled: bool = False,
) -> list:
    """列出註冊表模型（可依 product_type / 原始 dataset_id / enabled 過濾）。

    回精簡欄位 list（供清單頁）；usage 彙總由呼叫端另掛（facade 用 usage.counters）。
    """
    pt = (product_type or "").strip().lower() or None
    data = _read()
    out = []
    for rec in data["models"].values():
        if pt and rec.get("product_type") != pt:
            continue
        if dataset_id and (rec.get("origin") or {}).get("sid") != dataset_id:
            continue
        if only_enabled and not rec.get("enabled", True):
            continue
        out.append({
            "model_key": rec["model_key"],
            "display_name": rec.get("display_name"),
            "product_type": rec.get("product_type"),
            "task": rec.get("task"),
            "enabled": rec.get("enabled", True),
            "capabilities": rec.get("capabilities", []),
            "features": rec.get("features", []),
            "target": rec.get("target"),
            "dataset_id": (rec.get("origin") or {}).get("sid"),
            "published_at": rec.get("published_at"),
        })
    out.sort(key=lambda r: r["model_key"])
    return out


def capability(model_key: str) -> dict:
    """回契約宣告（L3 block 綁定前查）：capabilities＋input/output schema。

    即使底層 record/joblib 已被清（脫鉤），此宣告仍可回傳（快照常駐註冊表）。
    """
    rec = get(model_key)
    task = rec.get("task")
    features = rec.get("features", [])
    # anomaly 為無監督：required＝全部特徵；其餘一樣依 features 排序全需
    input_schema = {
        "features": [{"name": f} for f in features],
        "required": list(features),
    }
    output_schema = _output_schema_of(task)
    return {
        "model_key": model_key,
        "product_type": rec.get("product_type"),
        "task": task,
        "capabilities": rec.get("capabilities", []),
        "input_schema": input_schema,
        "output_schema": output_schema,
    }


def _output_schema_of(task: str) -> dict:
    if task == "regression" or task == "hybrid":
        return {"kind": "value", "fields": ["value"]}
    if task == "classification":
        return {"kind": "label", "fields": ["label", "proba"]}
    if task == "anomaly":
        return {"kind": "risk", "fields": ["risk", "health", "over_threshold"]}
    if task == "timeseries":
        return {"kind": "none", "note": "單點 predict 無語意，請用 evaluate/forecast"}
    return {"kind": "unknown", "fields": []}


# ------------------------------------------------------ 啟用/停用 · 移除
def set_enabled(model_key: str, enabled: bool) -> dict:
    """切換啟用開關。回 {model_key, enabled}。"""
    with _LOCK:
        data = _read()
        rec = data["models"].get(model_key)
        if not rec:
            raise HTTPException(404, "model_key 不存在")
        rec["enabled"] = bool(enabled)
        rec["updated_at"] = _now()
        _write(data)
    return {"model_key": model_key, "enabled": bool(enabled)}


def unregister(model_key: str) -> dict:
    """從註冊表移除 model_key（**不刪** automl 底層 joblib/record）。回 {ok:true}。"""
    with _LOCK:
        data = _read()
        if model_key not in data["models"]:
            raise HTTPException(404, "model_key 不存在")
        del data["models"][model_key]
        _write(data)
    return {"ok": True}


def update_meta(model_key: str, *, display_name: str | None = None,
                note: str | None = None) -> dict:
    """更新可編輯的中繼欄（display_name / note）。回更新後 record。"""
    with _LOCK:
        data = _read()
        rec = data["models"].get(model_key)
        if not rec:
            raise HTTPException(404, "model_key 不存在")
        if display_name is not None:
            nm = display_name.strip()
            if nm:
                rec["display_name"] = nm
        if note is not None:
            rec["note"] = note
        rec["updated_at"] = _now()
        _write(data)
        return dict(rec)


# ------------------------------------------------------ resolve（脫鉤/失聯策略）
def resolve(model_key: str, *, require_artifact: bool = True) -> tuple:
    """解析 model_key → (sid, mid, rec)。

    - rec＝註冊表 record（含 capabilities/features/target 等快照）。
    - require_artifact=True（predict/evaluate 等實作業）：先驗 origin.joblib_path 是否存在；
      不存在 → 409（model artifact missing）。存在即用，即使原 sid 的 data session 已刪。
    - require_artifact=False（純查契約）：不驗 joblib。

    回 (sid, mid, rec)：sid/mid 取自 origin，供轉呼叫 automl 既有 (sid, mid, ...) 端點。
    """
    rec = get(model_key)
    origin = rec.get("origin") or {}
    sid, mid = origin.get("sid"), origin.get("mid")
    if not sid or not mid:
        raise HTTPException(409, "model_key 缺少 origin(sid/mid)，無法解析")
    # timeseries 無 joblib（評估時即時 forecast），略過成品檢查。
    # 優先驗證註冊表 pin 的成品副本（脫鉤：原 sid/mid 檔即使刪除仍可用）；
    # 舊 record 無 artifact_path 時退回原 joblib_path。失敗只 raise 409，
    # 不在此自記稽核——由 facade 的 _Timer 對該次端點呼叫記一筆，避免同次雙記。
    if require_artifact and rec.get("task") != "timeseries":
        ap = rec.get("artifact_path")
        p = _abs(ap) if ap else (_abs(origin["joblib_path"]) if origin.get("joblib_path") else None)
        if p is None or not p.exists():
            raise HTTPException(409, "model artifact missing（成品已遺失，請重新訓練並重新發布）")
    return sid, mid, rec


# ------------------------------------------------------ inputs 對齊
def _rows_from_inputs(inputs, features: list) -> tuple:
    """把 predict 的 inputs（dict 或 list[dict]）依 features 順序組成 X。

    - 缺 required 特徵 → 422（不靜默補 0）；多給的 key 忽略。
    - 回 (X: np.ndarray[float] shape (n, F), n: int)。
    """
    if inputs is None:
        raise HTTPException(422, "缺少 inputs")
    rows = inputs if isinstance(inputs, list) else [inputs]
    if not rows:
        raise HTTPException(422, "inputs 為空")
    X = []
    for r in rows:
        if not isinstance(r, dict):
            raise HTTPException(422, "每筆 inputs 需為 {feature: value} 物件")
        missing = [f for f in features if f not in r or r[f] is None or r[f] == ""]
        if missing:
            raise HTTPException(422, f"缺少特徵：{missing}")
        try:
            X.append([float(r[f]) for f in features])
        except (TypeError, ValueError):
            raise HTTPException(422, "特徵值必須可轉為數值") from None
    return np.asarray(X, dtype=float), len(rows)


# ------------------------------------------------------ 統一 predict（task 分派）
def predict(model_key: str, inputs, *, check_enabled: bool = True) -> dict:
    """統一推論契約（規格 §6）：只需 model_key + inputs。

    task 分派（automl §5 第 1 條：_predict_any 僅涵蓋 tabular+hybrid）：
      - regression/classification/hybrid → _load_pipe → _predict_any（＋分類 proba）
      - anomaly → joblib pack →_anomaly_score → risk/health/over_threshold
      - timeseries → 422（單點 predict 無語意，請用 evaluate/forecast）

    回統一外殼：{model_key, product_type, task, n, predictions[], used_features}。
    enabled=false 且 check_enabled → 403（呼叫端仍應記 usage）。
    """
    sid, mid, rec = resolve(model_key, require_artifact=True)
    if check_enabled and not rec.get("enabled", True):
        raise HTTPException(403, "模型已停用")

    task = rec.get("task")
    features = rec.get("features", [])
    product_type = rec.get("product_type")

    if task == "timeseries":
        raise HTTPException(422, "timeseries 不支援單點 predict，請用 forecast/evaluate")

    X, n = _rows_from_inputs(inputs, features)

    pack = _load_artifact(rec, sid, mid)          # 從註冊表 pin 的成品載入（脫鉤）
    if task in ("regression", "classification", "hybrid"):
        preds = _predict_tabular(pack, X, task)
    elif task == "anomaly":
        preds = _predict_anomaly_pack(pack, rec, X)
    else:
        raise HTTPException(422, f"未知 task：{task}")

    return {
        "model_key": model_key,
        "product_type": product_type,
        "task": task,
        "n": n,
        "predictions": preds,
        "used_features": list(features),
    }


def _predict_tabular(pack, X: np.ndarray, task: str) -> list:
    from .automl import _predict_any
    if task == "classification":
        # 分類走原生 pipeline.predict（_predict_any 只 ravel 迴歸輸出）
        labels = pack.predict(X)
        out = []
        proba_all = None
        classes = None
        if hasattr(pack, "predict_proba"):
            try:
                proba_all = pack.predict_proba(X)
                classes = [str(c) for c in pack.classes_]
            except Exception:  # noqa: BLE001 部分模型 proba 不可用
                proba_all = None
        for i, lab in enumerate(labels):
            row = {"label": str(lab)}
            if proba_all is not None and classes is not None:
                row["proba"] = {c: round(float(p), 6)
                                for c, p in zip(classes, proba_all[i])}
            out.append(row)
        return out
    # regression / hybrid
    vals = np.ravel(_predict_any(pack, X)).astype(float)
    return [{"value": round(float(v), 6)} for v in vals]


def _load_artifact(rec: dict, sid: str, mid: str):
    """從註冊表 pin 的成品副本載入 joblib（脫鉤主路徑）；
    舊 record 無 artifact_path 時退回原 (sid, mid) 檔。"""
    import joblib
    ap = rec.get("artifact_path")
    p = _abs(ap) if ap else _pipe_path(sid, mid)
    if not p.exists():
        raise HTTPException(409, "model artifact missing（成品已遺失，請重新訓練並重新發布）")
    return joblib.load(p)


def _predict_anomaly_pack(pack: dict, rec: dict, X: np.ndarray) -> list:
    """異常 predict：用已載入的 joblib pack →_anomaly_score→ risk；
    門檻取發布時快照的 rec.threshold，缺則退回本批 P99（不回頭讀原 (sid, mid) record）。"""
    algo = pack.get("algo") or rec.get("algo")
    risk = np.asarray(_anomaly_score(algo, pack["meta"], X), dtype=float)
    thr = rec.get("threshold")
    thr = float(thr) if thr is not None else float(THRESH_METHODS["p99"][1](risk))
    health = _health_from_risk(risk, thr)
    return [{"risk": round(float(r), 6),
             "health": round(float(h), 2),
             "over_threshold": bool(r > thr)}
            for r, h in zip(risk, health)]
