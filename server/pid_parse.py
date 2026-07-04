"""P&ID 自動解析建模 — 上傳圖面 → OCR 抽位號 → 3D 場景草稿。

工作流：使用者上傳 P&ID（CAD 轉出的 PDF 文字多已曲線化，無文字層）
→ pypdfium2 渲染高解析圖 → EasyOCR 抽文字＋座標 → 正則抽設備/儀錶位號
→ 位號首字母映射素材類型、圖面座標映射場景佈局 → 存場景草稿
→ 使用者在 3D 編輯器開啟草稿修改（刪誤抓/調位置/補管線）。

草稿哲學：**寧可多抓給使用者刪，不要少抓讓使用者補**——編輯器的
undo/delete 就是清理誤抓的工作流。
"""

from __future__ import annotations

import math
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PID_DIR = BASE_DIR / "uploads" / "pid"
TILE_DIR = PID_DIR / "_tiles"  # 圖紙底圖（3D 場景地毯用，runtime 產物不進版控）

# 單圖場景的圖紙底圖寬度（場景單位 m）；高度按圖面比例
TILE_W = 56.0

# ---------------------------------------------------------------- 位號規則
# 儀錶位號（先判，避免被設備規則吃掉）
INST_RE = re.compile(
    r"^(TI|TIC|TE|TT|TV|TR|PI|PIC|PT|PDI|PDT|PR|FI|FIC|FT|FE|FV|FR|LI|LIC|LT|LG|LV|LR|"
    r"AI|AT|AR|HV|XV|VS|GD|SD|SFS|FSL|FAL|FALL|LSH|LSL|LAH|LAL|PAH|PAL|PDAH|STR|HS|ZS)"
    r"-?\d{3,5}[A-Z]?$"
)
# 設備位號：單字母（限已知設備類型）+ 3 碼數字 + 白名單字尾。
# TA32 全 30 張實測的三條硬規則（各擋一族系統性誤抓）：
# 1. 前綴限單字母且在 TYPE_MAP 內——雙字母前綴全是管線配件（BV 閥/SG 視鏡/
#    SC 取樣/RD 破裂盤/RO 限流孔板），不值得出現在 3D 場景；I/N/X/Y/J 等
#    非設備字母則多為線號/雜訊誤讀
# 2. 字尾白名單 A/B/AB/S/SA/SB/-n——開放任意兩字母會收進管徑誤讀
#    （3/4"P → 374P → B374P）與 RS485MO 這類通訊標註
# 3. 數字不得以 0 開頭——真位號無 0xx，PFD 小字誤讀常見 099/009
EQUIP_RE = re.compile(r"^[A-Z]-?[1-9]\d{2}(?:A|B|AB|S|SA|SB|-\d)?$")

# 首字母 → 編輯器素材類型
# 'S' 不收：TA32 慣例 S6xx＝流股號（stream number，性能表 S601 進料/
# S604 出口同源），PFD/P&ID 上被抓到的 S 開頭全是流股標記非設備——
# 曾生 15 顆假旋風分離器。真旋風可在編輯器手動放（素材仍在）。
TYPE_MAP = {
    "R": "reactor", "C": "column", "T": "tank", "V": "flash_v", "E": "hx",
    "P": "pump", "F": "furnace", "B": "compressor", "K": "compressor",
    "M": "block", "D": "flash_v", "G": "pump",
}
TYPE_NAME = {
    "reactor": "反應器", "column": "蒸餾塔", "tank": "儲槽", "flash_v": "槽/罐",
    "hx": "熱交換器", "pump": "泵", "furnace": "加熱爐", "compressor": "壓縮機",
    "cyclone": "旋風分離器", "block": "設備",
}
# 素材預設尺寸（與 plant-builders ASSET_CATALOG 同步）
TYPE_DIMS = {
    "reactor": {"r": 1.5, "h": 4}, "column": {"r": 1.2, "h": 9},
    "tank": {"r": 2, "h": 5}, "flash_v": {"r": 1.0, "h": 4},
    "hx": {"r": 0.5, "len": 3}, "pump": {"w": 1.0, "h": 0.8, "d": 0.7},
    "furnace": {"w": 3, "h": 3, "d": 2.5}, "compressor": {"w": 3, "h": 1.8, "d": 1.6},
    "cyclone": {"r": 0.8, "h": 4}, "block": {"w": 2, "h": 2, "d": 2},
}
# 儀錶前綴 → 單位
INST_UNIT = {"T": "°C", "P": "kg/cm²g", "F": "m³/h", "L": "%", "A": "ppm", "G": "ppm", "S": "%"}

# 常見誤抓黑名單（圖框/接續標記/公司字樣）
BLACKLIST_RE = re.compile(r"^(DWG|REV|NO|PAGE|SHT|SH|ISO|ANSI|API|NPS|SCH)\d*$")

# 跨圖接續標記（off-page connector）：「070-2/01」＝接到圖 C12070-2 的
# 01 號接點；對側圖上有互指的「070-1/01」。C12070-1↔C12070-2 實測雙向成對。
CONN_RE = re.compile(r"^(\d{3}-\d{1,2})/(\d{1,2}[A-Z]?)$")

# 設備位號最低信心：實測真正的設備大字（貼近容器繪圖的位號）信心穩定在
# 0.99-1.0；本文敘述句中夾帶的設備參照字（如「…POSSIBLE TO E651」誤讀
# 成「F651」）信心明顯偏低（~0.56）。用此門檻擋掉這類誤讀，儀錶不受影響
# （儀錶圈本來字體小，信心天生較低，過濾會誤殺真儀錶）。
EQUIP_MIN_CONF = 0.65

_reader = None  # EasyOCR 模型延遲載入（首次 ~數秒）


def _get_reader():
    global _reader
    if _reader is None:
        import easyocr

        _reader = easyocr.Reader(["en"], gpu=True, verbose=False)
    return _reader


def _orientation_score(img) -> float:
    """OCR 小樣本信心總和（判斷圖面是否倒置用）。"""
    import numpy as np

    reader = _get_reader()
    w, h = img.size
    band = img.crop((int(w * 0.2), int(h * 0.35), int(w * 0.8), int(h * 0.65)))
    band = band.resize((1600, round(band.height * 1600 / band.width)))
    return sum(
        conf for _, text, conf in reader.readtext(
            np.array(band.convert("RGB")), text_threshold=0.5, low_text=0.3)
        if len(text.strip()) >= 3)


def _render(pdf_path: Path, scale: float = 6.0):
    """渲染第一頁；直式頁面（CAD 橫圖轉 90° 存檔的常態）自動轉正，
    再以 OCR 小樣本投票防整張倒置（ARO-1 PFD 實測 180° 倒放，
    倒置圖 OCR 全滅只剩幽靈）。"""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc[0]
        bmp = page.render(scale=scale)
        img = bmp.to_pil()
    finally:
        doc.close()
    if img.height > img.width:  # 直式 → 逆時針轉正
        img = img.rotate(90, expand=True)
    flipped = img.rotate(180)
    if _orientation_score(flipped) > _orientation_score(img) * 1.15:
        img = flipped  # 倒置圖：180° 修正（1.15 遲滯防抖動）
    return img


def _ocr(img, tile=2200, overlap=200):
    """分塊 EasyOCR → [(cx, cy, text, conf, h)]（座標為圖面像素，h=字高）。

    工程圖大幅面整張餵 OCR 會掉字，分塊掃描後合併；tile 交界重複命中由
    後續同 tag 去重吸收。
    """
    import numpy as np

    reader = _get_reader()
    out = []
    W, H = img.width, img.height
    step = tile - overlap
    for ty in range(0, H, step):
        for tx in range(0, W, step):
            crop = img.crop((tx, ty, min(tx + tile, W), min(ty + tile, H)))
            results = reader.readtext(
                np.array(crop.convert("RGB")),
                # '/' 供跨圖接續標記（070-2/01）；位號不含 '/'，分類不受影響
                allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/",
                text_threshold=0.5, low_text=0.3,
            )
            for bbox, text, conf in results:
                if conf < 0.35 or not text.strip():
                    continue
                cx = tx + sum(p[0] for p in bbox) / 4
                cy = ty + sum(p[1] for p in bbox) / 4
                hh = max(p[1] for p in bbox) - min(p[1] for p in bbox)
                out.append((cx, cy, text.strip(), float(conf), hh))
    return out


# 碎片合併：P&ID 位號常被 OCR 拆成「字母前綴」＋「數字」兩塊
# （設備大字 V ‧ 613 有間距；儀錶圈 TI 在上半、6501 在下半）
_PREFIX_RE = re.compile(r"^[A-Z]{1,3}$")
_NUM_RE = re.compile(r"^\d{3,5}[A-Z]{0,2}$")


def _dedupe_hits(hits):
    """tile 交界的重複命中 → 空間去重：

    1. 同文字近距 → 取高信心（除完全重複的幽靈）
    2. 一者為另一者子字串且近距 → 丟棄短的那個（tile 邊界常把「65101」
       部分截斷讀成獨立的「101」、把「FR」讀成獨立的「R」——這些殘缺
       碎片會在後續合併階段被誤配對成幽靈設備，例如 R101（實為
       FR65101 儀錶旁的殘缺碎片，非真實設備）。"""
    # 長文字優先處理（子字串判斷需要「完整版先進 kept」，若按信心排序，
    # 殘缺碎片信心有時反而更高（如「101」1.0 vs「65101」0.88），會讓
    # 子字串判斷失效）；同長度時信心高者優先。
    kept = []
    for cx, cy, t, conf, h in sorted(hits, key=lambda x: (-len(x[2]), -x[3])):
        dup = False
        for cx2, cy2, t2, conf2, h2 in kept:
            if abs(cx - cx2) > max(h, h2) * 2.0 or abs(cy - cy2) > max(h, h2) * 2.0:
                continue
            if t == t2 or t in t2:
                dup = True
                break
        if not dup:
            kept.append((cx, cy, t, conf, h))
    return kept


def _merge_fragments(hits):
    """字母前綴與鄰近數字合併成完整位號；已完整的原樣保留。

    兩輪配對：先長前綴（2-3 字母，儀錶 TI/PDI…），再單字母（設備 V/E/C…）
    ——避免 FR101 的 101 被單獨的 R 搶走生成幽靈設備。
    """
    merged = list(hits)
    used = set()
    for pass_len in (2, 1):  # 先 ≥2 字母，後單字母
        for i, (cx, cy, t, conf, h) in enumerate(hits):
            if not _PREFIX_RE.match(t) or (len(t) >= 2) != (pass_len == 2):
                continue
            best, best_d = None, float("inf")
            for j, (cx2, cy2, t2, conf2, h2) in enumerate(hits):
                if j == i or j in used or not _NUM_RE.match(t2):
                    continue
                dx, dy = cx2 - cx, cy2 - cy
                d = (dx * dx + dy * dy) ** 0.5
                # 鄰近判定：距離 < 3 倍字高，且在右方或下方（位號閱讀方向）
                if d < 3.0 * max(h, h2) and (dx > -h or dy > -h):
                    if d < best_d:
                        best, best_d = j, d
            if best is not None:
                cx2, cy2, t2, conf2, h2 = hits[best]
                used.add(best)
                merged.append(((cx + cx2) / 2, (cy + cy2) / 2, t + t2, min(conf, conf2), max(h, h2)))
    return merged, used


def _rescue_orphans(img, hits, used):
    """孤兒大字數字補刀：設備位號的單字母前綴常被 OCR 吞掉（貼著符號線條），
    對高信心、大字、未配對的 3 碼數字，裁其左側小窗做低門檻字母專掃。"""
    import numpy as np

    reader = _get_reader()
    heights = [h for *_, h in hits] or [30]
    med_h = sorted(heights)[len(heights) // 2]
    rescued = []
    for j, (cx, cy, t, conf, h) in enumerate(hits):
        if j in used or not re.match(r"^\d{3}$", t) or conf < 0.8 or h < med_h * 1.3:
            continue
        # 左側窗（約 3 個字寬）
        x0 = max(0, int(cx - 4.2 * h))
        x1 = max(0, int(cx - 0.8 * h))
        y0 = max(0, int(cy - 1.2 * h))
        y1 = min(img.height, int(cy + 1.2 * h))
        if x1 - x0 < 10:
            continue
        crop = img.crop((x0, y0, x1, y1))
        # 預處理：去水平底線（位號底線會讓貼線字母認不出）＋放大 2x
        arr = np.array(crop.convert("L"))
        dark = arr < 128
        line_len = int(h * 0.8)
        for yy in range(dark.shape[0]):
            run = 0
            row = dark[yy]
            for xx in range(len(row)):
                if row[xx]:
                    run += 1
                else:
                    if run > line_len:
                        arr[yy, xx - run:xx] = 255
                    run = 0
            if run > line_len:
                arr[yy, -run:] = 255
        from PIL import Image

        clean = Image.fromarray(arr).resize((arr.shape[1] * 2, arr.shape[0] * 2))
        best_letter, best_conf = None, 0.0
        for bbox, text, c in reader.readtext(
            np.array(clean.convert("RGB")),
            allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            text_threshold=0.25, low_text=0.15,
        ):
            tt = text.strip()
            if len(tt) == 1 and c > best_conf:
                best_letter, best_conf = tt, c
        if best_letter and best_conf > 0.3:
            rescued.append((cx, cy, best_letter + t, min(conf, best_conf), h))
    return rescued


# ------------------------------------------------- 設備尺寸挖掘（模型比例真實化）
# P&ID 設備標題三行制：「V 613」/「REACTOR PRODUCTS SEPARATOR」/「1700 X 5100」
# （mm，殼徑 X 切線長）。OCR 實測讀法：'1700' + 'X-5100' 兩 token 同行，
# header 位號常只剩數字（'613'，字母貼底線被吃）→ 從尺寸行往上找位號行。
# 縮徑塔兩段殼徑分隔符：1600/2000、1600AND2000、1600AND-2000（OCR 讀法不一）
# X 前後都可能黏 OCR 連字號（'3000-X5100'、'X-5100'——空格被讀成 '-'）
_SEP = r"(?:/|AND-?|-)"
_DIM_JOINED_RE = re.compile(rf"^(\d{{3,5}})(?:{_SEP}(\d{{3,5}}))?-?X-?(\d{{4,5}})$")
_DIM_NUM_RE = re.compile(rf"^(\d{{3,5}})(?:{_SEP}(\d{{3,5}}))?$")
_DIM_XNUM_RE = re.compile(r"^-?X-?(\d{4,5})$")
# 有尺寸意義的素材類型 → dims 鍵
_SIZED_TYPES = {"reactor": "h", "column": "h", "tank": "h", "flash_v": "h",
                "cyclone": "h", "hx": "len"}


def _dim_candidates(hits) -> list:
    """命中 → 尺寸候選 [(cx, cy, h, 殼徑mm, 長mm)]。

    三形態：joined（1700X5100）、num+Xnum（'1700'+'X-5100' 同行）、
    縮徑塔雙徑（1600AND2000 取大者）。
    """
    def left_num(cx, cy, h):
        for cx2, cy2, t2, conf2, h2 in hits:
            mn = _DIM_NUM_RE.match(t2)
            if mn and abs(cy2 - cy) < h and 0 < cx - cx2 < 8 * h:
                return max(int(mn.group(1)), int(mn.group(2) or 0))
        return None

    out = []
    for cx, cy, t, conf, h in hits:
        m = _DIM_JOINED_RE.match(t)
        if m:
            d = max(int(m.group(1)), int(m.group(2) or 0))
            out.append((cx, cy, h, d, int(m.group(3))))
            continue
        mx = _DIM_XNUM_RE.match(t)
        if mx:  # 'X-5100' 黏字形：往左找同列殼徑數字
            d = left_num(cx, cy, h)
            if d:
                out.append((cx, cy, h, d, int(mx.group(1))))
            continue
        if t == "X":  # 三連 token 形：'3000' 'X' '5100'
            d = left_num(cx, cy, h)
            if d is None:
                continue
            best = None
            for cx2, cy2, t2, conf2, h2 in hits:
                m2 = re.match(r"^(\d{4,5})$", t2)
                if m2 and abs(cy2 - cy) < h and 0 < cx2 - cx < 8 * h:
                    if best is None or cx2 < best[0]:
                        best = (cx2, int(m2.group(1)))
            if best:
                out.append((cx, cy, h, d, best[1]))
    return out


def _dim_sane(d_mm: int, l_mm: int) -> bool:
    return 300 <= d_mm <= 8000 and 1500 <= l_mm <= 60000 and l_mm >= d_mm


def _mine_dims(raw, equips) -> dict:
    """OCR 命中 → {位號: (殼徑mm, 長mm)}。

    位號關聯：尺寸行正上方 1~6 字高內的 header 位號（完整位號或裸數字
    ——裸數字對回唯一符合的分類設備；header 字母常貼底線被吃）。
    """
    by_num: dict[str, list] = {}
    for tag in equips:
        num = re.sub(r"^[A-Z]+-?", "", tag)
        by_num.setdefault(num, []).append(tag)

    out = {}
    for cx, cy, h, d_mm, l_mm in _dim_candidates(raw):
        if not _dim_sane(d_mm, l_mm):
            continue  # 非設備尺寸（管號/座標等）
        best, best_d = None, float("inf")
        for cx2, cy2, t2, conf2, h2 in raw:
            dy = cy - cy2  # header 位號在尺寸行上方
            if not (h * 0.8 < dy < h * 6.5) or abs(cx2 - cx) > 10 * h:
                continue
            tag = None
            t2n = t2.replace("-", "")
            if t2n in equips:
                tag = t2n
            elif t2n in by_num and len(by_num[t2n]) == 1:
                tag = by_num[t2n][0]
            if tag is not None:
                dist = dy + abs(cx2 - cx)
                if dist < best_d:
                    best, best_d = tag, dist
        if best and best not in out:
            out[best] = (d_mm, l_mm)
    return out


def _rescue_dims(img, raw, equips, have) -> dict:
    """尺寸定向補刀：全域掃描沒挖到的設備，裁其位號命中的正下方窗，
    放大 2x＋限字元集重掃（同 V613 救 V 的套路——header 區小字/貼線
    數字全域掃描常讀爛，限縮候選字元後補刀成功率高）。"""
    import numpy as np

    reader = _get_reader()
    out = {}
    for tag in equips:
        if tag in have:
            continue
        num = re.sub(r"^[A-Z]+-?", "", tag)
        anchors = []
        for cx, cy, t, conf, h in raw:
            tn = t.replace("-", "")
            if tn == tag or tn == num or (
                    tn.startswith(tag[0]) and num in tn and len(tn) <= len(tag) + 3):
                anchors.append((cx, cy, h))
        # 同一窗微調重試：EasyOCR 偵測分組對窗口位置敏感（20px 平移就會
        # 把「5100」黏進鄰字或漏偵），多窗多一次分組落對的機會
        for cx, cy, h in anchors:
            for pad, scale in ((10.0, 2), (11.5, 2), (9.0, 3)):
                x0 = max(0, int(cx - pad * h))
                x1 = min(img.width, int(cx + pad * h))
                y0 = int(cy + 0.5 * h)
                y1 = min(img.height, int(cy + 8 * h))
                if y1 - y0 < 10 or x1 - x0 < 10:
                    continue
                crop = img.crop((x0, y0, x1, y1))
                crop = crop.resize((crop.width * scale, crop.height * scale))
                hits2 = []
                # 完整字元集——限縮字元集會把行內單位字（M^3/MT）硬轉成
                # 數字垃圾並把鄰近尺寸一起攪爛；字母開放讓雜字自然成雜字
                for bbox, text, c in reader.readtext(
                        np.array(crop.convert("RGB")),
                        allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/",
                        text_threshold=0.35, low_text=0.25):
                    t2 = text.strip().replace(" ", "")
                    hcx = sum(p[0] for p in bbox) / (4 * scale) + x0
                    hcy = sum(p[1] for p in bbox) / (4 * scale) + y0
                    hh = (max(p[1] for p in bbox) - min(p[1] for p in bbox)) / scale
                    hits2.append((hcx, hcy, t2, c, hh))
                cands = _dim_candidates(hits2)
                # token 分組免疫：同列 token 依 x 串接後全文搜尺寸樣式
                rows: dict[int, list] = {}
                for hcx, hcy, t2, c, hh in hits2:
                    rows.setdefault(round(hcy / max(hh, 8)), []).append((hcx, t2))
                for row in rows.values():
                    joined = "".join(t for _, t in sorted(row))
                    m = re.search(rf"(\d{{3,5}})(?:{_SEP}(\d{{3,5}}))?-?X-?(\d{{4,5}})", joined)
                    if m:
                        d = max(int(m.group(1)), int(m.group(2) or 0))
                        cands.append((0, 0, 0, d, int(m.group(3))))
                for _cx, _cy, _h, d_mm, l_mm in cands:
                    if _dim_sane(d_mm, l_mm):
                        out[tag] = (d_mm, l_mm)
                        break
                if tag in out:
                    break
            if tag in out:
                break
    return out


def _apply_dims(entry: dict, d_mm: int, l_mm: int) -> bool:
    """把挖到的實尺寸套進設備 dims（依素材類型；mm→m）。"""
    key = _SIZED_TYPES.get(entry["type"])
    if not key:
        return False
    entry["dims"] = {"r": round(d_mm / 2000, 2), key: round(l_mm / 1000, 2)}
    entry.setdefault("design", {})["尺寸來源"] = f"P&ID 標題 {d_mm}×{l_mm}mm"
    return True


def _extract_connectors(hits) -> list:
    """OCR 命中 → 跨圖接續標記清單（同標記取信心最高者）。"""
    conns = {}
    for cx, cy, text, conf, _h in hits:
        m = CONN_RE.match(text.replace(" ", ""))
        if not m:
            continue
        label = m.group(0)
        if label not in conns or conf > conns[label][2]:
            conns[label] = (cx, cy, conf, m.group(1), m.group(2))
    return [{"label": lb, "tgt": tgt, "cid": cid,
             "cx": round(cx, 1), "cy": round(cy, 1), "conf": round(conf, 2)}
            for lb, (cx, cy, conf, tgt, cid) in conns.items()]


def _classify(hits, page_w=None, page_h=None, margin=0.055):
    """OCR 命中 → 設備/儀錶清單（同 tag 取信心最高者）。

    設備位號在頁面外緣帶（margin）的命中不參賽——那是 off-page 參照
    /PFD 名稱列（「To C219」、上下緣設備名列）；**必須在 hit 層過濾**：
    若先取最高信心再過濾，名稱列副本會贏過圖中實例然後整組被殺
    （C618/C620 曾因此消失）。
    """
    equips, insts = {}, {}
    for cx, cy, text, conf, _h in hits:
        t = text.replace(" ", "").replace("-", "")  # 正規化去連字號（E-651≡E651）
        if BLACKLIST_RE.match(t) or "/" in t:
            continue
        in_margin = page_w and not (
            margin * page_w < cx < (1 - margin) * page_w
            and margin * page_h < cy < (1 - margin) * page_h)
        if INST_RE.match(t):
            if t not in insts or conf > insts[t][2]:
                insts[t] = (cx, cy, conf)
        elif EQUIP_RE.match(t) and conf >= EQUIP_MIN_CONF and t[0] in TYPE_MAP:
            if in_margin:
                continue
            if t not in equips or conf > equips[t][2]:
                equips[t] = (cx, cy, conf)
    return equips, insts


def _push_apart(pos: dict, min_gap: float = 3.5):
    """就地把 {tag: [x,0,z]} 推到彼此最小間距外（簡單迭代）。"""
    tags = list(pos)
    for _ in range(30):
        moved = False
        for i in range(len(tags)):
            for j in range(i + 1, len(tags)):
                a, b = pos[tags[i]], pos[tags[j]]
                dx, dz = b[0] - a[0], b[2] - a[2]
                d = (dx * dx + dz * dz) ** 0.5
                if d < min_gap:
                    push = (min_gap - d) / 2 + 0.05
                    if d < 1e-6:
                        dx, dz, d = 1, 0, 1
                    a[0] -= dx / d * push
                    a[2] -= dz / d * push
                    b[0] += dx / d * push
                    b[2] += dz / d * push
                    moved = True
        if not moved:
            break
    for t in tags:
        pos[t] = [round(pos[t][0], 2), 0, round(pos[t][2], 2)]
    return pos


def _layout(equips: dict, width: float, height: float, span_x=56.0, span_z=36.0, min_gap=3.5):
    """圖面像素座標 → 場景 (x, z)，正規化置中＋最小間距推開。"""
    if not equips:
        return {}
    xs = [v[0] for v in equips.values()]
    ys = [v[1] for v in equips.values()]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    sx = span_x / max(x1 - x0, 1)
    sz = span_z / max(y1 - y0, 1)
    s = min(sx, sz)
    pos = {}
    for tag, (cx, cy, conf) in equips.items():
        x = (cx - (x0 + x1) / 2) * s
        z = (cy - (y0 + y1) / 2) * s  # PDF y 向下 = 場景 +z（俯視）
        pos[tag] = [round(x, 2), 0, round(z, 2)]
    return _push_apart(pos, min_gap)


def _slugify(stem: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


# ------------------------------------------------- 管線向量抽取（3D 化）
# CAD PDF 的線 = stroke 路徑（文字/箭頭是 fill，線寬屬性無意義——實測
# 主管線與引線同寬 0.8，**長度**才是判準：主管線長、引線/符號/字短）。
PIPE_MIN_LEN = 60.0    # pt；主管線閾值（A3 圖上約 21mm）
PIPE_MAX_SEG = 400     # 每張圖最多收的管段數（防雲形/密集雜線塞爆場景）


def extract_pipes(pdf_path: Path) -> tuple[list, float, float]:
    """P&ID 向量線 → 管線 polyline 清單（頁面座標）＋頁面尺寸。

    過濾器（C12070-1 疊圖驗證逐一調出）：
    1. 只收 stroke 路徑、跳過含 Bezier 的（儀錶圓圈/弧）
    2. 長度 ≥ PIPE_MIN_LEN（殺引線/符號/文字/虛線的短段）
    3. 閉合迴路剔除（殺儀錶方框/六角框/容器輪廓）
    4. 雲形剔除（段數多且平均段長短 = 修訂雲）
    5. 頁緣框線剔除（貼邊的長直線 = 圖框）
    """
    import ctypes

    import pypdfium2 as pdfium
    import pypdfium2.raw as praw

    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc[0]
        pw, ph = page.get_size()
        n = praw.FPDFPage_CountObjects(page.raw)
        out = []

        def flush(cur, has_bezier):
            if len(cur) < 2 or has_bezier:
                return
            length = sum(math.dist(cur[k], cur[k + 1]) for k in range(len(cur) - 1))
            if length < PIPE_MIN_LEN:
                return
            if math.dist(cur[0], cur[-1]) < 5.0:  # 閉合迴路
                return
            if len(cur) > 12 and length / (len(cur) - 1) < 8.0:  # 雲形
                return
            xs = [q[0] for q in cur]
            ys = [q[1] for q in cur]
            margin = 26.0
            if (min(xs) < margin or max(xs) > pw - margin
                    or min(ys) < margin or max(ys) > ph - margin) and length > 300:
                return  # 圖框/標題欄長線
            out.append((cur, length))

        for i in range(n):
            obj = praw.FPDFPage_GetObject(page.raw, i)
            if praw.FPDFPageObj_GetType(obj) != praw.FPDF_PAGEOBJ_PATH:
                continue
            fill = ctypes.c_int()
            stroke = ctypes.c_int()
            praw.FPDFPath_GetDrawMode(obj, ctypes.byref(fill), ctypes.byref(stroke))
            if not stroke.value:
                continue
            m = praw.FS_MATRIX()
            praw.FPDFPageObj_GetMatrix(obj, ctypes.byref(m))
            cur: list = []
            has_bezier = False
            for j in range(praw.FPDFPath_CountSegments(obj)):
                seg = praw.FPDFPath_GetPathSegment(obj, j)
                x = ctypes.c_float()
                y = ctypes.c_float()
                praw.FPDFPathSegment_GetPoint(seg, ctypes.byref(x), ctypes.byref(y))
                st = praw.FPDFPathSegment_GetType(seg)
                X = m.a * x.value + m.c * y.value + m.e
                Y = m.b * x.value + m.d * y.value + m.f
                if st == praw.FPDF_SEGMENT_MOVETO:
                    flush(cur, has_bezier)
                    cur, has_bezier = [(X, Y)], False
                else:
                    if st == praw.FPDF_SEGMENT_BEZIERTO:
                        has_bezier = True
                    cur.append((X, Y))
            flush(cur, has_bezier)
    finally:
        doc.close()
    out.sort(key=lambda t: -t[1])  # 長的優先（超量時保主幹）
    return [pl for pl, _ in out[:PIPE_MAX_SEG]], pw, ph


def _save_tiles(img, stem: str) -> str:
    """OCR 渲染圖轉存圖紙底圖（hi：單圖場景讀位號用；lo：整廠 30 張省 GPU）。
    回傳 hi 檔 URL 路徑。"""
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    slug = _slugify(stem)
    for suffix, width in (("", 2900), ("_lo", 1300)):
        w = min(width, img.width)
        h = round(img.height * w / img.width)
        img.resize((w, h)).convert("RGB").save(
            TILE_DIR / f"{slug}{suffix}.jpg", quality=80)
    return f"/uploads/pid/_tiles/{slug}.jpg"


def _pixel_true_layout(equips: dict, width: float, height: float,
                       tile_w: float = TILE_W, min_gap: float = 2.2):
    """圖面像素座標 → 場景座標，**與圖紙底圖對齊**（整頁仿射映射，
    非設備範圍正規化）。微幅推開只防模型完全交疊，保住對圖性。"""
    tile_h = tile_w * height / width
    pos = {
        tag: [round((cx / width - 0.5) * tile_w, 2), 0,
              round((cy / height - 0.5) * tile_h, 2)]
        for tag, (cx, cy, conf) in equips.items()
    }
    return _push_apart(pos, min_gap), tile_h


PIPE_Y = 1.8   # 管線離地高（避開地毯、低於設備頂；>1.6 不觸發敷設管架）
PIPE_R = 0.11


def _pipes_to_uv(polylines: list, pw: float, ph: float) -> list:
    """頁面座標 polyline → (u,v) 分數座標（0-1，與轉正後圖紙同向）。"""
    portrait = ph > pw  # 與 _render 的直式轉正一致
    out = []
    for pl in polylines:
        if portrait:
            uv = [((ph - y) / ph, (pw - x) / pw) for x, y in pl]
        else:
            uv = [(x / pw, (ph - y) / ph) for x, y in pl]
        out.append([(round(u, 4), round(v, 4)) for u, v in uv])
    return out


def _uv_to_scene_pipes(pipes_uv: list, tile_w: float, tile_h: float,
                       ox: float = 0.0, oz: float = 0.0, limit: int | None = None) -> list:
    """(u,v) 管線 → 場景 pipes[]（可帶群聚原點偏移；與圖紙地毯對位）。"""
    out = []
    for uv in (pipes_uv[:limit] if limit else pipes_uv):
        pts = [[round((u - 0.5) * tile_w + ox, 2), PIPE_Y,
                round((v - 0.5) * tile_h + oz, 2)] for u, v in uv]
        out.append({"pts": pts, "r": PIPE_R})
    return out


def snap_pipes_to_equipment(pipes: list, equipment: list):
    """管線端點鄰近設備時，端點加垂直立管＋水平短段接進設備身
    （視覺上「插進」容器，不再懸空斷頭）。就地修改 pipes。"""
    for pipe in pipes:
        if pipe.get("bridge"):
            continue
        pts = pipe["pts"]
        for endi in (0, -1):
            ex, ey, ez = pts[endi]
            best, best_d = None, float("inf")
            for eq in equipment:
                dims = eq.get("dims", {})
                r = dims.get("r") or max(dims.get("w", 2.0), dims.get("d", 2.0)) / 2
                qx, _, qz = eq["pos"]
                d = math.hypot(ex - qx, ez - qz)
                if d < r + 2.5 and d < best_d:
                    best, best_d = eq, d
            if best is None:
                continue
            dims = best.get("dims", {})
            h = dims.get("h") or dims.get("len") or 2.0
            y_conn = min(max(h * 0.55, 1.2), 6.0)  # 接進設備中腹（高塔封頂 6m）
            qx, _, qz = best["pos"]
            joint = [[round(ex, 2), round(y_conn, 2), round(ez, 2)],
                     [round(qx, 2), round(y_conn, 2), round(qz, 2)]]
            if endi == 0:
                pts[:0] = joint[::-1]
            else:
                pts.extend(joint)


def parse_pid(filename: str) -> dict:
    """主入口：P&ID 檔名 → 場景草稿 dict ＋解析統計。"""
    pdf_path = PID_DIR / Path(filename).name
    if not pdf_path.exists():
        raise FileNotFoundError(filename)
    img = _render(pdf_path)
    raw = _dedupe_hits(_ocr(img))
    hits, used = _merge_fragments(raw)
    hits += _rescue_orphans(img, raw, used)
    equips, insts = _classify(hits, img.width, img.height)
    # 混淆前綴對決（C↔E、F↔E OCR 字形相近）：同一張圖同號多前綴＝誤讀，
    # 取信心高者（如 PFD 的 C665 vs E665）
    CONFUSABLE = [{"C", "E"}, {"F", "E"}]
    by_num: dict[str, list] = {}
    for t in list(equips):
        by_num.setdefault(re.sub(r"^[A-Z]+-?", "", t), []).append(t)
    for num, tags in by_num.items():
        if len(tags) < 2:
            continue
        for pair in CONFUSABLE:
            dup = [t for t in tags if t[0] in pair]
            if len(dup) >= 2:
                dup.sort(key=lambda t: -equips[t][2])
                for loser in dup[1:]:
                    equips.pop(loser, None)
    # 跨單元參照過濾：以本圖設備數字「百位系列」眾數為主系列（TA32=6xx），
    # 異系列位號（C712/C812/V721/C219…）＝「To xxx」流向標的，非本單元設備。
    # 樣本 <3 不啟用（小圖不可靠）。
    if len(equips) >= 3:
        from collections import Counter
        hundreds = [re.sub(r"^[A-Z]+-?", "", t)[0] for t in equips]
        series, n_series = Counter(hundreds).most_common(1)[0]
        if n_series >= 3:
            equips = {t: v for t, v in equips.items()
                      if re.sub(r"^[A-Z]+-?", "", t)[0] == series}
    connectors = _extract_connectors(hits)
    dims_mm = _mine_dims(raw, equips)
    dims_mm.update(_rescue_dims(img, raw, equips, set(dims_mm)))
    tile_url = _save_tiles(img, Path(filename).stem)
    pos, tile_h = _pixel_true_layout(equips, img.width, img.height)
    pipe_polys, page_w, page_h = extract_pipes(pdf_path)
    pipes_uv = _pipes_to_uv(pipe_polys, page_w, page_h)

    # 儀錶掛最近設備＋圖面位置（3D 標記用，與地毯對位）
    W, H = img.width, img.height
    inst_of_eq: dict[str, list] = {t: [] for t in equips}
    instruments = {}
    for itag, (icx, icy, iconf) in insts.items():
        best, best_d = None, float("inf")
        for etag, (ecx, ecy, _) in equips.items():
            d = (icx - ecx) ** 2 + (icy - ecy) ** 2
            if d < best_d:
                best, best_d = etag, d
        prefix = itag[0]
        instruments[itag] = {
            "name": itag, "unit": INST_UNIT.get(prefix, ""), "base": 0,
            "equipment": best or "",
            "pos": [round((icx / W - 0.5) * TILE_W, 2),
                    round((icy / H - 0.5) * (TILE_W * H / W), 2)],
        }
        if best:
            inst_of_eq[best].append(itag)

    equipment = []
    items = []
    for tag, (cx, cy, conf) in sorted(equips.items()):
        etype = TYPE_MAP.get(tag[0], "block")
        entry = {
            "tag": tag, "name": TYPE_NAME.get(etype, "設備"), "type": etype,
            "pos": pos[tag], "rot_y": 0,
            "dims": dict(TYPE_DIMS.get(etype, TYPE_DIMS["block"])),
            "pid_ref": Path(filename).stem, "design": {},
            "instruments": inst_of_eq.get(tag, []),
        }
        sized = tag in dims_mm and _apply_dims(entry, *dims_mm[tag])
        equipment.append(entry)
        items.append({"tag": tag, "type": etype, "conf": round(conf, 2),
                      "dims_mm": list(dims_mm[tag]) if sized else None})

    scene_pipes = _uv_to_scene_pipes(pipes_uv, TILE_W, tile_h)
    snap_pipes_to_equipment(scene_pipes, equipment)

    scene = {
        "plant": {
            "id": Path(filename).stem.upper(),
            "name": f"P&ID 草稿｜{Path(filename).stem}",
            "units": [{"id": "U-PID", "name": "P&ID 解析", "equipment": equipment}],
        },
        # 管線 3D 化：向量抽取的主管線浮在圖紙上方（與地毯對位）
        "pipes": scene_pipes,
        "instruments": instruments,
        # 圖紙底圖：設備即站在圖面自己的位置上（像素保真佈局），直接對圖
        "underlays": [{"image": tile_url, "x": 0, "z": 0,
                       "w": TILE_W, "h": round(tile_h, 2)}],
    }
    return {
        "scene": scene,
        "stats": {
            "ocr_hits": len(hits),
            "equipment": len(equipment),
            "instruments": len(instruments),
            "pipes": len(pipes_uv),
            "items": items,
        },
        # 整廠合併需要的原始幾何（像素座標與頁面尺寸）
        "geom": {
            "page_w": img.width, "page_h": img.height,
            "px": {tag: [round(c[0], 1), round(c[1], 1)] for tag, c in equips.items()},
            "inst_uv": {itag: [round(c[0] / img.width, 4), round(c[1] / img.height, 4)]
                        for itag, c in insts.items()},
            "tile_lo": tile_url.replace(".jpg", "_lo.jpg"),
            "pipes_uv": pipes_uv,
            "dims_mm": {tag: list(v) for tag, v in dims_mm.items()},
            # 跨圖接續標記（縫合用；cx/cy 為轉正後圖像像素）
            "connectors": [{**c, "u": round(c["cx"] / img.width, 4),
                            "v": round(c["cy"] / img.height, 4)} for c in connectors],
        },
    }
