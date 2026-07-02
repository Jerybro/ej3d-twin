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
import random
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = BASE_DIR / "data" / "plant.json"
STATIC_DIR = BASE_DIR / "static"
SCANS_DIR = BASE_DIR / "scans"
EXPORTS_DIR = BASE_DIR / "exports"

PLANT = json.loads(DATA_FILE.read_text(encoding="utf-8"))
INSTRUMENTS: dict = PLANT["instruments"]
SCENARIOS: dict = {s["id"]: s for s in PLANT["scenarios"]}

# ---------------------------------------------------------------- 模擬器狀態
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


def _sim_tick() -> None:
    """一階趨近 + 雜訊的假數據模擬。之後換 OPC UA 讀值時只要改這裡。"""
    driver = SIM["inject"] if SIM["inject"] else SIM["scenario"]
    scenario = SCENARIOS[driver]
    effects = scenario.get("effects", {})
    for tag, inst in INSTRUMENTS.items():
        base = inst["base"]
        target, rate = base, 0.15
        if tag in effects:
            target = effects[tag]["target"]
            rate = effects[tag].get("rate", 0.1)
        v = SIM["values"][tag]
        noise = random.gauss(0, max(abs(base) * 0.004, 0.05))
        v += (target - v) * rate + noise
        if inst["unit"] == "%":
            v = max(0.0, min(105.0, v))
        SIM["values"][tag] = v


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
    }


async def _sim_loop() -> None:
    while True:
        _sim_tick()
        await asyncio.sleep(1.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_sim_loop())
    yield
    task.cancel()


app = FastAPI(title="EJ_3D 數位孿生平台 MVP", lifespan=lifespan)

# ------------------------------------------------------------------- REST API


@app.get("/api/plant")
def get_plant() -> dict:
    return PLANT


@app.get("/api/scenarios")
def get_scenarios() -> list:
    return [
        {"id": s["id"], "name": s["name"], "kind": s["kind"], "desc": s.get("desc", "")}
        for s in PLANT["scenarios"]
    ]


@app.post("/api/scenario/{sid}")
def set_scenario(sid: str) -> dict:
    if sid not in SCENARIOS:
        raise HTTPException(404, f"unknown scenario: {sid}")
    SIM["scenario"] = sid
    SIM["inject"] = None
    SIM["confirmed"] = False
    return {"ok": True, "scenario": sid}


@app.post("/api/inject/random")
def inject_random() -> dict:
    """盲測：隨機挑一個風險情境注入感測訊號，由比對引擎自己找出來。"""
    sid = random.choice([s for s in SCENARIOS if s != "normal"])
    return _do_inject(sid)


@app.post("/api/inject/stop")
def inject_stop() -> dict:
    SIM["inject"] = None
    SIM["confirmed"] = False
    SIM["streak"] = {"sid": None, "n": 0}
    SIM["scenario"] = "normal"
    # 感測值歸位，避免殘值影響下一輪比對
    for tag, inst in INSTRUMENTS.items():
        SIM["values"][tag] = inst["base"]
    return {"ok": True}


@app.post("/api/inject/{sid}")
def inject(sid: str) -> dict:
    if sid not in SCENARIOS or sid == "normal":
        raise HTTPException(404, f"unknown scenario: {sid}")
    return _do_inject(sid)


def _do_inject(sid: str) -> dict:
    SIM["inject"] = sid
    SIM["confirmed"] = False
    SIM["streak"] = {"sid": None, "n": 0}
    SIM["scenario"] = "normal"
    # 感測值回到基準附近，讓偏移從頭發展（演示比對過程）
    for tag, inst in INSTRUMENTS.items():
        SIM["values"][tag] = inst["base"]
    return {"ok": True, "injected": True}


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

app.mount("/scans", StaticFiles(directory=SCANS_DIR), name="scans")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
