"""平台工具契約——一份定義，三種殼共用。

三種殼：
· **MCP over HTTP**（`/mcp`）：客戶在 Claude Desktop／Code 填 URL＋金鑰就能用
· **stdio bridge**：封閉網段用，跑在客戶自己機器上（之後補，讀這份定義）
· **OpenAI function schema**（`/mcp/openai-tools`）：地端模型多半不講 MCP，
  它們吃 function calling——同一份定義吐成它們的格式

所以工具定義寫成中立的資料結構（TOOLS），殼只負責轉換與傳輸。

身分：每個工具都在「某個使用者的身分」下執行——金鑰驗過之後，我們造一個帶
session 的假 Request 餵給既有函式，網域分租與圖面白名單原封不動生效。
不繞過任何權限，也不必為 MCP 另寫一套授權。
"""
from __future__ import annotations

from typing import Any, Callable

from fastapi import HTTPException
from starlette.requests import Request as StarletteRequest

SERIES_MAX = 2000        # 一次最多回幾點——AI 不是資料管線，大量處理請下載原始檔


def shim_request(email: str) -> StarletteRequest:
    """造一個「以這個人的身分」的 Request，讓既有函式照常判網域與白名單。"""
    return StarletteRequest({
        "type": "http", "http_version": "1.1", "method": "GET", "path": "/mcp",
        "raw_path": b"/mcp", "query_string": b"", "root_path": "", "scheme": "https",
        "headers": [], "client": ("mcp", 0), "server": ("mcp", 443),
        "session": {"email": email} if email else {},
    })


# ------------------------------------------------------------------ 工具實作
def _drawings(req, **_) -> Any:
    from .main import pid_list
    from .pid_model import _model_path

    from .auth import current_domain

    dom = current_domain(req)
    out = []
    for f in pid_list(req):
        n_eq = 0
        try:
            import json as _j

            mp = _model_path(f["name"], dom)
            if mp.exists():
                n_eq = len(_j.loads(mp.read_text(encoding="utf-8")).get("equipment") or [])
        except Exception:  # noqa: BLE001
            pass
        out.append({"drawing": f["name"], "size": f["size"], "equipment": n_eq,
                    "has_model": n_eq > 0})
    return {"drawings": out}


def _asset_model(req, drawing: str = "", **_) -> Any:
    from .pid_model import model_get

    m = model_get(drawing, req)
    keep = ("tag", "name", "type", "spec", "driver", "qty", "vfd", "remark",
            "source", "on_drawing", "note")
    return {
        "drawing": drawing,
        "stats": m.get("stats", {}),
        "equipment": [{**{k: e.get(k) for k in keep}, "located": bool(e.get("bbox"))}
                      for e in (m.get("equipment") or [])],
        "instruments": [{k: x.get(k) for k in ("tag", "function", "loop", "mounting", "note")}
                        for x in (m.get("instruments") or [])],
        "valves": [{k: v.get(k) for k in ("id", "size", "state", "bore", "net")}
                   for v in (m.get("valves") or [])],
        "lines": m.get("lines") or [],
        "loops": m.get("loops") or [],
    }


def _flow(req, drawing: str = "", **_) -> Any:
    from .pid_model import model_flow

    f = model_flow(drawing, req)
    if not f.get("ok"):
        return {"ok": False, "reason": f.get("reason", "尚未建模或無法推導")}
    return {"ok": True, "stats": f.get("stats", {}),
            "nodes": [{k: n.get(k) for k in ("tag", "name", "role", "level", "upstream", "downstream")}
                      for n in f.get("nodes", [])],
            "edges": [{k: e.get(k) for k in ("from", "to", "dir_by", "confidence", "evidence")}
                      for e in f.get("edges", [])]}


def _description(req, drawing: str = "", **_) -> Any:
    from .pid_vlm import describe_get

    d = describe_get(drawing, req)
    return {"drawing": drawing, "text": d.get("text", ""),
            "generated_at": d.get("at", ""), "revised": bool(d.get("revised")),
            "confirmed_by": d.get("confirmed_by", ""), "confirmed_at": d.get("confirmed_at", ""),
            "based_on_items": d.get("based_on")}


def _notes(req, drawing: str = "", **_) -> Any:
    from .pid_notes import get_notes

    d = get_notes(drawing, req)
    return {"drawing": drawing, "notes": [
        {k: n.get(k) for k in ("id", "label", "tag", "tags", "text", "by", "at")}
        for n in d.get("notes", [])]}


def _datasets(req, **_) -> Any:
    from .pid_mapping import mapping_datasets

    rows = mapping_datasets(req)
    return {"datasets": [{"id": r.get("sid"), "filename": r.get("filename"),
                          "rows": r.get("n_rows"), "mapped": r.get("mapped", 0),
                          "confirmed": r.get("confirmed", 0), "drawings": r.get("drawings", []),
                          "uploaded_at": r.get("uploaded_at")} for r in rows]}


def _points(req, dataset: str = "", **_) -> Any:
    from .pid_mapping import mapping_get

    m = mapping_get(dataset, req)
    out = []
    for p in m.get("points", []):
        st = p.get("stats") or {}
        out.append({"point": p.get("col"), "asset": p.get("tag") or None,
                    "asset_name": p.get("tag_name") or "", "sub": p.get("sub") or "",
                    "measure": p.get("measure") or "", "unit": p.get("unit") or "",
                    "range": {"lo": p.get("lo"), "hi": p.get("hi"), "by": p.get("range_by")},
                    "confirmed": bool(p.get("confirmed")),
                    "signed_by": p.get("signed_by") or "", "signed_at": p.get("signed_at") or "",
                    "guess": bool(p.get("guess")), "guess_confidence": p.get("guess_conf"),
                    "ignored": bool(p.get("ignored")),
                    "mean": st.get("mean"), "min": st.get("min"), "max": st.get("max"),
                    "missing_pct": st.get("missing_pct")})
    return {"dataset": dataset, "summary": m.get("summary", {}),
            "drawings": m.get("drawings", []), "points": out}


def _stats(req, dataset: str = "", point: str = "", **_) -> Any:
    from .pid_mapping import column_stats

    cols, meta = column_stats(dataset)
    hit = next((c for c in cols if c["col"] == point), None)
    if not hit:
        raise HTTPException(404, f"資料集裡沒有這一欄：{point}")
    return {"dataset": dataset, "point": point, "meta": meta, "stats": hit}


def _series(req, dataset: str = "", point: str = "", n: int = 400, **_) -> Any:
    from .pid_mapping import mapping_series

    n = int(n or 400)
    if n > SERIES_MAX:
        raise HTTPException(422, f"一次最多 {SERIES_MAX} 點（要求 {n}）。"
                                 "縮短範圍、加大聚合，或用 get_dataset_file 下載原始檔在本地處理。")
    d = mapping_series(dataset, point, n=n)
    got = len(d.get("v") or [])
    return {"dataset": dataset, "point": point, "points": got,
            "downsampled": True,
            "note": f"等距抽樣為 {got} 點；本工具不供大量原始資料，"
                    "大量處理請用 get_dataset_file 下載後在本地做。",
            "t": d.get("t"), "v": d.get("v")}


def _results(req, scope: str = "demo", drawing: str = "", **_) -> Any:
    from .twin_advisor import list_results

    d = list_results(req, scope=scope, drawing=drawing)
    return {"scope": scope, "drawing": drawing, "results": [
        {k: r.get(k) for k in ("id", "asset", "point", "metric", "value", "unit",
                               "model", "task", "computed_at", "by", "based_on", "note")}
        for r in d.get("results", [])]}


def _dataset_file(req, dataset: str = "", **_) -> Any:
    from .dataprep import DATA_DIR, _load_meta

    hits = list(DATA_DIR.glob(f"{dataset}.source.*"))
    if not hits:
        raise HTTPException(404, "這份資料集沒有保存原始上傳檔")
    meta = _load_meta(dataset) or {}
    return {"dataset": dataset, "filename": meta.get("filename"),
            "rows": meta.get("n_rows"), "size_bytes": hits[0].stat().st_size,
            "url": f"/api/data/{dataset}/source",
            "note": "帶同一把金鑰以 GET 下載；大量計算請在本地做完，再用 post_result 送回結果。"}


def _post_result(req, **kw) -> Any:
    from .twin_advisor import ResultReq, post_result

    return post_result(ResultReq(**kw), req)


# ------------------------------------------------------------------ 契約
def _t(name: str, scope: str, desc: str, params: dict, fn: Callable,
       required: list | None = None) -> dict:
    return {"name": name, "scope": scope, "description": desc, "fn": fn,
            "schema": {"type": "object", "properties": params,
                       "required": required or []}}


_S = {"type": "string"}
_I = {"type": "integer"}
_N = {"type": "number"}

TOOLS: list[dict] = [
    _t("list_drawings", "read",
       "列出這個帳號看得到的 P&ID 圖面，含是否已建資產模型、幾台設備。",
       {}, _drawings),
    _t("get_asset_model", "read",
       "取一張圖的資產模型：設備／儀錶／閥件／管線／控制迴路清單與規格，"
       "以及每台是否已在圖面上定位。",
       {"drawing": {**_S, "description": "圖面檔名（list_drawings 回的 drawing）"}},
       _asset_model, ["drawing"]),
    _t("get_flow", "read",
       "取製程順序：誰接誰、上下游、分流匯流點，以及每條連線的判定依據與信心。",
       {"drawing": _S}, _flow, ["drawing"]),
    _t("get_process_description", "read",
       "取這張圖的製程說明（AI 產生、人工確認過的那一份），含是否已確認與確認人。",
       {"drawing": _S}, _description, ["drawing"]),
    _t("list_notes", "read",
       "取現場評註：工程師對某台設備或某塊區域留下的、圖上讀不到的知識。",
       {"drawing": _S}, _notes, ["drawing"]),
    _t("list_datasets", "read",
       "列出歷史數據資料集：列數、涵蓋期間、已對到幾個點位、對到哪些圖。",
       {}, _datasets),
    _t("list_points", "read",
       "取點位語意——這才是平台的核心：每一欄對到哪台設備、什麼量測項、單位、"
       "合理範圍、是誰簽名確認的，以及基本統計。",
       {"dataset": {**_S, "description": "資料集 id（list_datasets 回的 id）"}},
       _points, ["dataset"]),
    _t("get_stats", "read",
       "取單一點位的完整統計：平均／極值／p1／p99／缺值率／分佈。",
       {"dataset": _S, "point": _S}, _stats, ["dataset", "point"]),
    _t("get_series", "read",
       f"取單一點位的時序，等距抽樣，一次最多 {SERIES_MAX} 點。"
       "本工具不供大量原始資料——大量計算請用 get_dataset_file 下載後在本地做。",
       {"dataset": _S, "point": _S,
        "n": {**_I, "description": f"要幾點（預設 400，上限 {SERIES_MAX}）"}},
       _series, ["dataset", "point"]),
    _t("list_results", "read",
       "取已承接的模型結果與建議，含彼此的承接鏈（based_on）。",
       {"scope": {**_S, "description": "demo 或 drawing"},
        "drawing": {**_S, "description": "scope=drawing 時必填"}},
       _results),
    _t("get_dataset_file", "read",
       "取資料集原始上傳檔的下載連結（帶同一把金鑰 GET）。要做大量計算走這條。",
       {"dataset": _S}, _dataset_file, ["dataset"]),

    _t("post_result", "write:result",
       "把模型算出來的結果落到某台資產上——健康分數、最佳設定值、異常標記都可以。"
       "會記下是誰算的、依據哪個點位、什麼時候，可用 based_on 串成承接鏈。",
       {"scope": {**_S, "description": "demo 或 drawing（預設 demo）"},
        "drawing": {**_S, "description": "scope=drawing 時必填"},
        "asset": {**_S, "description": "設備位號，例 209"},
        "point": {**_S, "description": "依據的點位欄名"},
        "metric": {**_S, "description": "health_score／optimal_setpoint／anomaly／自訂"},
        "value": _N, "unit": _S,
        "model": {**_S, "description": "誰算的（模型名與版本）"},
        "computed_at": {**_S, "description": "模型計算時間（ISO 8601，可省略）"},
        "based_on": {**_S, "description": "上游結果 id，用來串承接鏈"},
        "evidence": {"type": "array", "items": {"type": "object"}},
        "note": _S},
       _post_result, ["asset", "metric", "model"]),
]

BY_NAME = {t["name"]: t for t in TOOLS}


def allowed(scope: str) -> list[dict]:
    """這個權限級別看得到哪些工具。"""
    return [t for t in TOOLS if t["scope"] == "read" or scope == "write:result"]


def call(name: str, args: dict, email: str, scope: str) -> Any:
    """以某個使用者的身分執行工具——權限與白名單由既有機制把關。"""
    t = BY_NAME.get(name)
    if not t:
        raise HTTPException(404, f"沒有這個工具：{name}")
    if t["scope"] == "write:result" and scope != "write:result":
        raise HTTPException(403, f"{name} 需要 write:result 權限，這把金鑰是唯讀的")
    req = shim_request(email)
    return t["fn"](req, **(args or {}))


def openai_schema(scope: str = "read") -> list[dict]:
    """同一份契約吐成 OpenAI function calling 格式——地端模型多半只吃這個。"""
    return [{"type": "function",
             "function": {"name": t["name"], "description": t["description"],
                          "parameters": t["schema"]}}
            for t in allowed(scope)]
