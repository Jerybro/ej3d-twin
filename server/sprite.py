# AI 助手 — 孿生檢視 / E3D 工作區的情境對話（本機 LLM）
# 與資料工作台的 aiassist.py 同引擎不同模組（兩線檔案集不重疊，合併零衝突）。
# key：AI_API_KEY env 優先，否則讀 ~/llamacpp/api_key.txt；引擎=llama.cpp Qwen3.6
# （127.0.0.1:8787，本機推論——客戶位號資料不出這台機器）。
# Qwen3 思考模式必須用 chat_template_kwargs.enable_thinking=false 關（/no_think 無效）。
# 兩種模式：/suggest 開場一次性分析目前頁面；/ask 使用者主動追問、維持多輪對話。
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


# 開場「分析目前頁面」用：要求首行總結＋最多 3 點編號建議
SYSTEMS = {
    "twin": (
        "你是全廠 3D 數位孿生平台的駐場製程顧問，看得到目前場景的設備、儀錶偏離與告警摘要。"
        "以繁體中文、務實地給操作建議：第一行一句話總結目前廠況，"
        "接著列最多 3 點具體建議，每點一行、行首「1. 」式編號，"
        "優先講偏離最大的儀錶/告警該查什麼設備、下一步用哪個平台功能"
        "（數據圖層/製程計算/施工模擬/3D 設計工作室）。"
        "不要 markdown 標題與粗體，不要空泛話術；數據不足就明說是推測。"
    ),
    "e3d": (
        "你是 J.S_3D Studio（3D 工廠設計工作室）的駐場設計顧問，"
        "看得到目前場景統計與使用者選取狀態。"
        "以繁體中文給建模建議：第一行一句話總結場景現況，"
        "接著列最多 3 點具體下一步，每點一行、行首「1. 」式編號，"
        "從這些能力挑合適的建議：Spec 驅動配管、管線元件（閥/法蘭/異徑）、"
        "節點編輯、量測、剖切盒/蓋面、Clash 碰撞檢測、對齊、視角書籤、"
        "GA 配置圖、ISO 單管圖、MTO 材料表、結構鋼構、儀電橋架、"
        "設備管嘴、管線支撐自動生成、陣列/鏡射複製、標高基準面、圖層顯示。"
        "不要 markdown 標題與粗體；建議要對得上目前選取與場景狀態。"
    ),
}

# 使用者追問用：直接回答問題，不套「首行＋3 點」格式
CHAT_SYSTEMS = {
    "twin": (
        "你是全廠 3D 數位孿生平台的駐場製程顧問，正在跟現場工程師對話。"
        "你看得到目前場景的設備、儀錶偏離與告警摘要（每則訊息會附上最新情境）。"
        "以繁體中文直接回答對方的問題，務實精簡——一般 3～5 句，需要時才條列。"
        "可援引平台功能（數據圖層/製程計算 What-if/施工模擬/3D 設計工作室）與目前場景數據來回答；"
        "資訊不足就說明並指出該查哪個設備或儀錶，不要編造位號、數值或不存在的功能。"
        "不要 markdown 標題與粗體。"
    ),
    "e3d": (
        "你是 J.S_3D Studio（3D 工廠設計工作室）的駐場設計顧問，正在跟建模人員對話。"
        "你看得到目前場景統計與使用者選取狀態（每則訊息會附上最新情境）。"
        "以繁體中文直接回答對方的問題，務實精簡——一般 3～5 句，需要時才條列。"
        "可援引工作區能力（Spec 驅動配管、管線元件、節點編輯、量測、剖切盒/蓋面、"
        "Clash 碰撞檢測、對齊、視角書籤、GA 配置圖、ISO 單管圖、MTO 材料表、"
        "結構鋼構、儀電橋架、設備管嘴、管線支撐、陣列/鏡射、標高基準面、圖層顯示）回答操作與流程問題；"
        "不確定就說明，不要編造不存在的功能或數字。不要 markdown 標題與粗體。"
    ),
}


class SuggestReq(BaseModel):
    page: str = "twin"          # twin | e3d
    context: dict = {}          # 前端組好的場景摘要


class AskReq(BaseModel):
    page: str = "twin"          # twin | e3d
    context: dict = {}          # 目前頁面情境摘要（每輪即時帶入）
    history: list = []          # [{role: 'user'|'assistant', content: str}, ...]


def _complete(messages: list, max_tokens: int = 460) -> str:
    key = _api_key()
    if not key:
        raise HTTPException(503, "本機 AI 引擎未設定（找不到 API key）")
    body = {
        "model": "qwen3.6", "max_tokens": max_tokens, "temperature": 0.4,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": messages,
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"本機 AI 引擎無回應（{type(e).__name__}）——請確認引擎已啟動") from None
    return (out["choices"][0]["message"].get("content") or "").strip()


def _ctx_str(context: dict) -> str:
    ctx = json.dumps(context, ensure_ascii=False)
    if len(ctx) > 4000:
        ctx = ctx[:4000] + "…（截斷）"
    return ctx


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
    user = f"目前情境摘要（JSON）：\n{_ctx_str(req.context)}\n\n請依此給建議。"
    text = _complete([{"role": "system", "content": system},
                      {"role": "user", "content": user}], max_tokens=420)
    return {"text": text}


@router.post("/ask")
def ask(req: AskReq) -> dict:
    # 單一 system 訊息：本機 Qwen3.6 的 chat template 不接受多個 system 訊息（會 HTTP 400），
    # 故把顧問人設＋即時場景 context 併進同一則。history 開頭是 assistant（開場建議）template 可接受。
    system = (CHAT_SYSTEMS.get(req.page, CHAT_SYSTEMS["twin"])
              + "\n\n目前頁面情境摘要（JSON，供你參考，不必逐條複述）：\n"
              + _ctx_str(req.context))
    msgs = [{"role": "system", "content": system}]
    for m in (req.history or [])[-12:]:      # 只帶最近 12 則，控 token
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content[:2000]})
    if len(msgs) < 2 or msgs[-1]["role"] != "user":
        raise HTTPException(400, "history 最後一則需為使用者提問")
    return {"text": _complete(msgs, max_tokens=600)}
