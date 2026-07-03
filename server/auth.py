"""Google 登入與權限控管 — 參照 CRM 線（engjay-crm/auth.py）的機制移植 FastAPI。

- 憑證：repo 根 .env（gitignore）讀 GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI
- session：starlette SessionMiddleware（簽名 cookie），secret 存 data/.secret_key（gitignore）
- 使用者表：uploads/data/users.json（隨 uploads/ gitignore）——第一個登入者自動成為 admin
- 守衛：未登入頁面 302 /login、API 401；AUTH_DISABLED=1 可整站關閉（demo 免登入模式）
"""
from __future__ import annotations

import json
import os
import secrets
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

BASE_DIR = Path(__file__).resolve().parent.parent
USERS_PATH = BASE_DIR / "uploads" / "data" / "users.json"


def _load_dotenv():
    p = BASE_DIR / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "http://localhost:8600/login/google/callback")
AUTH_DISABLED = os.environ.get("AUTH_DISABLED", "") in ("1", "true", "yes")

router = APIRouter(tags=["auth"])


def secret_key() -> str:
    p = BASE_DIR / "data" / ".secret_key"
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_text(secrets.token_hex(32), encoding="utf-8")
    return p.read_text(encoding="utf-8").strip()


# ------------------------------------------------------ 使用者表
def _load_users() -> dict:
    if USERS_PATH.exists():
        return json.loads(USERS_PATH.read_text(encoding="utf-8"))
    return {}


def _save_users(users: dict):
    USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    USERS_PATH.write_text(json.dumps(users, ensure_ascii=False, indent=1), encoding="utf-8")


def current_user(request: Request) -> dict | None:
    """目前登入者（auth 關閉時回匿名 admin，功能全開）。"""
    if AUTH_DISABLED:
        return {"email": None, "name": "（未啟用登入）", "role": "admin"}
    email = request.session.get("email")
    if not email:
        return None
    u = _load_users().get(email)
    if not u or not u.get("is_active", True):
        return None
    return {"email": email, **u}


# ------------------------------------------------------ 守衛 middleware
# 未登入可及的路徑前綴（登入流程本身＋靜態資源）
PUBLIC_PREFIXES = ("/login", "/logout", "/static/", "/favicon", "/api/me")


async def auth_guard(request: Request, call_next):
    if AUTH_DISABLED or request.url.path in ("/",) or any(
            request.url.path.startswith(p) for p in PUBLIC_PREFIXES):
        return await call_next(request)
    if not current_user(request):
        if request.url.path.startswith("/api/") or request.url.path.startswith("/ws"):
            return JSONResponse({"detail": "未登入"}, status_code=401)
        return RedirectResponse(f"/login?next={urllib.parse.quote(str(request.url.path))}", 302)
    return await call_next(request)


# ------------------------------------------------------ 登入流程
@router.get("/login")
def login_page():
    return FileResponse(BASE_DIR / "static" / "login.html")


@router.get("/login/google")
def google_login(request: Request):
    if not CLIENT_ID or not CLIENT_SECRET:
        return JSONResponse({"detail": "Google OAuth 未設定（缺 .env 憑證）"}, status_code=503)
    state = secrets.token_urlsafe(16)
    request.session["g_state"] = state
    request.session["g_next"] = request.query_params.get("next") or "/"
    q = urllib.parse.urlencode({
        "client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI,
        "response_type": "code", "scope": "openid email profile",
        "state": state, "prompt": "select_account",
    })
    return RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{q}", 302)


@router.get("/login/google/callback")
def google_callback(request: Request):
    if request.query_params.get("state") != request.session.get("g_state"):
        return JSONResponse({"detail": "state 驗證失敗，請重新登入"}, status_code=400)
    code = request.query_params.get("code")
    if not code:
        return JSONResponse({"detail": f"Google 回傳錯誤：{request.query_params.get('error', '無授權碼')}"}, status_code=400)
    body = urllib.parse.urlencode({
        "code": code, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI, "grant_type": "authorization_code",
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(
                "https://oauth2.googleapis.com/token", data=body, method="POST"), timeout=15) as r:
            tok = json.loads(r.read())
        req = urllib.request.Request("https://openidconnect.googleapis.com/v1/userinfo",
                                     headers={"Authorization": f"Bearer {tok['access_token']}"})
        with urllib.request.urlopen(req, timeout=15) as r:
            info = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"detail": f"Google 驗證失敗（{type(e).__name__}）"}, status_code=502)
    email = (info.get("email") or "").lower()
    if not email or not info.get("email_verified", True):
        return JSONResponse({"detail": "Google 帳號未通過 email 驗證"}, status_code=403)
    users = _load_users()
    if email not in users:
        # 第一個登入者＝admin，其餘 user（admin 之後可在 users.json 調角色）
        users[email] = {"name": info.get("name") or email, "role": "admin" if not users else "user",
                        "is_active": True, "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        _save_users(users)
    if not users[email].get("is_active", True):
        return JSONResponse({"detail": "此帳號已被停用"}, status_code=403)
    nxt = request.session.get("g_next") or "/"
    request.session.clear()
    request.session["email"] = email
    return RedirectResponse(nxt, 302)


@router.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", 302)


@router.get("/api/me")
def me(request: Request):
    u = current_user(request)
    if not u:
        return JSONResponse({"detail": "未登入"}, status_code=401)
    return {"email": u["email"], "name": u.get("name"), "role": u.get("role", "user"),
            "auth_disabled": AUTH_DISABLED}
