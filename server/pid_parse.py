"""P&ID 自動解析建模 — 上傳圖面 → OCR 抽位號 → 3D 場景草稿。

工作流：使用者上傳 P&ID（CAD 轉出的 PDF 文字多已曲線化，無文字層）
→ pypdfium2 渲染高解析圖 → EasyOCR 抽文字＋座標 → 正則抽設備/儀錶位號
→ 位號首字母映射素材類型、圖面座標映射場景佈局 → 存場景草稿
→ 使用者在 3D 編輯器開啟草稿修改（刪誤抓/調位置/補管線）。

草稿哲學：**寧可多抓給使用者刪，不要少抓讓使用者補**——編輯器的
undo/delete 就是清理誤抓的工作流。
"""

from __future__ import annotations

import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PID_DIR = BASE_DIR / "uploads" / "pid"

# ---------------------------------------------------------------- 位號規則
# 儀錶位號（先判，避免被設備規則吃掉）
INST_RE = re.compile(
    r"^(TI|TIC|TE|TT|TV|TR|PI|PIC|PT|PDI|PDT|PR|FI|FIC|FT|FE|FV|FR|LI|LIC|LT|LG|LV|LR|"
    r"AI|AT|AR|HV|XV|VS|GD|SD|SFS|FSL|FAL|FALL|LSH|LSL|LAH|LAL|PAH|PAL|PDAH|STR|HS|ZS)"
    r"-?\d{3,5}[A-Z]?$"
)
# 設備位號：1-2 個字母 + 3 碼數字（可帶字尾 A/B/AB 或 -1）
EQUIP_RE = re.compile(r"^[A-Z]{1,2}-?\d{3}(?:[A-Z]{1,2}|-\d)?$")

# 首字母 → 編輯器素材類型
TYPE_MAP = {
    "R": "reactor", "C": "column", "T": "tank", "V": "flash_v", "E": "hx",
    "P": "pump", "F": "furnace", "B": "compressor", "K": "compressor",
    "S": "cyclone", "M": "block", "D": "flash_v", "G": "pump",
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


def _render(pdf_path: Path, scale: float = 6.0):
    """渲染第一頁；直式頁面（CAD 橫圖轉 90° 存檔的常態）自動轉正。"""
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
                allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
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


def _classify(hits):
    """OCR 命中 → 設備/儀錶清單（同 tag 取信心最高者）。"""
    equips, insts = {}, {}
    for cx, cy, text, conf, _h in hits:
        t = text.replace(" ", "").replace("-", "")  # 正規化去連字號（E-651≡E651）
        if BLACKLIST_RE.match(t):
            continue
        if INST_RE.match(t):
            if t not in insts or conf > insts[t][2]:
                insts[t] = (cx, cy, conf)
        elif EQUIP_RE.match(t) and conf >= EQUIP_MIN_CONF:
            if t not in equips or conf > equips[t][2]:
                equips[t] = (cx, cy, conf)
    return equips, insts


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
    # 最小間距推開（簡單迭代）
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


def parse_pid(filename: str) -> dict:
    """主入口：P&ID 檔名 → 場景草稿 dict ＋解析統計。"""
    pdf_path = PID_DIR / Path(filename).name
    if not pdf_path.exists():
        raise FileNotFoundError(filename)
    img = _render(pdf_path)
    raw = _dedupe_hits(_ocr(img))
    hits, used = _merge_fragments(raw)
    hits += _rescue_orphans(img, raw, used)
    equips, insts = _classify(hits)
    pos = _layout(equips, img.width, img.height)

    # 儀錶掛最近設備
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
        }
        if best:
            inst_of_eq[best].append(itag)

    equipment = []
    items = []
    for tag, (cx, cy, conf) in sorted(equips.items()):
        etype = TYPE_MAP.get(tag[0], "block")
        equipment.append({
            "tag": tag, "name": TYPE_NAME.get(etype, "設備"), "type": etype,
            "pos": pos[tag], "rot_y": 0,
            "dims": dict(TYPE_DIMS.get(etype, TYPE_DIMS["block"])),
            "pid_ref": Path(filename).stem, "design": {},
            "instruments": inst_of_eq.get(tag, []),
        })
        items.append({"tag": tag, "type": etype, "conf": round(conf, 2)})

    scene = {
        "plant": {
            "id": Path(filename).stem.upper(),
            "name": f"P&ID 草稿｜{Path(filename).stem}",
            "units": [{"id": "U-PID", "name": "P&ID 解析", "equipment": equipment}],
        },
        "pipes": [],
        "instruments": instruments,
    }
    return {
        "scene": scene,
        "stats": {
            "ocr_hits": len(hits),
            "equipment": len(equipment),
            "instruments": len(instruments),
            "items": items,
        },
    }
