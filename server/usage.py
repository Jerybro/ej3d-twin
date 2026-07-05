"""模型 API 使用計數 + 呼叫稽核（L2 治理層，對標 Tukey「API 累積使用次數 / 最後使用時間 / 所有 API 使用紀錄」）。

- counters.json：每 model_key 的 {total_calls, last_used_at, by_endpoint}。
- audit.jsonl：逐筆呼叫稽核（append-only，一行一 JSON）。
- 「使用次數」語意對標 Tukey：只計推論/應用呼叫，治理動作（發布/開關/移除）不計 total_calls，
  但仍記 by_endpoint 與稽核。

設計：record() 是唯一寫入點（由 facade 的 _Timer 與少數 _record 呼叫），
單一次呼叫只記一筆（resolve 不再自記，避免同次失敗雙記）。執行緒安全。
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path

from .automl import DATA_DIR

USAGE_DIR = DATA_DIR / "registry" / "usage"
USAGE_DIR.mkdir(parents=True, exist_ok=True)
COUNTERS_PATH = USAGE_DIR / "counters.json"
AUDIT_PATH = USAGE_DIR / "audit.jsonl"

_LOCK = threading.Lock()

# 不計入「API 累積使用次數」的治理動作（對標 Tukey：使用次數＝推論/應用呼叫）
_GOVERNANCE = {"publish", "enable", "disable", "unregister", "meta"}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _read_counters() -> dict:
    if not COUNTERS_PATH.exists():
        return {}
    try:
        d = json.loads(COUNTERS_PATH.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (ValueError, OSError):
        return {}


def _write_counters(d: dict) -> None:
    tmp = COUNTERS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, COUNTERS_PATH)


def record(model_key: str, endpoint: str, *, caller: str | None = None,
           source: str = "api", n_inputs: int = 0, ok: bool = True,
           ms: int = 0, http: int = 200, err: str | None = None) -> None:
    """記一筆 usage（稽核 append + counters 更新）。單一寫入點，同次呼叫只記一筆。"""
    ts = _now()
    entry = {
        "ts": ts, "model_key": model_key, "endpoint": endpoint, "caller": caller,
        "source": source, "n_inputs": int(n_inputs), "ok": bool(ok),
        "ms": int(ms), "http": int(http),
        "err": (err[:300] if isinstance(err, str) else err),
    }
    with _LOCK:
        with AUDIT_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        c = _read_counters()
        m = c.setdefault(model_key, {"total_calls": 0, "last_used_at": None, "by_endpoint": {}})
        m["by_endpoint"][endpoint] = m["by_endpoint"].get(endpoint, 0) + 1
        if endpoint not in _GOVERNANCE:
            m["total_calls"] = int(m.get("total_calls", 0)) + 1
            m["last_used_at"] = ts
        _write_counters(c)


def counters(model_key: str) -> dict:
    """單模型使用彙總。"""
    return _read_counters().get(
        model_key, {"total_calls": 0, "last_used_at": None, "by_endpoint": {}})


def audit(*, model_key: str | None = None, limit: int = 200,
          month: str | None = None) -> list:
    """稽核紀錄（最新在前）。可依 model_key 或 month（前綴如 2025-10）過濾。"""
    if not AUDIT_PATH.exists():
        return []
    out = []
    try:
        with AUDIT_PATH.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if model_key and e.get("model_key") != model_key:
                    continue
                if month and not str(e.get("ts", "")).startswith(month):
                    continue
                out.append(e)
    except OSError:
        return []
    out.reverse()
    return out[: max(0, int(limit))]
