# P&ID 資產實體層 — 辨識的下一步：框框清單 → 型別化資產物件
#
# 定位（Stage 2 的 L0/L1）：審核通過的標註不該只是一筆筆「bbox＋文字」，
# 而是帶屬性、帶出處、掛上拓撲的資產物件——
#
#   valve      位號?｜尺寸 2"｜狀態 NC｜口徑 FB｜是否接上管網
#   instrument 位號｜ISA 語意｜安裝別｜控制迴路
#   equipment  項次/位號｜名稱規格（PFD 走設備清冊 join）
#   pipe_line  管線編號四段式（尺寸-流體-序號-規格）
#
# 兩條鐵則沿用人工驗證關卡：
#   1. 實體只從「已確認」標註產生——模型輸出不會自己變成資產
#   2. 機器推定的屬性（尺寸、狀態、掛線）一律標注出處與依據，
#      工程師看得到「這個 2" 是從哪裡讀來的」，錯了才改得動
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/pid/model", tags=["pid-model"])

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_DIR = BASE_DIR / "data" / "pid_model"
REGISTRY_DIR = BASE_DIR / "data" / "pid_registry"


# ------------------------------------------------------------- 管線編號解析
# 業界慣例四～五段式：尺寸"-流體代碼-序號-管線等級(-順序號)
# 例：2"-DC-572009-ED200-4、6"-PL-202001。OCR 常把 " 讀成 ''、”、`，
# 破折號也可能黏字，所以分隔全部放寬。
LINE_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*[\"”“'`]{0,2}\s*-\s*"      # 尺寸
    r"([A-Z]{1,4})\s*-\s*"                          # 流體/服務代碼
    r"(\d{4,6})"                                    # 管線序號
    r"(?:\s*-\s*([A-Z]{1,3}\d{2,4}[A-Z0-9]*))?"     # 管線等級（選配）
    r"(?:\s*-\s*(\d{1,2}))?")                       # 順序號（選配）

# 閥件鄰近屬性的詞彙。NC/NO＝常閉/常開、FC/FO＝失效閉/開、
# LO/LC＝鎖開/鎖閉、FB/RB＝全口徑/縮口徑。
STATE_RE = re.compile(r"^(NC|NO|FC|FO|LO|LC)$")
BORE_RE = re.compile(r"^(FB|RB)$")
SIZE_RE = re.compile(r"^[øΦ]?\s*(\d+(?:\.\d+)?)\s*[\"”“'`x×]")


def _parse_line_no(text: str) -> dict | None:
    m = LINE_RE.search((text or "").upper())
    if not m:
        return None
    size, svc, num, spec, seq = m.groups()
    return {"raw": m.group(0), "size_in": float(size), "service": svc,
            "number": num, "spec": spec or "", "seq": seq or ""}


# ------------------------------------------------------------------ 小工具
def _num_key(s: str) -> tuple:
    """項次號排序/比較鍵：'204.4'→(204,4)、'210-1'→(210,1)。
    清冊的連號範圍（204.4~204.6）要能涵蓋掃描抓到的 204.5，
    純字串比對做不到，得轉數值元組。"""
    parts = re.findall(r"\d+", s or "")
    return tuple(int(p) for p in parts) if parts else (0,)


def _registry_of(filename: str) -> dict | None:
    p = REGISTRY_DIR / f"{Path(filename).stem}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _registry_match(item_no: str, rows: list) -> dict | None:
    """掃描項次號對回清冊列：先精確、再落入連號範圍（204.4~204.6 涵蓋 204.5）。"""
    for r in rows:
        if r.get("item") == item_no:
            return r
    k = _num_key(item_no)
    for r in rows:
        rng = r.get("range") or ""
        if "~" not in rng:
            continue
        lo, hi = (x.strip() for x in rng.split("~", 1))
        if _num_key(lo) <= k <= _num_key(hi):
            return r
    return None


def _load_hits(filename: str) -> tuple[list, float, float]:
    """整頁 OCR 命中（scan_all 落地的快取；沒有就現場重跑一次）。"""
    from .pid_vlm import VLM_DIR, _ocr_region, _slug

    hp = VLM_DIR / f"{_slug(Path(filename).stem)}.hits.json"
    if hp.exists():
        try:
            d = json.loads(hp.read_text(encoding="utf-8"))
            return d["hits"], d["w"], d["h"]
        except (json.JSONDecodeError, OSError, KeyError):
            pass
    # 快取缺失 → 與 scan_all 同參數重掃（約 30 秒，只發生在冷啟動）
    TC, TR, OV = 4, 3, 0.06
    hits: list = []
    W = H = 0.0
    for r in range(TR):
        for c in range(TC):
            box = [max(0.0, c / TC - OV), max(0.0, r / TR - OV),
                   min(1.0, (c + 1) / TC + OV), min(1.0, (r + 1) / TR + OV)]
            try:
                h, (W, H) = _ocr_region(filename, box)
                hits += h
            except Exception:  # noqa: BLE001
                continue
    return hits, W, H


def _size_candidate(t: str) -> tuple[str, float] | None:
    """文字 → (尺寸值, 罰分 0~1)。

    吋標「"」在 OCR 常整個消失或誤讀（實測台化：2"→「2」、3/4"→「3/49」「3/4P」），
    只認帶引號的會全軍覆沒。所以分三級收：帶吋標最可信、分數次之、
    裸數字罰分最高——罰分換算成距離加成，愈不確定的形式要愈貼近閥件才採信。
    """
    m = SIZE_RE.match(t)
    if m:
        return m.group(1) + '"', 0.0
    # 3/4"→「3/49」：尾碼 9 是誤讀的引號。管徑分母只有 2/4/8/16，
    # 限制住才不會把誤讀尾碼吃進分母（3/49 要斷成 3/4，不是 3/49）
    m = re.match(r"^(\d{1,2}/(?:16|2|4|8))", t)
    if m:
        return m.group(1) + '"', 0.15
    m = re.match(r"^(\d{1,2})P?$", t)                # 2"→「2」；管徑不會超過 24
    if m and int(m.group(1)) <= 24:
        return m.group(1) + '"', 0.35
    return None


def _near_attrs(cx: float, cy: float, hits: list, radius: float) -> dict:
    """讀元件鄰近的標註文字 → 尺寸/狀態/口徑屬性，各自帶出處。

    圖面慣例：閥件的 2"、NC、FB 就寫在符號旁邊。屬性取「加權最近的一個」，
    並記下讀到的原文與距離——機器推定要能被人一眼查證。
    """
    out: dict = {}
    best: dict = {}
    for hx, hy, text, _cf, _hh in hits:
        d = math.hypot(hx - cx, hy - cy)
        if d > radius:
            continue
        t = (text or "").strip().upper().replace(" ", "")
        for key, rx in (("state", STATE_RE), ("bore", BORE_RE)):
            m = rx.match(t)
            if m and (key not in best or d < best[key][0]):
                best[key] = (d, m.group(1), text.strip(), 0.0, d)
        c = _size_candidate(t)
        if c:
            val, pen = c
            score = d + pen * radius
            if "size" not in best or score < best["size"][0]:
                best["size"] = (score, val, text.strip(), pen, d)
    for key, (_s, val, raw, pen, d) in best.items():
        out[key] = val
        out[f"{key}_src"] = (f"鄰近文字「{raw}」（距 {int(d)}px）"
                             + ("；吋標疑被 OCR 吃掉，請覆核" if pen > 0 else ""))
    return out


def _hi_texts(filename: str) -> list:
    """高解析度 OCR 補讀（快取）→ [[nx, ny, text, nh], ...]。

    設備項次號（204.1、313.5）字比儀錶位號小，主掃描的 4×3／1900px
    讀不到——實測潤泰有 13 個清冊項次號在圖上完全沒被讀出來。
    這裡用 6×4／2600px 再掃一次，只花 ~28 秒，撈回 9 筆。
    分兩支而不是直接調高主掃描：主掃描的參數是為位號審核流校過的，
    不該為了設備定位去動它。
    """
    from .pid_vlm import VLM_DIR, _ensure_base, _slug

    cache = VLM_DIR / f"{_slug(Path(filename).stem)}.hits-hi.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    try:
        import numpy as np
        from PIL import Image

        from .pid_parse import OCR_LOCK, _get_reader

        img_p, meta = _ensure_base(filename)
        W, H = meta["w"], meta["h"]
        out: list = []
        TC, TR, OV = 6, 4, 0.04
        with OCR_LOCK, Image.open(img_p) as im:
            reader = _get_reader()
            for r in range(TR):
                for c in range(TC):
                    x0 = int(max(0.0, c / TC - OV) * W)
                    y0 = int(max(0.0, r / TR - OV) * H)
                    x1 = int(min(1.0, (c + 1) / TC + OV) * W)
                    y1 = int(min(1.0, (r + 1) / TR + OV) * H)
                    crop = im.crop((x0, y0, x1, y1)).convert("RGB")
                    k = max(1.0, 2600 / crop.width)
                    if k > 1:
                        crop = crop.resize((int(crop.width * k),
                                            int(crop.height * k)), Image.LANCZOS)
                    try:
                        res = reader.readtext(np.array(crop), text_threshold=0.5,
                                              low_text=0.28)
                    except Exception:  # noqa: BLE001
                        continue
                    for box, text, conf in res:
                        t = str(text).strip()
                        if conf < 0.3 or not t:
                            continue
                        xs = [p[0] / k for p in box]
                        ys = [p[1] / k for p in box]
                        cx = (min(xs) + max(xs)) / 2 + x0
                        cy = (min(ys) + max(ys)) / 2 + y0
                        hh = (max(ys) - min(ys)) / 2
                        out.append([round(cx / W, 4), round(cy / H, 4), t,
                                    round(hh / H, 4)])
        seen: set = set()
        ded: list = []
        for e in out:
            key = (e[2], round(e[0], 2), round(e[1], 2))
            if key in seen:
                continue
            seen.add(key)
            ded.append(e)
        cache.write_text(json.dumps(ded, ensure_ascii=False), encoding="utf-8")
        return ded
    except Exception:  # noqa: BLE001
        return []


def _vert_texts(filename: str) -> list:
    """直式文字補讀（快取）→ [[nx, ny, text, nh, 90], ...]。

    左右圖緣的管線標示（14P 6029 E4B2(H)）沿管線豎排，水平 OCR 完全
    看不見——不是讀錯，是根本不在偵測結果裡。這輪用 rotation_info
    重掃，只收「瘦高框」的命中（寬高比 >1.5），渲染時轉 90° 畫回去。
    """
    from .pid_vlm import VLM_DIR, _ensure_base, _slug

    cache = VLM_DIR / f"{_slug(Path(filename).stem)}.hits-vert.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    try:
        import numpy as np
        from PIL import Image

        from .pid_parse import OCR_LOCK, _get_reader

        img_p, meta = _ensure_base(filename)
        W, H = meta["w"], meta["h"]
        out: list = []
        TC, TR, OV = 3, 2, 0.04
        with OCR_LOCK, Image.open(img_p) as im:
            reader = _get_reader()
            for r in range(TR):
                for c in range(TC):
                    x0 = int(max(0.0, c / TC - OV) * W)
                    y0 = int(max(0.0, r / TR - OV) * H)
                    x1 = int(min(1.0, (c + 1) / TC + OV) * W)
                    y1 = int(min(1.0, (r + 1) / TR + OV) * H)
                    crop = im.crop((x0, y0, x1, y1)).convert("RGB")
                    k = max(1.0, 1900 / crop.width)
                    if k > 1:
                        crop = crop.resize((int(crop.width * k),
                                            int(crop.height * k)), Image.LANCZOS)
                    try:
                        res = reader.readtext(np.array(crop),
                                              rotation_info=[90, 270],
                                              text_threshold=0.55, low_text=0.3)
                    except TypeError:      # 舊版 easyocr 無 rotation_info
                        return []
                    except Exception:  # noqa: BLE001
                        continue
                    for box, text, conf in res:
                        t = str(text).strip()
                        if conf < 0.35 or len(t) < 3:
                            continue
                        xs = [p[0] / k for p in box]
                        ys = [p[1] / k for p in box]
                        bw, bh = max(xs) - min(xs), max(ys) - min(ys)
                        if bh < bw * 1.5:          # 只收直式（瘦高框）
                            continue
                        cx = (min(xs) + max(xs)) / 2 + x0
                        cy = (min(ys) + max(ys)) / 2 + y0
                        # 直式文字的「字高」是框的寬度
                        out.append([round(cx / W, 4), round(cy / H, 4), t,
                                    round(bw / 2 / H, 4), 90])
        seen: set = set()
        ded: list = []
        for e in out:
            key = (e[2], round(e[0], 2), round(e[1], 2))
            if key in seen:
                continue
            seen.add(key)
            ded.append(e)
        cache.write_text(json.dumps(ded, ensure_ascii=False), encoding="utf-8")
        return ded
    except Exception:  # noqa: BLE001
        return []


def _zh_texts(filename: str) -> list:
    """中文註記補讀（結果落地快取）→ [[nx, ny, text, nh], ...]，僅收含 CJK 的命中。

    英文 reader 把中文註記讀成亂碼字串（note 1-4 實測全滅）。這裡用
    繁中＋英雙語 reader 對整頁補讀一次，只取含中文字的結果——
    位號辨識照舊走英文主 reader，準確率不受影響。
    首次呼叫需下載繁中模型＋整頁推論（約 1 分鐘），之後走快取。
    """
    from .pid_vlm import VLM_DIR, _ensure_base, _slug

    cache = VLM_DIR / f"{_slug(Path(filename).stem)}.hits-zh.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    try:
        import numpy as np
        from PIL import Image

        from .pid_parse import OCR_LOCK, _get_zh_reader

        img_p, meta = _ensure_base(filename)
        W, H = meta["w"], meta["h"]
        out: list = []
        TC, TR, OV = 3, 2, 0.04
        with OCR_LOCK, Image.open(img_p) as im:
            reader = _get_zh_reader()
            for r in range(TR):
                for c in range(TC):
                    x0 = int(max(0.0, c / TC - OV) * W)
                    y0 = int(max(0.0, r / TR - OV) * H)
                    x1 = int(min(1.0, (c + 1) / TC + OV) * W)
                    y1 = int(min(1.0, (r + 1) / TR + OV) * H)
                    crop = im.crop((x0, y0, x1, y1)).convert("RGB")
                    k = max(1.0, 1900 / crop.width)
                    if k > 1:
                        crop = crop.resize((int(crop.width * k),
                                            int(crop.height * k)), Image.LANCZOS)
                    try:
                        res = reader.readtext(np.array(crop),
                                              text_threshold=0.55, low_text=0.3)
                    except Exception:  # noqa: BLE001
                        continue
                    for box, text, conf in res:
                        if conf < 0.3 or not re.search(r"[一-鿿]", text):
                            continue
                        xs = [p[0] / k for p in box]
                        ys = [p[1] / k for p in box]
                        cx = (min(xs) + max(xs)) / 2 + x0
                        cy = (min(ys) + max(ys)) / 2 + y0
                        hh = (max(ys) - min(ys)) / 2
                        out.append([round(cx / W, 4), round(cy / H, 4),
                                    text.strip(), round(hh / H, 4)])
        # tile 重疊去重
        seen: set = set()
        ded: list = []
        for e in out:
            key = (e[2], round(e[0], 2), round(e[1], 2))
            if key in seen:
                continue
            seen.add(key)
            ded.append(e)
        cache.write_text(json.dumps(ded, ensure_ascii=False), encoding="utf-8")
        return ded
    except Exception:  # noqa: BLE001
        return []


# ------------------------------------------------------------------- 建模
def build_model(filename: str) -> dict:
    """把「已確認標註＋清冊＋拓撲」編譯成資產模型並存檔。"""
    from datetime import datetime, timezone

    from .pid_topology import build_graph, control_loops, insert_valves, stats
    from .pid_vlm import _load_annots, _profile_of, _safe_pdf, _slug

    from .pid_vlm import _ensure_base

    pdf = _safe_pdf(filename)
    annots = _load_annots(filename)
    accepted = annots.get("items", [])
    n_reject = sum(1 for a in annots.get("audit", [])
                   if a.get("action") == "reject")
    is_pfd = _profile_of(filename) == "pfd.json"
    _, meta = _ensure_base(filename)

    hits, W, H = _load_hits(filename)

    # ---- 儀錶 ----
    instruments = []
    for a in accepted:
        if a.get("kind") != "instrument":
            continue
        tag = a.get("tag", "")
        m = re.search(r"(\d{3,6})[A-Z]?$", tag)
        instruments.append({
            "tag": tag, "function": a.get("symbol", ""),
            "mounting": a.get("mounting", ""), "loop": m.group(1) if m else "",
            "bbox": a.get("bbox"), "note": a.get("user_note", ""),
            "verified_by": a.get("verified_by", ""), "source": "審核確認",
        })

    # ---- 控制迴路（ISA 文法先驗，零視覺推論）----
    loops = control_loops([i["tag"] for i in instruments])

    # ---- 設備（PFD 走清冊 join；P&ID 走位號型別）----
    registry = _registry_of(filename)
    reg_rows = (registry or {}).get("items", [])
    # 註：定位器的候選在 texts / pipes 都齊之後才算得出來，見本函式尾段
    equipment = []
    seen_reg = set()
    for a in accepted:
        if a.get("kind") != "equipment":
            continue
        e = {"tag": a.get("tag", ""), "type": a.get("symbol", ""),
             "bbox": a.get("bbox"), "note": a.get("user_note", ""),
             "verified_by": a.get("verified_by", ""),
             "source": "審核確認", "on_drawing": True}
        # 審核者改過配對（L2）就以他選的為準——人工判斷凌駕自動比對
        picked = a.get("registry_item") or ""
        row = None
        if reg_rows:
            row = (next((r for r in reg_rows if r.get("item") == picked), None)
                   if picked else _registry_match(a.get("tag", ""), reg_rows))
        if row:
            seen_reg.add(row["item"])
            e.update({"name": row.get("name", ""), "spec": row.get("spec", ""),
                      "driver": row.get("driver", ""), "qty": row.get("qty"),
                      "remark": row.get("remark", ""), "vfd": row.get("vfd", False),
                      "source": "審核確認＋清冊"})
        equipment.append(e)
    # 清冊有、圖上未確認的也入庫——清冊本來就是圖面自帶的 L0 資料，
    # 缺的是「在圖上被點到」而非「不存在」
    for row in reg_rows:
        if row["item"] in seen_reg:
            continue
        equipment.append({
            "tag": row["item"], "type": "", "name": row.get("name", ""),
            "spec": row.get("spec", ""), "driver": row.get("driver", ""),
            "qty": row.get("qty"), "remark": row.get("remark", ""),
            "vfd": row.get("vfd", False), "bbox": None, "note": "",
            "verified_by": "", "source": "設備清冊", "on_drawing": False})
    equipment.sort(key=lambda e: _num_key(e["tag"]))

    # ---- 拓撲圖＋閥件掛線＋幾何層 ----
    # 幾何層（管線段座標）必須落進模型：盲測標準是「不看原圖、只讀這份
    # JSON 就能把圖重畫回來」。重建不出來的地方＝資料庫的洞。
    topo: dict = {"ok": False}
    vnodes: list = []           # [(norm_x, norm_y, component_id)]
    pipes: list = []            # [[u0, v0, u1, v1], ...] 正規化座標
    rot = meta.get("rot", 0)
    try:
        import networkx as nx

        from .pid_parse import detect_valves, pdf_to_norm

        pw0, ph0 = meta.get("pw", 0), meta.get("ph", 0)
        G = build_graph(pdf)
        raw_valves, pw, ph = detect_valves(pdf)
        bridge = insert_valves(G, raw_valves)
        comp_of = {}
        for ci, comp in enumerate(nx.connected_components(G)):
            for n in comp:
                comp_of[n] = ci
        for n, d in G.nodes(data=True):
            if d.get("kind") != "valve":
                continue
            x, y = d["pos"]
            u, v = pdf_to_norm(x, y, pw0 or pw, ph0 or ph, rot)
            vnodes.append((u, v, comp_of.get(n, -1)))
        topo = {"ok": True, "bridge": bridge, "stats": stats(G)}
    except Exception as exc:  # noqa: BLE001
        topo = {"ok": False, "reason": str(exc)[:200]}

    # 繪圖層線稿與拓撲**刻意分家**：拓撲要乾淨（page_segments 兩點段，
    # 折線會混入字形筆劃干擾閥件偵測）；重建要完整（styled_segments 折線拆解
    # ＋線寬/虛線樣式，否則帶轉角的管線消失、資訊層級被抹平）。
    styles: list = []            # [{"w": pt, "dash": bool}]
    try:
        from .pid_parse import pdf_to_norm, styled_segments

        raw_segs, pw2, ph2 = styled_segments(pdf)
        sidx: dict = {}
        for a, b, sw, dashed in raw_segs:
            if math.dist(a, b) < 4.0:   # 字形筆劃等碎屑；文字由 OCR 層負責
                continue
            key = (round(sw * 2) / 2, bool(dashed))
            if key not in sidx:
                sidx[key] = len(styles)
                styles.append({"w": key[0], "dash": key[1]})
            u0, v0 = pdf_to_norm(a[0], a[1], pw2, ph2, rot)
            u1, v1 = pdf_to_norm(b[0], b[1], pw2, ph2, rot)
            pipes.append([round(u0, 4), round(v0, 4), round(u1, 4),
                          round(v1, 4), sidx[key]])
    except Exception:  # noqa: BLE001
        pass

    # 流向箭頭：實心小三角形＋方向角。有方向的管線才是製程流程。
    arrows: list = []
    try:
        from .pid_parse import detect_arrows, pdf_to_norm

        raw_ar, pwa, pha = detect_arrows(pdf)
        for ax, ay, ang in raw_ar:
            u, v = pdf_to_norm(ax, ay, pwa, pha, rot)
            # 旋轉圖面時角度也要跟著轉（pdf_to_norm 只轉座標）
            aa = ang
            if rot == 90:
                aa = ang - 90
            elif rot == 180:
                aa = ang + 180
            elif rot == 270:
                aa = ang + 90
            # PDF Y 軸朝上、影像 Y 軸朝下 → 角度取負
            arrows.append([round(u, 4), round(v, 4), round(-aa % 360, 1)])
    except Exception:  # noqa: BLE001
        pass

    # OCR 文字層：管線編號、註記、設備名——命中本來就在快取裡，
    # 不進模型等於白掃。tile 重疊會產生重複命中，以（文字＋粗位置）去重。
    texts: list = []
    if hits and W:
        seen_t = set()
        for hx, hy, t, _cf, hh in hits:
            key = (t, round(hx / W, 2), round(hy / H, 2))
            if key in seen_t or not str(t).strip():
                continue
            seen_t.add(key)
            texts.append([round(hx / W, 4), round(hy / H, 4), str(t).strip(),
                          round(hh / H, 4)])
    # 中文註記補讀：英文 reader 會把 note 1-4 讀成亂碼。中文命中蓋掉
    # 同位置的英文亂碼，其餘位置維持英文結果（位號辨識不受影響）。
    zh = _zh_texts(filename)
    if zh:
        kept = []
        for e in texts:
            garbage = any(abs(e[1] - z[1]) < z[3] * 1.5
                          and abs(e[0] - z[0]) < max(len(z[2]), 2) * z[3] * 1.2
                          for z in zh)
            if not garbage:
                kept.append(e)
        texts = kept + zh
    # 直式文字補讀：左右圖緣的豎排管線標示，水平 OCR 看不見
    texts += _vert_texts(filename)
    # 高解析補讀：設備項次號字太小，主掃描讀不到（PFD 設備定位的關鍵來源）
    have = {(e[2], round(e[0], 2), round(e[1], 2)) for e in texts}
    texts += [e for e in _hi_texts(filename)
              if (e[2], round(e[0], 2), round(e[1], 2)) not in have]

    # OPC 跨圖接續角旗：070-2/01＝去 C12070-2 圖第 01 接點。
    # 這是跨圖串接（pid_linkset）的圖面端證據，建模時一併實體化。
    opcs: list = []
    _opc_re = re.compile(r"(\d{2,4}-\d{1,2})/(\d{1,2}[A-Z]?)")
    for tx, ty, txt, th, *_ in texts:
        mm = _opc_re.search(str(txt).replace(" ", ""))
        if mm:
            opcs.append({"code": mm.group(0), "target_dwg": mm.group(1),
                         "point": mm.group(2), "x": tx, "y": ty, "h": th,
                         "source": "OCR（系統推定）"})

    # 儀錶氣泡幾何層：實測圓心＋半徑＋形狀（圓/六角/DCS 方框）。
    # 已審儀錶對位到最近氣泡後用真實幾何畫；沒對上的畫空圈——
    # 「這裡有儀錶還沒審」直接顯示在重建圖上，盲測圖同時是待辦地圖。
    try:
        from .pid_vlm import _bubbles_norm

        bubbles = []
        for bx, by, rx, ry, shape in _bubbles_norm(filename):
            # 方框誤判源多（表格欄位、小設備框）——框內要有文字才收
            if shape == "square" and not any(
                    abs(tx - bx) < rx and abs(ty - by) < ry
                    for tx, ty, _t, _h, *_ in texts):
                continue
            bubbles.append([round(bx, 4), round(by, 4), round(rx, 4),
                            round(ry, 4), shape])
    except Exception:  # noqa: BLE001
        bubbles = []

    # ---- 閥件（已確認者），屬性充實＋掛線 ----
    valves = []
    vi = 0
    for a in accepted:
        if a.get("kind") != "valve":
            continue
        vi += 1
        b = a.get("bbox") or [0, 0, 0, 0]
        cxn, cyn = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        v = {"id": f"V{vi:02d}", "bbox": b, "note": a.get("user_note", ""),
             "verified_by": a.get("verified_by", ""), "source": "審核確認",
             "net": None}
        # 屬性充實：閥旁的 2"、NC、FB（搜尋半徑＝框寬 4 倍）
        if hits and W:
            r = max((b[2] - b[0]) * W, 30) * 4
            v.update(_near_attrs(cxn * W, cyn * H, hits, r))
        # 拓撲配對：最近的閥節點（正規化距離 < 0.01 才算同一顆）
        bestd, bestc = 1e9, None
        for u, vv, ci in vnodes:
            d = math.hypot(u - cxn, vv - cyn)
            if d < bestd:
                bestd, bestc = d, ci
        if bestc is not None and bestd < 0.01:
            v["net"] = bestc
        valves.append(v)

    # ---- 管線編號（整頁 OCR 撈四段式字串；同號去重取高信心）----
    lines: dict = {}
    for hx, hy, text, cf, hh in hits:
        p = _parse_line_no(text)
        if not p:
            continue
        key = f"{p['service']}-{p['number']}"
        if key not in lines or cf > lines[key]["conf"]:
            lines[key] = {**p, "conf": round(float(cf), 2),
                          "bbox": [round((hx - hh * 4) / W, 4),
                                   round((hy - hh) / H, 4),
                                   round((hx + hh * 4) / W, 4),
                                   round((hy + hh) / H, 4)] if W else None,
                          "source": "OCR（系統推定，未逐條審核）"}

    # ---- 設備定位器（PFD）：清冊有、圖上還沒審的，自動長出候選框 ----
    # 候選不入庫、只進審核佇列——與儀錶同一條人工驗證關卡。
    aspect = round(meta["h"] / meta["w"], 4) if meta.get("w") else 0.7
    locate = {"ok": False}
    try:
        from .pid_locate import locate_equipment

        loc = locate_equipment(texts, pipes, aspect, reg_rows, _registry_match)
        done = {a.get("tag") for a in accepted if a.get("kind") == "equipment"}
        loc["items"] = [i for i in loc["items"] if i["tag"] not in done]

        # 跨圖參照：本圖清冊查無的項次號，到同組其他圖的清冊找。
        # 「答案寫在下一張」是實際存在的情形（潤泰 500~508 在本張圖上，
        # 但清冊查無），找到就標成跨圖參照——那跟 OCR 誤讀是完全不同的事，
        # 前者要保留、後者要否決，審核者需要看得出差別。
        try:
            from .pid_group import crosssheet_lookup

            n_cross = 0
            for it in loc["items"]:
                if it.get("registry_item"):
                    continue
                hit = crosssheet_lookup(it["tag"], filename)
                if not hit:
                    continue
                n_cross += 1
                row = hit["row"]
                it["symbol"] = row.get("name") or it["symbol"]
                it["cross_sheet"] = hit["drawing"]
                it["warn"] = ""
                it["evidence"].append({
                    "stage": "跨圖清冊查找", "ok": True, "score": 0.85,
                    "detail": f"本圖清冊查無「{it['tag']}」，但同圖組的"
                              f"「{Path(hit['drawing']).stem}」清冊有此項"
                              f"（{row.get('name', '')}）→ 判定為跨圖參照，"
                              "不是誤讀"})
            if n_cross:
                loc["stats"]["cross_sheet"] = n_cross
        except Exception:  # noqa: BLE001
            pass
        # 已定位但尚未審核的清冊列 → 在資產庫顯示為「候選待審」而非「未定位」
        cand_of = {i["registry_item"]: i for i in loc["items"] if i["registry_item"]}
        for e in equipment:
            if e.get("bbox") is None and e["tag"] in cand_of:
                e["candidate_bbox"] = cand_of[e["tag"]]["bbox"]
                e["source"] = "設備清冊＋定位器候選（待審）"
        locate = {"ok": True, **loc["stats"], "items": loc["items"]}
    except Exception as exc:  # noqa: BLE001
        locate = {"ok": False, "reason": str(exc)[:200]}

    model = {
        "drawing": Path(filename).name,
        "profile": "pfd" if is_pfd else "isa-5.1",
        "built_at": datetime.now(timezone.utc).astimezone()
                    .isoformat(timespec="seconds"),
        "gate": {"accepted": len(accepted), "rejected": n_reject,
                 "rule": "實體只從已確認標註產生；清冊列與管線編號另標來源"},
        "equipment": equipment,
        "instruments": instruments,
        "valves": valves,
        "lines": sorted(lines.values(), key=lambda x: x["raw"]),
        "loops": [{"loop": k, **v} for k, v in sorted(loops.items())],
        "topology": topo,
        "opcs": opcs,
        "locate": locate,
        "geometry": {
            "aspect": aspect,
            "pipes": pipes,
            "pipe_styles": styles,
            "arrows": arrows,
            "valve_nodes": [[round(u, 4), round(v, 4), ci] for u, v, ci in vnodes],
            "texts": texts,
            "bubbles": bubbles,
            "note": "向量幾何層（系統推定）——盲測重建的骨架：線稿（含線寬/虛線"
                    "樣式）、流向箭頭、OCR 文字層（中英雙讀）、儀錶氣泡實測幾何"
                    "（含形狀）",
        },
        "stats": {
            "equipment": len(equipment),
            "equipment_on_drawing": sum(1 for e in equipment if e["on_drawing"]),
            "instruments": len(instruments), "valves": len(valves),
            "valves_on_net": sum(1 for v in valves if v["net"] is not None),
            "lines": len(lines), "loops": len(loops),
        },
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    (MODEL_DIR / f"{_slug(Path(filename).stem)}.json").write_text(
        json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    return model


# ------------------------------------------------------------ 盲測重建（SVG）
def _x(s: str) -> str:
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def _svg_of(m: dict) -> str:
    """只讀模型 JSON 把圖重畫回來——不碰 PDF、不碰底圖。

    這是資料庫完整度的驗收方式：重建圖與原圖並排，畫得出來的部分代表
    資料真的進了庫；畫不出來（缺文字、缺符號、缺連線）的部分就是洞，
    洞的清單就是下一輪工作的 backlog。
    """
    g = m.get("geometry") or {}
    W = 1600
    H = round(W * (g.get("aspect") or 0.7))
    # width/height 要明寫：只有 viewBox 的 SVG 在 <object>/<img> 裡
    # 會落到 300×150 的預設固有尺寸，版面撐不開
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
         f'width="{W}" height="{H}" font-family="Inter,Arial,sans-serif">',
         f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>']

    # 0) OCR 文字層（墊底）：管線編號、註記、設備名。灰色，蓋不過語意層。
    # 字級刻意壓小（×0.6、上限 13px）：OCR 的字高估計偏大，照畫會互疊成一片。
    # 重疊抑制：同一行常被讀成多個殘缺片段（標題欄實測疊成亂碼牆），
    # 長字串優先畫、蓋到已畫者跳過——留最完整的讀取，丟殘片。
    if g.get("texts"):
        drawn: list = []

        def _clash(r0) -> bool:
            for r1 in drawn:
                ix = min(r0[2], r1[2]) - max(r0[0], r1[0])
                iy = min(r0[3], r1[3]) - max(r0[1], r1[1])
                if ix <= 0 or iy <= 0:
                    continue
                a0 = (r0[2] - r0[0]) * (r0[3] - r0[1])
                a1 = (r1[2] - r1[0]) * (r1[3] - r1[1])
                if ix * iy > 0.4 * min(a0, a1):
                    return True
            return False

        p.append('<g opacity="0.78">')
        for e in sorted(g["texts"], key=lambda e: -len(str(e[2]))):
            tx, ty, txt, th = e[0], e[1], str(e[2]), e[3]
            rotv = e[4] if len(e) > 4 else 0
            fs = min(max(th * 2 * H * 0.6, 5.5), 13.0)
            wpx = max(len(txt), 1) * fs * 0.58
            x, y = tx * W, ty * H
            rect = ((x - fs * 0.6, y - wpx / 2, x + fs * 0.6, y + wpx / 2)
                    if rotv else
                    (x - wpx / 2, y - fs * 0.6, x + wpx / 2, y + fs * 0.6))
            if _clash(rect):
                continue
            drawn.append(rect)
            tr = f' transform="rotate(-90 {x:.0f} {y:.0f})"' if rotv else ""
            p.append(f'<text x="{x:.0f}" y="{y + fs * 0.35:.0f}" '
                     f'font-size="{fs:.1f}" fill="#9AA3AE" '
                     f'text-anchor="middle"{tr}>{_x(txt)}</text>')
        p.append('</g>')

    # 1) 線稿層：按樣式分組畫——粗細/虛實還原原圖的資訊層級
    #    （主管線粗、儀表信號細或虛；全畫同一種等於抹平圖面語言）
    style_defs = g.get("pipe_styles") or [{"w": 1.0, "dash": False}]
    grouped: dict = {}
    for seg_ in g.get("pipes", []):
        si = seg_[4] if len(seg_) > 4 else 0
        grouped.setdefault(si, []).append(seg_)
    scale_pt = W / 1190.0        # A1 橫幅約 1190pt → SVG px 換算
    for si, segs_ in grouped.items():
        st = style_defs[si] if si < len(style_defs) else {"w": 1.0, "dash": False}
        sw = min(max(float(st.get("w", 1.0)) * scale_pt, 0.7), 3.2)
        dash = ' stroke-dasharray="5 4"' if st.get("dash") else ""
        d = "".join(f"M{s[0] * W:.0f},{s[1] * H:.0f}L{s[2] * W:.0f},{s[3] * H:.0f}"
                    for s in segs_)
        p.append(f'<path d="{d}" stroke="#2A3441" stroke-width="{sw:.2f}" '
                 f'fill="none" stroke-linecap="round"{dash}/>')

    # 1b) 流向箭頭：實心三角，方向來自向量幾何
    for au, av, ang in g.get("arrows", []):
        x, y = au * W, av * H
        p.append(f'<g transform="rotate({ang:.1f} {x:.0f} {y:.0f})">'
                 f'<path d="M{x + 6:.0f},{y:.0f}L{x - 4:.0f},{y - 4:.0f}'
                 f'L{x - 4:.0f},{y + 4:.0f}Z" fill="#2A3441"/></g>')

    # 2) 閥件節點（拓撲層：蝴蝶結符號）
    for u, v, _ci in g.get("valve_nodes", []):
        x, y, s = u * W, v * H, 6
        p.append(f'<path d="M{x - s:.0f},{y - s:.0f}L{x + s:.0f},{y + s:.0f}'
                 f'L{x + s:.0f},{y - s:.0f}L{x - s:.0f},{y + s:.0f}Z" '
                 'fill="#fff" stroke="#6B7683" stroke-width="1.3"/>')

    # 3) 已確認閥件：accent 標記＋屬性
    for vv in m.get("valves", []):
        b = vv.get("bbox")
        if not b:
            continue
        x, y = (b[0] + b[2]) / 2 * W, (b[1] + b[3]) / 2 * H
        p.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="11" fill="none" '
                 'stroke="#046AFB" stroke-width="1.6"/>')
        lab = vv.get("id", "")
        if vv.get("size"):
            lab += f'　{vv["size"]}'
        p.append(f'<text x="{x:.0f}" y="{y + 24:.0f}" font-size="10" '
                 f'fill="#046AFB" text-anchor="middle">{_x(lab)}</text>')

    # 4) 儀錶氣泡：實測幾何＋形狀（圓/六角/DCS 方框）。已審者對位到
    #    最近氣泡；沒審到的畫灰圈——重建圖同時是「哪裡還沒審」的待辦地圖。
    bubs = g.get("bubbles", [])
    used_bub = set()

    def _bub_shape(cx: float, cy: float, r: float, shape: str,
                   stroke: str, dash: str = "") -> str:
        if shape == "square":
            s = r * 0.72
            return (f'<rect x="{cx - s:.0f}" y="{cy - s:.0f}" width="{s * 2:.0f}" '
                    f'height="{s * 2:.0f}" fill="#fff" stroke="{stroke}" '
                    f'stroke-width="1.4"{dash}/>')
        if shape == "hex":
            pts = " ".join(
                f"{cx + r * math.cos(math.radians(60 * k)):.0f},"
                f"{cy + r * math.sin(math.radians(60 * k)):.0f}" for k in range(6))
            return (f'<polygon points="{pts}" fill="#fff" stroke="{stroke}" '
                    f'stroke-width="1.4"{dash}/>')
        return (f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="#fff" '
                f'stroke="{stroke}" stroke-width="1.4"{dash}/>')

    def _nearest_bub(x: float, y: float):
        best, bi = None, -1
        for i, bb in enumerate(bubs):
            if i in used_bub:
                continue
            d = math.hypot(bb[0] - x, bb[1] - y)
            if d < max(bb[2] * 1.6, 0.01) and (best is None or d < best):
                best, bi = d, i
        return bi

    for it in m.get("instruments", []):
        b = it.get("bbox")
        if not b:
            continue
        x, y = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        bi = _nearest_bub(x, y)
        if bi >= 0:
            used_bub.add(bi)
            bb = bubs[bi]
            cx, cy, r = bb[0] * W, bb[1] * H, max(bb[2] * W, 11)
            shape = bb[4] if len(bb) > 4 else "circle"
        else:
            cx, cy = x * W, y * H
            r = max((b[3] - b[1]) * H * 0.95, 11)
            shape = "circle"
        mm = re.match(r"^([A-Z]+)(.*)$", it.get("tag", ""))
        top, bot = (mm.group(1), mm.group(2)) if mm else (it.get("tag", ""), "")
        fs = min(max(r * 0.42, 6.5), r * 0.9 / max(len(top), len(bot), 1) * 1.7)
        p.append(_bub_shape(cx, cy, r, shape, "#046AFB"))
        p.append(f'<text x="{cx:.0f}" y="{cy - r * 0.12:.0f}" font-size="{fs:.1f}" '
                 f'fill="#061027" text-anchor="middle" font-weight="600">{_x(top)}</text>')
        if bot:
            p.append(f'<text x="{cx:.0f}" y="{cy + r * 0.52:.0f}" font-size="{fs:.1f}" '
                     f'fill="#061027" text-anchor="middle">{_x(bot)}</text>')

    # 未審核的偵測氣泡：灰虛圈（審完會逐顆變藍）
    for i, bb in enumerate(bubs):
        if i in used_bub:
            continue
        shape = bb[4] if len(bb) > 4 else "circle"
        p.append(_bub_shape(bb[0] * W, bb[1] * H, max(bb[2] * W, 10), shape,
                            "#C3CAD2", ' stroke-dasharray="4 3"'))

    # 5) OPC 跨圖接續角旗：琥珀色旗形＋接續碼——這張圖跟誰相連
    for o in m.get("opcs", []):
        x, y = o["x"] * W, o["y"] * H
        hw = max(len(o["code"]) * 3.6, 26)
        p.append(f'<path d="M{x - hw:.0f},{y - 9:.0f}H{x + hw - 10:.0f}'
                 f'L{x + hw:.0f},{y:.0f}L{x + hw - 10:.0f},{y + 9:.0f}'
                 f'H{x - hw:.0f}Z" fill="#FFF6E3" stroke="#8A5B00" '
                 'stroke-width="1.3"/>')
        p.append(f'<text x="{x - 3:.0f}" y="{y + 3.5:.0f}" font-size="10" '
                 f'fill="#8A5B00" font-weight="600" '
                 f'text-anchor="middle">{_x(o["code"])}</text>')

    # 5) 已確認且定位的設備
    for e in m.get("equipment", []):
        b = e.get("bbox")
        if not b:
            continue
        x0, y0 = b[0] * W, b[1] * H
        w, h = (b[2] - b[0]) * W, (b[3] - b[1]) * H
        p.append(f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{w:.0f}" height="{h:.0f}" '
                 'fill="none" stroke="#0B8A46" stroke-width="1.8" rx="2"/>')
        name = e.get("name") or e.get("type") or ""
        p.append(f'<text x="{x0:.0f}" y="{y0 - 5:.0f}" font-size="11" fill="#0B8A46" '
                 f'font-weight="600">{_x(e.get("tag", ""))}　{_x(name)}</text>')

    # 6) 管線編號
    for ln in m.get("lines", []):
        b = ln.get("bbox")
        if not b:
            continue
        p.append(f'<text x="{b[0] * W:.0f}" y="{(b[1] + b[3]) / 2 * H:.0f}" '
                 f'font-size="9" fill="#8A5B00">{_x(ln.get("raw", ""))}</text>')

    p.append("</svg>")
    return "".join(p)


# ---------------------------------------------------------------- endpoints
@router.post("/build/{filename}")
def model_build(filename: str) -> dict:
    return build_model(filename)


@router.get("/locate/{filename}")
def model_locate(filename: str) -> dict:
    """設備定位候選（PFD）——沒建過模就先建一次。

    回傳的是**候選**，前端把它併進審核佇列，工程師逐項確認才入庫；
    另附清冊全表供 L2「改配對」下拉使用（AI 配錯時人可以直接改指）。
    """
    from .pid_vlm import _safe_pdf, _slug

    _safe_pdf(filename)
    p = MODEL_DIR / f"{_slug(Path(filename).stem)}.json"
    if p.exists():
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            m = build_model(filename)
    else:
        m = build_model(filename)
    rows = (_registry_of(filename) or {}).get("items", [])
    loc = m.get("locate") or {}
    return {"items": loc.get("items", []),
            "stats": {k: v for k, v in loc.items() if k != "items"},
            "registry": [{"item": r.get("item"), "name": r.get("name", ""),
                          "spec": r.get("spec", ""), "range": r.get("range")}
                         for r in rows]}


@router.get("/{filename}/rebuild.svg")
def model_rebuild_svg(filename: str):
    from fastapi.responses import Response

    return Response(content=_svg_of(model_get(filename)),
                    media_type="image/svg+xml")


@router.get("/{filename}")
def model_get(filename: str) -> dict:
    from .pid_vlm import _safe_pdf, _slug

    _safe_pdf(filename)
    p = MODEL_DIR / f"{_slug(Path(filename).stem)}.json"
    if not p.exists():
        raise HTTPException(404, "尚未建立資產模型——先完成審核再按「建立資產模型」")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(500, f"模型檔毀損：{exc}") from exc
