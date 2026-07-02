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
}


def _sim_tick() -> None:
    """一階趨近 + 雜訊的假數據模擬。之後換 OPC UA 讀值時只要改這裡。"""
    scenario = SCENARIOS[SIM["scenario"]]
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
    active = SIM["scenario"] != "normal"
    return {
        "type": "tick",
        "ts": time.time(),
        "scenario": SIM["scenario"],
        "message": scenario.get("message", "") if active else "",
        "tags": tags,
        "alarms": alarms,
        "alarm_equipment": sorted(alarm_eq) if active else sorted(alarm_eq),
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
    return {"ok": True, "scenario": sid}


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
