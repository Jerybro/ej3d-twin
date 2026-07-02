"""數據源抽象層 — 數據孿生的根。

平台的即時值一律經過 DataSource 介面取得，來源可在 data/datasource.json 切換：

- ``sim``     內建製程模擬器（一階趨近＋雜訊；支援情境注入，DEMO/開發用）
- ``opcua``   OPC UA Client（asyncua）— 廠端 DCS/SCADA/PI 介接主力
- ``modbus``  Modbus TCP（pymodbus）— PLC/RTU 輔助

設計原則：
- 上層（main.py）只看到 ``await source.read() -> {tag: value}``，換來源不動業務邏輯
- 廠端套件（asyncua/pymodbus）採 lazy import：沒安裝或連不上 → 自動 fallback 回
  模擬器，並在 ``source.status`` 標示，前端 chip 會顯示目前吃哪個來源
- 斷線自動重連（指數退避），read() 失敗回傳空 dict，上層保持前值
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_FILE = BASE_DIR / "data" / "datasource.json"


# ------------------------------------------------------------------ 介面


class DataSource:
    kind = "base"

    async def start(self) -> None:  # 建立連線／背景任務
        pass

    async def stop(self) -> None:
        pass

    async def read(self) -> dict[str, float]:  # tag -> 即時值；失敗回 {}
        raise NotImplementedError

    @property
    def status(self) -> dict:
        return {"kind": self.kind, "connected": True, "detail": ""}


# ------------------------------------------------------------ 內建模擬器


class SimSource(DataSource):
    """一階趨近＋雜訊的製程模擬器。支援情境注入（scenario effects 驅動目標值）。"""

    kind = "sim"

    def __init__(self, instruments: dict, scenarios: dict):
        self.instruments = instruments
        self.scenarios = scenarios
        self.values = {tag: inst["base"] for tag, inst in instruments.items()}
        self.driver = "normal"  # 由 main.py 設定（scenario 或 inject 的情境 id）

    def reset_values(self) -> None:
        for tag, inst in self.instruments.items():
            self.values[tag] = inst["base"]

    async def read(self) -> dict[str, float]:
        effects = self.scenarios[self.driver].get("effects", {})
        for tag, inst in self.instruments.items():
            base = inst["base"]
            target, rate = base, 0.15
            if tag in effects:
                target = effects[tag]["target"]
                rate = effects[tag].get("rate", 0.1)
            v = self.values[tag]
            noise = random.gauss(0, max(abs(base) * 0.004, 0.05))
            v += (target - v) * rate + noise
            if inst["unit"] == "%":
                v = max(0.0, min(105.0, v))
            self.values[tag] = v
        return dict(self.values)

    @property
    def status(self) -> dict:
        return {"kind": "sim", "connected": True, "detail": "內建製程模擬器"}


# ------------------------------------------------------------- OPC UA


class OpcUaSource(DataSource):
    """OPC UA 訂閱/輪詢。cfg: {"endpoint": "opc.tcp://host:4840", "nodes": {tag: nodeid}}"""

    kind = "opcua"

    def __init__(self, cfg: dict):
        self.endpoint = cfg["endpoint"]
        self.node_map: dict[str, str] = cfg.get("nodes", {})
        self.client = None
        self.nodes = {}
        self.connected = False
        self.detail = "未連線"
        self._backoff = 2.0

    async def start(self) -> None:
        await self._connect()

    async def _connect(self) -> None:
        try:
            from asyncua import Client  # lazy import
        except ImportError:
            self.detail = "asyncua 未安裝（pip install asyncua）"
            return
        try:
            self.client = Client(url=self.endpoint)
            await asyncio.wait_for(self.client.connect(), timeout=5)
            self.nodes = {tag: self.client.get_node(nid) for tag, nid in self.node_map.items()}
            self.connected = True
            self.detail = f"{self.endpoint}｜{len(self.nodes)} nodes"
            self._backoff = 2.0
        except Exception as e:  # noqa: BLE001 — 廠端連線什麼都可能炸，統一進重連
            self.connected = False
            self.detail = f"連線失敗: {type(e).__name__}"

    async def read(self) -> dict[str, float]:
        if not self.connected:
            await asyncio.sleep(self._backoff)
            self._backoff = min(self._backoff * 1.5, 30)
            await self._connect()
            if not self.connected:
                return {}
        try:
            values = await asyncio.wait_for(
                asyncio.gather(*(n.read_value() for n in self.nodes.values())), timeout=3
            )
            return {tag: float(v) for tag, v in zip(self.nodes.keys(), values)}
        except Exception as e:  # noqa: BLE001
            self.connected = False
            self.detail = f"讀取失敗: {type(e).__name__}"
            return {}

    async def stop(self) -> None:
        if self.client and self.connected:
            await self.client.disconnect()

    @property
    def status(self) -> dict:
        return {"kind": "opcua", "connected": self.connected, "detail": self.detail}


# ------------------------------------------------------------- Modbus


class ModbusSource(DataSource):
    """Modbus TCP 輪詢。cfg: {"host", "port", "unit",
    "registers": {tag: {"address": n, "scale": 0.1, "offset": 0, "kind": "holding"|"input"}}}"""

    kind = "modbus"

    def __init__(self, cfg: dict):
        self.host = cfg["host"]
        self.port = cfg.get("port", 502)
        self.unit = cfg.get("unit", 1)
        self.registers: dict[str, dict] = cfg.get("registers", {})
        self.client = None
        self.connected = False
        self.detail = "未連線"
        self._backoff = 2.0

    async def _connect(self) -> None:
        try:
            from pymodbus.client import AsyncModbusTcpClient  # lazy import
        except ImportError:
            self.detail = "pymodbus 未安裝（pip install pymodbus）"
            return
        try:
            self.client = AsyncModbusTcpClient(self.host, port=self.port)
            self.connected = await asyncio.wait_for(self.client.connect(), timeout=5)
            self.detail = f"{self.host}:{self.port}｜{len(self.registers)} regs" if self.connected else "連線失敗"
            self._backoff = 2.0
        except Exception as e:  # noqa: BLE001
            self.connected = False
            self.detail = f"連線失敗: {type(e).__name__}"

    async def read(self) -> dict[str, float]:
        if not self.connected:
            await asyncio.sleep(self._backoff)
            self._backoff = min(self._backoff * 1.5, 30)
            await self._connect()
            if not self.connected:
                return {}
        out = {}
        try:
            for tag, reg in self.registers.items():
                fn = self.client.read_input_registers if reg.get("kind") == "input" else self.client.read_holding_registers
                rr = await fn(reg["address"], count=1, slave=self.unit)
                if rr.isError():
                    continue
                out[tag] = rr.registers[0] * reg.get("scale", 1.0) + reg.get("offset", 0.0)
            return out
        except Exception as e:  # noqa: BLE001
            self.connected = False
            self.detail = f"讀取失敗: {type(e).__name__}"
            return {}

    async def stop(self) -> None:
        if self.client:
            self.client.close()

    @property
    def status(self) -> dict:
        return {"kind": "modbus", "connected": self.connected, "detail": self.detail}


# ------------------------------------------------------------ 工廠函式


def load_source(instruments: dict, scenarios: dict) -> tuple[DataSource, SimSource]:
    """依 datasource.json 建立主來源；一律同時建 SimSource 當 fallback／注入引擎。

    回傳 (主來源, sim)。主來源就是 sim 時兩者為同一實例。
    """
    sim = SimSource(instruments, scenarios)
    cfg = {}
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            cfg = {}
    kind = cfg.get("kind", "sim")
    if kind == "opcua" and cfg.get("opcua", {}).get("endpoint"):
        return OpcUaSource(cfg["opcua"]), sim
    if kind == "modbus" and cfg.get("modbus", {}).get("host"):
        return ModbusSource(cfg["modbus"]), sim
    return sim, sim


# ------------------------------------------------------------ 時序歷史


class History:
    """每 tag 環形緩衝（預設 15 分鐘 @1s）。DEMO 用記憶體即可；
    正式部署換 InfluxDB/TimescaleDB/PI 時只要改這個類別。"""

    def __init__(self, maxlen: int = 900):
        from collections import deque

        self.maxlen = maxlen
        self._buf: dict[str, "deque"] = {}
        self._deque = deque

    def append(self, values: dict[str, float]) -> None:
        ts = round(time.time(), 1)
        for tag, v in values.items():
            if tag not in self._buf:
                self._buf[tag] = self._deque(maxlen=self.maxlen)
            self._buf[tag].append((ts, round(float(v), 2)))

    def get(self, tag: str, n: int = 300) -> list:
        buf = self._buf.get(tag)
        if not buf:
            return []
        return list(buf)[-n:]
