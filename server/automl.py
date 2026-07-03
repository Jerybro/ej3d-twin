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


def _build_pipeline(algo: str, params: dict, task: str = "regression"):
    from sklearn.ensemble import (HistGradientBoostingClassifier, HistGradientBoostingRegressor,
                                  RandomForestClassifier, RandomForestRegressor)
    from sklearn.linear_model import BayesianRidge, ElasticNet, LinearRegression, LogisticRegression, Ridge
    from sklearn.naive_bayes import GaussianNB
    from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
    from sklearn.neural_network import MLPClassifier, MLPRegressor
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import SplineTransformer, StandardScaler
    from sklearn.svm import SVC, SVR

    p = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
    cls = task == "classification"
    steps = [("scaler", StandardScaler())]
    if algo == "GLM":
        model = LogisticRegression(max_iter=2000) if cls else LinearRegression()
    elif algo == "GNET":
        model = (LogisticRegression(penalty="elasticnet", solver="saga", max_iter=3000,
                                    C=1.0 / max(float(p.get("alpha", 1.0)), 1e-6),
                                    l1_ratio=float(p.get("l1_ratio", 0.5)))
                 if cls else
                 ElasticNet(alpha=float(p.get("alpha", 1.0)), l1_ratio=float(p.get("l1_ratio", 0.5)), max_iter=5000))
    elif algo == "GAM":
        steps.append(("spline", SplineTransformer(n_knots=int(p.get("n_knots", 8)), degree=3)))
        model = (LogisticRegression(max_iter=2000, C=1.0 / max(float(p.get("alpha", 1.0)), 1e-6))
                 if cls else Ridge(alpha=float(p.get("alpha", 1.0))))
    elif algo == "SVM":
        model = (SVC(C=float(p.get("C", 1.0)), gamma=p.get("gamma", "scale"), probability=True, random_state=0)
                 if cls else
                 SVR(C=float(p.get("C", 1.0)), epsilon=float(p.get("epsilon", 0.1)), gamma=p.get("gamma", "scale")))
    elif algo == "KNN":
        klass = KNeighborsClassifier if cls else KNeighborsRegressor
        model = klass(n_neighbors=int(p.get("n_neighbors", 5)), weights=p.get("weights", "uniform"))
    elif algo == "XGB":
        klass = HistGradientBoostingClassifier if cls else HistGradientBoostingRegressor
        model = klass(
            max_iter=int(p.get("max_iter", 200)), learning_rate=float(p.get("learning_rate", 0.1)),
            max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
            l2_regularization=float(p.get("l2_regularization", 0.0)), random_state=0)
    elif algo == "RF":
        klass = RandomForestClassifier if cls else RandomForestRegressor
        model = klass(
            n_estimators=int(p.get("n_estimators", 300)),
            max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
            min_samples_leaf=int(p.get("min_samples_leaf", 1)), random_state=0, n_jobs=-1)
    elif algo == "BYS":
        model = GaussianNB() if cls else BayesianRidge()
    elif algo == "DNN":
        hidden = tuple(int(x) for x in str(p.get("hidden", "64,64")).split(",") if x.strip())
        klass = MLPClassifier if cls else MLPRegressor
        model = klass(hidden_layer_sizes=hidden or (64, 64), max_iter=int(p.get("max_iter", 500)),
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


# ------------------------------------------------------ 共用 helper
def _current_xy(sid: str, rec: dict):
    """現行視圖（steps 重放後）取 target/features；評估/試算/優化同源。"""
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    missing = [c for c in (rec["target"], *rec["features"]) if c not in view.columns]
    if missing:
        raise HTTPException(422, f"現行視圖缺少欄位：{missing}")
    feats = view[rec["features"]].apply(pd.to_numeric, errors="coerce")
    if rec.get("task") == "classification":
        tgt = view[rec["target"]].astype(str)
    else:
        tgt = pd.to_numeric(view[rec["target"]], errors="coerce")
    data = pd.concat([tgt.rename(rec["target"]), feats], axis=1).dropna()
    # 強制 numpy：parquet 回讀的字串欄是 Arrow-backed，.values 給 ArrowExtensionArray，
    # sklearn 的 fancy indexing 會炸（pyarrow scalar index error）
    X = data[rec["features"]].to_numpy(dtype=float)
    if rec.get("task") == "classification":
        y = np.asarray(data[rec["target"]].tolist(), dtype=object)
    else:
        y = data[rec["target"]].to_numpy(dtype=float)
    return X, y


def _pipe_path(sid: str, mid: str) -> Path:
    return _mdir(sid) / f"{mid}.joblib"


def _load_pipe(sid: str, mid: str):
    import joblib
    p = _pipe_path(sid, mid)
    if not p.exists():
        raise HTTPException(422, "此模型未保存訓練成品（一期舊模型）——請重新訓練後再使用此功能")
    return joblib.load(p)


def _baseline(sid: str, rec: dict) -> dict:
    """what-if / 優化的基準點＝現行視圖各特徵中位數。"""
    X, _ = _current_xy(sid, rec)
    med = np.median(X, axis=0)
    return {f: round(float(med[i]), 6) for i, f in enumerate(rec["features"])}


def _ts_matrix(sid: str, rec: dict):
    """時序特徵矩陣：目標自身 L 期落遲＋外生變數當期值 → 預測 t+h 的目標。
    回 (X, y, t_epoch, feat_names)；t_epoch 為 y 對應時間點（畫時序圖用）。"""
    ts = rec.get("ts") or {}
    tcol, lags, horizon = ts.get("time_col"), int(ts.get("lags", 8)), int(ts.get("horizon", 1))
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    if tcol not in view.columns or not pd.api.types.is_datetime64_any_dtype(view[tcol]):
        raise HTTPException(422, f"時序模型需要時間欄（{tcol} 不存在或非時間型態）")
    d = view.sort_values(tcol).reset_index(drop=True)
    tgt = pd.to_numeric(d[rec["target"]], errors="coerce")
    cols = {}
    feat_names = []
    for k in range(lags):
        name = f"{rec['target']}(t{'' if k == 0 else f'-{k}'})"
        cols[name] = tgt.shift(k)
        feat_names.append(name)
    for f in rec["features"]:
        cols[f] = pd.to_numeric(d[f], errors="coerce")
        feat_names.append(f)
    frame = pd.DataFrame(cols)
    frame["__y__"] = tgt.shift(-horizon)
    frame["__t__"] = (d[tcol].shift(-horizon) - pd.Timestamp(0)) // pd.Timedelta(seconds=1)
    frame = frame.dropna()
    X = frame[feat_names].to_numpy(dtype=float)
    y = frame["__y__"].to_numpy(dtype=float)
    t = frame["__t__"].to_numpy(dtype=float)
    return X, y, t, feat_names


# ------------------------------------------------------ 指標
def _metrics_cls(y, yhat) -> dict:
    from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
    return {"accuracy": round(float(accuracy_score(y, yhat)), 5),
            "f1": round(float(f1_score(y, yhat, average="macro", zero_division=0)), 5),
            "precision": round(float(precision_score(y, yhat, average="macro", zero_division=0)), 5),
            "recall": round(float(recall_score(y, yhat, average="macro", zero_division=0)), 5)}


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
    """背景訓練：5 折交叉驗證指標＋全訓練集指標＋圖資料＋permutation importance＋joblib 持久化。"""
    try:
        import joblib
        from sklearn.inspection import permutation_importance
        from sklearn.model_selection import KFold, RandomizedSearchCV, StratifiedKFold, cross_val_predict

        task = rec.get("task", "regression")
        cls = task == "classification"
        ts = task == "timeseries"
        feat_names = rec["features"]
        t_epoch = None
        if ts:
            X, y, t_epoch, feat_names = _ts_matrix(sid, rec)
        else:
            X, y = _current_xy(sid, rec)
        if len(y) < 30:
            raise ValueError(f"有效樣本僅 {len(y)} 筆（<30），不足以訓練")
        if cls and len(set(y)) < 2:
            raise ValueError("分類目標只有一個類別")

        pipe = _build_pipeline(rec["algo"], rec.get("params"), "regression" if ts else task)
        if rec.get("auto_tune") and rec["algo"] in TUNE_SPACE:
            scoring = "f1_macro" if cls else "neg_root_mean_squared_error"
            space = {k: v for k, v in TUNE_SPACE[rec["algo"]].items()
                     if k.replace("model__", "") in {pp["key"] for pp in ALGOS[rec["algo"]]["params"]}
                     or k.startswith("spline__") or k == "model__hidden_layer_sizes"}
            try:
                search = RandomizedSearchCV(pipe, space, n_iter=8, cv=3,
                                            scoring=scoring, random_state=0, n_jobs=1)
                search.fit(X, y)
                pipe = search.best_estimator_
                rec["tuned_params"] = {k.replace("model__", "").replace("spline__", ""):
                                       (list(v) if isinstance(v, tuple) else v)
                                       for k, v in search.best_params_.items()}
            except Exception:  # noqa: BLE001 分類器參數名不合時退回預設
                pipe = _build_pipeline(rec["algo"], rec.get("params"), task)

        if ts:
            # 走前驗證（TimeSeriesSplit）：不能洗牌，逐折收 out-of-fold 預測
            from sklearn.model_selection import TimeSeriesSplit
            oof_idx, oof_pred = [], []
            for tr, te in TimeSeriesSplit(n_splits=5).split(X):
                pipe.fit(X[tr], y[tr])
                oof_idx.extend(te.tolist())
                oof_pred.extend(pipe.predict(X[te]).tolist())
            oof_idx = np.array(oof_idx)
            yhat_cv_ts = np.array(oof_pred)
            rec["metrics_cv"] = _metrics(y[oof_idx], yhat_cv_ts)
            pipe.fit(X, y)
            rec["metrics_train"] = _metrics(y, pipe.predict(X))
            rec["plots"] = {}
            # 時序圖：走前驗證區段的 actual vs pred（等距抽樣 ≤800 點，保持時間序）
            step = max(1, len(oof_idx) // 800)
            sel = oof_idx[::step]
            selp = yhat_cv_ts[::step]
            rec["plots"]["ts"] = {"t": t_epoch[sel].tolist(),
                                  "actual": np.round(y[sel], 4).tolist(),
                                  "pred": np.round(selp, 4).tolist()}
            rec["plots"]["pa"] = {"actual": np.round(y[oof_idx][:600], 4).tolist(),
                                  "pred": np.round(yhat_cv_ts[:600], 4).tolist()}
            sub = np.random.RandomState(0).choice(len(y), min(1500, len(y)), replace=False)
            imp = permutation_importance(pipe, X[sub], y[sub], n_repeats=5, random_state=0, n_jobs=1)
            order = np.argsort(imp.importances_mean)[::-1][:15]
            rec["plots"]["fi"] = {"names": [feat_names[i] for i in order],
                                  "values": np.round(imp.importances_mean[order], 5).tolist()}
            rec["n_rows"] = int(len(y))
            joblib.dump(pipe, _pipe_path(sid, rec["id"]))
            rec["status"] = "done"
            _save(sid, rec)
            return

        cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=0) if cls \
            else KFold(n_splits=5, shuffle=True, random_state=0)
        yhat_cv = cross_val_predict(pipe, X, y, cv=cv)
        rec["metrics_cv"] = _metrics_cls(y, yhat_cv) if cls else _metrics(y, yhat_cv)
        pipe.fit(X, y)
        rec["metrics_train"] = _metrics_cls(y, pipe.predict(X)) if cls else _metrics(y, pipe.predict(X))

        rec["plots"] = {}
        if cls:
            # 混淆矩陣（交叉驗證預測）
            from sklearn.metrics import confusion_matrix
            labels = sorted(set(y))
            cm = confusion_matrix(y, yhat_cv, labels=labels)
            rec["plots"]["cm"] = {"labels": [str(l) for l in labels], "matrix": cm.tolist()}
        else:
            idx = np.random.RandomState(0).choice(len(y), min(600, len(y)), replace=False)
            rec["plots"]["pa"] = {"actual": np.round(y[idx].astype(float), 4).tolist(),
                                  "pred": np.round(yhat_cv[idx].astype(float), 4).tolist()}
            rec["plots"]["err"] = {"actual": np.round(y[idx].astype(float), 4).tolist(),
                                   "error": np.round((y - yhat_cv)[idx].astype(float), 4).tolist()}
        sub = np.random.RandomState(0).choice(len(y), min(1500, len(y)), replace=False)
        imp = permutation_importance(pipe, X[sub], y[sub], n_repeats=5, random_state=0, n_jobs=1,
                                     scoring="f1_macro" if cls else None)
        order = np.argsort(imp.importances_mean)[::-1][:15]
        rec["plots"]["fi"] = {"names": [rec["features"][i] for i in order],
                              "values": np.round(imp.importances_mean[order], 5).tolist()}
        rec["n_rows"] = int(len(y))
        joblib.dump(pipe, _pipe_path(sid, rec["id"]))
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
                    ("id", "name", "target", "algo", "task", "status", "created",
                     "metrics_cv", "error", "auto_tune")})
    # 排名：迴歸依 CV RMSE、分類依 1−accuracy（完成者優先）
    def _rank(r):
        m = r.get("metrics_cv") or {}
        score = m.get("rmse", 1 - m.get("accuracy", -1e18))
        return (r["status"] != "done", score)
    out.sort(key=_rank)
    return out


@router.get("/{sid}/models/{mid}")
def get_model(sid: str, mid: str) -> dict:
    return _load(sid, mid)


@router.delete("/{sid}/models/{mid}")
def delete_model(sid: str, mid: str) -> dict:
    _mpath(sid, mid).unlink(missing_ok=True)
    _pipe_path(sid, mid).unlink(missing_ok=True)
    return {"ok": True}


@router.post("/{sid}/models")
def create_models(sid: str, body: dict) -> dict:
    """手動：單一演算法；全自動：九式各建一個（= Tukey 一次性建立多個模型）。
    任務自動判定：目標欄數值＝迴歸、字串/類別＝分類。"""
    target = body.get("target")
    features = [f for f in body.get("features", []) if f != target]
    if not target or (not features and body.get("task_type") != "timeseries"):
        # 時序預測可只用目標自身落遲（外生變數可留空）
        raise HTTPException(422, "需要 target 與至少一個自變數")
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    if target not in view.columns:
        raise HTTPException(422, f"目標欄 {target} 不存在")
    task = "regression" if pd.api.types.is_numeric_dtype(view[target]) else "classification"
    ts_cfg = None
    if body.get("task_type") == "timeseries":
        if task != "regression":
            raise HTTPException(422, "時序預測的目標必須是數值欄")
        tcols = [c for c in view.columns if pd.api.types.is_datetime64_any_dtype(view[c])]
        if not tcols:
            raise HTTPException(422, "時序預測需要時間欄")
        task = "timeseries"
        ts_cfg = {"time_col": body.get("time_col") or tcols[0],
                  "horizon": max(1, int(body.get("horizon") or 1)),
                  "lags": min(48, max(1, int(body.get("lags") or 8)))}
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
               "target": target, "features": features, "task": task, **j}
        if ts_cfg:
            rec["ts"] = ts_cfg
        _save(sid, rec)
        created.append(rec["id"])

    def run_all(ids=tuple(created)):
        for mid in ids:  # 逐一訓練避免 CPU 風暴
            _train_job(sid, _load(sid, mid))

    threading.Thread(target=run_all, daemon=True).start()
    return {"created": created, "count": len(created)}


# ------------------------------------------------------ 模型應用（Tukey 對齊，除 API 啟用管理）
@router.post("/{sid}/models/{mid}/evaluate")
def evaluate(sid: str, mid: str) -> dict:
    """單一模型評估（隨選）：以現行視圖重評——視圖若已變（新步驟/新資料），
    這就是模型在「現在這份資料」上的表現。"""
    rec = _load(sid, mid)
    if rec.get("status") != "done":
        raise HTTPException(422, "模型尚未完成訓練")
    pipe = _load_pipe(sid, mid)
    cls = rec.get("task") == "classification"
    ts = rec.get("task") == "timeseries"
    t_epoch = None
    if ts:
        X, y, t_epoch, _names = _ts_matrix(sid, rec)
    else:
        X, y = _current_xy(sid, rec)
    if len(y) < 5:
        raise HTTPException(422, f"現行視圖有效樣本僅 {len(y)} 筆，無法評估")
    yhat = pipe.predict(X)
    ev = {"evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
          "n_rows": int(len(y)),
          "metrics": _metrics_cls(y, yhat) if cls else _metrics(y, yhat)}
    if cls:
        from sklearn.metrics import confusion_matrix
        labels = sorted(set(list(y) + list(yhat)))
        ev["cm"] = {"labels": [str(l) for l in labels],
                    "matrix": confusion_matrix(y, yhat, labels=labels).tolist()}
    elif ts:
        step = max(1, len(y) // 800)
        ev["ts"] = {"t": t_epoch[::step].tolist(),
                    "actual": np.round(y[::step], 4).tolist(),
                    "pred": np.round(yhat[::step], 4).tolist()}
    else:
        idx = np.random.RandomState(0).choice(len(y), min(600, len(y)), replace=False)
        ev["pa"] = {"actual": np.round(y[idx].astype(float), 4).tolist(),
                    "pred": np.round(yhat[idx].astype(float), 4).tolist()}
    rec["evaluation"] = ev
    _save(sid, rec)
    return ev


@router.post("/{sid}/models/{mid}/whatif")
def whatif(sid: str, mid: str, body: dict) -> dict:
    """操作差異試算：baseline＝現行視圖特徵中位數，body.values 覆蓋部分特徵。"""
    rec = _load(sid, mid)
    if rec.get("task") == "timeseries":
        raise HTTPException(422, "時序模型不支援操作差異試算（輸入含自身落遲）")
    pipe = _load_pipe(sid, mid)
    base = _baseline(sid, rec)
    values = body.get("values") or {}
    row = dict(base)
    for k, v in values.items():
        if k in row and v is not None and v != "":
            row[k] = float(v)
    Xb = np.array([[base[f] for f in rec["features"]]])
    Xn = np.array([[row[f] for f in rec["features"]]])
    if rec.get("task") == "classification":
        pb, pn = str(pipe.predict(Xb)[0]), str(pipe.predict(Xn)[0])
        out = {"baseline_pred": pb, "pred": pn, "changed": pb != pn, "baseline": base}
        if hasattr(pipe, "predict_proba"):
            proba = pipe.predict_proba(Xn)[0]
            classes = [str(c) for c in pipe.classes_]
            out["proba"] = {c: round(float(p), 4) for c, p in
                            sorted(zip(classes, proba), key=lambda t: -t[1])[:5]}
        return out
    pb, pn = float(pipe.predict(Xb)[0]), float(pipe.predict(Xn)[0])
    return {"baseline_pred": round(pb, 5), "pred": round(pn, 5),
            "delta": round(pn - pb, 5), "baseline": base}


@router.post("/{sid}/models/{mid}/optimize")
def optimize(sid: str, mid: str, body: dict) -> dict:
    """配方優化（參數最佳化）：目標值/最大化/最小化，輸出最佳參數建議。
    可調參數邊界＝現行視圖 P1–P99；隨機搜尋＋最佳鄰域細化。僅迴歸。"""
    rec = _load(sid, mid)
    if rec.get("task") != "regression":
        raise HTTPException(422, "配方優化僅支援迴歸模型")
    pipe = _load_pipe(sid, mid)
    mode = body.get("mode", "target")
    knobs = [k for k in (body.get("knobs") or rec["features"]) if k in rec["features"]]
    if not knobs:
        raise HTTPException(422, "至少選一個可調參數")
    if mode == "target" and body.get("value") in (None, ""):
        raise HTTPException(422, "target 模式需要目標值")

    X, _ = _current_xy(sid, rec)
    base = _baseline(sid, rec)
    lo = {f: float(np.percentile(X[:, i], 1)) for i, f in enumerate(rec["features"])}
    hi = {f: float(np.percentile(X[:, i], 99)) for i, f in enumerate(rec["features"])}
    rng = np.random.RandomState(0)
    kidx = [rec["features"].index(k) for k in knobs]

    def make(n, center=None, spread=1.0):
        pts = np.tile([base[f] for f in rec["features"]], (n, 1))
        for j, i in enumerate(kidx):
            f = rec["features"][i]
            if center is None:
                pts[:, i] = rng.uniform(lo[f], hi[f], n)
            else:
                span = (hi[f] - lo[f]) * 0.08 * spread
                pts[:, i] = np.clip(rng.normal(center[j], span or 1e-9, n), lo[f], hi[f])
        return pts

    def score(preds):
        if mode == "max":
            return -preds
        if mode == "min":
            return preds
        return np.abs(preds - float(body["value"]))

    cand = make(3000)
    preds = pipe.predict(cand)
    order = np.argsort(score(preds))
    # 最佳 50 組鄰域細化一輪
    refined = np.vstack([make(40, center=cand[i, kidx], spread=1.0) for i in order[:50]])
    preds2 = pipe.predict(refined)
    all_pts = np.vstack([cand, refined])
    all_preds = np.concatenate([preds, preds2])
    best_i = int(np.argmin(score(all_preds)))
    best_pt = all_pts[best_i]

    baseline_pred = float(pipe.predict(np.array([[base[f] for f in rec["features"]]]))[0])
    return {
        "mode": mode, "value": body.get("value"),
        "best": {rec["features"][i]: round(float(best_pt[i]), 5) for i in kidx},
        "baseline": {k: base[k] for k in knobs},
        "bounds": {k: [round(lo[k], 5), round(hi[k], 5)] for k in knobs},
        "pred": round(float(all_preds[best_i]), 5),
        "baseline_pred": round(baseline_pred, 5),
    }
