# AI 小精靈 — 孿生檢視 / E3D 工作區的情境建議（本機 LLM）
# 與資料工作台的 aiassist.py 同引擎不同模組（兩線檔案集不重疊，合併零衝突）。
# key：AI_API_KEY env 優先，否則讀 ~/llamacpp/api_key.txt；引擎=llama.cpp Qwen3.6
# （127.0.0.1:8787，本機推論——客戶位號資料不出這台機器）。
# Qwen3 思考模式必須用 chat_template_kwargs.enable_thinking=false 關（/no_think 無效）。
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/sprite", tags=["sprite"])

BASE_URL = os.environ.get("AI_BASE_URL", "http://127.0.0.1:8787/v1")


def _api_key() -> str | None:
    k = os.environ.get("AI_API_KEY")
    if k:
        return k
    p = Path.home() / "llamacpp" / "api_key.txt"
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    return None


SYSTEMS = {
    "twin": (
        "你是全廠 3D 數位孿生平台的駐場製程顧問，看得到目前場景的設備、儀錶偏離與告警摘要。"
        "以繁體中文、務實地給操作建議：第一行一句話總結目前廠況，"
        "接著列最多 3 點具體建議，每點一行、行首「1. 」式編號，"
        "優先講偏離最大的儀錶/告警該查什麼設備、下一步用哪個平台功能"
        "（數據圖層/製程計算/施工模擬/E3D 編輯）。"
        "不要 markdown 標題與粗體，不要空泛話術；數據不足就明說是推測。"
    ),
    "e3d": (
        "你是 3D 工廠設計工作區（對標 AVEVA E3D）的駐場設計顧問，"
        "看得到目前場景統計與使用者選取狀態。"
        "以繁體中文給建模建議：第一行一句話總結場景現況，"
        "接著列最多 3 點具體下一步，每點一行、行首「1. 」式編號，"
        "從這些能力挑合適的建議：Spec 驅動配管、管線元件（閥/法蘭/異徑）、"
        "節點編輯、量測、剖切盒/蓋面、Clash 碰撞檢測、對齊、視角書籤、"
        "GA 配置圖、ISO 單管圖、結構鋼構。"
        "不要 markdown 標題與粗體；建議要對得上目前選取與場景狀態。"
    ),
    "data": (
        "你是製程資料智能平台（資料前處理＋AutoML 建模）的駐場資料科學顧問，"
        "使用者可能不懂統計與機器學習，看得到目前資料視圖與模型狀態摘要。"
        "以繁體中文、白話地給下一步建議：第一行一句話總結目前進度，"
        "接著列最多 3 點具體下一步，每點一行、行首「1. 」式編號，"
        "從這些平台能力挑合適的建議：探索分析框選排除異常段、資料健檢、"
        "全自動/手動建模（迴歸/分類/時序/設備異常偵測）、模型評估、"
        "操作差異試算、批次試算、配方優化、風險值門檻試算、AI 助教。"
        "不要 markdown 標題與粗體，不要空泛話術；資訊不足就明說。"
    ),
}


class SuggestReq(BaseModel):
    page: str = "twin"          # twin | e3d
    context: dict = {}          # 前端組好的場景摘要


def _chat(system: str, user_msg: str, max_tokens: int = 420) -> str:
    key = _api_key()
    if not key:
        raise HTTPException(503, "本機 AI 引擎未設定（找不到 API key）")
    body = {
        "model": "qwen3.6", "max_tokens": max_tokens, "temperature": 0.4,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user_msg}],
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            out = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"本機 AI 引擎無回應（{type(e).__name__}）——請確認引擎已啟動") from None
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


@router.post("/suggest")
def suggest(req: SuggestReq) -> dict:
    system = SYSTEMS.get(req.page, SYSTEMS["twin"])
    ctx = json.dumps(req.context, ensure_ascii=False)
    if len(ctx) > 4000:
        ctx = ctx[:4000] + "…（截斷）"
    user = f"目前情境摘要（JSON）：\n{ctx}\n\n請依此給建議。"
    return {"text": _chat(system, user)}
