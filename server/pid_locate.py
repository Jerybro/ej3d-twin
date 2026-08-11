# 設備定位器 — 項次號錨定＋圖形塊聚合
#
# 動機（2026-08-11 拍板）：潤泰清冊 50 列全部「未定位」——清冊早就知道
# 209 是捏和擠出機，缺的是「它在圖上哪裡」。所以這裡要解的不是
# 「認出這是什麼設備」（那是符號分類），是「找到它在圖上的框」。
#
# 為什麼不用符號模板或訓練模型：
#   ① 項次號本身就是最強的錨——設備一定畫在自己的編號旁邊
#   ② 潤泰的設備是斗昇機/螺運機/捏和擠出機這類複合圖形，手寫模板寫不完
#   ③ 沒有標註資料，訓不了偵測模型
# 幾何連通分量單獨也不行（實測 845 個分量、692 個是字形碎片）——
# 必須由錨點出發做區域成長，才知道該收哪些線。
from __future__ import annotations

import math
import re

# 項次號：3 碼數字，可帶 .N 或 -N 分項（204.1、210-1）
ITEM_RE = re.compile(r"^(\d{3})([.-]\d)?$")

# 區域成長參數（正規化座標，y 已依 aspect 校正成等比）
SEED_R = 0.012        # 種子半徑：錨點附近這麼近的線段先收進來
GROW_R = 0.055        # 成長上限：離錨點超過這麼遠就不再收（設備框的天花板）
LINK_TOL = 0.004      # 兩線段視為相連的端點距離
PIPE_LEN = 0.05       # 超過這個長度視為管線幹管，不併入設備塊（但可當連接）
MIN_SEGS = 3          # 少於這麼多線段的塊不算設備（多半是註記引線）


def _d(ax: float, ay: float, bx: float, by: float, aspect: float) -> float:
    """等比距離：正規化座標的 y 要乘 aspect 才跟 x 同尺度。"""
    return math.hypot(bx - ax, (by - ay) * aspect)


def find_item_anchors(texts: list) -> list:
    """OCR 文字層 → 項次號錨點 [(x, y, tag)]。"""
    out = []
    for t in texts:
        s = str(t[2]).strip()
        if ITEM_RE.match(s):
            out.append((float(t[0]), float(t[1]), s))
    return out


def _digits(s: str) -> str:
    """只留數字骨架，並修 OCR 常見字元混淆。

    設備項次號的小數點在圖上很小，OCR 幾乎必吃：實測 204.1→「2044」、
    313.3→「3133」、212→「212-」。開放式比對抓不到這些，但**清冊已經
    告訴我們哪些項次號存在**——反過來拿它去圖上找，就從「認出未知」
    變成「確認已知」，難度差一個量級。
    """
    s = str(s).strip().upper()
    for a, b in (("O", "0"), ("I", "1"), ("L", "1"), ("S", "5"), ("B", "8")):
        s = s.replace(a, b)
    return re.sub(r"[^0-9]", "", s)


def registry_guided_anchors(texts: list, registry_rows: list,
                            already: set) -> list:
    """清冊導向的第二輪：拿還沒定位的清冊項次號回頭去圖上找。

    回傳 [(x, y, tag, ocr_raw)]，tag 用**清冊的正式寫法**（204.1 而非 2044），
    這樣配對與台帳都對得起來。
    """
    idx: dict = {}
    for t in texts:
        n = _digits(t[2])
        if 3 <= len(n) <= 5:
            idx.setdefault(n, []).append((float(t[0]), float(t[1]), str(t[2])))
    out = []
    for row in registry_rows:
        item = row.get("item", "")
        if not item or item in already:
            continue
        for cand in idx.get(_digits(item), []):
            out.append((cand[0], cand[1], item, cand[2]))
    return out


def detect_table_column(anchors: list, pipes: list, aspect: float,
                        tol: float = 0.008) -> tuple:
    """找出設備清單表的 ITEM 欄 → (x 位置, 該欄錨點集合的索引)。

    實測潤泰：清單表的項次號全部落在同一條垂直線（x≈0.741）且**周圍沒有
    任何向量線段**——因為那是表格文字，不是圖面上的設備。這兩個條件
    合起來是很乾淨的判別器：把整欄一次排除，比逐個猜「這是不是誤讀」可靠。
    """
    dead = []                      # 周圍無線段的錨點
    for i, (ax, ay, _t) in enumerate(anchors):
        near = sum(1 for p in pipes
                   if _d(ax, ay, (p[0] + p[2]) / 2, (p[1] + p[3]) / 2, aspect) < 0.03)
        if near <= 1:
            dead.append((ax, i))
    if len(dead) < 5:
        return (None, set())
    # 這些死錨點是否共用同一個 x（表格欄的特徵）
    dead.sort()
    best_x, best_idx = None, set()
    for cx, _ in dead:
        grp = {i for x, i in dead if abs(x - cx) <= tol}
        if len(grp) > len(best_idx):
            best_x, best_idx = cx, grp
    return (best_x, best_idx) if len(best_idx) >= 5 else (None, set())


def _seg_dist(p, q, aspect: float) -> float:
    """兩線段最短距離（端點對線段，四向取小）。

    不能只比端點：CAD 的輪廓線常有零點幾 pt 的縫，或是一條線的端點
    落在另一條的中段（T 接）。嚴格端點相接會讓整個設備輪廓接不起來
    （實測 213/302 半徑內有 30~40 條線卻長不出塊，就是這個原因）。
    """
    def pt_seg(px, py, x0, y0, x1, y1):
        dx, dy = (x1 - x0), (y1 - y0) * aspect
        if dx == 0 and dy == 0:
            return _d(px, py, x0, y0, aspect)
        t = ((px - x0) * dx + (py - y0) * aspect * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        return _d(px, py, x0 + t * (x1 - x0), y0 + t * (y1 - y0), aspect)

    return min(pt_seg(p[0], p[1], *q[:4]), pt_seg(p[2], p[3], *q[:4]),
               pt_seg(q[0], q[1], *p[:4]), pt_seg(q[2], q[3], *p[:4]))


def grow_block(ax: float, ay: float, pipes: list, aspect: float,
               pipe_len: float = PIPE_LEN) -> dict | None:
    """從錨點長出設備圖形塊 → {bbox, n_segs, relaxed}。

    區域成長而非固定半徑框：先收錨點附近的種子線段，再沿著「彼此夠近」
    往外擴，遇到長幹管就停（那是離開設備的管線，不是輪廓）。
    固定半徑會把鄰居設備和路過的管線一起框進來，區域成長不會。

    長設備（帶運機、輸送機）的輪廓線本來就長，會被 pipe_len 濾掉——
    所以呼叫端在第一輪失敗時會用放寬的 pipe_len 重試一次（見 locate_equipment）。
    """
    cand = []
    for p in pipes:
        L = _d(p[0], p[1], p[2], p[3], aspect)
        mx, my = (p[0] + p[2]) / 2, (p[1] + p[3]) / 2
        if _d(ax, ay, mx, my, aspect) > GROW_R:
            continue
        cand.append((p, L))
    if not cand:
        return None

    short = [(i, _d(ax, ay, (p[0] + p[2]) / 2, (p[1] + p[3]) / 2, aspect))
             for i, (p, L) in enumerate(cand) if L < pipe_len]
    if not short:
        return None
    picked = [i for i, dist in short if dist < SEED_R]
    if not picked:                       # 位號離設備稍遠 → 取最近的幾條當種子
        picked = [i for i, _ in sorted(short, key=lambda x: x[1])[:3]]

    chosen = set(picked)
    frontier = list(picked)
    while frontier:
        i = frontier.pop()
        pi = cand[i][0]
        for j, (pj, Lj) in enumerate(cand):
            if j in chosen or Lj >= pipe_len:
                continue
            if _seg_dist(pi, pj, aspect) < LINK_TOL:
                chosen.add(j)
                frontier.append(j)

    if len(chosen) < MIN_SEGS:
        return None
    xs, ys = [], []
    for i in chosen:
        p = cand[i][0]
        xs += [p[0], p[2]]
        ys += [p[1], p[3]]
    return {"bbox": [round(min(xs), 4), round(min(ys), 4),
                     round(max(xs), 4), round(max(ys), 4)],
            "n_segs": len(chosen), "relaxed": pipe_len > PIPE_LEN}


def locate_equipment(texts: list, pipes: list, aspect: float,
                     registry_rows: list | None = None,
                     match_fn=None) -> dict:
    """主流程：項次號 → 排除清單表欄 → 區域成長 → 配對清冊 → 候選清單。

    回傳的每一筆都是**候選**，帶證據鏈進審核佇列——與儀錶同一條規則，
    模型／幾何算出來的東西不會自己入庫。
    """
    anchors = find_item_anchors(texts)
    table_x, table_idx = detect_table_column(anchors, pipes, aspect)

    # 第一輪：圖面上直接讀到的項次號
    work = [(ax, ay, tag, "") for i, (ax, ay, tag) in enumerate(anchors)
            if i not in table_idx]
    # 第二輪：清冊裡還沒定位的，用數字骨架回頭找（OCR 吃掉小數點的救援）
    if registry_rows:
        got = {t for _x, _y, t, _r in work}
        for ax, ay, tag, raw in registry_guided_anchors(texts, registry_rows, got):
            if table_x is None or abs(ax - table_x) > 0.008:
                work.append((ax, ay, tag, raw))

    seen = {}
    for ax, ay, tag, raw in work:
        blk = grow_block(ax, ay, pipes, aspect)
        if not blk:
            # 長設備（帶運機／輸送機）的輪廓線本身就長，第一輪會被當管線濾掉。
            # 放寬長度門檻重試一次——成長半徑仍箝制框的大小，不會失控。
            blk = grow_block(ax, ay, pipes, aspect, pipe_len=0.13)
        if not blk:
            continue
        # 同一項次號出現多次（分項標註）→ 取線段最多的那個塊
        if tag in seen and seen[tag]["n_segs"] >= blk["n_segs"]:
            continue

        row = match_fn(tag, registry_rows) if (match_fn and registry_rows) else None
        w = blk["bbox"][2] - blk["bbox"][0]
        h = (blk["bbox"][3] - blk["bbox"][1]) * aspect
        ev = [
            {"stage": "項次號錨定", "ok": True, "score": 1.0,
             "detail": (f"圖面文字「{tag}」在 ({ax:.3f}, {ay:.3f})，以此為錨往外找設備輪廓"
                        if not raw else
                        f"清冊導向搜尋：清冊有「{tag}」，圖上 ({ax:.3f}, {ay:.3f}) "
                        f"讀到「{raw}」數字骨架相符（小數點常被 OCR 吃掉），以此為錨")},
            {"stage": "圖形塊區域成長", "ok": True,
             "score": min(1.0, blk["n_segs"] / 12),
             "detail": f"由錨點沿相鄰線段擴出 {blk['n_segs']} 段輪廓線，"
                       f"框約 {w:.3f}×{h:.3f}（遇長幹管即停，不併入路過的管線）"
                       + ("｜此項用放寬門檻才長出（長型設備如帶運機），"
                          "框範圍請特別確認" if blk.get("relaxed") else "")},
        ]
        if table_x is not None:
            ev.append({"stage": "清單表排除", "ok": True, "score": 1.0,
                       "detail": f"已排除 x≈{table_x:.3f} 的清單表欄位文字"
                                 f"（{len(table_idx)} 筆），本項在圖面區域內"})
        if registry_rows:
            ev.append({"stage": "設備清冊對照", "ok": bool(row),
                       "score": 1.0 if row else 0.3,
                       "detail": (f"對到清冊「{row.get('name', '')}」"
                                  f"{('｜' + row['spec']) if row.get('spec') else ''}"
                                  if row else "清冊中查無此項次號——可能是清冊續頁"
                                              "或圖上另一區的設備，請人工確認")})
        seen[tag] = {
            "tag": tag, "kind": "equipment",
            "symbol": (row.get("name") if row else "") or "設備（待確認類型）",
            "note": "", "mounting": "", "mount_conf": 0.0,
            "confidence": round(min(0.95, 0.45 + blk["n_segs"] * 0.04), 2),
            "bbox": blk["bbox"], "n_segs": blk["n_segs"],
            "registry_item": row.get("item") if row else "",
            "evidence": ev, "source": "定位器",
        }
        if not row:
            seen[tag]["warn"] = "清冊中查無此項次號，請確認是否為其他系統的設備"
    items = sorted(seen.values(), key=lambda x: x["tag"])
    n_reg = len(registry_rows or [])
    covered = len({i["registry_item"] for i in items if i["registry_item"]})
    return {"items": items,
            "stats": {"anchors": len(anchors), "table_excluded": len(table_idx),
                      "located": len(items), "registry_rows": n_reg,
                      "registry_located": covered,
                      "matched": sum(1 for i in items if i["registry_item"])}}
