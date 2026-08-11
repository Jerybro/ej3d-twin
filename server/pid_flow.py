# 製程順序圖 — 從「一堆設備」推導出「誰先誰後、哪裡分流」
#
# 資產庫回答「這張圖有什麼」，順序圖回答「物料怎麼走」。後者才是製程，
# 也才是 Stage 2 掛數據時的骨架（要判斷上下游異常傳遞，得先知道上下游）。
#
# 三種證據，強度分明——絕不把推論當事實：
#   ① 流向箭頭（強）：箭頭壓在哪條線上，那條線的方向就是它指的方向
#   ② 線段連通（中）：兩台設備被同一串線接起來＝有物料往來，但不知誰先
#   ③ 項次號序（弱）：台灣工程慣例編號大致照製程走（201→209→210），
#      但不保證，只在①②都定不出方向時當後備，且明確標示為推測
#
# 分流／並流不是猜的，是圖論定義：出度>1＝分流、入度>1＝並流。
from __future__ import annotations

import math
import re

# 設備框往外擴這麼多（正規化）才算「線接到這台設備」——CAD 的接管線
# 常在符號邊界外停住一小段。
PORT_PAD = 0.02
# 兩線段視為相連的端點距離
LINK_TOL = 0.004
# 箭頭要離線段多近才算「壓在這條線上」
ARROW_TOL = 0.012


def _d(ax, ay, bx, by, aspect):
    return math.hypot(bx - ax, (by - ay) * aspect)


def _pt_seg(px, py, s, aspect):
    x0, y0, x1, y1 = s[0], s[1], s[2], s[3]
    dx, dy = (x1 - x0), (y1 - y0) * aspect
    if dx == 0 and dy == 0:
        return _d(px, py, x0, y0, aspect)
    t = ((px - x0) * dx + (py - y0) * aspect * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return _d(px, py, x0 + t * (x1 - x0), y0 + t * (y1 - y0), aspect)


def _inside(x, y, b, pad=None):
    """點是否落在設備框內（含外擴）。

    pad 預設 None 而非直接寫 PORT_PAD——預設參數在函式**定義時**求值，
    寫死會讓之後調整 PORT_PAD 完全沒作用（pid_topology 的 _key 踩過同一個坑，
    這次標定時又踩一次：四種半徑跑出完全相同的結果才發現）。
    """
    p = PORT_PAD if pad is None else pad
    return (b[0] - p <= x <= b[2] + p) and (b[1] - p <= y <= b[3] + p)


def _num_key(s: str) -> tuple:
    parts = re.findall(r"\d+", s or "")
    return tuple(int(p) for p in parts) if parts else (0,)


def build_flow(equipment: list, pipes: list, arrows: list, aspect: float) -> dict:
    """設備清單＋線稿＋箭頭 → 製程有向圖。

    equipment: [{tag, name, bbox}]（bbox 必要）
    pipes:     [[x0,y0,x1,y1,(style)], ...] 正規化
    arrows:    [[x, y, deg], ...] 正規化＋角度（影像座標系，右為 0、順時針為正）
    """
    import networkx as nx

    eq = [e for e in equipment if e.get("bbox")]
    if len(eq) < 2:
        return {"ok": False, "reason": "已定位的設備少於兩台，無法推導流向"}

    # ── 1. 線段圖：端點合併 ─────────────────────────────────
    G = nx.Graph()
    key = lambda p: (round(p[0] / LINK_TOL), round(p[1] / LINK_TOL))  # noqa: E731
    for i, s in enumerate(pipes):
        if _d(s[0], s[1], s[2], s[3], aspect) < 0.002:
            continue
        a, b = key((s[0], s[1])), key((s[2], s[3]))
        if a == b:
            continue
        G.add_node(a, pos=(s[0], s[1]))
        G.add_node(b, pos=(s[2], s[3]))
        G.add_edge(a, b, seg=i)

    # ── 2. 設備「埠」：落在設備框內（或緊鄰）的線段端點 ──────
    #      定位器的候選框常互相重疊；一個端點落在兩台設備框內時，配給
    #      「框中心最近」的那台——原本後到先贏（迭代順序決定歸屬）等於
    #      擲骰子，重疊區的埠會把兩台設備亂牽在一起。
    port_of: dict = {}          # node → 設備 index
    for n, data in G.nodes(data=True):
        x, y = data["pos"]
        best, bi = None, None
        for idx, e in enumerate(eq):
            b = e["bbox"]
            if not _inside(x, y, b):
                continue
            d = _d(x, y, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, aspect)
            if best is None or d < best:
                best, bi = d, idx
        if bi is not None:
            port_of[n] = bi

    # ── 3. 設備連通：兩台設備的埠若能沿線段互通，且路徑不穿過
    #      第三台設備，就算有直接物料往來 ─────────────────
    #      作法是把設備節點視為「牆」：從 A 的埠出發做 BFS，遇到別台
    #      設備的埠就停下並記一條邊。這樣才不會把 A→B→C 誤記成 A→C。
    links: dict = {}            # (i, j) → {segs: [seg idx]}
    for n0, i0 in list(port_of.items()):
        seen = {n0}
        stack = [(n0, [])]
        while stack:
            n, path = stack.pop()
            for m in G.neighbors(n):
                if m in seen:
                    continue
                seg = G[n][m].get("seg")
                j = port_of.get(m)
                if j is not None:
                    if j != i0:
                        k = (min(i0, j), max(i0, j))
                        links.setdefault(k, {"segs": []})["segs"] += path + [seg]
                    continue        # 到達設備就停（設備是牆）
                seen.add(m)
                stack.append((m, path + [seg]))

    # ── 4. 方向：箭頭壓在這條連線的哪一段上 ──────────────
    def _overlap_frac(a, b) -> float:
        ix = min(a[2], b[2]) - max(a[0], b[0])
        iy = min(a[3], b[3]) - max(a[1], b[1])
        if ix <= 0 or iy <= 0:
            return 0.0
        aa = (a[2] - a[0]) * (a[3] - a[1])
        ab = (b[2] - b[0]) * (b[3] - b[1])
        return ix * iy / max(min(aa, ab), 1e-9)

    edges = []
    for (i, j), info in links.items():
        # 兩台的框都疊在一起了，「相連」多半是重疊造成的假訊號，
        # 不是製程關係——這種邊寧可不出，留給人工／VLM 判
        if _overlap_frac(eq[i]["bbox"], eq[j]["bbox"]) > 0.3:
            continue
        segs = [pipes[s] for s in info["segs"] if s is not None and s < len(pipes)]
        if not segs:
            continue
        ci = [(eq[i]["bbox"][0] + eq[i]["bbox"][2]) / 2,
              (eq[i]["bbox"][1] + eq[i]["bbox"][3]) / 2]
        cj = [(eq[j]["bbox"][0] + eq[j]["bbox"][2]) / 2,
              (eq[j]["bbox"][1] + eq[j]["bbox"][3]) / 2]
        vote = 0.0
        n_arrow = 0
        for ax, ay, deg in arrows:
            near = min((_pt_seg(ax, ay, s, aspect) for s in segs), default=9)
            if near > ARROW_TOL:
                continue
            n_arrow += 1
            rad = math.radians(deg)
            avx, avy = math.cos(rad), math.sin(rad)
            # 箭頭方向與「i→j」的向量同向為正
            dx, dy = cj[0] - ci[0], (cj[1] - ci[1]) * aspect
            norm = math.hypot(dx, dy) or 1
            vote += (avx * dx + avy * dy) / norm
        if n_arrow and abs(vote) > 0.35:
            src, dst = (i, j) if vote > 0 else (j, i)
            edges.append({"from": eq[src]["tag"], "to": eq[dst]["tag"],
                          "dir_by": "arrow", "confidence": 0.85,
                          "evidence": f"連線上有 {n_arrow} 個流向箭頭，方向一致指向"
                                      f"{eq[dst]['tag']}"})
        else:
            # 沒有箭頭可判 → 用項次號順序當後備，並標明是推測
            a, b = (i, j) if _num_key(eq[i]["tag"]) <= _num_key(eq[j]["tag"]) else (j, i)
            edges.append({"from": eq[a]["tag"], "to": eq[b]["tag"],
                          "dir_by": "item_no", "confidence": 0.4,
                          "evidence": f"此連線上沒有可判讀的流向箭頭，"
                                      f"依項次號順序推測 {eq[a]['tag']}→{eq[b]['tag']}"
                                      "（工程慣例，非圖面證據，請人工確認）"})

    # ── 5. 分流／並流：圖論定義，不是猜的 ───────────────
    D = nx.DiGraph()
    for e in eq:
        D.add_node(e["tag"], name=e.get("name") or e.get("symbol") or "",
                   bbox=e["bbox"])
    for e in edges:
        D.add_edge(e["from"], e["to"], **e)

    nodes = []
    for t in D.nodes:
        od, idg = D.out_degree(t), D.in_degree(t)
        role = ("分流點" if od > 1 else
                "匯流點" if idg > 1 else
                "起點" if idg == 0 and od > 0 else
                "終點" if od == 0 and idg > 0 else
                "串接" if od == 1 and idg == 1 else "孤立")
        nodes.append({"tag": t, "name": D.nodes[t]["name"], "bbox": D.nodes[t]["bbox"],
                      "in": idg, "out": od, "role": role,
                      "downstream": sorted(D.successors(t), key=_num_key),
                      "upstream": sorted(D.predecessors(t), key=_num_key)})

    # 拓撲層級：起點為 0，往下游遞增（有環就退回項次號排序）
    try:
        order = list(nx.topological_sort(D))
        level: dict = {}
        for t in order:
            preds = list(D.predecessors(t))
            level[t] = (max((level[p] for p in preds), default=-1) + 1) if preds else 0
        cyc = []
    except nx.NetworkXUnfeasible:
        level = {n["tag"]: i for i, n in enumerate(sorted(nodes,
                                                         key=lambda x: _num_key(x["tag"])))}
        cyc = [list(c) for c in nx.simple_cycles(D)][:5]
    for n in nodes:
        n["level"] = level.get(n["tag"], 0)
    nodes.sort(key=lambda n: (n["level"], _num_key(n["tag"])))

    return {
        "ok": True, "nodes": nodes, "edges": edges,
        "stats": {
            "equipment": len(eq), "links": len(edges),
            "by_arrow": sum(1 for e in edges if e["dir_by"] == "arrow"),
            "by_item_no": sum(1 for e in edges if e["dir_by"] == "item_no"),
            "splits": sum(1 for n in nodes if n["role"] == "分流點"),
            "merges": sum(1 for n in nodes if n["role"] == "匯流點"),
            "starts": sum(1 for n in nodes if n["role"] == "起點"),
            "ends": sum(1 for n in nodes if n["role"] == "終點"),
            "isolated": sum(1 for n in nodes if n["role"] == "孤立"),
            "cycles": cyc,
        },
    }
