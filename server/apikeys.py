"""API 金鑰（服務帳號）——讓程式與 AI 代理接得上平台。

為什麼要這支：平台原本只有 Google 登入與本機帳號，所有 API 都靠 session cookie。
於是「外部模型用同一支 API 把結果送進來」「客戶的程式來拿資料」這兩句話
在技術上都做不到——外部服務沒有瀏覽器，登不進來。

設計三條原則：

1. **金鑰是身分，不是後門**：一把 key 綁一個使用者帳號，直接繼承他的網域分租與
   圖面白名單。test123 發的 key 一樣只看得到 M0200。
2. **只存雜湊**：明碼只在產生當下顯示一次；之後連管理員都看不到。
3. **權限只有兩級**：`read`（讀）與 `write:result`（讀＋承接模型結果）。
   改點位綁定、改資產模型這類**人工簽名過**的資料不開放程式覆寫——
   那些東西的價值就在「有人簽過名」。
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
KEYS_PATH = BASE_DIR / "uploads" / "data" / "apikeys.json"

router = APIRouter(prefix="/api/keys", tags=["apikeys"])
_LOCK = threading.Lock()

SCOPES = {
    "read": "唯讀：資產模型、點位語意、統計、時序、製程說明、既有建議",
    "write:result": "唯讀 ＋ 承接模型結果（POST /api/twin/result）",
}
PREFIX = "ejt_"          # ej3d-twin key，方便在 log 與外洩掃描器裡認出來


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _load() -> dict:
    if not KEYS_PATH.exists():
        return {}
    try:
        d = json.loads(KEYS_PATH.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save(d: dict) -> None:
    KEYS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = KEYS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(KEYS_PATH)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def verify(token: str) -> dict | None:
    """驗證金鑰 → 回這把 key 的紀錄（含 owner email 與 scope）；無效回 None。

    順便記最後使用時間與呼叫次數——客戶問「這把還有人在用嗎」要答得出來。
    """
    if not token or not token.startswith(PREFIX):
        return None
    h = _hash(token)
    with _LOCK:
        d = _load()
        for kid, rec in d.items():
            if rec.get("hash") == h and not rec.get("revoked"):
                rec["last_used"] = _now()
                rec["calls"] = int(rec.get("calls", 0)) + 1
                d[kid] = rec
                _save(d)
                return {"id": kid, **rec}
    return None


# ------------------------------------------------------------------ 管理端點
class KeyReq(BaseModel):
    name: str = ""
    scope: str = "read"


@router.get("")
def list_keys(request: Request) -> dict:
    """自己的金鑰；管理員看得到全部（永遠只回前綴，不回明碼）。"""
    from .auth import current_user

    u = current_user(request)
    if not u:
        raise HTTPException(401, "未登入")
    me, is_admin = u.get("email"), u.get("role") == "admin"
    out = []
    for kid, rec in sorted(_load().items(), key=lambda kv: kv[1].get("created", "")):
        if not is_admin and rec.get("owner") != me:
            continue
        out.append({"id": kid, "name": rec.get("name", ""), "owner": rec.get("owner"),
                    "scope": rec.get("scope", "read"), "prefix": rec.get("prefix", ""),
                    "created": rec.get("created"), "last_used": rec.get("last_used"),
                    "calls": rec.get("calls", 0), "revoked": bool(rec.get("revoked"))})
    return {"scopes": SCOPES, "keys": out, "is_admin": is_admin}


@router.post("")
def create_key(req: KeyReq, request: Request) -> dict:
    """產生一把新金鑰。**明碼只在這一次回傳**，之後拿不回來。"""
    from .auth import AUTH_DISABLED, current_user

    if AUTH_DISABLED:
        raise HTTPException(403, "免登入模式下不發金鑰——請先啟用登入")
    u = current_user(request)
    if not u or not u.get("email"):
        raise HTTPException(401, "未登入")
    if req.scope not in SCOPES:
        raise HTTPException(422, f"scope 只能是 {' / '.join(SCOPES)}")
    token = PREFIX + secrets.token_hex(24)
    kid = secrets.token_hex(6)
    rec = {"hash": _hash(token), "prefix": token[:len(PREFIX) + 6],
           "name": (req.name or "未命名").strip()[:40], "owner": u["email"],
           "scope": req.scope, "created": _now(), "last_used": "", "calls": 0,
           "revoked": False}
    with _LOCK:
        d = _load()
        d[kid] = rec
        _save(d)
    return {"id": kid, "token": token, "warn": "這把金鑰只會顯示這一次，請立刻複製保存",
            **{k: v for k, v in rec.items() if k != "hash"}}


@router.delete("/{kid}")
def revoke_key(kid: str, request: Request) -> dict:
    from .auth import current_user

    u = current_user(request)
    if not u:
        raise HTTPException(401, "未登入")
    with _LOCK:
        d = _load()
        rec = d.get(kid)
        if not rec:
            raise HTTPException(404, "金鑰不存在")
        if rec.get("owner") != u.get("email") and u.get("role") != "admin":
            raise HTTPException(403, "只能撤銷自己的金鑰")
        rec["revoked"] = True
        rec["revoked_at"] = _now()
        d[kid] = rec
        _save(d)
    return {"ok": True}


def key_from_header(request: Request) -> str:
    """從 Authorization: Bearer 或 X-API-Key 取金鑰。"""
    auth = request.headers.get("authorization") or ""
    m = re.match(r"^\s*Bearer\s+(\S+)\s*$", auth, re.I)
    if m:
        return m.group(1)
    return request.headers.get("x-api-key") or ""
