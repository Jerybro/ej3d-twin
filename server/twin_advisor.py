"""製程建議（/twin/advisor）＋模型結果承接 API（/api/twin/result）。

兩件事，一個模組：

1. **承接 API**：任何人（平台內建 AutoML、客戶自己的模型、第三方服務）算出的
   結果都能 POST 進來，落到指定資產上——記「誰算的、根據哪個點位、什麼時候、
   基於哪個上游結果」。平台不做模型，做承接；內建 AutoML 也走同一條路，
   不給自己開後門。

2. **示範場景**：一座虛構三設備小廠（擠出機→隧道烘箱→燒結窯），假數據埋了
   真實物理耦合，用平台自己的 AutoML 訓練＋尋優，跑「A 最佳化 → 最佳解沿
   製程鏈固定成 B 的條件 → 再傳到 C」的三段連鎖——上下文承接的可見證明。
   與客戶資料完全隔離（Jery 2026-08-20 拍板）。
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
RESULT_DIR = BASE_DIR / "data" / "twin_results"
DATA_DIR = BASE_DIR / "uploads" / "data"

router = APIRouter(prefix="/api/twin", tags=["twin-advisor"])

_LOCK = threading.Lock()

DEMO_SID = "demoplant"          # 示範資料集固定 sid（與 uuid8 不撞）
# 伺服器重啟會殺掉 AutoML 的訓練執行緒，但落盤紀錄還寫著 status=training——
# 那種「上一輩子留下的 training」永遠不會完成。記下本次啟動時間，比它早的視為死掉重訓。
_BOOT = datetime.now()

# ------------------------------------------------------------------ 承接結果存放
def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _result_path(domain: str, key: str) -> Path:
    d = RESULT_DIR / (re.sub(r"[^a-z0-9.-]+", "-", (domain or "dev.local").lower()) or "_")
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{re.sub(r'[^a-z0-9_-]+', '-', key.lower()) or 'demo'}.json"


def _load_results(domain: str, key: str) -> list:
    p = _result_path(domain, key)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _save_results(domain: str, key: str, rows: list) -> None:
    p = _result_path(domain, key)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows[-500:], ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


class ResultReq(BaseModel):
    scope: str = "demo"              # demo | drawing
    drawing: str = ""                # scope=drawing 時必填（圖檔名）
    asset: str                       # 設備位號
    point: str = ""                  # 依據的點位欄名（建議填，可追溯）
    metric: str                      # health_score | optimal_setpoint | anomaly | 自訂
    value: float | None = None
    unit: str = ""
    model: str                       # 誰算的（模型名/版本）
    computed_at: str = ""            # 模型計算時間（空＝收到時間）
    evidence: list = Field(default_factory=list)
    based_on: str = ""               # 上游結果 id（上下文承接鏈）
    note: str = ""


def _result_key(req_scope: str, drawing: str) -> str:
    if req_scope == "demo":
        return "demo"
    if not drawing:
        raise HTTPException(422, "scope=drawing 需要 drawing（圖檔名）")
    return re.sub(r"[^a-z0-9]+", "-", Path(drawing).stem.lower()).strip("-")


def store_result(domain: str, actor: str, req: ResultReq) -> dict:
    key = _result_key(req.scope, req.drawing)
    rec = req.model_dump()
    rec["id"] = uuid.uuid4().hex[:8]
    rec["by"] = actor
    rec["at"] = _now()
    if not rec["computed_at"]:
        rec["computed_at"] = rec["at"]
    with _LOCK:
        rows = _load_results(domain, key)
        rows.append(rec)
        _save_results(domain, key, rows)
    return rec


@router.post("/result")
def post_result(req: ResultReq, request: Request) -> dict:
    """模型結果承接：外部/內部模型算完 → 落到資產上。回存 id 供下游 based_on。"""
    from .auth import current_actor, current_domain

    if req.scope == "drawing":
        from .pid_vlm import _safe_pdf

        _safe_pdf(req.drawing)
    return store_result(current_domain(request), current_actor(request), req)


@router.get("/result")
def list_results(request: Request, scope: str = "demo", drawing: str = "") -> dict:
    from .auth import current_domain

    key = _result_key(scope, drawing)
    return {"results": _load_results(current_domain(request), key)}


@router.delete("/result/{rid}")
def delete_result(rid: str, request: Request, scope: str = "demo", drawing: str = "") -> dict:
    from .auth import current_domain

    key = _result_key(scope, drawing)
    dom = current_domain(request)
    with _LOCK:
        rows = _load_results(dom, key)
        n0 = len(rows)
        rows = [r for r in rows if r.get("id") != rid]
        if len(rows) == n0:
            raise HTTPException(404, "結果不存在")
        _save_results(dom, key, rows)
    return {"ok": True}


# ------------------------------------------------------------------ 示範場景
# **資產模型是真的**（潤泰 M0200 礦化及造粒，已審核 68 個框），
# **點位數值是模擬的**（真資料只有馬達電流/頻率，沒有溫度/含水/品質，
# 算不出「省燃氣、守規格」這種故事）。畫面上明講哪一半真、哪一半模擬。
#
# 三台取自這張圖真實的物料順序：209 捏和擠出機 → 210 隧道式烘箱 65M
# （燃燒機 210-1/210-2 就掛在它身上）→ 212 雙軸破碎機。
# 「細粉率」對應圖上真的有的「106.1 回料太空包／細粉回料」。
DEMO_DRAWING = "R-M0200-00-000-000-00 礦化及造粒系統流程圖_20260408.pdf"

CHAIN = [
    {"tag": "209", "name": "捏和擠出機", "points": {
        "209_10_feed_mean": {"label": "進料量", "unit": "t/h"},
        "209_10_hz_mean": {"label": "螺桿頻率", "unit": "Hz"},
        "209_10_amp_mean": {"label": "電流", "unit": "A"},
        "209_10_ok_frac": {"label": "粒徑合格率", "unit": "%"},
    }},
    {"tag": "210", "name": "隧道式烘箱帶運機 65M", "points": {
        "210_10_temp_mean": {"label": "爐溫", "unit": "°C"},
        "210_10_gas_mean": {"label": "燃氣", "unit": "m³/h"},
        "210_10_moist_mean": {"label": "出料含水", "unit": "%"},
    }},
    {"tag": "212", "name": "雙軸破碎機", "points": {
        "212_10_hz_mean": {"label": "破碎頻率", "unit": "Hz"},
        "212_10_amp_mean": {"label": "電流", "unit": "A"},
        "212_10_fine_frac": {"label": "細粉率（回料）", "unit": "%"},
    }},
]

DEMO_MODELS = {
    "amp":   {"target": "209_10_amp_mean",   "features": ["209_10_feed_mean", "209_10_hz_mean"]},
    "ok":    {"target": "209_10_ok_frac",    "features": ["209_10_feed_mean", "209_10_hz_mean"]},
    "moist": {"target": "210_10_moist_mean", "features": ["210_10_temp_mean", "209_10_feed_mean"]},
    "gas":   {"target": "210_10_gas_mean",   "features": ["210_10_temp_mean", "209_10_feed_mean"]},
    "fine":  {"target": "212_10_fine_frac",  "features": ["210_10_moist_mean", "212_10_hz_mean"]},
}


def _is_stale(rec: dict) -> bool:
    """這筆 training 是不是上一個程序留下的（本次啟動之前建的）。"""
    try:
        return datetime.strptime(rec.get("created", ""), "%Y-%m-%d %H:%M:%S") < _BOOT
    except (ValueError, TypeError):
        return True


def _scenario_path() -> Path:
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    return RESULT_DIR / "demo_scenario.json"


def _make_demo_dataset() -> None:
    """示範點位數值：1 分鐘 × 92 天，埋真物理耦合；最後 7 天做成操作漂移＝現行條件。
    冪等（存在就不重做）。這是模擬值，不是潤泰真資料。"""
    import numpy as np
    import pandas as pd

    if (DATA_DIR / f"{DEMO_SID}.parquet").exists():
        return
    rng = np.random.RandomState(42)
    n = 92 * 24 * 60
    t = pd.date_range("2026-05-01", periods=n, freq="min")

    def steps(lo, hi, dmin, dmax):
        """操作員每 dmin~dmax 分鐘換一次設定。"""
        v = np.empty(n)
        i = 0
        while i < n:
            d = int(rng.uniform(dmin, dmax))
            v[i:i + d] = rng.uniform(lo, hi)
            i += d
        return v

    feed = np.clip(2.3 + np.cumsum(rng.normal(0, 0.004, n)) % 0.9 - 0.45 + rng.normal(0, 0.02, n), 1.8, 2.8)
    hz = steps(40, 48, 240, 480)
    temp = steps(174, 192, 360, 720)
    chz = steps(38, 48, 360, 720)
    # 最後 7 天：螺桿開太快、爐溫催太高、破碎機保守慢轉——示範對比的「現行條件」
    k = 7 * 24 * 60
    hz[-k:], temp[-k:], chz[-k:] = 47.5, 190.0, 41.0
    hz += rng.normal(0, 0.15, n)
    temp += rng.normal(0, 0.4, n)
    chz += rng.normal(0, 0.2, n)

    # 209 擠出：電流對頻率呈 U 形（43 附近最省）；頻率過高粒徑合格率掉
    amp = 8.0 * feed + 0.06 * (hz - 43) ** 2 + rng.normal(0, 0.35, n)
    ok = 99.0 - 0.35 * np.clip(hz - 45, 0, None) ** 1.5 - 0.5 * np.clip(feed - 2.6, 0, None) + rng.normal(0, 0.12, n)
    # 210 烘箱：爐溫越高越乾、越耗氣
    gas = 0.9 * (temp - 160) + 2.2 * feed + rng.normal(0, 0.5, n)
    moist = np.clip(1.9 - 0.075 * (temp - 172) + 0.5 * (feed - 2.4) + rng.normal(0, 0.05, n), 0.1, None)
    # 212 破碎：料越乾越易碎成細粉（要回料）；轉速越高細粉越多、電流越高
    fine = np.clip(3.0 - 1.5 * moist + 0.03 * (chz - 40) + rng.normal(0, 0.06, n), 0.2, None)
    camp = 5.0 + 2.0 * feed + 1.8 * moist + 0.10 * (chz - 40) + rng.normal(0, 0.25, n)

    df = pd.DataFrame({
        "__id__": range(1, n + 1), "time": t,
        "209_10_feed_mean": np.round(feed, 3), "209_10_hz_mean": np.round(hz, 2),
        "209_10_amp_mean": np.round(amp, 2), "209_10_ok_frac": np.round(ok, 2),
        "210_10_temp_mean": np.round(temp, 1), "210_10_gas_mean": np.round(gas, 2),
        "210_10_moist_mean": np.round(moist, 3),
        "212_10_hz_mean": np.round(chz, 2), "212_10_amp_mean": np.round(camp, 2),
        "212_10_fine_frac": np.round(fine, 3),
    })
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_parquet(DATA_DIR / f"{DEMO_SID}.parquet")
    (DATA_DIR / f"{DEMO_SID}.steps.json").write_text("[]", encoding="utf-8")
    meta = {"filename": "示範_礦化造粒線_1min（模擬值）.csv", "time_col": "time",
            "uploaded_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "owner": None, "n_rows": int(n), "demo": True}
    (DATA_DIR / f"{DEMO_SID}.meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def _ensure_models() -> dict:
    """確保五個示範模型存在（沒有就開訓練），回 {key: {mid, status}}。

    整段上鎖：前端每 3 秒輪詢一次狀態，沒鎖的話兩個併發請求會各建一批
    （實測跑出 10 個模型、5 個變孤兒）。
    """
    with _LOCK:
        return _ensure_models_locked()


def _ensure_models_locked() -> dict:
    from .automl import AUTOML_DIR, create_models, list_models

    sc = {}
    if _scenario_path().exists():
        try:
            sc = json.loads(_scenario_path().read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            sc = {}
    mids = sc.get("models", {})
    existing = {m["id"]: m for m in list_models(DEMO_SID)}
    out = {}
    changed = False
    for key, spec in DEMO_MODELS.items():
        mid = mids.get(key)
        rec = existing.get(mid)
        if rec is not None and rec.get("status") == "training" and _is_stale(rec):
            rec = None                      # 前一個程序留下的殭屍訓練 → 重訓
        if rec is None or rec.get("status") == "failed":
            r = create_models(DEMO_SID, {"mode": "manual", "algo": "XGB",
                                         "name": f"demo_{key}", "target": spec["target"],
                                         "features": spec["features"]})
            mid = r["created"][0]
            mids[key] = mid
            changed = True
            out[key] = {"mid": mid, "status": "training"}
        else:
            out[key] = {"mid": mid, "status": rec.get("status", "training")}
    if changed:
        sc["models"] = mids
        _scenario_path().write_text(json.dumps(sc, ensure_ascii=False, indent=1), encoding="utf-8")
    # 孤兒清理：沒被 mids 指到的示範模型（早期併發或改版留下的）直接刪，
    # 免得清單越積越多、也省得它們繼續佔 CPU 訓練
    keep = set(mids.values())
    for m in existing.values():
        if m["id"] not in keep:
            for suf in (".json", ".joblib"):
                (AUTOML_DIR / DEMO_SID / f"{m['id']}{suf}").unlink(missing_ok=True)
    return out


@router.get("/advisor/demo")
def demo_state(request: Request) -> dict:
    """示範狀態：真資產模型（圖面／設備框）＋模擬點位統計＋模型就緒度＋既有結果。"""
    from .auth import current_domain
    from .pid_mapping import column_stats

    _make_demo_dataset()
    models = _ensure_models()
    cols, meta = column_stats(DEMO_SID)
    stats = {c["col"]: c for c in cols}
    recent = _recent_means()

    # 真資產模型：這張圖已審核的設備框（本網域沒建模就回無框，畫面退成方塊圖）
    boxes, aspect, model_ok = {}, 0.707, False
    try:
        from .pid_model import _model_path

        mp = _model_path(DEMO_DRAWING, current_domain(request))
        if mp.exists():
            m = json.loads(mp.read_text(encoding="utf-8"))
            aspect = (m.get("geometry") or {}).get("aspect") or aspect
            for e in (m.get("equipment") or []):
                if e.get("bbox") and e.get("tag"):
                    boxes[str(e["tag"])] = {"bbox": e["bbox"], "name": e.get("name") or "",
                                            "spec": e.get("spec") or ""}
            model_ok = any(eq["tag"] in boxes for eq in CHAIN)
    except Exception:  # noqa: BLE001
        pass

    chain = []
    for eq in CHAIN:
        b = boxes.get(eq["tag"], {})
        pts = [{"col": col, **info, "mean": recent.get(col),
                "min": (stats.get(col) or {}).get("min"), "max": (stats.get(col) or {}).get("max")}
               for col, info in eq["points"].items()]
        chain.append({"tag": eq["tag"], "name": b.get("name") or eq["name"],
                      "spec": b.get("spec", ""), "bbox": b.get("bbox"), "points": pts})

    return {"sid": DEMO_SID, "meta": meta, "chain": chain, "models": models,
            "ready": all(m["status"] == "done" for m in models.values()),
            "drawing": DEMO_DRAWING, "aspect": aspect, "model_ok": model_ok,
            "boxes": [{"tag": t, "bbox": v["bbox"]} for t, v in boxes.items()],
            "results": _load_results(current_domain(request), "demo")}


@router.post("/advisor/demo/reset")
def demo_reset(request: Request) -> dict:
    """清掉本網域的示範結果（重跑用）。資料集與模型留著。"""
    from .auth import current_domain

    _save_results(current_domain(request), "demo", [])
    return {"ok": True}


def _fmt(v, nd=2):
    return None if v is None else round(float(v), nd)


def _recent_means() -> dict:
    """近 7 天各欄平均＝「現行條件」。建議對比的是最近的操作，不是三個月中位數。"""
    import pandas as pd

    df = pd.read_parquet(DATA_DIR / f"{DEMO_SID}.parquet")
    tail = df.tail(7 * 24 * 60)
    return {c: float(tail[c].mean()) for c in tail.columns
            if c not in ("__id__", "time")}


def _pct(now: float, new: float) -> float:
    return (now - new) / now * 100 if now else 0.0


def _sgn(v: float, unit: str = "%") -> str:
    return f"{'−' if v >= 0 else '+'}{abs(round(float(v), 1))}{unit}"


@router.post("/advisor/demo/run")
def demo_run(request: Request) -> dict:
    """三段連鎖：A（901 擠出機）最佳化 → 最佳解固定成 B（903 烘箱）的條件 →
    再傳 C（905 窯）。每一段都是真的 CALL 平台 AutoML（optimize/whatif），
    每個結論都經 store_result 落庫——內建模型與外部模型走同一條承接路。"""
    from .auth import current_actor, current_domain
    from .automl import optimize, whatif

    models = _ensure_models()
    not_ready = [k for k, m in models.items() if m["status"] != "done"]
    if not_ready:
        raise HTTPException(409, f"模型還在訓練：{', '.join(not_ready)}——幾秒後再按一次")
    dom, actor = current_domain(request), current_actor(request)
    mid = {k: m["mid"] for k, m in models.items()}
    cur = _recent_means()          # 近 7 天現行條件——三張卡都對比它
    feed = round(cur["209_10_feed_mean"], 2)

    # ---- A｜901 擠出機：現行進料下找最省電的螺桿頻率；合格率 ≥98 才收
    o = optimize(DEMO_SID, mid["amp"], {"mode": "min", "knobs": ["209_10_hz_mean"],
                                        "fixed": {"209_10_feed_mean": feed}})
    hz_now = cur["209_10_hz_mean"]
    hz_best = o["best"]["209_10_hz_mean"]
    ok_at = whatif(DEMO_SID, mid["ok"], {"values": {"209_10_feed_mean": feed,
                                                    "209_10_hz_mean": hz_best}})["pred"]
    tries = 0
    while ok_at < 98.0 and tries < 12:
        hz_best += 0.5 if hz_now > hz_best else -0.5
        ok_at = whatif(DEMO_SID, mid["ok"], {"values": {"209_10_feed_mean": feed,
                                                        "209_10_hz_mean": hz_best}})["pred"]
        tries += 1
    amp_now = whatif(DEMO_SID, mid["amp"], {"values": {"209_10_feed_mean": feed,
                                                       "209_10_hz_mean": hz_now}})["pred"]
    amp_best = whatif(DEMO_SID, mid["amp"], {"values": {"209_10_feed_mean": feed,
                                                        "209_10_hz_mean": hz_best}})["pred"]
    saving_a = _pct(amp_now, amp_best)
    ra = store_result(dom, actor, ResultReq(
        scope="demo", asset="209", point="209_10_hz_mean", metric="optimal_setpoint",
        value=_fmt(hz_best, 1), unit="Hz", model="platform-automl/XGB",
        evidence=[{"point": "209_10_amp_mean", "current": _fmt(amp_now),
                   "optimized": _fmt(amp_best), "saving_pct": _fmt(saving_a, 1)},
                  {"point": "209_10_ok_frac", "predicted": _fmt(ok_at, 1), "constraint": ">=98"}],
        note=f"進料 {feed} t/h 下，螺桿 {_fmt(hz_now, 1)}→{_fmt(hz_best, 1)} Hz，"
             f"電流 {_sgn(saving_a)}，合格率預估 {_fmt(ok_at, 1)}%"))

    # ---- B｜903 烘箱：承接 A（產線維持現行進料），找「含水 ≤0.8%」的最低爐溫
    ob = optimize(DEMO_SID, mid["moist"], {"mode": "target", "value": 0.8,
                                           "knobs": ["210_10_temp_mean"],
                                           "fixed": {"209_10_feed_mean": feed}})
    temp_now = cur["210_10_temp_mean"]
    temp_best = ob["best"]["210_10_temp_mean"]
    gas_now = whatif(DEMO_SID, mid["gas"], {"values": {"210_10_temp_mean": temp_now,
                                                       "209_10_feed_mean": feed}})["pred"]
    gas_best = whatif(DEMO_SID, mid["gas"], {"values": {"210_10_temp_mean": temp_best,
                                                        "209_10_feed_mean": feed}})["pred"]
    saving_b = _pct(gas_now, gas_best)
    rb = store_result(dom, actor, ResultReq(
        scope="demo", asset="210", point="210_10_temp_mean", metric="optimal_setpoint",
        value=_fmt(temp_best, 1), unit="°C", model="platform-automl/XGB",
        based_on=ra["id"],
        evidence=[{"point": "210_10_moist_mean", "target": 0.8, "predicted": ob["pred"]},
                  {"point": "210_10_gas_mean", "current": _fmt(gas_now),
                   "optimized": _fmt(gas_best), "saving_pct": _fmt(saving_b, 1)}],
        note=f"承接 209 條件（{feed} t/h）：爐溫 {_fmt(temp_now, 1)}→{_fmt(temp_best, 1)}°C "
             f"即保含水 ≤0.8%，燃氣 {_sgn(saving_b)}"))

    # ---- C｜212 雙軸破碎機：承接 B 的含水 0.8%，守細粉率規格 ≤2.0% 下可提的轉速。
    # 料沒那麼乾＝不易碎成細粉＝破碎機可以開快一點，產能上去、回料下來。
    FINE_SPEC = 2.0
    chz_now = cur["212_10_hz_mean"]
    fine_now = whatif(DEMO_SID, mid["fine"], {"values": {
        "210_10_moist_mean": cur["210_10_moist_mean"], "212_10_hz_mean": chz_now}})["pred"]
    oc = optimize(DEMO_SID, mid["fine"], {"mode": "target", "value": FINE_SPEC,
                                          "knobs": ["212_10_hz_mean"],
                                          "fixed": {"210_10_moist_mean": 0.8}})
    chz_best = oc["best"]["212_10_hz_mean"]
    up = _pct(chz_now, chz_best)
    rc = store_result(dom, actor, ResultReq(
        scope="demo", asset="212", point="212_10_hz_mean", metric="optimal_setpoint",
        value=_fmt(chz_best, 1), unit="Hz", model="platform-automl/XGB",
        based_on=rb["id"],
        evidence=[{"point": "212_10_fine_frac", "spec": FINE_SPEC,
                   "current": _fmt(fine_now, 2), "predicted": oc["pred"]},
                  {"point": "212_10_hz_mean", "current": _fmt(chz_now, 1),
                   "throughput_pct": _fmt(-up, 1)}],
        note=f"承接 210 條件（含水 0.8%）：料不再過乾，破碎頻率 {_fmt(chz_now, 1)}"
             f"→{_fmt(chz_best, 1)} Hz（產能 +{_fmt(abs(up), 1)}%），"
             f"細粉率仍守規格 ≤{FINE_SPEC}%（現行 {_fmt(fine_now, 2)}%）"))

    cards = [ra, rb, rc]
    return {"ok": True, "cards": cards}
