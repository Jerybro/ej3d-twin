"""EJ_3D 數位孿生平台 MVP — FastAPI 後端。

- 提供前端靜態頁面（Three.js 3D 視圖器）
- /api/plant       廠區階層 + 設備 + 儀錶 + 情境定義（來自 data/plant.json）
- /api/scenario/*  切換工安情境（正常 / 洩漏 / 起火）
- /ws              WebSocket 每秒推播模擬製程數據（之後換成 OPC UA / PI 來源）
- /api/export/usd  匯出 OpenUSD（Omniverse 相容）
"""

from __future__ import annotations

import asyncio
import json
import re
import random
import time
from contextlib import asynccontextmanager
from pathlib import Path

# 必須最先 import：缺件時給人話（缺什麼、會壞什麼、怎麼修），
# 而不是深層 traceback 或更糟的「啟動正常、點下去才壞」。
from . import depcheck  # noqa: F401

from fastapi import FastAPI, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi import File as FastAPIFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .dataprep import router as dataprep_router
from .scenes import load_scene
from .scenes import router as scenes_router
from .sources import History, SimSource, load_source

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = BASE_DIR / "data" / "plant.json"
STATIC_DIR = BASE_DIR / "static"
SCANS_DIR = BASE_DIR / "scans"
EXPORTS_DIR = BASE_DIR / "exports"

PLANT = json.loads(DATA_FILE.read_text(encoding="utf-8"))
INSTRUMENTS: dict = PLANT["instruments"]
SCENARIOS: dict = {s["id"]: s for s in PLANT["scenarios"]}

# ------------------------------------------------------------ 數據層
# 即時值一律來自 DataSource（sim / opcua / modbus，見 data/datasource.json）；
# SimSource 同時兼任情境注入引擎（只在主來源=sim 時可用）
SOURCE, SIM_ENGINE = load_source(INSTRUMENTS, SCENARIOS)
HISTORY = History(maxlen=900)  # 15 分鐘 @1s；正式部署換 InfluxDB/PI 只動 History

SIM = {
    "scenario": "normal",
    "values": {tag: inst["base"] for tag, inst in INSTRUMENTS.items()},
    # 異常注入（盲測）：感測值照 inject 情境漂移，但 3D 情境維持 normal，
    # 交給比對引擎從 DCS 特徵自動找出最接近的預載情境（簡報「預設情境比對法」）
    "inject": None,
    "confirmed": False,
    "streak": {"sid": None, "n": 0},
}

CONFIRM_THRESHOLD = 0.80
# 特徵重疊的情境（如 R-101 超壓氣爆 vs 攪拌失效，早期都是 TI/PI 同升）
# 要求領先幅度 + 連續穩定，避免慢速訊號還沒發展就搶先誤判
CONFIRM_MARGIN = 0.10
CONFIRM_STREAK = 3


async def _tick() -> None:
    """每秒一拍：從數據源讀值 → 更新即時狀態 → 寫入時序歷史。"""
    SIM_ENGINE.driver = SIM["inject"] if SIM["inject"] else SIM["scenario"]
    values = await SOURCE.read()
    if values:  # 廠端來源斷線時 read() 回空 dict → 保持前值，UI 顯示斷線
        SIM["values"].update(values)
        HISTORY.append(values)


def _match_scenarios() -> list[dict]:
    """預設情境比對法：把目前 DCS 偏移量 vs 各預載情境的特徵向量做餘弦相似度，
    再乘上偏移幅度（避免剛注入、訊號還沒起來就誤判滿分）。"""
    dev = {t: SIM["values"][t] - INSTRUMENTS[t]["base"] for t in INSTRUMENTS}
    ranked = []
    for sid, sc in SCENARIOS.items():
        effects = sc.get("effects")
        if not effects:
            continue
        sig = {t: e["target"] - INSTRUMENTS[t]["base"] for t, e in effects.items()}
        # 正規化尺度：每個 tag 用該情境目標偏移量當量尺
        num = mag_d = mag_s = 0.0
        for t in INSTRUMENTS:
            s = sig.get(t, 0.0)
            scale = max(abs(s), abs(INSTRUMENTS[t]["base"]) * 0.25, 1.0)
            d = dev[t] / scale
            s_n = s / scale
            num += d * s_n
            mag_d += d * d
            mag_s += s_n * s_n
        if mag_d < 1e-9 or mag_s < 1e-9:
            conf = 0.0
        else:
            cos = num / (mag_d**0.5 * mag_s**0.5)
            # 訊號發展度：偏移到目標值 50% 即視為特徵成形（一階趨近後段很慢，
            # 等 100% 會讓慢速情境拖過一分鐘，簡報現場等不了）
            progress = min(1.0, (mag_d / mag_s) ** 0.5 / 0.5)
            conf = max(0.0, cos) * progress
        ranked.append({"id": sid, "name": sc["name"], "conf": round(conf, 3)})
    ranked.sort(key=lambda r: -r["conf"])
    return ranked


def _snapshot() -> dict:
    scenario = SCENARIOS[SIM["scenario"]]
    tags, alarms, alarm_eq = {}, [], set(scenario.get("alarm_equipment", []))
    for tag, inst in INSTRUMENTS.items():
        v = SIM["values"][tag]
        hi, lo = inst.get("alarm_hi"), inst.get("alarm_lo")
        in_alarm = (hi is not None and v > hi) or (lo is not None and v < lo)
        tags[tag] = {
            "v": round(v, 1),
            "unit": inst["unit"],
            "name": inst["name"],
            "alarm": in_alarm,
        }
        if in_alarm:
            alarms.append(
                {
                    "tag": tag,
                    "text": f"{tag} {inst['name']} {v:.1f} {inst['unit']}"
                    + (f"（HI {hi}）" if hi is not None and v > hi else f"（LO {lo}）"),
                }
            )
            alarm_eq.add(inst["equipment"])
    # 異常注入時跑比對引擎；信心值過門檻 → 自動確認情境（3D 特效隨之切換）
    match = None
    if SIM["inject"]:
        ranked = _match_scenarios()
        if not SIM["confirmed"] and ranked:
            top = ranked[0]
            lead = top["conf"] - (ranked[1]["conf"] if len(ranked) > 1 else 0.0)
            qualified = top["conf"] >= CONFIRM_THRESHOLD and lead >= CONFIRM_MARGIN
            st = SIM["streak"]
            if qualified and st["sid"] == top["id"]:
                st["n"] += 1
            else:
                st["sid"] = top["id"] if qualified else None
                st["n"] = 1 if qualified else 0
            if st["n"] >= CONFIRM_STREAK:
                SIM["confirmed"] = True
                SIM["scenario"] = top["id"]
                scenario = SCENARIOS[SIM["scenario"]]
        match = {
            "active": True,
            "confirmed": SIM["confirmed"],
            "truth": SIM["inject"] if SIM["confirmed"] else None,
            "ranked": ranked[:4],
        }

    active = SIM["scenario"] != "normal"
    return {
        "type": "tick",
        "ts": time.time(),
        "scenario": SIM["scenario"],
        "message": scenario.get("message", "") if active else "",
        "tags": tags,
        "alarms": alarms,
        "alarm_equipment": sorted(alarm_eq) if active else sorted(alarm_eq),
        "match": match,
        "source": SOURCE.status,
    }


async def _tick_loop() -> None:
    while True:
        await _tick()
        await asyncio.sleep(1.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await SOURCE.start()
    task = asyncio.create_task(_tick_loop())
    yield
    task.cancel()
    await SOURCE.stop()


# /docs 保留給操作說明頁（見 PAGES），FastAPI 內建 Swagger 移到 /api-docs
app = FastAPI(title="J.S Process Intelligence API", lifespan=lifespan,
              docs_url="/api-docs", redoc_url="/api-redoc")

# ------------------------------------------------------------------- REST API


@app.get("/api/plant")
def get_plant(scene: str = "demo") -> dict:
    """場景資料：預設 demo（=plant.json）；編輯器自建場景由 scenes API 存取。"""
    if scene == "demo":
        return PLANT
    return load_scene(scene)


@app.get("/api/scenarios")
def get_scenarios(scene: str = "demo") -> list:
    src = PLANT if scene == "demo" else load_scene(scene)
    return [
        {"id": s["id"], "name": s["name"], "kind": s.get("kind", "normal"), "desc": s.get("desc", "")}
        for s in src.get("scenarios", [])
    ]


@app.post("/api/scenario/{sid}")
def set_scenario(sid: str) -> dict:
    if sid not in SCENARIOS:
        raise HTTPException(404, f"unknown scenario: {sid}")
    SIM["scenario"] = sid
    SIM["inject"] = None
    SIM["confirmed"] = False
    return {"ok": True, "scenario": sid}


def _require_sim() -> None:
    """異常注入只對內建模擬器有意義；接真實 DCS 時禁用（不能對現場數據造假）。"""
    if SOURCE is not SIM_ENGINE:
        raise HTTPException(409, "數據源為廠端即時數據，異常注入僅在模擬器模式可用")


@app.post("/api/inject/random")
def inject_random() -> dict:
    """盲測：隨機挑一個風險情境注入感測訊號，由比對引擎自己找出來。"""
    _require_sim()
    sid = random.choice([s for s in SCENARIOS if s != "normal"])
    return _do_inject(sid)


@app.post("/api/inject/stop")
def inject_stop() -> dict:
    _require_sim()
    SIM["inject"] = None
    SIM["confirmed"] = False
    SIM["streak"] = {"sid": None, "n": 0}
    SIM["scenario"] = "normal"
    # 感測值歸位，避免殘值影響下一輪比對
    SIM_ENGINE.reset_values()
    SIM["values"].update(SIM_ENGINE.values)
    return {"ok": True}


@app.post("/api/inject/{sid}")
def inject(sid: str) -> dict:
    if sid not in SCENARIOS or sid == "normal":
        raise HTTPException(404, f"unknown scenario: {sid}")
    _require_sim()
    return _do_inject(sid)


def _do_inject(sid: str) -> dict:
    SIM["inject"] = sid
    SIM["confirmed"] = False
    SIM["streak"] = {"sid": None, "n": 0}
    SIM["scenario"] = "normal"
    # 感測值回到基準附近，讓偏移從頭發展（演示比對過程）
    SIM_ENGINE.reset_values()
    SIM["values"].update(SIM_ENGINE.values)
    return {"ok": True, "injected": True}


@app.get("/api/history/{tag}")
def get_history(tag: str, n: int = 300) -> list:
    """時序歷史（ring buffer；正式部署換 InfluxDB/PI 查詢）。"""
    if tag not in INSTRUMENTS:
        raise HTTPException(404, f"unknown tag: {tag}")
    return HISTORY.get(tag, n)


@app.get("/api/datasource")
def get_datasource() -> dict:
    return SOURCE.status


# --------------------------------------------------- 分析層：製程代理模型


@app.get("/api/surrogate/info")
def surrogate_info() -> dict:
    from . import surrogate

    if not surrogate.available():
        raise HTTPException(503, "代理模型未啟用（缺 models/*.joblib 或 scikit-learn）")
    return surrogate.info()


@app.post("/api/surrogate/predict")
def surrogate_predict(body: dict) -> dict:
    """What-if：body = {"feed": {feed_TOL: .., ...覆寫}, "lag": {out_BZ: ..（選填）}}"""
    from . import surrogate

    if not surrogate.available():
        raise HTTPException(503, "代理模型未啟用")
    return surrogate.predict(body.get("feed"), body.get("lag"))


@app.get("/api/surrogate/catalyst")
def surrogate_catalyst(hours: float | None = None) -> dict:
    """催化劑健康：所需溫度／衰退速率／剩餘壽命外推（三年 DCS 實績模型）。"""
    from . import surrogate

    if not surrogate.catalyst_available():
        raise HTTPException(503, "催化劑模型未啟用")
    return surrogate.catalyst_health(hours)


# ------------------------------------- 分析層：約束平衡反應器（解析化 Aspen）


@app.get("/api/reactor/info")
def reactor_info() -> dict:
    from . import reactor_model

    if not reactor_model.available():
        raise HTTPException(503, "反應器模型未啟用（缺 models/reactor_params.json）")
    return reactor_model.info()


@app.post("/api/reactor/solve")
def reactor_solve(feed: dict) -> dict:
    """入料組成 A（wt%）→ 出口組成 B：守恆×2 + 平衡商×2 牛頓法求解。"""
    from . import reactor_model

    if not reactor_model.available():
        raise HTTPException(503, "反應器模型未啟用")
    try:
        return reactor_model.solve(feed)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


@app.get("/api/export/usd")
def export_usd() -> FileResponse:
    from . import usd_export

    EXPORTS_DIR.mkdir(exist_ok=True)
    out = EXPORTS_DIR / "plant.usda"
    out.write_text(usd_export.generate_usda(PLANT), encoding="utf-8")
    return FileResponse(out, media_type="text/plain", filename="plant.usda")


@app.get("/healthz")
def healthz() -> PlainTextResponse:
    return PlainTextResponse("ok")


def _read_version() -> str:
    p = Path(__file__).resolve().parent.parent / "VERSION"
    try:
        return p.read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def _git_short() -> str:
    """**啟動當下**的 commit 短碼，程序活著就不變。

    每次請求現查 HEAD 會說謊：桌機上剛 commit 還沒重啟時，工作樹是新的、
    跑的是舊的——版號要回答「現在跑的是哪一刀」，不是「硬碟上是哪一刀」。
    """
    global _BOOT_COMMIT
    if _BOOT_COMMIT is None:
        import subprocess

        try:
            _BOOT_COMMIT = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                cwd=Path(__file__).resolve().parent.parent, timeout=3,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            _BOOT_COMMIT = ""
    return _BOOT_COMMIT


_BOOT_COMMIT: str | None = None


@app.get("/api/version")
def api_version() -> dict:
    """平台版本：VERSION 檔為單一真相；附 commit 短碼與變更紀錄位置。

    使用者回報問題時要能說「我用的是 0.9.0（56cf79a）」，而不是「昨天那版」。
    """
    return {"version": _read_version(), "commit": _git_short(),
            "changelog": "/CHANGELOG.md"}


@app.get("/CHANGELOG.md")
def changelog_md() -> PlainTextResponse:
    p = Path(__file__).resolve().parent.parent / "CHANGELOG.md"
    if not p.exists():
        raise HTTPException(404, "尚無變更紀錄")
    return PlainTextResponse(p.read_text(encoding="utf-8"),
                             media_type="text/markdown; charset=utf-8")


# ------------------------------------------------------------------ WebSocket


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    try:
        while True:
            await ws.send_text(json.dumps(_snapshot(), ensure_ascii=False))
            await asyncio.sleep(1.0)
    except (WebSocketDisconnect, ConnectionError):
        pass


# ------------------------------------------------------------------- 靜態檔案

app.include_router(scenes_router)
app.include_router(dataprep_router)

from .automl import router as automl_router  # noqa: E402

app.include_router(automl_router)

from .aiassist import router as aiassist_router  # noqa: E402

app.include_router(aiassist_router)

from .sprite import router as sprite_router  # noqa: E402

app.include_router(sprite_router)

from .model_api import router as model_api_router  # noqa: E402

app.include_router(model_api_router)

from .data_api import router as data_api_router  # noqa: E402

app.include_router(data_api_router)

from .flowsheet import router as flowsheet_router  # noqa: E402

app.include_router(flowsheet_router)

# ------------------------------------ P&ID 標示化協作（地端 VLM 區域問答）
from .pid_vlm import router as pid_vlm_router  # noqa: E402

app.include_router(pid_vlm_router)

# ------------------------------------ P&ID 資產實體層（審核結果 → 型別化資產）
from .pid_model import router as pid_model_router  # noqa: E402

app.include_router(pid_model_router)

# ------------------------------------ P&ID 圖組（跨圖群集與整體辨識）
from .pid_group import router as pid_group_router  # noqa: E402

app.include_router(pid_group_router)

# ------------------------------------ P&ID 現場評註（製程說明的 RAG 來源）
from .pid_notes import router as pid_notes_router  # noqa: E402

app.include_router(pid_notes_router)

# ------------------------------------ 點位對照（歷史數據欄位 ↔ P&ID 資產）
from .pid_mapping import router as pid_mapping_router  # noqa: E402

from .data_inventory import router as data_inventory_router  # noqa: E402
from .twin_advisor import router as twin_advisor_router  # noqa: E402

app.include_router(pid_mapping_router)
app.include_router(data_inventory_router)
app.include_router(twin_advisor_router)

# --------------------------------------------------------- 登入與權限（Google OAuth）
from starlette.middleware.sessions import SessionMiddleware  # noqa: E402

from .auth import auth_guard, secret_key  # noqa: E402
from .auth import router as auth_router  # noqa: E402
from .apikeys import router as apikeys_router  # noqa: E402
from .mcp_server import router as mcp_router  # noqa: E402

app.include_router(auth_router)
app.include_router(apikeys_router)
app.include_router(mcp_router)
app.middleware("http")(auth_guard)                      # 內層：登入守衛
app.add_middleware(SessionMiddleware, secret_key=secret_key(),
                   same_site="lax", https_only=False)   # 外層：簽名 cookie session


@app.middleware("http")
async def _static_no_cache(request, call_next):
    # /static 一律強制重新驗證（避免瀏覽器把舊版 JS 模組快取在 module map，開發期抓不到新版）
    resp = await call_next(request)
    if request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp

# --------------------------------------------------------- P&ID 圖面管理
UPLOADS_DIR = BASE_DIR / "uploads"
PID_DIR = UPLOADS_DIR / "pid"
PID_DIR.mkdir(parents=True, exist_ok=True)


@app.delete("/api/pid/file/{filename}")
def pid_file_delete(filename: str) -> dict:
    """刪掉一張圖面：PDF＋底圖／OCR 快取。

    審核紀錄、資產模型、評註**刻意保留**——那是人力審出來的成果，
    同檔名重新上傳就接得回既有進度（與同檔名沿用機制同一條邏輯）。
    要連成果一併清除是另一個決定，不做靜默連坐。
    """
    from .pid_vlm import VLM_DIR, _safe_pdf, _slug

    pdf = _safe_pdf(filename)          # 也擋路徑穿越
    slug = _slug(Path(filename).stem)
    pdf.unlink()
    n = 1
    for p in VLM_DIR.glob(f"{slug}.*"):
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    return {"ok": True, "removed": n}


@app.post("/api/pid/upload")
async def pid_upload(file: "UploadFile" = FastAPIFile(...)) -> dict:
    name = Path(file.filename or "upload.pdf").name  # 去除路徑成分
    low = name.lower()
    data = await file.read()
    if low.endswith((".jpg", ".jpeg", ".png")):
        # 掃描圖／截圖：封裝成 PDF 走同一條管線。
        # 注意這類圖沒有向量圖元，閥件與氣泡幾何偵測會全數落空，只有 OCR 有效。
        import io as _io

        from PIL import Image

        try:
            im = Image.open(_io.BytesIO(data)).convert("RGB")
        except Exception:  # noqa: BLE001
            raise HTTPException(422, "圖檔無法讀取") from None
        name = Path(name).stem + ".pdf"
        buf = _io.BytesIO()
        im.save(buf, "PDF", resolution=200.0)
        data = buf.getvalue()
    elif not low.endswith(".pdf"):
        raise HTTPException(422, "僅接受 PDF／JPG／PNG")
    # 同檔名重傳＝同一張圖的新版本，既有台帳／評註／說明一律保留
    # （那些都以檔名 slug 為鍵，本來就接得上）。只有在**內容真的變了**時
    # 才清掉渲染與 OCR 快取，否則使用者會看到舊底圖卻不知道。
    dest = PID_DIR / name
    import hashlib

    existed = dest.exists()
    same = existed and hashlib.md5(dest.read_bytes()).digest() == hashlib.md5(data).digest()
    dest.write_bytes(data)
    cleared = 0
    if existed and not same:
        from .pid_vlm import VLM_DIR, _slug

        slug = _slug(Path(name).stem)
        for p in VLM_DIR.glob(f"{slug}.*"):
            try:
                p.unlink()
                cleared += 1
            except OSError:
                pass
    return {"ok": True, "name": name, "size": dest.stat().st_size,
            "replaced": existed, "content_changed": existed and not same,
            "caches_cleared": cleared,
            "note": ("同名檔已存在——既有的審核紀錄、評註與製程說明都會沿用"
                     if existed else "")}


@app.get("/api/pid/list")
def pid_list(request: Request) -> list:
    from .scenes import SCENES_DIR
    from .auth import restricted_files

    allow = restricted_files(request)
    out = []
    for p in sorted(PID_DIR.glob("*.pdf")):
        if allow is not None and p.name not in allow:
            continue
        slug = "pid-" + re.sub(r"[^a-z0-9]+", "-", p.stem.lower()).strip("-")
        out.append({"name": p.name, "size": p.stat().st_size,
                    "scene_id": slug if (SCENES_DIR / f"{slug}.json").exists() else None})
    return out


@app.post("/api/pid/parse/{filename}")
def pid_parse_endpoint(filename: str) -> dict:
    """P&ID 自動解析建模：OCR 抽位號 → 場景草稿 → 編輯器接手修改。"""
    from .pid_parse import parse_pid
    from .scenes import SCENES_DIR, _normalize

    try:
        result = parse_pid(filename)
    except FileNotFoundError:
        raise HTTPException(404, f"圖面不存在: {filename}") from None
    slug = "pid-" + re.sub(r"[^a-z0-9]+", "-", Path(filename).stem.lower()).strip("-")
    scene = _normalize(result["scene"])
    (SCENES_DIR / f"{slug}.json").write_text(
        json.dumps(scene, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"scene_id": slug, **result["stats"]}


@app.post("/api/pid/parse_all")
def pid_parse_all() -> dict:
    """批次解析全部圖面 → 單圖草稿 ×N + TA32 整廠合併場景（背景執行）。"""
    from .pid_batch import start_batch_thread

    return start_batch_thread()


@app.get("/api/pid/parse_all/status")
def pid_parse_all_status() -> dict:
    from .pid_batch import read_status

    return read_status()


app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")
app.mount("/scans", StaticFiles(directory=SCANS_DIR), name="scans")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ------------------------------------------------------------------ 頁面路由
PAGES = {
    "/": "home_v4.html",       # 平台首頁：3D 主視覺純白版（2026-08-18 取代舊版；舊版仍在 /static/home.html）
    "/twin": "index.html",     # 產品3：3D 數位孿生檢視
    "/studio": "editor.html",  # 產品3：J.S_3D Studio 設計工作室（獨立入口）
    "/e3d": "editor.html",     # 舊路徑別名（既有連結相容）
    "/twin/editor": "editor.html",  # 舊路徑別名（既有連結相容）
    "/twin/pid": "pid.html",   # 產品3：P&ID 管理
    "/twin/pid/label": "pid-label.html",  # 產品3：P&ID 標示化協作工作台（舊版面，並存一週後下架）
    "/twin/pid/label2": "pid-label2.html",  # 產品3：P&ID 判讀工作台 新版面（階段式：①辨識②審核③資產模型④評註與說明）
    "/twin/pid/rebuild": "pid-rebuild.html",  # 產品3：盲測重建（模型 JSON → 重畫）
    "/twin/mapping": "pid-mapping.html",       # 點位對照：歷史數據欄位 ↔ P&ID 資產
    "/twin/advisor": "twin-advisor.html",      # 製程建議：ML 結果承接＋三段連鎖最佳化示範
    "/keys": "apikeys.html",                   # API 金鑰／MCP：讓客戶接自己的 AI
    "/data/inventory": "data-inventory.html",  # 資料盤點：收到的資料在時間上長什麼樣
    "/data": "data.html",      # 產品2：資料前處理
    "/docs": "docs.html",      # 操作說明（雙語）
    "/admin": "admin.html",    # 權限管理（admin）
}
for route, fname in PAGES.items():
    def _page(fname=fname) -> FileResponse:
        # 頁面本身也要 no-cache：JS 靠檔名版本號破快取，但 HTML 若被快取住，
        # 使用者拿到的還是舊版本號，等於整條破快取機制失效（實測踩到）。
        return FileResponse(STATIC_DIR / fname,
                            headers={"Cache-Control": "no-cache, must-revalidate"})
    app.get(route)(_page)
