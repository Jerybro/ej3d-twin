# P&ID 中性拓撲模型 — L1 圖譜層
#
# 解耦動機（技術文件 P0）：原本 3D 生成器與標示化工具共用 extract_pipes，
# 但那個函式的 PIPE_MIN_LEN=60pt 是為 3D 建模調的，會把閥件所在的短支管
# 全濾掉（實測 10 顆閥只有 1 顆判得到管線）。標示化工具因此繞過它另開
# page_segments 平行路徑——那是症狀處理。
#
# 正解是讓 pid_parse 產出**中性**拓撲，3D 生成器與標示化工具各自消費、
# 各自套用自己的過濾門檻，誰也不用繞過誰：
#
#   page_segments() ─→ build_graph() ─→ PlantGraph
#                                        ├→ 3D 生成器（自行套 PIPE_MIN_LEN）
#                                        └→ 標示化工具（用完整圖）
from __future__ import annotations

import math
from pathlib import Path

# 端點合併容差（pt）。CAD 線段端點常差零點幾點，太嚴會把該連的斷開、
# 太鬆會把平行管誤併。1.5pt 為起手值，換廠請用真圖標定。
TOL_JOIN = 1.5


def _key(p: tuple, tol: float | None = None) -> tuple:
    """座標量化成格點鍵，供端點合併。

    tol 預設 None 而非直接寫 TOL_JOIN——預設參數在函式定義時就求值，
    寫死會導致之後調整 TOL_JOIN 完全沒作用（標定時踩過這個坑）。
    """
    t = TOL_JOIN if tol is None else tol
    return (round(p[0] / t), round(p[1] / t))


# 進圖的最小線段長（pt）。本廠 CAD 把文字曲線化，字形筆劃也是折線，
# 不濾掉會讓圖被上千段字形碎片灌爆（實測 5544 段中大量為字形）。
# 這個門檻只擋字形，遠低於 3D 用的 PIPE_MIN_LEN=60——中性模型不該
# 套用任何單一消費端的視覺門檻。
SEG_MIN_LEN = 6.0


def build_graph(pdf_path: Path, min_len: float = SEG_MIN_LEN):
    """線段端點合併 → networkx 幾何圖（頂點＝接點，邊＝管段）。

    這只是 L1 的骨架：把「一堆線段」變成「有連通性的圖」。
    元件插入（閥切邊）、設備接管、儀錶關聯、控制迴路分群依序疊在其上。
    """
    import networkx as nx

    from .pid_parse import page_segments

    segs, arcs, pw, ph = page_segments(pdf_path, with_arcs=True)

    G = nx.MultiGraph()
    G.graph.update({"pw": pw, "ph": ph, "jumps": arcs})
    for a, b in segs:
        if math.dist(a, b) < min_len:
            continue                     # 字形筆劃等碎片
        ka, kb = _key(a), _key(b)
        if ka == kb:
            continue                     # 零長度
        for k, p in ((ka, a), (kb, b)):
            if k not in G:
                G.add_node(k, pos=p, kind="junction")
        G.add_edge(ka, kb, length=math.dist(a, b), kind="segment",
                   pts=(a, b))
    return G


def insert_valves(G, valves: list) -> dict:
    """把閥件插進圖裡——不是「切開邊」，是「橋接缺口」。

    關鍵認知：CAD 插入閥符號時會把管線截斷讓符號嵌進去，所以閥件兩側是
    兩個懸空端而非一條完整的邊。先前用「最近管線距離」判歸屬只有 10%
    命中率，正是因為那個位置根本沒有線通過。

    作法：找閥件兩側的懸空端點，確認它們大致在閥的相對兩側（避免把
    垂直交錯的無關線頭接起來），再經由閥節點把兩端連起來。
    """
    import networkx as nx

    stat = {"bridged": 0, "orphan": 0}
    # 只考慮懸空端（度數 1）——管線中段不會被閥截斷
    ends = [(n, G.nodes[n]["pos"]) for n, d in G.degree() if d <= 2]
    for i, (vx, vy, size) in enumerate(valves):
        reach = max(size * 1.6, 12.0)
        near = [(n, p) for n, p in ends
                if abs(p[0] - vx) <= reach and abs(p[1] - vy) <= reach]
        if len(near) < 2:
            stat["orphan"] += 1
            continue
        # 挑一對「分居閥件兩側」的端點：兩者到閥心的方向要接近相反
        best = None
        for a in range(len(near)):
            for b in range(a + 1, len(near)):
                pa, pb = near[a][1], near[b][1]
                va = (pa[0] - vx, pa[1] - vy)
                vb = (pb[0] - vx, pb[1] - vy)
                na = math.hypot(*va)
                nb = math.hypot(*vb)
                if na < 0.1 or nb < 0.1:
                    continue
                cos = (va[0] * vb[0] + va[1] * vb[1]) / (na * nb)
                if cos > -0.65:            # 需接近反向（180°±50°）
                    continue
                score = abs(cos) - (na + nb) / (reach * 4)
                if best is None or score > best[0]:
                    best = (score, near[a][0], near[b][0])
        if best is None:
            stat["orphan"] += 1
            continue
        vnode = ("valve", i)
        G.add_node(vnode, pos=(vx, vy), kind="valve", size=size)
        G.add_edge(best[1], vnode, kind="through_valve")
        G.add_edge(vnode, best[2], kind="through_valve")
        stat["bridged"] += 1
    return stat


def jump_at(G, x: float, y: float, tol: float = 4.0) -> bool:
    """該交叉處是否有跳線弧 → 有的話兩條線是「跨過」而非「相接」。

    跳線判定錯一個，整個管網連通性就跟著錯，因此這是 L1 正確率的關鍵。
    本廠 CAD 把曲線轉成折線，所以跳線弧是折線近似而非 Bezier（實測整張圖
    0 個 Bezier 區段）——偵測要看折線弧，不能只看曲線指令。
    """
    for cx, cy, r, _chord in G.graph.get("jumps", []):
        if abs(cx - x) <= tol and abs(cy - y) <= tol:
            return True
    return False


def valves_on_run(G, node) -> list:
    """給定圖上任一節點，回傳同一連通管段內的所有閥件——
    「這條線上有幾顆閥」這個問題，有圖才答得出來。"""
    import networkx as nx

    if node not in G:
        return []
    comp = nx.node_connected_component(G, node)
    return [n for n in comp if G.nodes[n].get("kind") == "valve"]


def control_loops(tags: list) -> dict:
    """依 ISA 5.1 文法把位號分成控制迴路：同迴路號的 FT/FIC/FV 屬同一迴路。

    這一步完全靠標準文法，不需要任何視覺判讀——ISA 5.1 本身就是先驗知識。
    """
    import re

    loops: dict = {}
    for t in tags:
        m = re.match(r"^([A-Z]{1,5})[\s-]?(\d{3,6}[A-Z]?)$", (t or "").strip().upper())
        if not m:
            continue
        letters, num = m.group(1), m.group(2)
        loops.setdefault(num, {"members": [], "has_controller": False,
                               "has_transmitter": False, "has_element": False,
                               "has_valve": False})
        e = loops[num]
        e["members"].append(t)
        if "C" in letters[1:]:
            e["has_controller"] = True
        if letters.endswith("T"):
            e["has_transmitter"] = True
        if letters.endswith("E"):
            e["has_element"] = True
        if letters.endswith("V"):
            e["has_valve"] = True
    # 只留真正成迴路的（單一儀錶不算迴路）
    return {k: v for k, v in loops.items() if len(v["members"]) >= 2}


def stats(G) -> dict:
    """圖的基本統計，供驗收與回歸比對。"""
    import networkx as nx

    deg = [d for _, d in G.degree()]
    return {
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "components": nx.number_connected_components(G),
        "jumps": len(G.graph.get("jumps", [])),
        "deg_max": max(deg) if deg else 0,
        "deg_mean": round(sum(deg) / len(deg), 2) if deg else 0,
        "endpoints": sum(1 for d in deg if d == 1),      # 懸空端，一致性檢查用
        "tees": sum(1 for d in deg if d == 3),
        "crosses": sum(1 for d in deg if d >= 4),
    }
