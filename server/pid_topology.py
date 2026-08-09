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


def _key(p: tuple, tol: float = TOL_JOIN) -> tuple:
    """座標量化成格點鍵，供端點合併。"""
    return (round(p[0] / tol), round(p[1] / tol))


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
