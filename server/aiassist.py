"""生成式 AI 助教 — 本機 LLM（OpenAI 相容端點）實時評估建模狀況、給資料處理建議。

金鑰與端點不進版控：AI_API_KEY / AI_BASE_URL 環境變數優先，
否則讀 ~/llamacpp/api_key.txt；端點預設本機 llama.cpp（127.0.0.1:8787）。
Qwen3 思考模式用 chat_template_kwargs.enable_thinking=false 關閉（延遲 2-3s）。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
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


# ------------------------------------------------------ 供應商層（嚮導問答用）
# 架構：介面固定、腦可換——四層擇優：
#   anthropic（API 金鑰）＞ claude_cli（本機 Claude Code 訂閱登入，免金鑰）
#   ＞ local（地端 OpenAI 相容端點）＞ none（規則 FAQ 兜底）。
# 走同一個 ask 契約；預設用「快、便宜」的小模型秒回，深度分析才升級大模型。
# 金鑰不進版控：ANTHROPIC_API_KEY 放 repo 根 .env（auth._load_dotenv 已會載入）。

_ANTHROPIC_FAST = "claude-haiku-4-5-20251001"   # 快答（嚮導預設）
_ANTHROPIC_DEEP = "claude-sonnet-5"             # 深度資料分析才用


def _anthropic_key() -> str | None:
    return os.environ.get("ANTHROPIC_API_KEY") or None


def _chat_anthropic(system: str, user_msg: str, *, deep: bool = False,
                    max_tokens: int = 700) -> str:
    body = {
        "model": _ANTHROPIC_DEEP if deep else _ANTHROPIC_FAST,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user_msg}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(), method="POST",
        headers={"x-api-key": _anthropic_key(), "anthropic-version": "2023-06-01",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Claude 無回應（{type(e).__name__}）") from None
    return "".join(b.get("text", "") for b in out.get("content", [])).strip()


# 本機 Claude Code CLI：使用者這台機器已登入的 claude 指令（訂閱額度、免 API 金鑰），
# 以無頭模式（-p）回答。找不到執行檔或 CLAUDE_CLI=0 → 不啟用；登入過期 → ask 端優雅降級。
_CLI_UNRESOLVED = ("unresolved",)
_cli_cmd: tuple[str, ...] | None = _CLI_UNRESOLVED


def _claude_cli() -> list[str] | None:
    global _cli_cmd
    if os.environ.get("CLAUDE_CLI", "").strip() == "0":
        return None
    if _cli_cmd is not _CLI_UNRESOLVED:
        return list(_cli_cmd) if _cli_cmd else None
    cand: list[str] | None = None
    w = shutil.which("claude")
    if w and not w.lower().endswith((".cmd", ".bat", ".ps1")):
        cand = [w]                                   # 原生執行檔，直接叫
    else:
        # npm 殼層（.cmd/.ps1）不適合 subprocess——改叫殼層背後的真執行檔
        base = Path(w).parent if w else Path(os.environ.get("APPDATA", "")) / "npm"
        exe = base / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
        if exe.exists():
            cand = [str(exe)]
        elif w:
            cand = ["cmd", "/c", w]
    _cli_cmd = tuple(cand) if cand else None
    return cand


def _chat_claude_cli(system: str, user_msg: str, *, deep: bool = False,
                     timeout: int = 120) -> str:
    cmd = _claude_cli()
    if not cmd:
        raise HTTPException(503, "本機 Claude CLI 不可用")
    prompt = f"{system}\n\n請直接回答，不要使用任何工具、不要讀寫任何檔案。\n\n{user_msg}"
    env = {**os.environ}
    env.pop("ANTHROPIC_API_KEY", None)               # 一律走 CLI 自己的訂閱登入
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    try:
        r = subprocess.run(
            cmd + ["-p", prompt, "--output-format", "text",
                   "--model", "sonnet" if deep else "haiku"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL, timeout=timeout, env=env,
            cwd=tempfile.gettempdir())
    except subprocess.TimeoutExpired:
        raise HTTPException(503, "Claude（本機）回答逾時") from None
    out = (r.stdout or "").strip()
    if r.returncode != 0 or not out:
        err = (r.stderr or r.stdout or "").strip()
        if "authenticate" in err.lower() or "oauth" in err.lower():
            raise HTTPException(503, "本機 Claude 登入已過期——在終端機執行 claude、輸入 /login 重新登入即可恢復")
        raise HTTPException(503, f"Claude（本機）呼叫失敗：{err[-200:] or '無輸出'}")
    return out


def ai_provider() -> str:
    """目前可用的問答供應商：anthropic ＞ claude_cli ＞ local ＞ none（規則 FAQ 兜底）。"""
    if _anthropic_key():
        return "anthropic"
    if _claude_cli():
        return "claude_cli"
    if _api_key():
        return "local"
    return "none"


# 規則 FAQ 兜底：沒有任何 AI 金鑰時，常見術語仍給得出白話答案（與 term.js 字典同源語意）
_FAQ = {
    "r2": "R²（判定係數）：模型解釋目標變異的比例，1 為完美、0 為毫無解釋力。0.95 以上極佳、0.85 以上良好、0.7 以下建議換演算法或補資料。",
    "rmse": "RMSE（均方根誤差）：預測值與實際值的平均誤差量，單位與目標欄相同——越小越好，直接跟目標的正常波動幅度比。",
    "mae": "MAE（平均絕對誤差）：預測平均差多少，單位與目標欄相同，比 RMSE 不易被離群值放大。",
    "相關": "相關強度 |r|：兩欄一起變動的程度，0＝無關、1＝完全同步。目標欄被其他欄解釋得越多，通常越好預測。",
    "model_key": "模型金鑰：模型發布後取得的固定識別碼，孿生區塊與 API 呼叫都以它指名模型，原始資料刪除也不影響推論。",
    "守門員": "守門員：檢查每個輸入是否落在模型的訓練域（P1~P99）內；超出即為外插、預測不可信，會以橘／紅警示。",
    "異常": "異常偵測（健康監測）：以健康運轉資料為基準，計算目前運轉點的偏離程度（風險值）與健康分數，不需要目標欄。",
    "什麼是目標": "目標欄＝你要模型預測的那一欄（例：產量、品質、排放）。其餘數值欄會當成解釋它的輸入特徵。",
}


def _faq_answer(q: str) -> str | None:
    ql = q.lower().replace("²", "2")   # 「R²」上標打法也要命中 r2
    for k, v in _FAQ.items():
        if k in ql:
            return v
    return None


_ASK_SYSTEM = (
    "你是 Process Intelligence（製程數據孿生平台）的建模嚮導助教。"
    "使用者是製程工程師，可能不懂統計與機器學習。規則："
    "1) 繁體中文、白話，最多 6 行；2) 先直接回答，再給一個下一步建議；"
    "3) 只依提供的 context 陳述事實，不編造欄位或數字；不確定就說不確定並指路"
    "（資料工作台看分布、模型工作區看指標）；4) 不用 markdown 標題與粗體。"
)


@router.post("/ask")
def ask(body: dict) -> dict:
    """嚮導問答：body={question, context?, depth?}。
    context 由前端組（step/檔名/欄位/指標/最近錯誤——結構化餵給模型，這是之後
    擴充成 MCP 工具層的同一份契約）。depth='deep' 才用大模型。
    無任何金鑰 → 規則 FAQ 兜底（誠實標示 provider='none'）。"""
    q = str(body.get("question") or "").strip()
    if not q:
        raise HTTPException(422, "需要 question")
    ctx = body.get("context") or {}
    provider = ai_provider()
    if provider == "none":
        ans = _faq_answer(q)
        return {"provider": "none",
                "answer": ans or "這題我需要 AI 引擎才能回答。三種開法：伺服器 .env 加 ANTHROPIC_API_KEY（雲端）；或在這台機器登入 Claude Code（終端機跑 claude → /login）；或啟動地端引擎（AI_API_KEY）。常見術語可以直接問：R²、RMSE、相關、守門員、model_key。"}
    ctx_lines = [f"{k}: {json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v}"
                 for k, v in ctx.items() if v not in (None, "", [])]
    user = ("目前情境：\n" + "\n".join(ctx_lines[:14]) + "\n\n使用者問題：" + q) if ctx_lines else q
    deep = body.get("depth") == "deep"
    if provider == "anthropic":
        return {"provider": "anthropic", "model": _ANTHROPIC_DEEP if deep else _ANTHROPIC_FAST,
                "answer": _chat_anthropic(_ASK_SYSTEM, user, deep=deep)}
    if provider == "claude_cli":
        try:
            return {"provider": "claude_cli", "model": "sonnet" if deep else "haiku",
                    "answer": _chat_claude_cli(_ASK_SYSTEM, user, deep=deep)}
        except HTTPException as e:
            # 登入過期等狀況 → 不擋使用者：FAQ 兜底並誠實附上修復方法
            ans = _faq_answer(q)
            base = ans or "這題需要 AI 引擎才能完整回答。常見術語可以直接問：R²、RMSE、相關、守門員、model_key。"
            return {"provider": "none", "answer": f"{base}\n（{e.detail}）"}
    # 地端（OpenAI 相容）：沿用既有 _chat（qwen 白話助教 SYSTEM 由 _ASK_SYSTEM 取代語境）
    return {"provider": "local", "answer": _chat(user, max_tokens=500)}


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
    if rec.get("task") == "hybrid" and rec.get("compare"):
        c = rec["compare"]
        lines.append(f"這是混合模型（物理模擬基準欄 {rec.get('sim_col')}＋AI 殘差修正），同折三方對比："
                     f"純物理模擬 {_fmt_metrics(c.get('sim'))}；純 AI {_fmt_metrics(c.get('ai'))}；"
                     f"混合 {_fmt_metrics(c.get('hybrid'))}。"
                     "評估重點：混合是否同時勝過純模擬與純 AI（互補成功才值得採用）；"
                     "殘差重要變數排前面的，代表模擬在該條件下與現場落差最大。")
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
