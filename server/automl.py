"""AutoML 建模引擎 — 對標 Tukey 模型頁（fitting）。

演算法對齊 Tukey 九式（sklearn 實作）；差異化：開放超參數自訂＋自動調參可選
（Tukey 全自動調參、不給使用者手調）。
訓練資料＝資料前處理的現行視圖（steps pipeline 重放後），模型成為歷程下游。
"""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from .dataprep import DATA_DIR, _load_base, _load_steps, apply_steps

router = APIRouter(prefix="/api/automl", tags=["automl"])
AUTOML_DIR = DATA_DIR / "automl"
AUTOML_DIR.mkdir(parents=True, exist_ok=True)

# ------------------------------------------------------ 演算法註冊表（九式對齊）
# params schema: [key, 標籤, type(int/float/str/choice), default, min, max, choices]
ALGOS = {
    "GLM": {
        "name": "廣義線性迴歸 (GLM)", "params": [],
    },
    "GNET": {
        "name": "正規化回歸 (GNET)",
        "params": [
            {"key": "alpha", "label": "正則化強度 alpha", "type": "float", "default": 1.0, "min": 0.0001, "max": 100},
            {"key": "l1_ratio", "label": "L1 比例 l1_ratio", "type": "float", "default": 0.5, "min": 0.0, "max": 1.0},
        ],
    },
    "GAM": {
        "name": "廣義相加模型 (GAM)",
        "params": [
            {"key": "n_knots", "label": "樣條節點數 n_knots", "type": "int", "default": 8, "min": 4, "max": 30},
            {"key": "alpha", "label": "Ridge alpha", "type": "float", "default": 1.0, "min": 0.0001, "max": 100},
        ],
    },
    "SVM": {
        "name": "支持向量機 (SVM)",
        "params": [
            {"key": "C", "label": "懲罰係數 C", "type": "float", "default": 1.0, "min": 0.01, "max": 1000},
            {"key": "epsilon", "label": "不敏感帶 epsilon", "type": "float", "default": 0.1, "min": 0.001, "max": 10},
            {"key": "gamma", "label": "核係數 gamma", "type": "choice", "default": "scale", "choices": ["scale", "auto"]},
        ],
    },
    "KNN": {
        "name": "K-鄰近法 (KNN)",
        "params": [
            {"key": "n_neighbors", "label": "鄰居數 k", "type": "int", "default": 5, "min": 1, "max": 50},
            {"key": "weights", "label": "權重", "type": "choice", "default": "uniform", "choices": ["uniform", "distance"]},
        ],
    },
    "XGB": {
        "name": "梯度提升 (XGB)",
        "params": [
            {"key": "max_iter", "label": "樹數 n_estimators", "type": "int", "default": 200, "min": 20, "max": 1000},
            {"key": "learning_rate", "label": "學習率", "type": "float", "default": 0.1, "min": 0.005, "max": 1.0},
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 20},
            {"key": "l2_regularization", "label": "L2 正則化", "type": "float", "default": 0.0, "min": 0.0, "max": 10},
        ],
    },
    "RF": {
        "name": "隨機森林 (RF)",
        "params": [
            {"key": "n_estimators", "label": "樹數 n_estimators", "type": "int", "default": 300, "min": 20, "max": 1000},
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 40},
            {"key": "min_samples_leaf", "label": "葉最小樣本", "type": "int", "default": 1, "min": 1, "max": 50},
        ],
    },
    "BYS": {
        "name": "貝式迴歸 (BYS)", "params": [],
    },
    "DNN": {
        "name": "神經網路 (DNN)",
        "params": [
            {"key": "hidden", "label": "隱藏層（逗號分隔，如 64,64）", "type": "str", "default": "64,64"},
            {"key": "max_iter", "label": "迭代上限", "type": "int", "default": 500, "min": 50, "max": 5000},
            {"key": "alpha", "label": "L2 正則化 alpha", "type": "float", "default": 0.0001, "min": 1e-6, "max": 1.0},
        ],
    },
}

# 自動調參搜尋空間（RandomizedSearchCV）
TUNE_SPACE = {
    "GNET": {"model__alpha": [0.01, 0.1, 1, 10], "model__l1_ratio": [0.1, 0.5, 0.9]},
    "GAM": {"spline__n_knots": [5, 8, 12, 20], "model__alpha": [0.1, 1, 10]},
    "SVM": {"model__C": [0.1, 1, 10, 100], "model__epsilon": [0.01, 0.1, 0.5]},
    "KNN": {"model__n_neighbors": [3, 5, 9, 15, 25], "model__weights": ["uniform", "distance"]},
    "XGB": {"model__max_iter": [100, 200, 400], "model__learning_rate": [0.03, 0.1, 0.3],
            "model__max_depth": [None, 4, 8]},
    "RF": {"model__n_estimators": [100, 300, 600], "model__max_depth": [None, 8, 16],
           "model__min_samples_leaf": [1, 3, 9]},
    "DNN": {"model__hidden_layer_sizes": [(64,), (64, 64), (128, 64)],
            "model__alpha": [1e-5, 1e-4, 1e-3]},
}


def _build_pipeline(algo: str, params: dict):
    from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
    from sklearn.linear_model import BayesianRidge, ElasticNet, LinearRegression, Ridge
    from sklearn.neighbors import KNeighborsRegressor
    from sklearn.neural_network import MLPRegressor
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import SplineTransformer, StandardScaler
    from sklearn.svm import SVR

    p = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
    steps = [("scaler", StandardScaler())]
    if algo == "GLM":
        model = LinearRegression()
    elif algo == "GNET":
        model = ElasticNet(alpha=float(p.get("alpha", 1.0)), l1_ratio=float(p.get("l1_ratio", 0.5)), max_iter=5000)
    elif algo == "GAM":
        steps.append(("spline", SplineTransformer(n_knots=int(p.get("n_knots", 8)), degree=3)))
        model = Ridge(alpha=float(p.get("alpha", 1.0)))
    elif algo == "SVM":
        model = SVR(C=float(p.get("C", 1.0)), epsilon=float(p.get("epsilon", 0.1)), gamma=p.get("gamma", "scale"))
    elif algo == "KNN":
        model = KNeighborsRegressor(n_neighbors=int(p.get("n_neighbors", 5)), weights=p.get("weights", "uniform"))
    elif algo == "XGB":
        model = HistGradientBoostingRegressor(
            max_iter=int(p.get("max_iter", 200)), learning_rate=float(p.get("learning_rate", 0.1)),
            max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
            l2_regularization=float(p.get("l2_regularization", 0.0)), random_state=0)
    elif algo == "RF":
        model = RandomForestRegressor(
            n_estimators=int(p.get("n_estimators", 300)),
            max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
            min_samples_leaf=int(p.get("min_samples_leaf", 1)), random_state=0, n_jobs=-1)
    elif algo == "BYS":
        model = BayesianRidge()
    elif algo == "DNN":
        hidden = tuple(int(x) for x in str(p.get("hidden", "64,64")).split(",") if x.strip())
        model = MLPRegressor(hidden_layer_sizes=hidden or (64, 64), max_iter=int(p.get("max_iter", 500)),
                             alpha=float(p.get("alpha", 1e-4)), random_state=0)
    else:
        raise HTTPException(422, f"未知演算法 {algo}")
    steps.append(("model", model))
    return Pipeline(steps)


# ------------------------------------------------------ 儲存
def _mdir(sid: str) -> Path:
    d = AUTOML_DIR / sid
    d.mkdir(parents=True, exist_ok=True)
    return d


def _mpath(sid: str, mid: str) -> Path:
    return _mdir(sid) / f"{mid}.json"


def _save(sid: str, rec: dict):
    _mpath(sid, rec["id"]).write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")


def _load(sid: str, mid: str) -> dict:
    p = _mpath(sid, mid)
    if not p.exists():
        raise HTTPException(404, "模型不存在")
    return json.loads(p.read_text(encoding="utf-8"))


# ------------------------------------------------------ 指標
def _metrics(y, yhat) -> dict:
    y, yhat = np.asarray(y, float), np.asarray(yhat, float)
    err = y - yhat
    ss_res = float((err ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum()) or 1e-12
    with np.errstate(divide="ignore", invalid="ignore"):
        ape = np.arctan(np.abs(np.where(y != 0, err / y, err)))  # MAAPE（Tukey 同款指標）
    return {"rmse": round(float(np.sqrt((err ** 2).mean())), 5),
            "mae": round(float(np.abs(err).mean()), 5),
            "maape": round(float(ape.mean()), 7),
            "r2": round(1 - ss_res / ss_tot, 5)}


def _train_job(sid: str, rec: dict):
    """背景訓練：5 折交叉驗證指標＋全訓練集指標＋三圖資料＋permutation importance。"""
    try:
        from sklearn.inspection import permutation_importance
        from sklearn.model_selection import KFold, RandomizedSearchCV, cross_val_predict

        df = _load_base(sid)
        view, *_ = apply_steps(df, _load_steps(sid))
        cols = [rec["target"], *rec["features"]]
        data = view[cols].apply(pd.to_numeric, errors="coerce").dropna()
        if len(data) < 30:
            raise ValueError(f"有效樣本僅 {len(data)} 筆（<30），不足以訓練")
        X, y = data[rec["features"]].values, data[rec["target"]].values

        pipe = _build_pipeline(rec["algo"], rec.get("params"))
        if rec.get("auto_tune") and rec["algo"] in TUNE_SPACE:
            search = RandomizedSearchCV(pipe, TUNE_SPACE[rec["algo"]], n_iter=8, cv=3,
                                        scoring="neg_root_mean_squared_error", random_state=0, n_jobs=1)
            search.fit(X, y)
            pipe = search.best_estimator_
            rec["tuned_params"] = {k.replace("model__", "").replace("spline__", ""): (list(v) if isinstance(v, tuple) else v)
                                   for k, v in search.best_params_.items()}

        cv = KFold(n_splits=5, shuffle=True, random_state=0)
        yhat_cv = cross_val_predict(pipe, X, y, cv=cv)
        rec["metrics_cv"] = _metrics(y, yhat_cv)
        pipe.fit(X, y)
        rec["metrics_train"] = _metrics(y, pipe.predict(X))

        # 三圖資料（抽樣 ≤600 點）：Actual-Predicted / Actual-Error / Feature Importance
        idx = np.random.RandomState(0).choice(len(y), min(600, len(y)), replace=False)
        rec["plots"] = {
            "pa": {"actual": np.round(y[idx], 4).tolist(), "pred": np.round(yhat_cv[idx], 4).tolist()},
            "err": {"actual": np.round(y[idx], 4).tolist(), "error": np.round((y - yhat_cv)[idx], 4).tolist()},
        }
        sub = np.random.RandomState(0).choice(len(y), min(1500, len(y)), replace=False)
        imp = permutation_importance(pipe, X[sub], y[sub], n_repeats=5, random_state=0, n_jobs=1)
        order = np.argsort(imp.importances_mean)[::-1][:15]
        rec["plots"]["fi"] = {"names": [rec["features"][i] for i in order],
                              "values": np.round(imp.importances_mean[order], 5).tolist()}
        rec["n_rows"] = int(len(y))
        rec["status"] = "done"
    except Exception as e:  # noqa: BLE001
        rec["status"] = "error"
        rec["error"] = str(e)[:300]
    _save(sid, rec)


# ------------------------------------------------------ API
@router.get("/algos")
def algos() -> dict:
    return {"algos": [{"key": k, "name": v["name"], "params": v["params"],
                       "tunable": k in TUNE_SPACE} for k, v in ALGOS.items()]}


@router.get("/{sid}/models")
def list_models(sid: str) -> list:
    out = []
    for p in sorted(_mdir(sid).glob("*.json")):
        r = json.loads(p.read_text(encoding="utf-8"))
        out.append({k: r.get(k) for k in
                    ("id", "name", "target", "algo", "status", "created", "metrics_cv", "error", "auto_tune")})
    # 依交叉驗證 RMSE 排名（完成者優先）
    out.sort(key=lambda r: (r["status"] != "done", (r.get("metrics_cv") or {}).get("rmse", 1e18)))
    return out


@router.get("/{sid}/models/{mid}")
def get_model(sid: str, mid: str) -> dict:
    return _load(sid, mid)


@router.delete("/{sid}/models/{mid}")
def delete_model(sid: str, mid: str) -> dict:
    _mpath(sid, mid).unlink(missing_ok=True)
    return {"ok": True}


@router.post("/{sid}/models")
def create_models(sid: str, body: dict) -> dict:
    """手動：單一演算法；全自動：九式各建一個（= Tukey 一次性建立多個模型）。"""
    target = body.get("target")
    features = [f for f in body.get("features", []) if f != target]
    if not target or not features:
        raise HTTPException(422, "需要 target 與至少一個自變數")
    mode = body.get("mode", "manual")
    jobs = []
    if mode == "auto":
        for algo in ALGOS:
            jobs.append({"algo": algo, "name": f"{body.get('name') or target}_{algo}",
                         "params": {}, "auto_tune": True})
    else:
        algo = body.get("algo", "XGB")
        if algo not in ALGOS:
            raise HTTPException(422, f"未知演算法 {algo}")
        jobs.append({"algo": algo, "name": body.get("name") or f"{target}_{algo}",
                     "params": body.get("params") or {}, "auto_tune": bool(body.get("auto_tune"))})

    created = []
    for j in jobs:
        rec = {"id": uuid.uuid4().hex[:8], "sid": sid, "status": "training",
               "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
               "target": target, "features": features, **j}
        _save(sid, rec)
        created.append(rec["id"])

    def run_all(ids=tuple(created)):
        for mid in ids:  # 逐一訓練避免 CPU 風暴
            _train_job(sid, _load(sid, mid))

    threading.Thread(target=run_all, daemon=True).start()
    return {"created": created, "count": len(created)}
