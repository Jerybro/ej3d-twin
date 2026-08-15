# 辨識結果自動檢查 —— 共用讀取層
#
# 這批工具是**離線評測腳本**，不進工作台 UI：這一輪要回答的是「這些檢查
# 方法在我們的圖上抓不抓得到錯」，數字還沒出來就動 UI 等於賭它有效。
# 腳本形態才做得到批次重跑、掃描多組閾值、結果落地可複算。
#
# 方法出處：Kim et al. 2025, "Automated inspection of P&ID object recognition
# using deep learning" (Sci Rep 15) —— 未辨識檢查 recall 100%、誤辨識檢查
# 符號 98.8%/文字 94.6-96.6%/線 100%，人工修正時間減約 40%。
# 我們只抄它的**判準**，不抄它的閾值：論文的 25px/5px 是它們圖的解析度，
# 照搬到別的 DPI 上沒有意義，全部參數化並掃描。
from __future__ import annotations

import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(BASE))

PID_DIR = BASE / "uploads" / "pid"
VLM_DIR = PID_DIR / "_vlm"
MODEL_DIR = BASE / "data" / "pid_model"
OUT_DIR = BASE / "data" / "pid_inspect"


def slug_of(pdf_name: str) -> str:
    from server.pid_vlm import _slug

    return _slug(Path(pdf_name).stem)


def load_meta(pdf_name: str) -> dict:
    """底圖 meta（w/h/rot/pw/ph）——文字層要靠 rot 才對得回模型座標。"""
    p = VLM_DIR / f"{slug_of(pdf_name)}.json"
    if not p.exists():
        from server.pid_vlm import _ensure_base

        _ensure_base(pdf_name)
    return json.loads(p.read_text(encoding="utf-8"))


def load_model(pdf_name: str, rebuild: bool = False) -> dict:
    """資產模型（沒有就現場建一次）。

    建模是純地端（OCR＋向量解析＋定位器），不打雲端 VLM，所以三張潤泰圖
    即使沒審過也建得出來——M0300/M0400 的台帳是 0，但它們各有清冊，
    定位器照樣跑得動。
    """
    p = MODEL_DIR / f"{slug_of(pdf_name)}.json"
    if rebuild or not p.exists():
        from server.pid_model import build_model

        return build_model(pdf_name, "")
    return json.loads(p.read_text(encoding="utf-8"))


# ------------------------------------------------------------------ 文字層
def pdf_text_boxes(pdf_name: str, meta: dict | None = None) -> list[dict]:
    """PDF 內嵌文字層 → 正規化框（與模型同一座標系）。

    潤泰的圖是向量 PDF，項次號（204.1、313.5、315-2）**直接躺在文字層裡**，
    有精確座標。這是零誤差的真值，可以拿來對帳 OCR——`recall 的分母不存在』
    這個評測難題，對文字這一類就此解決（台化的圖沒有可用文字層，仍需人判）。
    """
    import pdfplumber

    from server.pid_parse import pdf_to_norm

    meta = meta or load_meta(pdf_name)
    rot = int(meta.get("rot", 0))
    pdf_p = PID_DIR / Path(pdf_name).name
    out = []
    with pdfplumber.open(str(pdf_p)) as pdf:
        pg = pdf.pages[0]
        pw, ph = float(pg.width), float(pg.height)
        for w in pg.extract_words():
            # pdfplumber 的 top/bottom 由上而下量，pdf_to_norm 要的是 PDF
            # 原生（左下原點）座標；旋轉會換軸，所以四角都轉再取包絡。
            xs, ys = (float(w["x0"]), float(w["x1"])), \
                     (ph - float(w["bottom"]), ph - float(w["top"]))
            pts = [pdf_to_norm(x, y, pw, ph, rot) for x in xs for y in ys]
            us = [p[0] for p in pts]
            vs = [p[1] for p in pts]
            out.append({
                "text": str(w["text"]).strip(),
                "box": [min(us), min(vs), max(us), max(vs)],
                "cx": (min(us) + max(us)) / 2, "cy": (min(vs) + max(vs)) / 2,
            })
    return [t for t in out if t["text"]]


# ------------------------------------------------------------------ 模型內容
def ocr_texts(model: dict) -> list[dict]:
    """模型幾何層的 OCR 文字 → [{text, cx, cy, half_h, rot}]。

    註：台帳只存了中心點與半高，**沒有寬度**——OCR 命中在落地時就把框丟了。
    ②的距離判準需要左右邊界，只能由字數×字高推估（見 text.py 的 char_w），
    這是這一輪的已知誤差來源，會在報告裡標明。
    """
    out = []
    for e in (model.get("geometry") or {}).get("texts", []):
        if len(e) < 4:
            continue
        out.append({"text": str(e[2]).strip(), "cx": float(e[0]), "cy": float(e[1]),
                    "half_h": float(e[3]), "rot": (e[4] if len(e) > 4 else 0)})
    return [t for t in out if t["text"]]


def symbol_boxes(model: dict) -> list[dict]:
    """所有「符號框」——已審設備／儀錶／閥＋定位器候選＋偵測到的氣泡。

    分類保留（kind），因為設備框和儀錶氣泡的尺度差一個量級，用同一組閾值
    去判會得到一個誰都不代表的數字，報告要分開看。
    """
    out = []
    for e in model.get("equipment", []):
        b = e.get("bbox") or e.get("candidate_bbox")
        if b:
            out.append({"kind": "equipment", "tag": e.get("tag", ""), "box": list(b),
                        "confirmed": bool(e.get("bbox"))})
    for it in model.get("instruments", []):
        if it.get("bbox"):
            out.append({"kind": "instrument", "tag": it.get("tag", ""),
                        "box": list(it["bbox"]), "confirmed": True})
    for v in model.get("valves", []):
        if v.get("bbox"):
            out.append({"kind": "valve", "tag": v.get("id", ""),
                        "box": list(v["bbox"]), "confirmed": True})
    seen = {(round(s["box"][0], 4), round(s["box"][1], 4)) for s in out}
    for bb in (model.get("geometry") or {}).get("bubbles", []):
        if len(bb) < 3:
            continue
        x, y, r = float(bb[0]), float(bb[1]), float(bb[2])
        key = (round(x - r, 4), round(y - r, 4))
        if key in seen:
            continue
        out.append({"kind": "bubble", "tag": "", "box": [x - r, y - r, x + r, y + r],
                    "confirmed": False})
    return out


def pipes_of(model: dict) -> list[list]:
    return [list(s) for s in (model.get("geometry") or {}).get("pipes", [])]


def save_json(name: str, data) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / name
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return p
