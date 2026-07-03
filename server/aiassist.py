"""生成式 AI 助教 — 本機 LLM（OpenAI 相容端點）實時評估建模狀況、給資料處理建議。

金鑰與端點不進版控：AI_API_KEY / AI_BASE_URL 環境變數優先，
否則讀 ~/llamacpp/api_key.txt；端點預設本機 llama.cpp（127.0.0.1:8787）。
Qwen3 思考模式用 chat_template_kwargs.enable_thinking=false 關閉（延遲 2-3s）。
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from .automl import ALGOS
from .automl import _load as _load_model
from .automl import _mdir
from .dataprep import _load_base, _load_steps, apply_steps

router = APIRouter(prefix="/api/ai", tags=["ai"])

BASE_URL = os.environ.get("AI_BASE_URL", "http://127.0.0.1:8787/v1")


def _api_key() -> str | None:
    k = os.environ.get("AI_API_KEY")
    if k:
        return k
    p = Path.home() / "llamacpp" / "api_key.txt"
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    return None


SYSTEM = (
    "你是製程資料智能平台的 AI 助教，使用者可能不懂統計與機器學習。"
    "以繁體中文、白話、務實地回覆：第一行先一句話總結目前狀態，"
    "接著列最多 4 點具體建議，每點一行、行首用「1. 」式編號，"
    "每點說清楚「做什麼＋為什麼」。不要 markdown 標題與粗體符號，"
    "不要空泛話術；證據不足的判斷要明說是推測。"
)


def _chat(user_msg: str, max_tokens: int = 600) -> str:
    key = _api_key()
    if not key:
        raise HTTPException(503, "本機 AI 引擎未設定（找不到 API key）")
    body = {
        "model": "qwen3.6", "max_tokens": max_tokens, "temperature": 0.4,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": user_msg}],
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            out = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"本機 AI 引擎無回應（{type(e).__name__}）——請確認引擎服務已啟動") from None
    return (out["choices"][0]["message"].get("content") or "").strip()


@router.get("/status")
def status() -> dict:
    if not _api_key():
        return {"ok": False, "reason": "未設定 API key"}
    try:
        req = urllib.request.Request(f"{BASE_URL}/models",
                                     headers={"Authorization": f"Bearer {_api_key()}"})
        with urllib.request.urlopen(req, timeout=3) as r:
            r.read()
        return {"ok": True}
    except Exception:  # noqa: BLE001
        return {"ok": False, "reason": "本機 AI 引擎未啟動"}


# ------------------------------------------------------ context 構建
def _data_context(sid: str) -> str:
    df = _load_base(sid)
    steps = _load_steps(sid)
    view, *_ = apply_steps(df, steps)
    num = view.select_dtypes(include="number")
    lines = [f"原始資料 {len(df)} 筆，經 {len([s for s in steps if s.get('enabled', True)])} 個處理步驟後現行視圖 {len(view)} 筆、{len(view.columns)} 欄。"]
    if steps:
        kinds = [s.get("kind", "?") for s in steps if s.get("enabled", True)][-8:]
        lines.append(f"最近的處理步驟：{('、'.join(kinds)) or '無'}。")
    # 欄位品質摘要（缺失/常數）
    na = view.isna().mean()
    bad_na = [f"{c}({p * 100:.0f}%)" for c, p in na.items() if p > 0.1][:6]
    if bad_na:
        lines.append(f"缺失率超過 10% 的欄位：{'、'.join(bad_na)}。")
    consts = [c for c in num.columns if num[c].nunique(dropna=True) <= 1][:6]
    if consts:
        lines.append(f"幾乎不變的常數欄：{'、'.join(consts)}。")
    # 數值範圍摘要（抽前 8 欄）
    for c in list(num.columns)[:8]:
        s = num[c]
        lines.append(f"欄 {c}: 範圍 {s.min():.4g}~{s.max():.4g}，平均 {s.mean():.4g}，標準差 {s.std():.4g}")
    lines.append("請評估這份資料目前的處理狀態，指出建模前還該做哪些前處理（如異常段排除、缺失處理、欄位取捨），以及適合建什麼任務的模型。")
    return "\n".join(lines)


def _fmt_metrics(m: dict | None) -> str:
    if not m:
        return "無"
    return "、".join(f"{k}={v}" for k, v in m.items() if v is not None)


def _model_context(sid: str, mid: str) -> str:
    rec = _load_model(sid, mid)
    algo = ALGOS.get(rec.get("algo"), {})
    lines = [f"模型「{rec.get('name')}」：任務={rec.get('task') or '迴歸'}，演算法={algo.get('name', rec.get('algo'))}，"
             f"目標={rec.get('target')}，特徵 {len(rec.get('features') or [])} 個，訓練資料 {rec.get('n_rows')} 筆。"]
    lines.append(f"驗證指標（{rec.get('val_desc', '交叉驗證')}）：{_fmt_metrics(rec.get('metrics_cv'))}")
    if rec.get("metrics_train") and rec.get("metrics_train") != rec.get("metrics_cv"):
        lines.append(f"訓練集指標：{_fmt_metrics(rec.get('metrics_train'))}")
    fi = (rec.get("plots") or {}).get("fi")
    if fi:
        top = list(zip(fi["names"], fi["values"]))[:5]
        lines.append("重要變數前五：" + "、".join(f"{n}({v})" for n, v in top))
    if rec.get("evaluation"):
        ev = rec["evaluation"]
        lines.append(f"最近一次現行視圖評估（{ev.get('evaluated_at')}，{ev.get('n_rows')} 筆）：{_fmt_metrics(ev.get('metrics'))}")
    if rec.get("batch"):
        b = rec["batch"]
        lines.append(f"最近一次批次試算（{b.get('filename')}，{b.get('n_pred')} 筆）：{_fmt_metrics(b.get('metrics'))}")
    if rec.get("task") == "anomaly":
        lines.append("注意：這是非監督異常偵測——訓練資料被假設為健康基準，健康分數代表偏離基準的程度。")
        if rec.get("events"):
            e = rec["events"][0]
            lines.append(f"最大故障事件：峰值風險 {e['peak_risk']}、最低健康 {e['min_health']}、主導感測器 {e['top_sensor']}。")
    lines.append("請評估這個模型目前的狀態（好壞、過擬合跡象、可信度），並給下一步建議（調參方向、資料面改善、或該怎麼應用）。")
    return "\n".join(lines)


def _models_context(sid: str) -> str:
    recs = []
    for p in sorted(_mdir(sid).glob("*.json")):
        r = json.loads(p.read_text(encoding="utf-8"))
        if r.get("status") == "done":
            recs.append(r)
    if not recs:
        raise HTTPException(422, "尚無完成的模型可評估")
    lines = [f"目前共有 {len(recs)} 個完成的模型："]
    for r in recs[:20]:
        algo = ALGOS.get(r.get("algo"), {})
        lines.append(f"- {r.get('name')}：任務={r.get('task') or '迴歸'}，演算法={algo.get('name', r.get('algo'))}，"
                     f"目標={r.get('target') or '（無監督）'}，{_fmt_metrics(r.get('metrics_cv'))}")
    lines.append("請比較這些模型的表現，指出哪個最值得採用、誰有過擬合或表現異常的跡象，以及整體建模還缺什麼。")
    return "\n".join(lines)


@router.post("/advise")
def advise(body: dict) -> dict:
    sid = body.get("sid")
    if not sid:
        raise HTTPException(422, "缺 sid")
    scope = body.get("scope", "data")
    if scope == "model":
        ctx = _model_context(sid, body.get("mid"))
    elif scope == "models":
        ctx = _models_context(sid)
    else:
        ctx = _data_context(sid)
    return {"advice": _chat(ctx), "scope": scope}
