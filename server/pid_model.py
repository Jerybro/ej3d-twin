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

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

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


def _model_path(filename: str, domain: str = "") -> Path:
    """模型檔位置。分租後每個網域一份；未分租（內部呼叫）走舊的平面路徑，
    那份同時是新網域的**共用基線**（讀得到、但不會被寫入蓋掉）。"""
    from .pid_vlm import _slug

    slug = _slug(Path(filename).stem)
    if not domain:
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        return MODEL_DIR / f"{slug}.json"
    d = MODEL_DIR / re.sub(r"[^a-z0-9.-]+", "-", domain.lower())
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{slug}.json"
    if not p.exists():
        legacy = MODEL_DIR / f"{slug}.json"
        if legacy.exists():
            return legacy          # 尚未在本網域建模 → 先讀共用基線
    return p


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
def _demote_list_refs(equipment: list) -> int:
    """把「框在設備清冊表格上」的已審框降級為清冊參照。

    審核時 VLM 常把右側設備清冊表格的項次欄整排框成「設備」，人一批次
    接受，台帳裡就多出一疊表格框。那個接受的語意是「清冊有這列」，
    不是「設備在圖上這裡」——照畫會讓資產模型、流向圖、說明溯源全部
    指到表格去（潤泰 R-M0200 實測 301~314 一整欄）。

    判準是幾何形態學，不是位號白名單：≥4 個小框（邊長 <0.03）x 中心
    落在同一條窄直欄、且縱向堆疊超過三倍框高——圖面上真實的圖形塊
    不會長這樣。降級後 bbox 移到 list_bbox，圖面位置留給定位器候選。
    """
    cols: dict = {}
    for e in equipment:
        b = e.get("bbox")
        if not b or (b[2] - b[0]) > 0.03 or (b[3] - b[1]) > 0.03:
            continue
        cols.setdefault(round((b[0] + b[2]) / 2 / 0.008), []).append(e)
    n = 0
    for grp in cols.values():
        if len(grp) < 4:
            continue
        ys = sorted((e["bbox"][1] + e["bbox"][3]) / 2 for e in grp)
        hmax = max(e["bbox"][3] - e["bbox"][1] for e in grp)
        if ys[-1] - ys[0] < hmax * 3:
            continue
        for e in grp:
            e["list_bbox"] = e["bbox"]
            e["bbox"] = None
            e["list_ref"] = True
            e["on_drawing"] = False
            e["source"] += "（框位於設備清冊表格，圖面位置改由定位器提供）"
            n += 1
    return n


def build_model(filename: str, domain: str = "") -> dict:
    """把「已確認標註＋清冊＋拓撲」編譯成資產模型並存檔。

    domain：分租單位（email 網域）。模型是台帳的編譯產物，台帳分租了，
    模型也必須跟著分，否則 A 公司會看到 B 公司審出來的資產。
    """
    from datetime import datetime, timezone

    from .pid_topology import build_graph, control_loops, insert_valves, stats
    from .pid_vlm import _load_annots, _profile_of, _safe_pdf, _slug

    from .pid_vlm import _ensure_base

    pdf = _safe_pdf(filename)
    annots = _load_annots(filename, domain)
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
    _demote_list_refs(equipment)
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
        # 只排除「已有圖面框」的——被降級成清冊參照的（框在表格上的那批）
        # 圖面位置還沒有著落，它們的定位候選必須留下來
        drawn = {e["tag"] for e in equipment if e.get("bbox")}
        loc["items"] = [i for i in loc["items"] if i["tag"] not in drawn]

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
                hit = crosssheet_lookup(it["tag"], filename, domain)
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
        cand_by_tag: dict = {}
        for i in loc["items"]:
            cand_by_tag.setdefault(i["tag"], i)
        for e in equipment:
            if e.get("bbox") is not None:
                continue
            c = cand_of.get(e["tag"]) or cand_by_tag.get(e["tag"])
            if not c:
                continue
            e["candidate_bbox"] = c["bbox"]
            if not e.get("list_ref"):
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
    _model_path(filename, domain).write_text(
        json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    return model


# ------------------------------------------------------------ 盲測重建（SVG）
def _x(s: str) -> str:
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def _svg_of(m: dict, flow: dict | None = None, notes: list | None = None) -> str:
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

    # 5b) 定位器候選（待審）：虛線綠框。「哪個 block 是哪台設備、它負責
    #     什麼功能」先框出來給人看——虛線＝位置尚未經人工確認，跟實線的
    #     已審框視覺上分兩級。定位器把鄰居長進同一框時只畫一次，避免同一
    #     個 block 疊好幾層框、標籤蓋成一團。
    seen_cand: set = set()
    for e in m.get("equipment", []):
        b = e.get("candidate_bbox")
        if not b or e.get("bbox"):
            continue
        k = (round(b[0], 3), round(b[1], 3), round(b[2], 3), round(b[3], 3))
        if k in seen_cand:
            continue
        seen_cand.add(k)
        x0, y0 = b[0] * W, b[1] * H
        w, h = (b[2] - b[0]) * W, (b[3] - b[1]) * H
        p.append(f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{w:.0f}" height="{h:.0f}" '
                 'fill="none" stroke="#0B8A46" stroke-width="1.2" '
                 'stroke-dasharray="6 4" rx="2" opacity="0.8"/>')
        name = e.get("name") or e.get("type") or ""
        p.append(f'<text x="{x0 + 3:.0f}" y="{y0 + 12:.0f}" font-size="10" '
                 f'fill="#0B8A46" opacity="0.85">{_x(e.get("tag", ""))}　'
                 f'{_x(name)}</text>')

    # 6) 管線編號
    for ln in m.get("lines", []):
        b = ln.get("bbox")
        if not b:
            continue
        p.append(f'<text x="{b[0] * W:.0f}" y="{(b[1] + b[3]) / 2 * H:.0f}" '
                 f'font-size="9" fill="#8A5B00">{_x(ln.get("raw", ""))}</text>')

    # 7) 製程流向層：設備→設備的物料方向。原圖只隱含這件事（要人看箭頭
    #    自己串），我們是**明確知道**的——重建圖要把它畫出來，那是資料庫
    #    比原圖多出來的價值。
    #
    #    只畫有實據的邊（圖面箭頭／人工／AI 判定＋紅色可疑邊）：項次號推測
    #    在順序圖頁有標示脈絡可看，但畫在重建圖上就是一堆沒根據的線斜穿
    #    整張圖——推論與事實混著畫，比不畫更糟。走線用直角折線，
    #    讀起來才像製程圖，不是散彈孔。
    if flow and flow.get("ok"):
        pos = {n["tag"]: n["bbox"] for n in flow["nodes"] if n.get("bbox")}
        p.append('<g id="flow">')
        p.append('<defs><marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" '
                 'markerWidth="5" markerHeight="5" orient="auto-start-reverse">'
                 '<path d="M0,0 L10,5 L0,10 z" fill="#7C4DFF"/></marker></defs>')
        for e in flow.get("edges", []):
            if e["dir_by"] == "item_no" and not e.get("suspect"):
                continue
            a, b = pos.get(e["from"]), pos.get(e["to"])
            if not a or not b:
                continue
            x1, y1 = (a[0] + a[2]) / 2 * W, (a[1] + a[3]) / 2 * H
            x2, y2 = (b[0] + b[2]) / 2 * W, (b[1] + b[3]) / 2 * H
            if e.get("suspect"):
                col, dash, mk = "#D93F3F", ' stroke-dasharray="3 5"', ""
            else:
                col, dash, mk = "#7C4DFF", "", ' marker-end="url(#fa)"'
            elbow = (f'M{x1:.0f},{y1:.0f}H{x2:.0f}V{y2:.0f}'
                     if abs(x2 - x1) >= abs(y2 - y1) else
                     f'M{x1:.0f},{y1:.0f}V{y2:.0f}H{x2:.0f}')
            p.append(f'<path d="{elbow}" fill="none" stroke="{col}" '
                     f'stroke-width="{W / 800:.2f}" opacity="0.7"{dash}{mk}/>')
        p.append("</g>")

    # 8) 現場評註層：走過現場的人留下的知識，原圖上一個字都沒有。
    #    製程說明引用了哪一則，在重建圖上就看得到它標在哪——
    #    說明與重建圖是同一份資料的兩種呈現，不是兩件事。
    if notes:
        p.append('<g id="notes">')
        for n in notes:
            b = n.get("bbox") or []
            if len(b) != 4 and n.get("tag"):
                hit = next((e for e in m.get("equipment", [])
                            if e.get("tag") == n["tag"] and e.get("bbox")), None)
                b = (hit or {}).get("bbox") or []
            if len(b) != 4:
                continue
            x0, y0 = b[0] * W, b[1] * H
            w, h = max((b[2] - b[0]) * W, 22), max((b[3] - b[1]) * H, 16)
            p.append(f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{w:.0f}" height="{h:.0f}" '
                     'fill="rgba(4,106,251,0.06)" stroke="#046AFB" stroke-width="1.4" '
                     'stroke-dasharray="4 3" rx="3"/>')
            p.append(f'<rect x="{x0 - 1:.0f}" y="{y0 - 13:.0f}" width="{max(len(n["id"]) * 8, 22):.0f}" '
                     'height="13" fill="#046AFB" rx="3"/>')
            p.append(f'<text x="{x0 + 3:.0f}" y="{y0 - 3:.0f}" font-size="10" '
                     f'fill="#fff" font-weight="700">{_x(n["id"])}</text>')
        p.append("</g>")

    p.append("</svg>")
    return "".join(p)


def _svg_blind(m: dict, flow: dict | None = None, notes: list | None = None) -> str:
    """真盲重建——只畫資料庫的**語意層**，一條原圖線稿都不描。

    _svg_of（描圖模式）的線稿／文字／氣泡幾何是建模時從原 PDF 轉錄的：
    「不看原圖畫得出來」只證明轉錄存好了，不證明系統懂了。這裡反過來，
    素材只准用審核後的資產與拓撲結論：
      · 設備／儀錶／閥件——位置是資產的屬性（審核時定的框），符號由
        屬性生成（儀錶依 mounting 畫 ISA 圓／方框、閥件畫蝴蝶結）
      · 管線＝流向圖的設備→設備連線，**走線由拓撲正交生成**，不抄原圖
        路徑——路徑跟原圖不同是特徵不是缺陷：這是資料庫自己的佈線
    畫得出來的＝系統真正理解的；與原圖並排的差距＝誠實的辨識缺口。
    """
    g = m.get("geometry") or {}
    W = 1600
    H = round(W * (g.get("aspect") or 0.7))   # 只借畫布比例，讓疊圖能對位
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
         f'width="{W}" height="{H}" font-family="Inter,Arial,sans-serif">',
         f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>',
         '<defs>'
         '<marker id="ba" viewBox="0 0 10 10" refX="8.5" refY="5" '
         'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
         '<path d="M0,0 L10,5 L0,10 z" fill="#2A3441"/></marker>'
         '<marker id="bv" viewBox="0 0 10 10" refX="8.5" refY="5" '
         'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
         '<path d="M0,0 L10,5 L0,10 z" fill="#046AFB"/></marker>'
         '</defs>']

    # 1) 流向層＝盲重建的管線。端點裁到設備框緣，箭頭才不會被白底蓋掉。
    #    樣式帶證據等級：圖面箭頭／人工＝深實線、VLM 判定＝藍實線、
    #    可疑＝紅虛線（項次號推測一律不畫——推論與事實不混）。
    n_edges = 0
    if flow and flow.get("ok"):
        pos = {n["tag"]: n["bbox"] for n in flow["nodes"] if n.get("bbox")}
        EPS = 3.0
        p.append('<g id="flow">')
        for e in flow.get("edges", []):
            if e["dir_by"] == "item_no" and not e.get("suspect"):
                continue
            a, b = pos.get(e["from"]), pos.get(e["to"])
            if not a or not b:
                continue
            n_edges += 1
            x1, y1 = (a[0] + a[2]) / 2 * W, (a[1] + a[3]) / 2 * H
            x2, y2 = (b[0] + b[2]) / 2 * W, (b[1] + b[3]) / 2 * H
            if abs(x2 - x1) >= abs(y2 - y1):
                sx = (a[2] if x2 > x1 else a[0]) * W
                if abs(y2 - y1) < EPS:
                    ex = (b[0] if x2 > x1 else b[2]) * W
                    d = f'M{sx:.0f},{y1:.0f}H{ex:.0f}'
                else:
                    ey = (b[1] if y2 > y1 else b[3]) * H
                    d = f'M{sx:.0f},{y1:.0f}H{x2:.0f}V{ey:.0f}'
            else:
                sy = (a[3] if y2 > y1 else a[1]) * H
                if abs(x2 - x1) < EPS:
                    ey = (b[1] if y2 > y1 else b[3]) * H
                    d = f'M{x1:.0f},{sy:.0f}V{ey:.0f}'
                else:
                    ex = (b[0] if x2 > x1 else b[2]) * W
                    d = f'M{x1:.0f},{sy:.0f}V{y2:.0f}H{ex:.0f}'
            if e.get("suspect"):
                col, dash, mk = "#D93F3F", ' stroke-dasharray="4 5"', ""
            elif e["dir_by"] in ("arrow", "manual"):
                col, dash, mk = "#2A3441", "", ' marker-end="url(#ba)"'
            else:
                col, dash, mk = "#046AFB", "", ' marker-end="url(#bv)"'
            p.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2" '
                     f'stroke-linejoin="round" opacity="0.9"{dash}{mk}/>')
        p.append('</g>')

    # 2) 控制迴路信號線（ISA 虛線）：同迴路儀錶串起來
    ins_pos = {}
    for it in m.get("instruments", []):
        b = it.get("bbox")
        if b:
            ins_pos[it["tag"]] = ((b[0] + b[2]) / 2 * W, (b[1] + b[3]) / 2 * H)
    for lp in m.get("loops", []):
        pts = [ins_pos[t] for t in lp.get("members", []) if t in ins_pos]
        if len(pts) < 2:
            continue
        d = f'M{pts[0][0]:.0f},{pts[0][1]:.0f}' + "".join(
            f'L{x:.0f},{y:.0f}' for x, y in pts[1:])
        p.append(f'<path d="{d}" fill="none" stroke="#046AFB" stroke-width="0.9" '
                 'stroke-dasharray="2 3" opacity="0.5"/>')

    # 3) 管線編號（OCR 推定的型別化資產，未逐條審核→淺色）
    for ln in m.get("lines", []):
        b = ln.get("bbox")
        if not b:
            continue
        p.append(f'<text x="{b[0] * W:.0f}" y="{(b[1] + b[3]) / 2 * H:.0f}" '
                 f'font-size="9" fill="#8A5B00" opacity="0.8">{_x(ln.get("raw", ""))}</text>')

    # 4) 定位器候選（待審）：虛線框，與已審實線分兩級
    seen_cand: set = set()
    for e in m.get("equipment", []):
        b = e.get("candidate_bbox")
        if not b or e.get("bbox"):
            continue
        k = (round(b[0], 3), round(b[1], 3), round(b[2], 3), round(b[3], 3))
        if k in seen_cand:
            continue
        seen_cand.add(k)
        x0, y0 = b[0] * W, b[1] * H
        w, h = (b[2] - b[0]) * W, (b[3] - b[1]) * H
        p.append(f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{w:.0f}" height="{h:.0f}" '
                 'fill="none" stroke="#0B8A46" stroke-width="1.2" '
                 'stroke-dasharray="6 4" rx="4" opacity="0.75"/>')
        p.append(f'<text x="{x0 + 3:.0f}" y="{y0 + 12:.0f}" font-size="10" '
                 f'fill="#0B8A46" opacity="0.85">{_x(e.get("tag", ""))}　'
                 f'{_x(e.get("name") or e.get("type") or "")}</text>')

    # 5) 已審設備：資料庫的設備方塊（位號＋名稱置中）
    n_eq = 0
    for e in m.get("equipment", []):
        b = e.get("bbox")
        if not b:
            continue
        n_eq += 1
        x0, y0 = b[0] * W, b[1] * H
        w, h = (b[2] - b[0]) * W, (b[3] - b[1]) * H
        p.append(f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{w:.0f}" height="{h:.0f}" '
                 'fill="rgba(11,138,70,0.05)" stroke="#0B8A46" stroke-width="2" rx="4"/>')
        name = e.get("name") or e.get("type") or ""
        fs = min(max(h * 0.22, 9), 13)
        tx, ty = x0 + w / 2, y0 + h / 2
        p.append(f'<text x="{tx:.0f}" y="{ty - 2:.0f}" font-size="{fs:.1f}" '
                 f'fill="#0B6B36" text-anchor="middle" font-weight="700">'
                 f'{_x(e.get("tag", ""))}</text>')
        if name:
            p.append(f'<text x="{tx:.0f}" y="{ty + fs:.0f}" font-size="{fs * 0.8:.1f}" '
                     f'fill="#0B6B36" text-anchor="middle">{_x(name)}</text>')

    # 6) 已審閥件：蝴蝶結符號由屬性生成
    n_vv = 0
    for vv in m.get("valves", []):
        b = vv.get("bbox")
        if not b:
            continue
        n_vv += 1
        x, y = (b[0] + b[2]) / 2 * W, (b[1] + b[3]) / 2 * H
        s = min(max((b[2] - b[0]) * W * 0.5, 5), 10)
        p.append(f'<path d="M{x - s:.0f},{y - s * 0.8:.0f}L{x + s:.0f},{y + s * 0.8:.0f}'
                 f'L{x + s:.0f},{y - s * 0.8:.0f}L{x - s:.0f},{y + s * 0.8:.0f}Z" '
                 'fill="#fff" stroke="#046AFB" stroke-width="1.6"/>')
        lab = vv.get("id", "")
        if vv.get("size"):
            lab += f'　{vv["size"]}'
        p.append(f'<text x="{x:.0f}" y="{y + s * 0.8 + 11:.0f}" font-size="9.5" '
                 f'fill="#046AFB" text-anchor="middle">{_x(lab)}</text>')

    # 7) 已審儀錶：ISA 符號由 mounting 生成（現場＝圓、盤面/DCS＝方框內圓）
    for it in m.get("instruments", []):
        b = it.get("bbox")
        if not b:
            continue
        cx, cy = (b[0] + b[2]) / 2 * W, (b[1] + b[3]) / 2 * H
        r = min(max((b[3] - b[1]) * H * 0.55, 10), 18)
        mnt = str(it.get("mounting", "")).lower()
        if any(kw in mnt for kw in ("dcs", "panel", "盤", "控制室")):
            s = r * 0.95
            p.append(f'<rect x="{cx - s:.0f}" y="{cy - s:.0f}" width="{s * 2:.0f}" '
                     f'height="{s * 2:.0f}" rx="2" fill="#fff" stroke="#046AFB" '
                     'stroke-width="1.5"/>')
            p.append(f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r * 0.78:.0f}" '
                     'fill="none" stroke="#046AFB" stroke-width="1.2"/>')
        else:
            p.append(f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="#fff" '
                     'stroke="#046AFB" stroke-width="1.5"/>')
        mm = re.match(r"^([A-Z]+)(.*)$", it.get("tag", ""))
        top, bot = (mm.group(1), mm.group(2)) if mm else (it.get("tag", ""), "")
        fs = min(max(r * 0.5, 6.5), 10.5)
        p.append(f'<text x="{cx:.0f}" y="{cy - r * 0.08:.0f}" font-size="{fs:.1f}" '
                 f'fill="#061027" text-anchor="middle" font-weight="600">{_x(top)}</text>')
        if bot:
            p.append(f'<text x="{cx:.0f}" y="{cy + r * 0.55:.0f}" font-size="{fs:.1f}" '
                     f'fill="#061027" text-anchor="middle">{_x(bot)}</text>')

    # 8) OPC 跨圖接續角旗（同描圖模式——它是型別化的接續資產）
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

    # 9) 現場評註（同描圖模式——原圖上一個字都沒有的知識）
    if notes:
        p.append('<g id="notes">')
        for n in notes:
            b = n.get("bbox") or []
            if len(b) != 4 and n.get("tag"):
                hit = next((e for e in m.get("equipment", [])
                            if e.get("tag") == n["tag"] and e.get("bbox")), None)
                b = (hit or {}).get("bbox") or []
            if len(b) != 4:
                continue
            x0, y0 = b[0] * W, b[1] * H
            w, h = max((b[2] - b[0]) * W, 22), max((b[3] - b[1]) * H, 16)
            p.append(f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{w:.0f}" height="{h:.0f}" '
                     'fill="rgba(4,106,251,0.06)" stroke="#046AFB" stroke-width="1.4" '
                     'stroke-dasharray="4 3" rx="3"/>')
            p.append(f'<rect x="{x0 - 1:.0f}" y="{y0 - 13:.0f}" '
                     f'width="{max(len(n["id"]) * 8, 22):.0f}" height="13" '
                     'fill="#046AFB" rx="3"/>')
            p.append(f'<text x="{x0 + 3:.0f}" y="{y0 - 3:.0f}" font-size="10" '
                     f'fill="#fff" font-weight="700">{_x(n["id"])}</text>')
        p.append("</g>")

    # 10) 圖例（右上角）：這張圖畫了什麼、沒畫的去哪了
    n_unloc = sum(1 for e in m.get("equipment", [])
                  if not e.get("bbox") and not e.get("candidate_bbox"))
    rows = [
        ("盲重建｜只畫資料庫語意層", True),
        (f"設備 {n_eq} 台（候選 {len(seen_cand)}、未定位 {n_unloc}）", False),
        (f"儀錶 {len(ins_pos)}｜閥件 {n_vv}｜流向 {n_edges} 條", False),
        ("線稿不描原圖：走線由拓撲生成", False),
    ]
    bh = len(rows) * 15 + 12
    p.append(f'<g><rect x="{W - 286}" y="10" width="276" height="{bh}" rx="6" '
             'fill="rgba(255,255,255,0.92)" stroke="#DBDDE0"/>')
    for i, (t, bold) in enumerate(rows):
        fw = ' font-weight="700"' if bold else ''
        p.append(f'<text x="{W - 274}" y="{29 + i * 15}" font-size="11" '
                 f'fill="{"#061027" if bold else "#5C6773"}"'
                 f'{fw}>{_x(t)}</text>')
    p.append('</g>')

    p.append("</svg>")
    return "".join(p)


# ---------------------------------------------------------------- endpoints
@router.post("/build/{filename}")
def model_build(filename: str, request: Request) -> dict:
    from .auth import current_domain

    return build_model(filename, current_domain(request))


@router.get("/locate/{filename}")
def model_locate(filename: str, request: Request) -> dict:
    """設備定位候選（PFD）——沒建過模就先建一次。

    回傳的是**候選**，前端把它併進審核佇列，工程師逐項確認才入庫；
    另附清冊全表供 L2「改配對」下拉使用（AI 配錯時人可以直接改指）。
    """
    from .auth import current_domain
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    dom = current_domain(request)
    p = _model_path(filename, dom)
    if p.exists():
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            m = build_model(filename, dom)
    else:
        m = build_model(filename, dom)
    rows = (_registry_of(filename) or {}).get("items", [])
    loc = m.get("locate") or {}
    return {"items": loc.get("items", []),
            "stats": {k: v for k, v in loc.items() if k != "items"},
            "registry": [{"item": r.get("item"), "name": r.get("name", ""),
                          "spec": r.get("spec", ""), "range": r.get("range")}
                         for r in rows]}


@router.get("/flow/{filename}")
def model_flow(filename: str, request: Request) -> dict:
    """製程順序圖：誰先誰後、哪裡分流匯流。

    來源是**已定位的設備**（含尚未審核的候選）＋線稿＋流向箭頭。
    方向優先採信箭頭；沒有箭頭的連線退回項次號順序，並在證據裡
    明講那是工程慣例推測不是圖面證據——順序圖是要拿去掛數據的骨架，
    推論與事實混在一起是最危險的。
    """
    from .pid_flow import build_flow

    m = model_locate(filename, request)      # 需要時會自動建模
    full = model_get(filename, request)
    g = full.get("geometry") or {}
    # 節點品質決定整張順序圖的品質，三條規則：
    #   ① 已確認的圖面框最優先，再來清冊列的定位候選，最後才是未配對候選
    #   ② 同一個框只留一台——定位器把鄰居長進同一框時，同框互連會生出
    #      整團假邊（潤泰實測 206/204.5/208.3 三個位號共用一框）
    #   ③ 清冊參照（框在表格上的）沒有圖面框就不進節點，表格不是製程
    eq, used_box, seen = [], set(), set()

    def _add(tag, name, b):
        if not b or tag in seen:
            return
        k = (round(b[0], 3), round(b[1], 3), round(b[2], 3), round(b[3], 3))
        if k in used_box:
            return
        seen.add(tag)
        used_box.add(k)
        eq.append({"tag": tag, "name": name, "bbox": b})

    for e in (full.get("equipment") or []):
        if e.get("bbox"):
            _add(e["tag"], e.get("name") or e.get("type", ""), e["bbox"])
    for e in (full.get("equipment") or []):
        _add(e["tag"], e.get("name") or e.get("type", ""),
             e.get("candidate_bbox"))
    for src in (m.get("items") or []):
        _add(src["tag"], src.get("symbol", ""), src.get("bbox"))
    flow = build_flow(eq, g.get("pipes") or [], g.get("arrows") or [],
                      g.get("aspect") or 0.7)
    return _apply_flow_overrides(flow, filename, current_domain_of(request))


def _apply_flow_overrides(flow: dict, filename: str, domain: str) -> dict:
    """套用 VLM／人工判過的方向，並重算分流匯流。

    覆寫層與自動推導分開存：自動推導會隨重建而變，但「判過的方向」是結論，
    不該被下一次重建洗掉。
    """
    if not flow.get("ok"):
        return flow
    p = _flow_override_path(filename, domain)
    if not p.exists():
        return flow
    try:
        ov = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return flow
    if not ov:
        return flow

    src = {"vlm": ("AI 看圖判定", 0.8), "manual": ("人工判定", 1.0)}
    n_applied = n_suspect = 0
    for e in flow["edges"]:
        k = f"{min(e['from'], e['to'])}|{max(e['from'], e['to'])}"
        o = ov.get(k)
        if not o:
            continue
        if o.get("by") == "vlm-suspect":
            n_suspect += 1
            e["suspect"] = True
            e["confidence"] = 0.2
            e["evidence"] = (f"AI 看圖後判定這兩台之間沒有可見連線："
                             f"{o.get('detail', '')} → 這條連線可能是線稿誤接，"
                             "請人工確認是否刪除")
            continue
        n_applied += 1
        label, conf = src.get(o.get("by", "vlm"), ("判定", 0.8))
        e["from"], e["to"] = o["from"], o["to"]
        e["dir_by"] = o.get("by", "vlm")
        e["confidence"] = conf
        e["evidence"] = (f"{label}：{o.get('detail', '') or '依圖面判定方向'}"
                         f"（{o['from']}→{o['to']}）")

    # 方向改了，分流匯流要跟著重算——這兩個是圖論定義，不能沿用舊值
    import networkx as nx

    D = nx.DiGraph()
    box = {n["tag"]: n["bbox"] for n in flow["nodes"]}
    nm = {n["tag"]: n["name"] for n in flow["nodes"]}
    D.add_nodes_from(box)
    for e in flow["edges"]:
        D.add_edge(e["from"], e["to"])
    nodes = []
    for t in D.nodes:
        od, idg = D.out_degree(t), D.in_degree(t)
        role = ("分流點" if od > 1 else "匯流點" if idg > 1 else
                "起點" if idg == 0 and od > 0 else
                "終點" if od == 0 and idg > 0 else
                "串接" if od == 1 and idg == 1 else "孤立")
        nodes.append({"tag": t, "name": nm.get(t, ""), "bbox": box.get(t),
                      "in": idg, "out": od, "role": role,
                      "downstream": sorted(D.successors(t), key=_num_key),
                      "upstream": sorted(D.predecessors(t), key=_num_key)})
    try:
        level = {}
        for t in nx.topological_sort(D):
            pr = list(D.predecessors(t))
            level[t] = (max((level[x] for x in pr), default=-1) + 1) if pr else 0
    except nx.NetworkXUnfeasible:
        level = {n["tag"]: i for i, n in enumerate(
            sorted(nodes, key=lambda x: _num_key(x["tag"])))}
    for n in nodes:
        n["level"] = level.get(n["tag"], 0)
    nodes.sort(key=lambda n: (n["level"], _num_key(n["tag"])))
    flow["nodes"] = nodes
    st = flow["stats"]
    st.update({
        "by_arrow": sum(1 for e in flow["edges"] if e["dir_by"] == "arrow"),
        "by_item_no": sum(1 for e in flow["edges"] if e["dir_by"] == "item_no"),
        "by_vlm": sum(1 for e in flow["edges"] if e["dir_by"] == "vlm"),
        "by_manual": sum(1 for e in flow["edges"] if e["dir_by"] == "manual"),
        "splits": sum(1 for n in nodes if n["role"] == "分流點"),
        "merges": sum(1 for n in nodes if n["role"] == "匯流點"),
        "starts": sum(1 for n in nodes if n["role"] == "起點"),
        "ends": sum(1 for n in nodes if n["role"] == "終點"),
        "isolated": sum(1 for n in nodes if n["role"] == "孤立"),
        "overrides": n_applied, "suspect": n_suspect,
    })
    return flow


class FlowVlmReq(BaseModel):
    pairs: list = []             # [[from_tag, to_tag], ...]，空＝全部弱證據邊
    provider: str = "cloud"
    limit: int = 20              # 成本閘門：一次最多問幾條


@router.post("/flow/{filename}/vlm")
def model_flow_vlm(filename: str, req: FlowVlmReq, request: Request) -> dict:
    """用 VLM 判流向——只問「沒有箭頭可判」的那些連線。

    成本閘門：整張圖亂槍打鳥沒必要，箭頭已經定死的邊不必再花錢問。
    每一條都裁出「涵蓋兩台設備與其間連線」的局部圖，讓模型看著圖回答，
    並把模型的原話留進證據鏈——判錯了，人看得出它憑什麼這樣說。
    """
    from .pid_vlm import _crop_b64, _vlm

    flow = model_flow(filename, request)
    if not flow.get("ok"):
        raise HTTPException(422, flow.get("reason", "無法推導流向"))
    pos = {n["tag"]: n["bbox"] for n in flow["nodes"]}
    name_of = {n["tag"]: n.get("name", "") for n in flow["nodes"]}

    want = {(a, b) for a, b in req.pairs}
    todo = [e for e in flow["edges"]
            if (not want and e["dir_by"] != "arrow")
            or (e["from"], e["to"]) in want or (e["to"], e["from"]) in want]
    todo = todo[:max(1, min(req.limit, 40))]

    SYSTEM = ("你是資深製程工程師，正在判讀 PFD／P&ID 局部圖。"
              "只依圖面可見的箭頭、輸送機傾角、料斗出口方向、管線接點高低作答，"
              "看不出來就說不確定，不要臆測。")
    out, changed = [], 0
    for e in todo:
        a, b = e["from"], e["to"]
        ba, bb = pos.get(a), pos.get(b)
        if not ba or not bb:
            continue
        box = [max(0.0, min(ba[0], bb[0]) - 0.012), max(0.0, min(ba[1], bb[1]) - 0.012),
               min(1.0, max(ba[2], bb[2]) + 0.012), min(1.0, max(ba[3], bb[3]) + 0.012)]
        try:
            img_b64, _ = _crop_b64(filename, box)
            q = (f"圖中有兩台設備：{a}（{name_of.get(a, '')}）與 {b}（{name_of.get(b, '')}）。"
                 f"物料是從哪一台流向哪一台？\n"
                 f"只回一行，格式：<起點位號>-><終點位號>|<依據，20字內>\n"
                 f"若圖上看不出方向，回：unknown|<原因>")
            txt = (_vlm(req.provider, SYSTEM, q, img_b64) or "").strip()
        except Exception as exc:  # noqa: BLE001
            out.append({"from": a, "to": b, "result": "error", "detail": str(exc)[:120]})
            continue
        line = txt.splitlines()[0][:160] if txt else ""
        m = re.search(r"([A-Za-z0-9.\-]+)\s*->\s*([A-Za-z0-9.\-]+)", line)
        why = line.split("|", 1)[1].strip() if "|" in line else line
        if not m or {m.group(1), m.group(2)} != {a, b}:
            out.append({"from": a, "to": b, "result": "unknown",
                        "detail": why or line or "模型未給出方向"})
            continue
        src, dst = m.group(1), m.group(2)
        flipped = (src, dst) != (a, b)
        changed += 1
        out.append({"from": src, "to": dst, "result": "ok", "flipped": flipped,
                    "detail": why, "raw": line})

    # 判定結果落地成覆寫層，之後 model_flow 會套用（人工仍可再改）
    ov = _flow_override_path(filename, current_domain_of(request))
    cur = {}
    if ov.exists():
        try:
            cur = json.loads(ov.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            cur = {}
    for r in out:
        k = f"{min(r['from'], r['to'])}|{max(r['from'], r['to'])}"
        if r["result"] == "ok":
            cur[k] = {"from": r["from"], "to": r["to"], "by": "vlm",
                      "detail": r.get("detail", ""), "at": _now_iso()}
        elif r["result"] == "unknown" and re.search(
                r"無.{0,6}(連接|相連|管線|關係)|沒有.{0,6}(連接|管線)|不相連",
                r.get("detail", "")):
            # 「這兩台根本沒接在一起」比「判不出方向」更有價值——那代表
            # 拓撲抓到一條假連線。留下來讓人決定要不要刪，別靜默吞掉。
            cur[k] = {"from": r["from"], "to": r["to"], "by": "vlm-suspect",
                      "detail": r.get("detail", ""), "at": _now_iso()}
    ov.parent.mkdir(parents=True, exist_ok=True)
    ov.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")

    return {"asked": len(todo), "resolved": changed,
            "unknown": sum(1 for r in out if r["result"] == "unknown"),
            "results": out}


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def current_domain_of(request: Request) -> str:
    from .auth import current_domain

    return current_domain(request)


def _flow_override_path(filename: str, domain: str) -> Path:
    """流向覆寫層：VLM 判定與人工修正都寫在這裡，與自動推導分開存。

    分開的理由：自動推導會隨模型重建而變，但「人／VLM 判過的方向」
    是要保留的結論，不該被下次重建洗掉。
    """
    from .pid_vlm import _slug

    d = MODEL_DIR / re.sub(r"[^a-z0-9.-]+", "-", (domain or "dev.local").lower())
    return d / f"{_slug(Path(filename).stem)}.flowdir.json"


@router.get("/{filename}/rebuild.svg")
def model_rebuild_svg(filename: str, request: Request,
                      flow: int = 1, notes: int = 1, mode: str = "trace"):
    """重建圖，兩種模式，驗的東西不同：

    · mode=trace（描圖）＝原圖幾何轉錄＋語意疊加。線稿／文字／氣泡是建模時
      從 PDF 抄的——驗的是「幾何與 OCR 進庫的完整度」，不是理解。
    · mode=blind（盲重建）＝只畫資料庫語意層（審核後資產＋流向拓撲），
      一條原圖線稿都不描，管線走線由拓撲重新生成。這才是
      「只靠資料庫重現這座廠」的誠實版本：畫得出來的＝系統懂的，
      與原圖並排的差距＝辨識缺口。

    兩種模式都帶語意層（流向、評註）：製程說明引用了哪些評註，
    重建圖上就看得到標在哪裡——說明與重建圖是同一份資料的兩種呈現。
    """
    from fastapi.responses import Response

    m = model_get(filename, request)
    fl = model_flow(filename, request) if flow else None
    nt = None
    if notes:
        from .pid_notes import list_notes

        nt = list_notes(filename, current_domain_of(request))
    render = _svg_blind if mode == "blind" else _svg_of
    return Response(content=render(m, fl, nt), media_type="image/svg+xml")


@router.get("/{filename}/annotated.jpg")
def model_annotated(filename: str, request: Request):
    """全量標示圖：原圖一筆不動，資產模型逐層疊上——對著原圖驗收的交付物。

    與盲重建互補：盲重建驗「資料庫懂多少」（不看原圖），標示圖給人
    「對著原圖驗收」——每個入庫資產框在原圖哪裡、位號是什麼，一張圖交付。
    分層配色：設備綠（含候選淡綠）、儀錶藍、閥件紫（審核閥全框、
    幾何偵測閥小方塊）、管線號琥珀、OPC 紅橘；左上角統計欄。
    """
    import io as _io

    from fastapi.responses import Response
    from PIL import Image, ImageDraw, ImageFont

    from .pid_vlm import _ensure_base

    m = model_get(filename, request)
    img_p, _meta = _ensure_base(filename)
    im = Image.open(img_p).convert("RGB")
    W, H = im.size
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dr = ImageDraw.Draw(ov)
    S = W / 3600.0                      # 字級與線寬隨底圖解析度縮放

    def _font(px: float):
        for name in ("msjhbd.ttc", "msjh.ttc", "arialbd.ttf", "arial.ttf"):
            try:
                return ImageFont.truetype(rf"C:\Windows\Fonts\{name}", int(px))
            except OSError:
                continue
        return ImageFont.load_default()

    F, F2 = _font(30 * S), _font(42 * S)
    EQ, IN, VA, LN, OP = ((11, 138, 70), (4, 106, 251), (124, 77, 255),
                          (138, 91, 0), (194, 65, 12))

    def _box(bb, col, w=5, alpha=34):
        x0, y0 = bb[0] * W, bb[1] * H
        dr.rectangle([x0, y0, bb[2] * W, bb[3] * H],
                     fill=col + (alpha,), outline=col + (255,),
                     width=max(2, int(w * S)))
        return x0, y0

    def _label(x, y, txt, col, font=None):
        font = font or F
        tb = dr.textbbox((x, y - 36 * S), txt, font=font)
        dr.rectangle([tb[0] - 4, tb[1] - 2, tb[2] + 4, tb[3] + 2],
                     fill=(255, 255, 255, 210))
        dr.text((x, y - 36 * S), txt, fill=col + (255,), font=font)

    n_eq = n_cand = 0
    for e in m.get("equipment", []):
        if e.get("bbox"):
            n_eq += 1
            x0, y0 = _box(e["bbox"], EQ, w=7, alpha=22)
            _label(x0, y0, f'{e.get("tag", "")} {e.get("name") or ""}', EQ, F2)
        elif e.get("candidate_bbox"):
            n_cand += 1
            x0, y0 = _box(e["candidate_bbox"], EQ, w=3, alpha=12)
            _label(x0, y0, f'{e.get("tag", "")}（候選）', EQ)
    for i in m.get("instruments", []):
        if not i.get("bbox"):
            continue
        x0, y0 = _box(i["bbox"], IN)
        _label(x0, y0, i.get("tag", ""), IN)
    n_geom_v = 0
    g = m.get("geometry") or {}
    for u, v, _ci in g.get("valve_nodes", []):     # 幾何偵測閥：小方塊、不標字
        n_geom_v += 1
        r = 0.004
        _box([u - r, v - r * (W / H), u + r, v + r * (W / H)], VA, w=3, alpha=46)
    for vv in m.get("valves", []):                 # 審核入庫閥：全框＋位號
        if not vv.get("bbox"):
            continue
        x0, y0 = _box(vv["bbox"], VA, w=5, alpha=30)
        if vv.get("id"):
            _label(x0, y0, vv["id"], VA)
    for ln in m.get("lines", []):
        if ln.get("bbox"):
            _box(ln["bbox"], LN, w=3, alpha=26)
    for o in m.get("opcs", []):
        bb = [o["x"] - 0.017, o["y"] - 0.014, o["x"] + 0.017, o["y"] + 0.014]
        x0, y0 = _box(bb, OP, w=4, alpha=26)
        _label(x0, y0, o.get("code", ""), OP)

    out = Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB")
    dr2 = ImageDraw.Draw(out)
    txt = (f"{m.get('drawing', filename)}　全量標示｜設備 {n_eq}（候選 {n_cand}）｜"
           f"儀錶 {sum(1 for i in m.get('instruments', []) if i.get('bbox'))}｜"
           f"閥件 {len(m.get('valves', []))}＋幾何 {n_geom_v}｜"
           f"管線號 {len(m.get('lines', []))}｜OPC {len(m.get('opcs', []))}")
    tb = dr2.textbbox((int(50 * S), int(44 * S)), txt, font=F2)
    dr2.rectangle([tb[0] - 20, tb[1] - 14, tb[2] + 20, tb[3] + 14],
                  fill=(255, 255, 255), outline=(60, 60, 60), width=max(2, int(3 * S)))
    dr2.text((int(50 * S), int(44 * S)), txt, fill=(6, 16, 39), font=F2)

    buf = _io.BytesIO()
    out.save(buf, format="JPEG", quality=86)
    return Response(content=buf.getvalue(), media_type="image/jpeg")


@router.get("/{filename}")
def model_get(filename: str, request: Request) -> dict:
    from .auth import current_domain
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    p = _model_path(filename, current_domain(request))
    if not p.exists():
        raise HTTPException(404, "尚未建立資產模型——先完成審核再按「建立資產模型」")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(500, f"模型檔毀損：{exc}") from exc
