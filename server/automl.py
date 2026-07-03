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

# ------------------------------------------------------ 演算法註冊表
# tasks: regression / classification / timeseries；params schema:
# {key, label, type(int/float/str/choice), default, min, max, choices}
TAB = ["regression", "classification"]
ALGOS = {
    "GLM": {
        "name": "廣義線性迴歸 (GLM)", "tasks": TAB, "params": [],
    },
    "RIDGE": {
        "name": "脊迴歸 (Ridge)", "tasks": TAB,
        "params": [{"key": "alpha", "label": "正則化強度 alpha", "type": "float", "default": 1.0, "min": 0.0001, "max": 1000}],
    },
    "LASSO": {
        "name": "套索迴歸 (Lasso)", "tasks": TAB,
        "params": [{"key": "alpha", "label": "正則化強度 alpha", "type": "float", "default": 0.1, "min": 0.0001, "max": 100}],
    },
    "HUBER": {
        "name": "穩健迴歸 (Huber)", "tasks": ["regression"],
        "params": [
            {"key": "epsilon", "label": "離群閾值 epsilon", "type": "float", "default": 1.35, "min": 1.0, "max": 5.0},
            {"key": "alpha", "label": "正則化 alpha", "type": "float", "default": 0.0001, "min": 1e-6, "max": 1.0},
        ],
    },
    "PLS": {
        "name": "偏最小平方 (PLS)", "tasks": ["regression"],
        "params": [{"key": "n_components", "label": "潛在成分數", "type": "int", "default": 4, "min": 1, "max": 20}],
    },
    "GNET": {
        "name": "正規化回歸 (GNET)", "tasks": TAB,
        "params": [
            {"key": "alpha", "label": "正則化強度 alpha", "type": "float", "default": 1.0, "min": 0.0001, "max": 100},
            {"key": "l1_ratio", "label": "L1 比例 l1_ratio", "type": "float", "default": 0.5, "min": 0.0, "max": 1.0},
        ],
    },
    "GAM": {
        "name": "廣義相加模型 (GAM)", "tasks": TAB,
        "params": [
            {"key": "n_knots", "label": "樣條節點數 n_knots", "type": "int", "default": 8, "min": 4, "max": 30},
            {"key": "alpha", "label": "Ridge alpha", "type": "float", "default": 1.0, "min": 0.0001, "max": 100},
        ],
    },
    "SVM": {
        "name": "支持向量機 (SVM)", "tasks": TAB,
        "params": [
            {"key": "C", "label": "懲罰係數 C", "type": "float", "default": 1.0, "min": 0.01, "max": 1000},
            {"key": "epsilon", "label": "不敏感帶 epsilon（迴歸）", "type": "float", "default": 0.1, "min": 0.001, "max": 10},
            {"key": "gamma", "label": "核係數 gamma", "type": "choice", "default": "scale", "choices": ["scale", "auto"]},
        ],
    },
    "KNN": {
        "name": "K-鄰近法 (KNN)", "tasks": TAB,
        "params": [
            {"key": "n_neighbors", "label": "鄰居數 k", "type": "int", "default": 5, "min": 1, "max": 50},
            {"key": "weights", "label": "權重", "type": "choice", "default": "uniform", "choices": ["uniform", "distance"]},
        ],
    },
    "DT": {
        "name": "決策樹 (DT)", "tasks": TAB,
        "params": [
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 40},
            {"key": "min_samples_leaf", "label": "葉最小樣本", "type": "int", "default": 3, "min": 1, "max": 100},
        ],
    },
    "ET": {
        "name": "極端隨機樹 (ExtraTrees)", "tasks": TAB,
        "params": [
            {"key": "n_estimators", "label": "樹數", "type": "int", "default": 300, "min": 20, "max": 1000},
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 40},
        ],
    },
    "ADA": {
        "name": "AdaBoost", "tasks": TAB,
        "params": [
            {"key": "n_estimators", "label": "弱學習器數", "type": "int", "default": 100, "min": 10, "max": 500},
            {"key": "learning_rate", "label": "學習率", "type": "float", "default": 1.0, "min": 0.01, "max": 3.0},
        ],
    },
    "XGB": {
        "name": "梯度提升 (XGB)", "tasks": TAB,
        "params": [
            {"key": "max_iter", "label": "樹數 n_estimators", "type": "int", "default": 200, "min": 20, "max": 1000},
            {"key": "learning_rate", "label": "學習率", "type": "float", "default": 0.1, "min": 0.005, "max": 1.0},
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 20},
            {"key": "l2_regularization", "label": "L2 正則化", "type": "float", "default": 0.0, "min": 0.0, "max": 10},
        ],
    },
    "RF": {
        "name": "隨機森林 (RF)", "tasks": TAB,
        "params": [
            {"key": "n_estimators", "label": "樹數 n_estimators", "type": "int", "default": 300, "min": 20, "max": 1000},
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 40},
            {"key": "min_samples_leaf", "label": "葉最小樣本", "type": "int", "default": 1, "min": 1, "max": 50},
        ],
    },
    "GPR": {
        "name": "高斯過程 (GPR，小樣本)", "tasks": ["regression"],
        "params": [{"key": "alpha", "label": "雜訊項 alpha", "type": "float", "default": 1e-6, "min": 1e-10, "max": 1.0}],
    },
    "BYS": {
        "name": "貝式迴歸 (BYS)", "tasks": TAB, "params": [],
    },
    "DNN": {
        "name": "神經網路 (DNN)", "tasks": TAB,
        "params": [
            {"key": "hidden", "label": "隱藏層（逗號分隔，如 64,64）", "type": "str", "default": "64,64"},
            {"key": "max_iter", "label": "迭代上限", "type": "int", "default": 500, "min": 50, "max": 5000},
            {"key": "alpha", "label": "L2 正則化 alpha", "type": "float", "default": 0.0001, "min": 1e-6, "max": 1.0},
        ],
    },
    # ---- 異常偵測（設備健康度：以健康運轉段為基準，無監督）----
    "PCA_T2": {
        "name": "PCA 多變量監控 (T²+SPE)", "tasks": ["anomaly"],
        "params": [{"key": "var_keep", "label": "保留變異比例", "type": "float", "default": 0.9, "min": 0.5, "max": 0.99}],
    },
    "IFOREST": {
        "name": "隔離森林 (Isolation Forest)", "tasks": ["anomaly"],
        "params": [{"key": "n_estimators", "label": "樹數", "type": "int", "default": 200, "min": 50, "max": 1000}],
    },
    "OCSVM": {
        "name": "單類支持向量機 (One-Class SVM)", "tasks": ["anomaly"],
        "params": [{"key": "nu", "label": "異常比例上界 nu", "type": "float", "default": 0.05, "min": 0.001, "max": 0.5}],
    },
    "LOF": {
        "name": "局部離群因子 (LOF)", "tasks": ["anomaly"],
        "params": [{"key": "n_neighbors", "label": "鄰居數", "type": "int", "default": 20, "min": 5, "max": 100}],
    },
    "MAHAL": {
        "name": "穩健共變異 (Mahalanobis)", "tasks": ["anomaly"], "params": [],
    },
    # ---- 時序演算法（statsmodels 單變量預測；特徵工程請於上傳前完成）----
    "NAIVE": {
        "name": "Naive（最後值基準）", "tasks": ["timeseries"], "params": [],
    },
    "SNAIVE": {
        "name": "Seasonal Naive（季節基準）", "tasks": ["timeseries"],
        "params": [{"key": "s", "label": "季節週期 s（筆）", "type": "int", "default": 24, "min": 2, "max": 8760}],
    },
    "AR": {
        "name": "自迴歸 (AR)", "tasks": ["timeseries"],
        "params": [{"key": "lags", "label": "階數 p", "type": "int", "default": 8, "min": 1, "max": 96}],
    },
    "ARIMA": {
        "name": "ARIMA", "tasks": ["timeseries"],
        "params": [
            {"key": "p", "label": "AR 階數 p", "type": "int", "default": 2, "min": 0, "max": 10},
            {"key": "d", "label": "差分階數 d", "type": "int", "default": 1, "min": 0, "max": 2},
            {"key": "q", "label": "MA 階數 q", "type": "int", "default": 2, "min": 0, "max": 10},
        ],
    },
    "SARIMA": {
        "name": "SARIMA（季節性）", "tasks": ["timeseries"],
        "params": [
            {"key": "p", "label": "p", "type": "int", "default": 1, "min": 0, "max": 5},
            {"key": "d", "label": "d", "type": "int", "default": 1, "min": 0, "max": 2},
            {"key": "q", "label": "q", "type": "int", "default": 1, "min": 0, "max": 5},
            {"key": "P", "label": "季節 P", "type": "int", "default": 1, "min": 0, "max": 3},
            {"key": "D", "label": "季節 D", "type": "int", "default": 0, "min": 0, "max": 1},
            {"key": "Q", "label": "季節 Q", "type": "int", "default": 1, "min": 0, "max": 3},
            {"key": "s", "label": "季節週期 s", "type": "int", "default": 24, "min": 2, "max": 8760},
        ],
    },
    "ETS": {
        "name": "指數平滑 (Holt-Winters)", "tasks": ["timeseries"],
        "params": [
            {"key": "trend", "label": "趨勢", "type": "choice", "default": "add", "choices": ["add", "mul", "none"]},
            {"key": "seasonal", "label": "季節性", "type": "choice", "default": "none", "choices": ["add", "mul", "none"]},
            {"key": "s", "label": "季節週期 s", "type": "int", "default": 24, "min": 2, "max": 8760},
        ],
    },
    "THETA": {
        "name": "Theta 模型", "tasks": ["timeseries"],
        "params": [{"key": "period", "label": "季節週期", "type": "int", "default": 24, "min": 2, "max": 8760}],
    },
}

# 自動調參搜尋空間（RandomizedSearchCV）
TUNE_SPACE = {
    "RIDGE": {"model__alpha": [0.01, 0.1, 1, 10, 100]},
    "LASSO": {"model__alpha": [0.001, 0.01, 0.1, 1]},
    "HUBER": {"model__epsilon": [1.1, 1.35, 2.0], "model__alpha": [1e-5, 1e-4, 1e-3]},
    "PLS": {"model__n_components": [2, 4, 6, 10]},
    "DT": {"model__max_depth": [None, 4, 8, 16], "model__min_samples_leaf": [1, 3, 9]},
    "ET": {"model__n_estimators": [100, 300, 600], "model__max_depth": [None, 8, 16]},
    "ADA": {"model__n_estimators": [50, 100, 200], "model__learning_rate": [0.1, 0.5, 1.0]},
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

    from sklearn.cross_decomposition import PLSRegression
    from sklearn.ensemble import AdaBoostClassifier, AdaBoostRegressor, ExtraTreesClassifier, ExtraTreesRegressor
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.linear_model import HuberRegressor, Lasso, RidgeClassifier
    from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

    p = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
    cls = task == "classification"
    steps = [("scaler", StandardScaler())]
    if algo == "GLM":
        model = LogisticRegression(max_iter=2000) if cls else LinearRegression()
    elif algo == "RIDGE":
        model = (RidgeClassifier(alpha=float(p.get("alpha", 1.0)))
                 if cls else Ridge(alpha=float(p.get("alpha", 1.0))))
    elif algo == "LASSO":
        model = (LogisticRegression(penalty="l1", solver="saga", max_iter=3000,
                                    C=1.0 / max(float(p.get("alpha", 0.1)), 1e-6))
                 if cls else Lasso(alpha=float(p.get("alpha", 0.1)), max_iter=5000))
    elif algo == "HUBER":
        model = HuberRegressor(epsilon=float(p.get("epsilon", 1.35)), alpha=float(p.get("alpha", 1e-4)))
    elif algo == "PLS":
        model = PLSRegression(n_components=int(p.get("n_components", 4)))
    elif algo == "DT":
        klass = DecisionTreeClassifier if cls else DecisionTreeRegressor
        model = klass(max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
                      min_samples_leaf=int(p.get("min_samples_leaf", 3)), random_state=0)
    elif algo == "ET":
        klass = ExtraTreesClassifier if cls else ExtraTreesRegressor
        model = klass(n_estimators=int(p.get("n_estimators", 300)),
                      max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
                      random_state=0, n_jobs=-1)
    elif algo == "ADA":
        klass = AdaBoostClassifier if cls else AdaBoostRegressor
        model = klass(n_estimators=int(p.get("n_estimators", 100)),
                      learning_rate=float(p.get("learning_rate", 1.0)), random_state=0)
    elif algo == "GPR":
        model = GaussianProcessRegressor(alpha=float(p.get("alpha", 1e-6)),
                                         normalize_y=True, random_state=0)
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


def _ts_series(sid: str, rec: dict):
    """時序單變量序列：現行視圖依時間欄排序的目標值（特徵工程請於上傳前完成）。"""
    ts = rec.get("ts") or {}
    tcol = ts.get("time_col")
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    if tcol not in view.columns or not pd.api.types.is_datetime64_any_dtype(view[tcol]):
        raise HTTPException(422, f"時序模型需要時間欄（{tcol} 不存在或非時間型態）")
    d = view[[tcol, rec["target"]]].copy()
    d[rec["target"]] = pd.to_numeric(d[rec["target"]], errors="coerce")
    d = d.dropna().sort_values(tcol)
    y = d[rec["target"]].to_numpy(dtype=float)
    t = ((d[tcol] - pd.Timestamp(0)) // pd.Timedelta(seconds=1)).to_numpy(dtype=float)
    return y, t


def _ts_forecast(algo: str, params: dict, ytr: np.ndarray, steps: int):
    """以訓練段擬合時序模型並外推 steps 筆。回 (forecast, fitted-in-sample|None)。"""
    p = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
    if algo == "NAIVE":
        return np.full(steps, ytr[-1]), None
    if algo == "SNAIVE":
        s = int(p.get("s", 24))
        if s >= len(ytr):
            return np.full(steps, ytr[-1]), None
        return np.array([ytr[-s + (i % s)] for i in range(steps)]), None
    if algo == "AR":
        from statsmodels.tsa.ar_model import AutoReg
        lags = min(int(p.get("lags", 8)), max(1, len(ytr) // 4))
        res = AutoReg(ytr, lags=lags, old_names=False).fit()
        fc = res.predict(start=len(ytr), end=len(ytr) + steps - 1)
        return np.asarray(fc, float), np.asarray(res.fittedvalues, float)
    if algo == "ARIMA":
        from statsmodels.tsa.arima.model import ARIMA
        res = ARIMA(ytr, order=(int(p.get("p", 2)), int(p.get("d", 1)), int(p.get("q", 2)))).fit()
        return np.asarray(res.forecast(steps), float), np.asarray(res.fittedvalues, float)
    if algo == "SARIMA":
        from statsmodels.tsa.statespace.sarimax import SARIMAX
        res = SARIMAX(ytr, order=(int(p.get("p", 1)), int(p.get("d", 1)), int(p.get("q", 1))),
                      seasonal_order=(int(p.get("P", 1)), int(p.get("D", 0)), int(p.get("Q", 1)), int(p.get("s", 24))),
                      enforce_stationarity=False, enforce_invertibility=False).fit(disp=0)
        return np.asarray(res.forecast(steps), float), np.asarray(res.fittedvalues, float)
    if algo == "ETS":
        from statsmodels.tsa.holtwinters import ExponentialSmoothing
        trend = None if p.get("trend", "add") == "none" else p.get("trend", "add")
        seasonal = None if p.get("seasonal", "none") == "none" else p.get("seasonal")
        res = ExponentialSmoothing(ytr, trend=trend, seasonal=seasonal,
                                   seasonal_periods=int(p.get("s", 24)) if seasonal else None,
                                   initialization_method="estimated").fit()
        return np.asarray(res.forecast(steps), float), np.asarray(res.fittedvalues, float)
    if algo == "THETA":
        from statsmodels.tsa.forecasting.theta import ThetaModel
        res = ThetaModel(pd.Series(ytr), period=int(p.get("period", 24))).fit()
        return res.forecast(steps).to_numpy(dtype=float), None
    raise HTTPException(422, f"未知時序演算法 {algo}")


# ------------------------------------------------------ 異常偵測（設備健康度）
def _anomaly_xt(sid: str, rec: dict):
    """監測欄位矩陣＋時間軸（有時間欄時）。現行視圖＝健康基準假設。"""
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    missing = [c for c in rec["features"] if c not in view.columns]
    if missing:
        raise HTTPException(422, f"現行視圖缺少欄位：{missing}")
    feats = view[rec["features"]].apply(pd.to_numeric, errors="coerce")
    tcol = next((c for c in view.columns if pd.api.types.is_datetime64_any_dtype(view[c])), None)
    if tcol:
        t = (view[tcol] - pd.Timestamp(0)) / pd.Timedelta(seconds=1)
        data = pd.concat([t.rename("__t__"), feats], axis=1).dropna()
        return data[rec["features"]].to_numpy(dtype=float), data["__t__"].to_numpy(dtype=float)
    data = feats.dropna()
    return data.to_numpy(dtype=float), np.arange(len(data), dtype=float)


def _fit_anomaly(algo: str, params: dict, Xtr: np.ndarray) -> dict:
    """以健康基準擬合，回可 joblib 的 meta（純物件，無 closure）。"""
    from sklearn.preprocessing import StandardScaler
    p = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
    sc = StandardScaler().fit(Xtr)
    Z = sc.transform(Xtr)
    if algo == "PCA_T2":
        from sklearn.decomposition import PCA
        pca = PCA(n_components=min(float(p.get("var_keep", 0.9)), 0.99), svd_solver="full").fit(Z)
        lam = np.maximum(pca.explained_variance_, 1e-12)
        T = pca.transform(Z)
        t2 = ((T ** 2) / lam).sum(axis=1)
        spe = ((Z - pca.inverse_transform(T)) ** 2).sum(axis=1)
        # 正規化基準用「訓練段」中位數（新資料評分才可比）
        return {"scaler": sc, "pca": pca, "lam": lam,
                "med_t2": max(float(np.median(t2)), 1e-9), "med_spe": max(float(np.median(spe)), 1e-9)}
    if algo == "IFOREST":
        from sklearn.ensemble import IsolationForest
        m = IsolationForest(n_estimators=int(p.get("n_estimators", 200)), random_state=0).fit(Z)
        return {"scaler": sc, "model": m}
    if algo == "OCSVM":
        from sklearn.svm import OneClassSVM
        m = OneClassSVM(nu=float(p.get("nu", 0.05)), gamma="scale").fit(Z)
        return {"scaler": sc, "model": m}
    if algo == "LOF":
        from sklearn.neighbors import LocalOutlierFactor
        m = LocalOutlierFactor(n_neighbors=int(p.get("n_neighbors", 20)), novelty=True).fit(Z)
        return {"scaler": sc, "model": m}
    if algo == "MAHAL":
        from sklearn.covariance import EllipticEnvelope
        m = EllipticEnvelope(support_fraction=0.9, random_state=0).fit(Z)
        return {"scaler": sc, "model": m}
    raise HTTPException(422, f"未知異常偵測演算法 {algo}")


def _anomaly_score(algo: str, meta: dict, X: np.ndarray) -> np.ndarray:
    """以已擬合 meta 對任意資料計算風險值（越高越異常）。"""
    Z = meta["scaler"].transform(X)
    if algo == "PCA_T2":
        T = meta["pca"].transform(Z)
        t2 = ((T ** 2) / meta["lam"]).sum(axis=1)
        spe = ((Z - meta["pca"].inverse_transform(T)) ** 2).sum(axis=1)
        return t2 / meta["med_t2"] + spe / meta["med_spe"]
    if algo == "IFOREST":
        return -meta["model"].score_samples(Z)
    if algo in ("OCSVM", "LOF"):
        return -meta["model"].decision_function(Z)
    if algo == "MAHAL":
        return meta["model"].mahalanobis(Z)
    raise HTTPException(422, f"未知異常偵測演算法 {algo}")


THRESH_METHODS = {
    "p99": ("風險值 99 百分位", lambda r: float(np.percentile(r, 99))),
    "p995": ("風險值 99.5 百分位", lambda r: float(np.percentile(r, 99.5))),
    "sigma3": ("平均 + 3 倍標準差", lambda r: float(r.mean() + 3 * r.std())),
    "iqr": ("IQR 上界（Q3 + 1.5×IQR）", lambda r: float(np.percentile(r, 75) + 1.5 * (np.percentile(r, 75) - np.percentile(r, 25)))),
}


def _run_anomaly(sid: str, rec: dict):
    """異常偵測訓練：健康基準擬合→全段風險值→建議門檻（P99）＋貢獻度。"""
    import joblib
    X, t = _anomaly_xt(sid, rec)
    if len(X) < 30:
        raise ValueError(f"有效樣本僅 {len(X)} 筆（<30），不足以建立基準")
    meta = _fit_anomaly(rec["algo"], rec.get("params"), X)
    risk = np.asarray(_anomaly_score(rec["algo"], meta, X), float)
    thr = THRESH_METHODS["p99"][1](risk)
    exceed = risk > thr
    rec["metrics_cv"] = {"threshold": round(thr, 5), "exceed_pct": round(float(exceed.mean()) * 100, 3),
                         "mean_risk": round(float(risk.mean()), 5), "max_risk": round(float(risk.max()), 5)}
    rec["metrics_train"] = rec["metrics_cv"]
    rec["val_desc"] = "健康基準＝現行視圖；預設門檻＝P99"
    step = max(1, len(risk) // 900)
    rec["plots"] = {"risk": {"t": t[::step].tolist(), "risk": np.round(risk[::step], 5).tolist(),
                             "threshold": round(thr, 5)}}
    # 貢獻度：超標點各欄位 |z| 平均（哪些感測器把風險推高）
    mu, sd = X.mean(axis=0), np.maximum(X.std(axis=0), 1e-9)
    zi = np.abs((X[exceed] - mu) / sd) if exceed.any() else np.abs((X - mu) / sd)
    contrib = zi.mean(axis=0)
    order = np.argsort(contrib)[::-1][:15]
    rec["plots"]["fi"] = {"names": [rec["features"][i] for i in order],
                          "values": np.round(contrib[order], 4).tolist()}
    rec["n_rows"] = int(len(X))
    joblib.dump({"algo": rec["algo"], "params": rec.get("params"), "meta": meta}, _pipe_path(sid, rec["id"]))
    rec["status"] = "done"


# ------------------------------------------------------ 驗證方法（使用者可選）
def _validation_cfg(rec: dict) -> dict:
    v = rec.get("validation") or {}
    return {"method": v.get("method", "kfold"),
            "k": min(10, max(2, int(v.get("k") or 5))),
            "test_size": min(0.5, max(0.05, float(v.get("test_size") or 0.2))),
            "shuffle": v.get("shuffle", True) not in (False, "false", "0"),
            "n_splits": min(10, max(2, int(v.get("n_splits") or 5)))}


def _validate_tabular(pipe, X, y, cls: bool, cfg: dict):
    """依驗證設定產生驗證對 (y_val, yhat_val, 描述)。"""
    from sklearn.model_selection import (KFold, StratifiedKFold, TimeSeriesSplit,
                                         cross_val_predict, train_test_split)
    m = cfg["method"]
    if m == "holdout":
        pct = int(cfg["test_size"] * 100)
        if cfg["shuffle"]:
            Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=cfg["test_size"], random_state=0,
                                                  stratify=y if cls else None)
            desc = f"保留法（隨機抽 {pct}% 測試）"
        else:
            n_te = max(5, int(len(y) * cfg["test_size"]))
            Xtr, Xte, ytr, yte = X[:-n_te], X[-n_te:], y[:-n_te], y[-n_te:]
            desc = f"保留法（資料末端 {pct}% 測試）"
        pipe.fit(Xtr, ytr)
        return yte, np.ravel(pipe.predict(Xte)) if not cls else pipe.predict(Xte), desc
    if m == "timesplit":
        oof_i, oof_p = [], []
        for tr, te in TimeSeriesSplit(n_splits=cfg["n_splits"]).split(X):
            pipe.fit(X[tr], y[tr])
            oof_i.extend(te.tolist())
            oof_p.extend(np.ravel(pipe.predict(X[te])).tolist() if not cls
                         else list(pipe.predict(X[te])))
        oof_i = np.array(oof_i)
        return y[oof_i], np.asarray(oof_p), f"時序切分（{cfg['n_splits']} 折走前）"
    rs = 0 if cfg["shuffle"] else None
    cv = StratifiedKFold(cfg["k"], shuffle=cfg["shuffle"], random_state=rs) if cls \
        else KFold(cfg["k"], shuffle=cfg["shuffle"], random_state=rs)
    yhat = cross_val_predict(pipe, X, y, cv=cv)
    return y, (np.ravel(yhat) if not cls else yhat), f"{cfg['k']} 折交叉驗證{'' if cfg['shuffle'] else '（不洗牌）'}"


# ------------------------------------------------------ 指標
def _metrics_cls(y, yhat) -> dict:
    from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
    return {"accuracy": round(float(accuracy_score(y, yhat)), 5),
            "f1": round(float(f1_score(y, yhat, average="macro", zero_division=0)), 5),
            "precision": round(float(precision_score(y, yhat, average="macro", zero_division=0)), 5),
            "recall": round(float(recall_score(y, yhat, average="macro", zero_division=0)), 5)}


def _metrics(y, yhat) -> dict:
    # ravel：PLS 等模型輸出 (n,1)，不壓平會廣播成 (n,n)
    y, yhat = np.asarray(y, float).ravel(), np.asarray(yhat, float).ravel()
    err = y - yhat
    ss_res = float((err ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum()) or 1e-12
    with np.errstate(divide="ignore", invalid="ignore"):
        ape = np.arctan(np.abs(np.where(y != 0, err / y, err)))  # MAAPE（Tukey 同款指標）
    return {"rmse": round(float(np.sqrt((err ** 2).mean())), 5),
            "mae": round(float(np.abs(err).mean()), 5),
            "maape": round(float(ape.mean()), 7),
            "r2": round(1 - ss_res / ss_tot, 5)}


def _run_ts(sid: str, rec: dict):
    """時序訓練：尾端保留驗證——訓練段擬合、外推測試段、對照實際。"""
    y, t = _ts_series(sid, rec)
    if len(y) < 40:
        raise ValueError(f"有效樣本僅 {len(y)} 筆（<40），不足以訓練時序模型")
    test_size = min(0.5, max(0.05, float((rec.get("ts") or {}).get("test_size") or 0.2)))
    n_te = min(len(y) // 2, max(8, int(len(y) * test_size)))
    ytr, yte = y[:-n_te], y[-n_te:]
    fc, fitted = _ts_forecast(rec["algo"], rec.get("params"), ytr, n_te)
    rec["metrics_cv"] = _metrics(yte, fc)
    rec["val_desc"] = f"尾端保留 {int(test_size * 100)}%（外推 {n_te} 筆）"
    if fitted is not None and len(fitted) > 0:
        k = len(ytr) - len(fitted)  # AR 類前 lags 筆無 fitted
        skip = max(5, k)            # 差分/初始化模型前幾筆 fitted 不可靠，一律跳過
        rec["metrics_train"] = _metrics(ytr[skip:], fitted[skip - k:])
    else:
        rec["metrics_train"] = _metrics(ytr[1:], ytr[:-1])  # 基準模型：一階遞延
    # 時序疊圖：訓練尾段脈絡＋測試段實際 vs 外推
    n_hist = min(3 * n_te, 600, len(ytr))
    rec["plots"] = {"tsf": {
        "t_hist": t[len(ytr) - n_hist:len(ytr)].tolist(),
        "y_hist": np.round(ytr[-n_hist:], 4).tolist(),
        "t_test": t[-n_te:].tolist(),
        "y_test": np.round(yte, 4).tolist(),
        "pred": np.round(fc, 4).tolist(),
    }}
    rec["n_rows"] = int(len(y))
    rec["status"] = "done"


def _train_job(sid: str, rec: dict):
    """背景訓練：使用者選定的驗證方法＋訓練集指標＋圖資料＋permutation importance＋joblib 持久化。"""
    try:
        import joblib
        from sklearn.inspection import permutation_importance
        from sklearn.model_selection import RandomizedSearchCV

        task = rec.get("task", "regression")
        if task == "timeseries":
            _run_ts(sid, rec)
            _save(sid, rec)
            return
        if task == "anomaly":
            _run_anomaly(sid, rec)
            _save(sid, rec)
            return

        cls = task == "classification"
        X, y = _current_xy(sid, rec)
        if len(y) < 30:
            raise ValueError(f"有效樣本僅 {len(y)} 筆（<30），不足以訓練")
        if cls and len(set(y)) < 2:
            raise ValueError("分類目標只有一個類別")

        pipe = _build_pipeline(rec["algo"], rec.get("params"), task)
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

        # 驗證（使用者可選：K 折／保留法／時序切分）
        cfg = _validation_cfg(rec)
        y_val, yhat_val, desc = _validate_tabular(pipe, X, y, cls, cfg)
        rec["metrics_cv"] = _metrics_cls(y_val, yhat_val) if cls else _metrics(y_val, yhat_val)
        rec["val_desc"] = desc
        pipe.fit(X, y)
        rec["metrics_train"] = _metrics_cls(y, pipe.predict(X)) if cls else _metrics(y, np.ravel(pipe.predict(X)))

        rec["plots"] = {}
        if cls:
            from sklearn.metrics import confusion_matrix
            labels = sorted(set(list(y_val) + list(yhat_val)))
            cm = confusion_matrix(y_val, yhat_val, labels=labels)
            rec["plots"]["cm"] = {"labels": [str(l) for l in labels], "matrix": cm.tolist()}
        else:
            y_val = np.asarray(y_val, float).ravel()
            yhat_val = np.asarray(yhat_val, float).ravel()
            idx = np.random.RandomState(0).choice(len(y_val), min(600, len(y_val)), replace=False)
            rec["plots"]["pa"] = {"actual": np.round(y_val[idx], 4).tolist(),
                                  "pred": np.round(yhat_val[idx], 4).tolist()}
            rec["plots"]["err"] = {"actual": np.round(y_val[idx], 4).tolist(),
                                   "error": np.round((y_val - yhat_val)[idx], 4).tolist()}
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
                       "tasks": v["tasks"], "tunable": k in TUNE_SPACE}
                      for k, v in ALGOS.items()]}


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
    is_anomaly = body.get("task_type") == "anomaly"
    if is_anomaly:
        # 異常偵測＝無監督：不需目標，只要監測欄位
        if len(features) < 2:
            raise HTTPException(422, "異常偵測至少需要兩個監測欄位")
        target = target or "（無監督）"
    elif not target or not features:
        raise HTTPException(422, "需要 target 與至少一個自變數")
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    if is_anomaly:
        task = "anomaly"
    else:
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
                  "test_size": min(0.5, max(0.05, float(body.get("test_size") or 0.2)))}
    validation = body.get("validation") or {}
    mode = body.get("mode", "manual")
    jobs = []
    task_algos = [k for k, v in ALGOS.items() if task in v["tasks"]]
    if mode == "auto":
        for algo in task_algos:
            jobs.append({"algo": algo, "name": f"{body.get('name') or target}_{algo}",
                         "params": {}, "auto_tune": task != "timeseries"})
    else:
        algo = body.get("algo", "XGB")
        if algo not in ALGOS:
            raise HTTPException(422, f"未知演算法 {algo}")
        if task not in ALGOS[algo]["tasks"]:
            raise HTTPException(422, f"{ALGOS[algo]['name']} 不支援{task}任務")
        jobs.append({"algo": algo, "name": body.get("name") or f"{target}_{algo}",
                     "params": body.get("params") or {}, "auto_tune": bool(body.get("auto_tune"))})

    created = []
    for j in jobs:
        rec = {"id": uuid.uuid4().hex[:8], "sid": sid, "status": "training",
               "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
               "target": target, "features": features, "task": task, **j}
        if ts_cfg:
            rec["ts"] = ts_cfg
        if validation:
            rec["validation"] = validation
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
    cls = rec.get("task") == "classification"
    if rec.get("task") == "anomaly":
        # 異常評估＝已訓練基準對「現行視圖」計算風險值（監控新資料）
        import joblib
        pack = joblib.load(_pipe_path(sid, mid)) if _pipe_path(sid, mid).exists() else None
        if not pack:
            raise HTTPException(422, "此模型未保存訓練成品——請重新訓練")
        X, t = _anomaly_xt(sid, rec)
        if len(X) < 5:
            raise HTTPException(422, f"現行視圖有效樣本僅 {len(X)} 筆，無法評估")
        risk = np.asarray(_anomaly_score(rec["algo"], pack["meta"], X), float)
        thr = (rec.get("metrics_cv") or {}).get("threshold") or THRESH_METHODS["p99"][1](risk)
        step = max(1, len(risk) // 900)
        ev = {"evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
              "n_rows": int(len(X)),
              "metrics": {"threshold": round(float(thr), 5),
                          "exceed_pct": round(float((risk > thr).mean()) * 100, 3),
                          "mean_risk": round(float(risk.mean()), 5),
                          "max_risk": round(float(risk.max()), 5)},
              "risk": {"t": t[::step].tolist(), "risk": np.round(risk[::step], 5).tolist(),
                       "threshold": round(float(thr), 5)}}
        rec["evaluation"] = ev
        _save(sid, rec)
        return ev
    if rec.get("task") == "timeseries":
        # 時序評估＝在「現行視圖」重跑尾端保留（重擬合＋外推）
        y, t = _ts_series(sid, rec)
        if len(y) < 40:
            raise HTTPException(422, f"現行視圖有效樣本僅 {len(y)} 筆，無法評估")
        test_size = min(0.5, max(0.05, float((rec.get("ts") or {}).get("test_size") or 0.2)))
        n_te = min(len(y) // 2, max(8, int(len(y) * test_size)))
        ytr, yte = y[:-n_te], y[-n_te:]
        fc, _fitted = _ts_forecast(rec["algo"], rec.get("params"), ytr, n_te)
        n_hist = min(3 * n_te, 600, len(ytr))
        ev = {"evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
              "n_rows": int(len(y)), "metrics": _metrics(yte, fc),
              "tsf": {"t_hist": t[len(ytr) - n_hist:len(ytr)].tolist(),
                      "y_hist": np.round(ytr[-n_hist:], 4).tolist(),
                      "t_test": t[-n_te:].tolist(),
                      "y_test": np.round(yte, 4).tolist(),
                      "pred": np.round(fc, 4).tolist()}}
        rec["evaluation"] = ev
        _save(sid, rec)
        return ev
    pipe = _load_pipe(sid, mid)
    X, y = _current_xy(sid, rec)
    if len(y) < 5:
        raise HTTPException(422, f"現行視圖有效樣本僅 {len(y)} 筆，無法評估")
    yhat = np.ravel(pipe.predict(X)) if not cls else pipe.predict(X)
    ev = {"evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
          "n_rows": int(len(y)),
          "metrics": _metrics_cls(y, yhat) if cls else _metrics(y, yhat)}
    if cls:
        from sklearn.metrics import confusion_matrix
        labels = sorted(set(list(y) + list(yhat)))
        ev["cm"] = {"labels": [str(l) for l in labels],
                    "matrix": confusion_matrix(y, yhat, labels=labels).tolist()}
    else:
        idx = np.random.RandomState(0).choice(len(y), min(600, len(y)), replace=False)
        ev["pa"] = {"actual": np.round(y[idx].astype(float), 4).tolist(),
                    "pred": np.round(yhat[idx].astype(float), 4).tolist()}
    rec["evaluation"] = ev
    _save(sid, rec)
    return ev


@router.post("/{sid}/models/{mid}/threshold")
def threshold(sid: str, mid: str, body: dict) -> dict:
    """風險值門檻試算：對異常偵測模型以指定方法計算合理門檻，回門檻＋超標統計。"""
    rec = _load(sid, mid)
    if rec.get("task") != "anomaly":
        raise HTTPException(422, "門檻試算僅適用異常偵測模型")
    import joblib
    pack = joblib.load(_pipe_path(sid, mid)) if _pipe_path(sid, mid).exists() else None
    if not pack:
        raise HTTPException(422, "此模型未保存訓練成品——請重新訓練")
    method = body.get("method", "p99")
    if method not in THRESH_METHODS:
        raise HTTPException(422, f"未知門檻方法 {method}")
    X, t = _anomaly_xt(sid, rec)
    risk = np.asarray(_anomaly_score(rec["algo"], pack["meta"], X), float)
    name, fn = THRESH_METHODS[method]
    thr = fn(risk)
    exceed = risk > thr
    # 套用：更新模型建議門檻並重繪風險圖
    if body.get("apply"):
        rec["metrics_cv"] = {**(rec.get("metrics_cv") or {}), "threshold": round(thr, 5),
                             "exceed_pct": round(float(exceed.mean()) * 100, 3)}
        if "risk" in (rec.get("plots") or {}):
            rec["plots"]["risk"]["threshold"] = round(thr, 5)
        rec["val_desc"] = f"健康基準＝現行視圖；門檻＝{name}"
        _save(sid, rec)
    return {"method": method, "method_name": name, "threshold": round(thr, 5),
            "n_rows": int(len(risk)), "exceed": int(exceed.sum()),
            "exceed_pct": round(float(exceed.mean()) * 100, 3), "applied": bool(body.get("apply"))}


@router.post("/{sid}/models/{mid}/whatif")
def whatif(sid: str, mid: str, body: dict) -> dict:
    """操作差異試算：baseline＝現行視圖特徵中位數，body.values 覆蓋部分特徵。"""
    rec = _load(sid, mid)
    if rec.get("task") not in ("regression", "classification"):
        raise HTTPException(422, "操作差異試算僅支援迴歸／分類模型")
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
