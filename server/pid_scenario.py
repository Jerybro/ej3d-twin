# 情境流量傳遞 —— 資產模型掛數據的第一塊
#
# 資產模型回答「有什麼、誰接誰」，這裡回答「數字怎麼流」。第一版是**靜態傳遞**：
# 起點設備由人設入料量，往下游走——沒掛模型的設備直通（進多少出多少）、
# 分流點依比例分（預設均分並明標「未確認」）、匯流點加總。
#
# 三條鐵則（與審核流同一套）：
#   ・每個數字都帶來源：manual（人填）／split（均分推定）／sum（加總）／
#     model（模型算的，本版尚無）——推定與事實不混在同一種顏色裡
#   ・單位跟著設備存，不全平台寫死；單位不符的邊停下來標，不偷偷換算
#   ・情境檔照 flowsheet 規格形狀存（blocks/connections/defaults），日後要開進
#     設計器或跑最佳化直接接得上，不用重做
#
# 資料落在 data/pid_scenario/{domain}/{slug}.json：
#   {"scenarios": {"<name>": {"feeds": {"201": {"value": 10, "unit": "t/h",
#                                                "source": "manual"}},
#                              "splits": {"209": {"210": 0.5, "210-1": 0.5}},
#                              "units":  {"<tag>": "t/h"}}},
#    "active": "<name>"}
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/pid/model", tags=["pid-scenario"])

BASE_DIR = Path(__file__).resolve().parent.parent
SCN_DIR = BASE_DIR / "data" / "pid_scenario"
_LOCK = threading.Lock()

DEFAULT_UNIT = "t/h"


# ------------------------------------------------------------------ storage
def _path(filename: str, domain: str) -> Path:
    from .pid_vlm import _slug

    d = SCN_DIR / (re.sub(r"[^a-z0-9.-]+", "-", (domain or "").lower()) or "_")
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{_slug(Path(filename).stem)}.json"


def _load(filename: str, domain: str) -> dict:
    p = _path(filename, domain)
    if not p.exists():
        return {"scenarios": {}, "active": ""}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"scenarios": {}, "active": ""}
    d.setdefault("scenarios", {})
    d.setdefault("active", "")
    return d


def _save(filename: str, domain: str, d: dict) -> None:
    p = _path(filename, domain)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


# ------------------------------------------------------------------ engine
def _num_key(s: str) -> tuple:
    parts = re.findall(r"\d+", s or "")
    return tuple(int(p) for p in parts) if parts else (0,)


def propagate(nodes: list, edges: list, feeds: dict, splits: dict,
              units: dict, capacity: dict | None = None) -> dict:
    """靜態流量傳遞。

    nodes: [{tag, name, bbox}]；edges: [{from, to}]（已解析方向的邊，可疑邊
    由呼叫端先過濾）；feeds: {tag: {value, unit, source}}；splits: {tag: {to: 比例}}；
    units: {tag: unit}；capacity: {tag: 上限值}（用來標瓶頸）。

    回傳每台設備的 in/out（值、單位、來源）、每條邊的流量、問題清單。
    來源語意：manual＝人填｜split＝依比例分（比例若是預設均分會標 assumed）
    ｜sum＝加總｜pass＝直通｜none＝沒有數字流到這裡。
    """
    import networkx as nx

    capacity = capacity or {}
    G = nx.DiGraph()
    for n in nodes:
        G.add_node(n["tag"], name=n.get("name", ""))
    for e in edges:
        if e["from"] in G and e["to"] in G:
            G.add_edge(e["from"], e["to"])

    def unit_of(t: str) -> str:
        return (units.get(t) or feeds.get(t, {}).get("unit") or DEFAULT_UNIT)

    # 拓撲序；有環就退回項次號序並記一條問題（靜態傳遞不解環）
    issues: list = []
    try:
        order = list(nx.topological_sort(G))
    except nx.NetworkXUnfeasible:
        cyc = next(iter(nx.simple_cycles(G)), [])
        issues.append({"kind": "cycle", "tags": cyc,
                       "msg": "流向圖含迴圈，靜態傳遞按項次號序略過回流邊"})
        order = sorted(G.nodes, key=_num_key)

    flow_in: dict = {}          # tag → {value, unit, source, parts:[...]}
    flow_out: dict = {}
    edge_flow: dict = {}        # (from,to) → {value, unit, source, assumed}

    for t in order:
        u = unit_of(t)
        preds = [p for p in G.predecessors(t) if (p, t) in edge_flow]
        # ---- 進料：人填 > 上游加總 ----
        if t in feeds and feeds[t].get("value") is not None:
            f = feeds[t]
            fin = {"value": float(f["value"]), "unit": f.get("unit") or u,
                   "source": f.get("source") or "manual", "parts": []}
        elif preds:
            parts, total, bad = [], 0.0, []
            for p in preds:
                ef = edge_flow[(p, t)]
                if ef["value"] is None:
                    continue
                if ef["unit"] != u:
                    bad.append({"from": p, "unit_from": ef["unit"], "unit_to": u})
                    continue
                parts.append({"from": p, "value": ef["value"], "assumed": ef.get("assumed", False)})
                total += ef["value"]
            for b in bad:
                issues.append({"kind": "unit", "tags": [b["from"], t],
                               "msg": f"{b['from']}→{t} 單位不符（{b['unit_from']} → {b['unit_to']}），"
                                      "未換算；請補密度或改單位"})
            if parts:
                fin = {"value": round(total, 4), "unit": u,
                       "source": "sum" if len(parts) > 1 else "pass", "parts": parts,
                       "assumed": any(p["assumed"] for p in parts)}
            else:
                fin = {"value": None, "unit": u, "source": "none", "parts": []}
        else:
            fin = {"value": None, "unit": u, "source": "none", "parts": []}
        flow_in[t] = fin

        # ---- 出料：本版直通（有模型的設備日後在這裡換成模型輸出）----
        fout = dict(fin)
        fout["source"] = "pass" if fin["source"] not in ("none",) else "none"
        if fin["source"] == "manual":
            fout["source"] = "manual"
        flow_out[t] = fout

        # ---- 瓶頸：進料超過清冊產能 ----
        cap = capacity.get(t)
        if cap and fin["value"] is not None and fin["value"] > float(cap):
            issues.append({"kind": "capacity", "tags": [t],
                           "msg": f"{t} 進料 {fin['value']} {u} 超過清冊產能 {cap} {u}"})

        # ---- 分配到下游 ----
        succ = list(G.successors(t))
        if not succ:
            continue
        ratio = splits.get(t) or {}
        assumed = False
        if len(succ) > 1 and not ratio:
            ratio = {s: 1.0 / len(succ) for s in succ}
            assumed = True
        elif len(succ) == 1:
            ratio = {succ[0]: 1.0}
        else:
            # 人填的比例：正規化並補漏（沒填的下游拿剩下的均分）
            given = {s: float(ratio.get(s, 0)) for s in succ}
            tot = sum(given.values())
            missing = [s for s in succ if s not in ratio]
            if tot > 1.0001:
                given = {s: v / tot for s, v in given.items()}
                tot = 1.0
            rem = max(0.0, 1.0 - tot)
            for s in missing:
                given[s] = rem / len(missing) if missing else 0.0
            ratio = given
        for s in succ:
            r = float(ratio.get(s, 0.0))
            v = None if fout["value"] is None else round(fout["value"] * r, 4)
            edge_flow[(t, s)] = {"value": v, "unit": fout["unit"], "ratio": r,
                                 "source": "split" if len(succ) > 1 else fout["source"],
                                 "assumed": assumed or fout.get("assumed", False)}

    return {
        "ok": True,
        "nodes": {t: {"in": flow_in.get(t), "out": flow_out.get(t),
                      "unit": unit_of(t), "capacity": capacity.get(t)}
                  for t in G.nodes},
        "edges": [{"from": a, "to": b, **v} for (a, b), v in edge_flow.items()],
        "issues": issues,
        "stats": {
            "nodes": G.number_of_nodes(), "edges": G.number_of_edges(),
            "fed": sum(1 for t in G.nodes if (flow_in.get(t) or {}).get("value") is not None),
            "assumed_splits": sum(1 for v in edge_flow.values() if v.get("assumed")),
            "issues": len(issues),
        },
    }


# ------------------------------------------------------------------ helpers
def _graph_of(filename: str, request: Request) -> tuple[list, list, dict, dict]:
    """從資產模型取節點、流向邊、清冊產能、名稱。可疑邊不進傳遞圖。"""
    from .pid_model import model_flow, model_get

    flow = model_flow(filename, request)
    full = model_get(filename, request)
    if not flow.get("ok"):
        raise HTTPException(409, flow.get("reason", "尚無流向圖——請先建立資產模型並確認設備"))
    nodes = [{"tag": n["tag"], "name": n.get("name", ""), "bbox": n.get("bbox")}
             for n in flow["nodes"]]
    edges = [{"from": e["from"], "to": e["to"]} for e in flow["edges"]
             if not e.get("suspect")]
    # 清冊產能：從 spec 抓「產能：3T/hr」這類
    cap: dict = {}
    names: dict = {}
    for e in full.get("equipment", []):
        names[e["tag"]] = e.get("name") or e.get("type") or ""
        m = re.search(r"產能[:：]\s*([\d.]+)\s*T/?hr", str(e.get("spec", "")), re.I)
        if m:
            cap[e["tag"]] = float(m.group(1))
    return nodes, edges, cap, names


# ------------------------------------------------------------------ endpoints
class ScenarioReq(BaseModel):
    name: str = "設計流量"
    feeds: dict = {}          # {tag: {value, unit, source?}}
    splits: dict = {}         # {tag: {to: ratio}}
    units: dict = {}          # {tag: unit}


@router.get("/{filename}/scenario")
def scenario_get(filename: str, request: Request) -> dict:
    """情境清單＋目前使用中的情境＋起點/分流點（給面板畫表單用）。"""
    from .auth import current_domain
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    dom = current_domain(request)
    d = _load(filename, dom)
    nodes, edges, cap, names = _graph_of(filename, request)
    import networkx as nx

    G = nx.DiGraph()
    G.add_nodes_from(n["tag"] for n in nodes)
    G.add_edges_from((e["from"], e["to"]) for e in edges)
    starts = sorted([t for t in G.nodes if G.in_degree(t) == 0 and G.out_degree(t) > 0],
                    key=_num_key)
    splits = {t: sorted(G.successors(t), key=_num_key)
              for t in G.nodes if G.out_degree(t) > 1}
    return {**d,
            "starts": [{"tag": t, "name": names.get(t, "")} for t in starts],
            "split_points": [{"tag": t, "name": names.get(t, ""), "to": v}
                             for t, v in sorted(splits.items(), key=lambda kv: _num_key(kv[0]))],
            "capacity": cap}


@router.put("/{filename}/scenario")
def scenario_put(filename: str, req: ScenarioReq, request: Request) -> dict:
    """存一組情境（同名覆蓋）並設為使用中。每個人填的值都標 source=manual。"""
    from .auth import current_actor, current_domain
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    dom = current_domain(request)
    name = (req.name or "").strip() or "設計流量"
    feeds = {}
    for t, f in (req.feeds or {}).items():
        if f is None or f.get("value") in (None, ""):
            continue
        try:
            v = float(f["value"])
        except (TypeError, ValueError):
            raise HTTPException(422, f"{t} 的入料量不是數字")
        feeds[t] = {"value": v, "unit": (f.get("unit") or DEFAULT_UNIT).strip(),
                    "source": f.get("source") or "manual"}
    splits = {}
    for t, m in (req.splits or {}).items():
        clean = {}
        for s, r in (m or {}).items():
            try:
                clean[s] = float(r)
            except (TypeError, ValueError):
                continue
        if clean:
            splits[t] = clean
    with _LOCK:
        d = _load(filename, dom)
        d["scenarios"][name] = {"feeds": feeds, "splits": splits,
                                "units": dict(req.units or {}),
                                "by": current_actor(request)}
        d["active"] = name
        _save(filename, dom, d)
    return {"ok": True, "active": name, "count": len(d["scenarios"])}


@router.post("/{filename}/scenario/run")
def scenario_run(filename: str, request: Request, name: str = "") -> dict:
    """跑靜態傳遞。name 空＝使用中的情境。"""
    from .auth import current_domain
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    dom = current_domain(request)
    d = _load(filename, dom)
    nm = name or d.get("active") or ""
    sc = d["scenarios"].get(nm) or {"feeds": {}, "splits": {}, "units": {}}
    nodes, edges, cap, names = _graph_of(filename, request)
    res = propagate(nodes, edges, sc.get("feeds", {}), sc.get("splits", {}),
                    sc.get("units", {}), cap)
    res["scenario"] = nm
    res["names"] = names
    return res


@router.delete("/{filename}/scenario/{name}")
def scenario_delete(filename: str, name: str, request: Request) -> dict:
    from .auth import current_domain
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    dom = current_domain(request)
    with _LOCK:
        d = _load(filename, dom)
        if name not in d["scenarios"]:
            raise HTTPException(404, "情境不存在")
        del d["scenarios"][name]
        if d.get("active") == name:
            d["active"] = next(iter(d["scenarios"]), "")
        _save(filename, dom, d)
    return {"ok": True, "active": d["active"]}
