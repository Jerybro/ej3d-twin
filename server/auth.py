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

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

BASE_DIR = Path(__file__).resolve().parent.parent
USERS_PATH = BASE_DIR / "uploads" / "data" / "users.json"


def _load_dotenv():
    # .env 為本機部署的權威設定：覆寫既有環境變數（避免其他專案殘留的
    # GOOGLE_REDIRECT_URI 等變數蓋掉本專案值——實測 CRM PoC 會洩漏 5055 callback）。
    # 例外：AUTH_DISABLED 是執行期開關，啟動時給的環境變數優先（驗證/demo 用）。
    keep = {k: os.environ[k] for k in ("AUTH_DISABLED",) if k in os.environ}
    p = BASE_DIR / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ[k.strip()] = v.strip()
    os.environ.update(keep)


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


# 分租單位＝email 網域。同公司的人共用同一份圖組與台帳（一個人建的檔
# 同事接得下去、也改得動），不同公司之間互不可見——平台上同時放著
# 台化、中油、潤泰的圖，這條界線是必要的。
def current_domain(request: Request) -> str:
    u = current_user(request)
    email = (u or {}).get("email") or ""
    if "@" in email:
        return email.split("@", 1)[1].lower()
    return os.environ.get("PID_DEV_DOMAIN", "dev.local")


def current_actor(request: Request) -> str:
    """稽核用的操作者識別（免登入模式回空字串）。"""
    return ((current_user(request) or {}).get("email") or "")


# ------------------------------------------------------ 守衛 middleware
# 未登入可及的路徑前綴——只留登入流程本身與靜態資源。
#
# 平台上已存放客戶 P&ID（台化、中油大林），首頁會列出圖面清單與專案資訊，
# 說明書也含平台能力細節，兩者都不該對未登入者開放。
# 原本 `/` 與 `/docs` 是公開的，此處一併收回。
# /healthz 開放：部署健檢（deploy/auto-pull.ps1）與監控要能不帶 session 打，
# 它只回 "ok" 純文字，無資訊洩漏疑慮。
PUBLIC_PREFIXES = ("/login", "/logout", "/static/", "/favicon", "/api/me", "/healthz",
                   "/api/version")   # 版號不是機密，登入頁也要顯示得出來


async def auth_guard(request: Request, call_next):
    if AUTH_DISABLED or any(
            request.url.path.startswith(p) for p in PUBLIC_PREFIXES):
        return await call_next(request)
    if not current_user(request):
        if (request.url.path.startswith("/api/") or request.url.path.startswith("/ws")
                or request.url.path.startswith("/agatha")):
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
        # 白名單制：只有事先登錄的帳號能進。
        # 站台掛在 Tailscale Funnel（公網可達）且存放客戶 P&ID（台化、中油），
        # 原本「登入即自動建帳號」等於對全網任何 Google 帳號開放——那不是白名單。
        # 例外：使用者表為空時，第一個登入者成為 admin（初始化用）。
        if users:
            return JSONResponse(
                {"detail": f"{email} 不在授權名單中。請聯絡管理員開通後再登入。"},
                status_code=403)
        users[email] = {"name": info.get("name") or email, "role": "admin",
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


# ------------------------------------------------------ 權限管理（admin only）
def _require_admin(request: Request) -> dict:
    u = current_user(request)
    if not u or u.get("role") != "admin":
        raise HTTPException(403, "需要管理員權限")
    return u


@router.get("/api/admin/users")
def admin_list_users(request: Request):
    _require_admin(request)
    # 免登入（demo）模式沒有真正的驗證身分：不對匿名訪客洩漏真實帳號清單
    if AUTH_DISABLED:
        return {"auth_disabled": True, "users": []}
    users = _load_users()
    return {"auth_disabled": False,
            "users": [{"email": e, "name": v.get("name"), "role": v.get("role", "user"),
                       "is_active": v.get("is_active", True), "created": v.get("created")}
                      for e, v in sorted(users.items(), key=lambda kv: kv[1].get("created") or "")]}


@router.post("/api/admin/invite")
def admin_invite_user(request: Request, body: dict):
    """預先登錄一個帳號（白名單制下，沒登錄過的人登入會被擋）。

    改成白名單後就需要這支：管理員先把 email 加進來，對方才登得進去。
    協作者（例如外部工程師）一律給 user 角色。
    """
    _require_admin(request)
    if AUTH_DISABLED:
        raise HTTPException(403, "免登入模式下無法新增帳號——請先啟用登入")
    email = (body.get("email") or "").strip().lower()
    if "@" not in email or " " in email:
        raise HTTPException(422, "請填寫有效的 Google 帳號 email")
    role = body.get("role") or "user"
    if role not in ("admin", "user"):
        raise HTTPException(422, "角色只能是 admin 或 user")
    users = _load_users()
    if email in users:
        raise HTTPException(409, "此帳號已在名單中")
    users[email] = {"name": body.get("name") or email, "role": role,
                    "is_active": True,
                    "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "invited_by": request.session.get("email", "")}
    _save_users(users)
    return {"ok": True, "email": email, **users[email]}


@router.post("/api/admin/users/{email}")
def admin_update_user(email: str, request: Request, body: dict):
    me_u = _require_admin(request)
    if AUTH_DISABLED:
        raise HTTPException(403, "免登入模式下無法變更帳號——請先啟用登入")
    users = _load_users()
    if email not in users:
        raise HTTPException(404, "使用者不存在")
    # 防呆：不能把自己降權或停用（避免鎖死唯一管理員）
    if email == me_u.get("email"):
        if body.get("role") and body["role"] != "admin":
            raise HTTPException(422, "不能移除自己的管理員權限")
        if body.get("is_active") is False:
            raise HTTPException(422, "不能停用自己的帳號")
    if "role" in body:
        if body["role"] not in ("admin", "user"):
            raise HTTPException(422, "角色只能是 admin 或 user")
        users[email]["role"] = body["role"]
    if "is_active" in body:
        users[email]["is_active"] = bool(body["is_active"])
    _save_users(users)
    return {"ok": True, "email": email, **users[email]}


@router.delete("/api/admin/users/{email}")
def admin_delete_user(email: str, request: Request):
    me_u = _require_admin(request)
    if AUTH_DISABLED:
        raise HTTPException(403, "免登入模式下無法刪除帳號——請先啟用登入")
    if email == me_u.get("email"):
        raise HTTPException(422, "不能刪除自己的帳號")
    users = _load_users()
    if email not in users:
        raise HTTPException(404, "使用者不存在")
    del users[email]
    _save_users(users)
    return {"ok": True}
