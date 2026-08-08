# P&ID 標示化協作 — 地端 VLM 區域問答（產品3 互動層）
#
# 定位：不是「按一鍵自動解析完給你」，而是工程師框一塊圖面、當場問 AI、
# 確認後才採納成標註——模型原始輸出絕不直接入庫（人工驗證關卡）。
#
# 資安：影像推論全走本機 Ollama（127.0.0.1:11434），客戶 P&ID 不出這台機器。
# 與 aiassist.py / sprite.py 同原則、不同引擎（那兩者是文字 Qwen3.6@8787）。
from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/pid/vlm", tags=["pid-vlm"])

BASE_DIR = Path(__file__).resolve().parent.parent
PID_DIR = BASE_DIR / "uploads" / "pid"
VLM_DIR = PID_DIR / "_vlm"          # 底圖快取（runtime 產物，不進版控）
ANNOT_DIR = BASE_DIR / "data" / "pid_annot"

OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
VLM_MODEL = os.environ.get("PID_VLM_MODEL", "qwen2.5vl:7b")

# 雲端引擎（Anthropic Messages API）。注意：走雲端代表客戶圖面會離開這台機器——
# 中油／台化這類 NDA 場域上線前必須切回 local。UI 會明示目前引擎。
CLOUD_MODEL = os.environ.get("PID_CLOUD_MODEL", "claude-sonnet-5")
CLOUD_BASE = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")


def _cloud_key() -> str | None:
    return os.environ.get("ANTHROPIC_API_KEY") or None

BASE_W = 6000       # 底圖快取寬度（A1 CAD 圖夠讀小字，單檔約 5-8MB）
CROP_MIN = 900      # 裁切後放大到至少這麼寬（VLM 對小圖辨識率差）
CROP_MAX = 1600     # 上限（再大只是浪費 token）
_render_lock = threading.Lock()   # 大圖渲染吃記憶體，同時只跑一張


def _slug(stem: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


def _safe_pdf(filename: str) -> Path:
    """只允許 uploads/pid 底下的 PDF（擋路徑穿越）。"""
    name = Path(filename).name
    if not name.lower().endswith(".pdf"):
        raise HTTPException(422, "僅接受 PDF 圖面")
    p = PID_DIR / name
    if not p.exists():
        raise HTTPException(404, f"圖面不存在：{name}")
    return p


# ----------------------------------------------------------------- 底圖快取
def _ensure_base(filename: str) -> tuple[Path, dict]:
    """渲染整頁底圖並快取。沿用 pid_parse._render（同一套直式/倒置轉正邏輯），
    因此座標與自動解析結果同一個座標系，標註可直接對得上已解析的位號。"""
    pdf = _safe_pdf(filename)
    slug = _slug(pdf.stem)
    VLM_DIR.mkdir(parents=True, exist_ok=True)
    img_p = VLM_DIR / f"{slug}.jpg"
    meta_p = VLM_DIR / f"{slug}.json"
    if img_p.exists() and meta_p.exists():
        try:
            return img_p, json.loads(meta_p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass  # 快取毀損 → 重畫

    from .pid_parse import _render

    with _render_lock:
        rinfo: dict = {}
        img = _render(pdf, scale=3.0, info=rinfo)
        if img.width > BASE_W:
            img = img.resize((BASE_W, round(img.height * BASE_W / img.width)))
        img.convert("RGB").save(img_p, quality=88)
        # rot/pw/ph 供向量圖元（閥件）把 PDF 座標對回這張圖
        meta = {"w": img.width, "h": img.height,
                "url": f"/uploads/pid/_vlm/{slug}.jpg", "slug": slug,
                "rot": rinfo.get("rot", 0), "pw": rinfo.get("pw", 0),
                "ph": rinfo.get("ph", 0)}
    meta_p.write_text(json.dumps(meta), encoding="utf-8")
    return img_p, meta


def _crop_b64(filename: str, bbox: list) -> tuple[str, dict]:
    """依正規化 bbox（0-1，左上原點）裁切底圖 → base64 JPEG。

    小區域會被放大到 CROP_MIN，否則 VLM 讀不到管線上的小字。
    """
    from PIL import Image

    img_p, meta = _ensure_base(filename)
    x0, y0, x1, y1 = (float(v) for v in bbox)
    x0, x1 = sorted((max(0.0, x0), min(1.0, x1)))
    y0, y1 = sorted((max(0.0, y0), min(1.0, y1)))
    if (x1 - x0) < 0.002 or (y1 - y0) < 0.002:
        raise HTTPException(422, "框選範圍太小，請重新框選")

    W, H = meta["w"], meta["h"]
    pad = 0.004                       # 留一點邊，符號才不會被切掉外框
    px0 = max(0, int((x0 - pad) * W)); px1 = min(W, int((x1 + pad) * W))
    py0 = max(0, int((y0 - pad) * H)); py1 = min(H, int((y1 + pad) * H))
    with Image.open(img_p) as im:
        crop = im.crop((px0, py0, px1, py1)).convert("RGB")
    if crop.width < CROP_MIN:         # 放大小區域
        k = min(CROP_MIN / crop.width, 4.0)
        crop = crop.resize((int(crop.width * k), int(crop.height * k)),
                           Image.LANCZOS)
    if crop.width > CROP_MAX:
        k = CROP_MAX / crop.width
        crop = crop.resize((CROP_MAX, int(crop.height * k)), Image.LANCZOS)

    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode(), meta


# --------------------------------------------------------------- VLM 呼叫
SYSTEM_ASK = (
    "你是資深製程工程師，正在協助同事判讀 P&ID（管線與儀錶圖）。"
    "使用者框選了圖面的一小塊區域，你只看得到這塊區域。"
    "以繁體中文回答，務實精簡（一般 2～5 句），必要時才條列。"
    "看得到的位號、符號、管線編號請直接引用；"
    "看不清楚或框選範圍不足以判斷就明說「這塊看不出來，建議把框放大到含某某」，"
    "**絕對不要臆造位號、口徑或數值**——寧可說不確定。"
    "不要用 markdown 標題與粗體。"
)

SYSTEM_ID = (
    "你是 P&ID 判讀引擎。使用者框選了圖面的一塊區域，你只看得到這塊區域。"
    "請把區域內的工程元件逐一列出，輸出 JSON。\n"
    "務必涵蓋這四類，**不要只列設備**：\n"
    "1) instrument＝儀錶氣泡：圓圈（或圓圈加方框）內的位號，如 PI 61302、"
    "TT 65102、LIC 61301、FSLL 63101A。圈內上半是功能字母、下半是編號，"
    "請合併成一個 tag。這類在 P&ID 上數量最多，請仔細逐個掃過不要遺漏。\n"
    "2) valve＝閥件：閘閥／球閥／逆止閥／控制閥（帶執行器）／安全閥等，"
    "有位號就填，沒有位號 tag 留空字串。\n"
    "3) equipment＝設備：槽、塔、換熱器、泵、壓縮機、風扇等（如 V 613、E 651）。\n"
    "4) pipe＝管線：管線編號，如 14P 6029A E4B2、6P 6008 B4B2。\n"
    "只輸出你在圖上**真的看得到**的元件；看不清楚就不要列，寧缺勿濫。"
    "每個元件給 confidence（0-1），不確定請誠實給低分。"
)

ID_SCHEMA_HINT = (
    '輸出格式（僅輸出 JSON，不要其他文字）：\n'
    '{"items":[{"tag":"位號或空字串","kind":"equipment|valve|instrument|pipe|other",'
    '"symbol":"中文說明，如 就地壓力指示／控制閥／臥式分離槽／製程管線",'
    '"confidence":0.0,"note":"補充，沒有就空字串"}]}'
)


# ------------------------------------------------- ISA 5.1 位號字母碼解碼
# VLM 認得出「PDT」這幾個字母，但常把語意講錯（實測把 PDT 說成「密度指示」、
# TT 說成「雙色溫度指示」）。字母碼是規範化的東西，不該讓模型猜——
# 讀字母交給 VLM、解語意交給下表，錯誤率直接歸零。
ISA_VAR = {
    "A": "分析", "B": "燃燒器", "C": "電導", "D": "密度", "E": "電壓",
    "F": "流量", "G": "視鏡", "H": "手動", "I": "電流", "J": "功率",
    "K": "時間", "L": "液位", "M": "水分", "N": "自訂", "O": "自訂",
    "P": "壓力", "Q": "數量", "R": "輻射", "S": "速度", "T": "溫度",
    "U": "多變數", "V": "振動", "W": "重量", "X": "未分類",
    "Y": "事件", "Z": "位置",
}
ISA_MOD = {"D": "差", "F": "比值", "Q": "累積", "S": "安全", "J": "掃描"}
ISA_FN = {
    "I": "指示", "C": "控制", "T": "傳送器", "R": "記錄", "V": "閥",
    "S": "開關", "A": "警報", "E": "元件", "G": "視鏡", "Y": "轉換",
    "Z": "驅動", "K": "控制站", "B": "視鏡", "W": "套管", "N": "自訂",
}
ISA_QUAL = {"HH": "高高", "LL": "低低", "H": "高", "L": "低"}
# 位號可能已正規化成無空格（HV61301），字母與數字之間沒有 \b 邊界——
# 必須用前瞻而非 \b，否則整組解碼會靜默失效退回 fallback。
_TAG_LETTERS = re.compile(r"^([A-Z]{1,5})(?=\d|[\s\-]|$)")


def _decode_isa(tag: str) -> str:
    """位號字母碼 → 中文語意（PDT→壓差傳送器、FSLL→流量開關低低）。
    無法判讀回空字串（不猜）。"""
    m = _TAG_LETTERS.match((tag or "").strip().upper())
    if not m:
        return ""
    s = m.group(1)
    if s[0] not in ISA_VAR:
        return ""
    out = ISA_VAR[s[0]]
    rest = s[1:]
    # 尾端高低限定詞先剝離（FSLL 的 LL、PAH 的 H）
    qual = ""
    for q in ("HH", "LL", "H", "L"):
        if rest.endswith(q) and len(rest) > len(q):
            qual = ISA_QUAL[q]
            rest = rest[:-len(q)]
            break
    # 第二字母可能是修飾詞：後面還有功能字母才算修飾（PSE=安全元件），
    # 否則視為功能（FSLL 的 S=開關）
    if rest and rest[0] in ISA_MOD and len(rest) > 1:
        out += ISA_MOD[rest[0]]
        rest = rest[1:]
    for ch in rest:
        if ch in ISA_FN:
            out += ISA_FN[ch]
    out = out.replace("壓力差", "壓差").replace("溫度差", "溫差")  # 現場慣用語
    return out + qual


def _decode_equip(tag: str) -> str:
    """設備位號首字母 → 中文型別（E651→熱交換器）。沿用 pid_parse 的 TYPE_MAP
    慣例，與自動解析建模同一套判定，避免兩邊講法不一致。"""
    from .pid_parse import TYPE_MAP, TYPE_NAME

    m = re.match(r"^([A-Z])", (tag or "").strip().upper())
    if not m:
        return ""
    return TYPE_NAME.get(TYPE_MAP.get(m.group(1), ""), "")


def _ollama_chat(system: str, prompt: str, image_b64: str,
                 want_json: bool = False, timeout: int = 180) -> str:
    body = {
        "model": VLM_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt, "images": [image_b64]},
        ],
        "stream": False,
        "options": {"temperature": 0.15, "num_predict": 700},
    }
    if want_json:
        body["format"] = "json"
    req = urllib.request.Request(
        f"{OLLAMA}/api/chat", data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:200]
        if e.code == 404:
            raise HTTPException(
                503, f"本機視覺模型未安裝（{VLM_MODEL}）——請先執行 "
                     f"ollama pull {VLM_MODEL}") from None
        raise HTTPException(503, f"本機視覺模型錯誤：{detail}") from None
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            503, f"本機視覺模型無回應（{type(e).__name__}）——請確認 Ollama 已啟動"
        ) from None
    return (out.get("message", {}).get("content") or "").strip()


def _claude_chat(system: str, prompt: str, image_b64: str,
                 want_json: bool = False, timeout: int = 180) -> str:
    """雲端 Claude 視覺判讀。實測對 P&ID 的符號語意（圓圈=就地／方框=盤面、
    六角=DCS 運算、閥件、管線編號）辨識力遠高於 7B 地端模型。"""
    key = _cloud_key()
    if not key:
        raise HTTPException(
            503, "未設定雲端金鑰（ANTHROPIC_API_KEY）——"
                 "請設定後重啟，或在引擎切換選 地端 Qwen")
    if want_json:
        prompt += "\n\n只輸出 JSON 本體，不要任何前後說明或程式碼圍欄。"
    body = {
        "model": CLOUD_MODEL,
        "max_tokens": 2000,
        "system": system,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64",
                                         "media_type": "image/jpeg",
                                         "data": image_b64}},
            {"type": "text", "text": prompt},
        ]}],
    }
    req = urllib.request.Request(
        f"{CLOUD_BASE}/v1/messages", data=json.dumps(body).encode(), method="POST",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise HTTPException(
            503, f"雲端引擎錯誤 {e.code}：{e.read().decode(errors='replace')[:200]}"
        ) from None
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"雲端引擎無回應（{type(e).__name__}）") from None
    txt = "".join(b.get("text", "") for b in out.get("content", [])).strip()
    if want_json:                       # 防模型包 ``` 圍欄
        txt = re.sub(r"^```(?:json)?|```$", "", txt.strip(), flags=re.M).strip()
    return txt


def _vlm(provider: str, system: str, prompt: str, image_b64: str,
         want_json: bool = False) -> str:
    """引擎分派。cloud＝雲端 Claude（準但圖面外流）、local＝地端 Qwen（資安優先）。"""
    if provider == "cloud":
        return _claude_chat(system, prompt, image_b64, want_json)
    return _ollama_chat(system, prompt, image_b64, want_json)


# ------------------------------------------------------------------- 模型
class AskReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)   # [x0,y0,x1,y1] 0-1
    question: str = ""
    provider: str = "cloud"


class IdentifyReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)
    provider: str = "cloud"


class CompareReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)


class Annot(BaseModel):
    bbox: list = Field(..., min_length=4, max_length=4)
    tag: str = ""
    kind: str = "other"
    symbol: str = ""
    mounting: str = ""           # 就地／盤面 DCS／DCS 運算（智慧掃描判出的安裝別）
    note: str = ""
    confidence: float = 0.0
    source: str = "vlm"          # vlm-cloud | vlm-local | manual
    verified_by: str = ""


# ---------------------------------------------------------------- endpoints
@router.get("/status")
def status() -> dict:
    """兩個引擎各自是否就緒（前端據此顯示，不硬擋——讓使用者自己選）。"""
    local = {"ok": False, "model": VLM_MODEL, "reason": "Ollama 未啟動"}
    try:
        r0 = urllib.request.Request(f"{OLLAMA}/api/tags")
        with urllib.request.urlopen(r0, timeout=3) as r:
            names = [m.get("name", "") for m in json.loads(r.read()).get("models", [])]
        base = VLM_MODEL.split(":")[0]
        have = any(n == VLM_MODEL or n.split(":")[0] == base for n in names)
        local = {"ok": have, "model": VLM_MODEL,
                 "reason": "" if have else f"模型未安裝：ollama pull {VLM_MODEL}"}
    except Exception:  # noqa: BLE001
        pass
    cloud = {"ok": bool(_cloud_key()), "model": CLOUD_MODEL,
             "reason": "" if _cloud_key() else "未設定 ANTHROPIC_API_KEY"}
    return {"cloud": cloud, "local": local}


@router.get("/base/{filename}")
def base_image(filename: str) -> dict:
    """取得（必要時即時渲染）整頁底圖，前端拿去顯示與框選。"""
    _, meta = _ensure_base(filename)
    return meta


@router.post("/ask")
def ask(req: AskReq) -> dict:
    """框選區域自由問答——互動層核心。"""
    q = (req.question or "").strip() or "這塊區域是什麼？請說明看得到的元件與管線。"
    img_b64, _ = _crop_b64(req.filename, req.bbox)
    text = _vlm(req.provider, SYSTEM_ASK, q, img_b64)
    return {"text": text or "（模型沒有回應內容，請換個問法或把框放大）"}


def _run_identify(img_b64: str, provider: str) -> dict:
    guide = _rules_prompt()
    raw = _vlm(provider, SYSTEM_ID + ("\n\n" + guide if guide else ""),
               "請辨識這塊 P&ID 區域中的元件。\n" + ID_SCHEMA_HINT,
               img_b64, want_json=True)
    items = []
    try:
        data = json.loads(raw) if raw else {}
        for it in (data.get("items") or [])[:24]:
            if not isinstance(it, dict):
                continue
            kind = str(it.get("kind") or "other")
            if kind not in ("equipment", "valve", "instrument", "pipe", "other"):
                kind = "other"
            tag = str(it.get("tag") or "")[:32]
            symbol = str(it.get("symbol") or "")[:60]
            note = str(it.get("note") or "")[:120]
            if kind == "instrument":
                # 語意以 ISA 規則為準（模型常講錯），模型原說法降級成備註
                decoded = _decode_isa(tag)
                if decoded:
                    if symbol and symbol != decoded:
                        note = (note + "｜" if note else "") + f"模型原判讀：{symbol}"
                    symbol = decoded
            elif kind == "equipment":
                # 設備型別同樣看位號首字母（E=熱交換器、V=槽），
                # 模型光看外形常猜錯（實測把換熱器 E651 說成臥式分離槽）
                decoded = _decode_equip(tag)
                if decoded:
                    if symbol and symbol != decoded:
                        note = (note + "｜" if note else "") + f"模型原判讀：{symbol}"
                    symbol = decoded
            items.append({
                "tag": tag, "kind": kind, "symbol": symbol,
                "note": note[:160],
                "confidence": max(0.0, min(1.0, float(it.get("confidence") or 0))),
            })
    except (json.JSONDecodeError, TypeError, ValueError):
        # 模型沒吐乾淨 JSON：不猜，回原文讓工程師自己看
        return {"items": [], "raw": raw[:500],
                "warn": "模型未回傳結構化結果，請改用問答或重新框選"}
    # 同一區域模型常把同個位號吐兩次（圈上下半分開讀）→ 依 (tag, kind) 去重取高分
    seen = {}
    for it in items:
        k = (it["tag"].upper().replace(" ", ""), it["kind"])
        if k not in seen or it["confidence"] > seen[k]["confidence"]:
            seen[k] = it
    items = sorted(seen.values(), key=lambda x: -x["confidence"])
    return {"items": items}


@router.post("/identify")
def identify(req: IdentifyReq) -> dict:
    """框選區域結構化辨識 → 候選標註清單，工程師勾選後才採納入庫。"""
    img_b64, _ = _crop_b64(req.filename, req.bbox)
    return _run_identify(img_b64, req.provider)


@router.post("/compare")
def compare(req: CompareReq) -> dict:
    """同一塊區域兩個引擎各判一次，原始結果並排——用來評估雲端與地端的落差
    （地端要上中油這種 NDA 場域，得先知道犧牲多少準確度）。"""
    img_b64, _ = _crop_b64(req.filename, req.bbox)
    out = {}
    for name in ("cloud", "local"):
        try:
            out[name] = _run_identify(img_b64, name)
        except HTTPException as e:
            out[name] = {"items": [], "error": str(e.detail)}
    cloud_tags = {i["tag"].upper().replace(" ", "") for i in out["cloud"].get("items", []) if i["tag"]}
    local_tags = {i["tag"].upper().replace(" ", "") for i in out["local"].get("items", []) if i["tag"]}
    out["diff"] = {
        "both": sorted(cloud_tags & local_tags),
        "cloud_only": sorted(cloud_tags - local_tags),
        "local_only": sorted(local_tags - cloud_tags),
    }
    return out


# ============================================================ 混合智慧掃描
# 技術選型：不要拿開放式問題去問 7B 模型（實測同題三次吐 9/4/10 項，還漏光儀錶）。
# 改成分工——
#   「哪裡有東西」→ 既有 OCR（確定性、免費、穩定，已在 pid_parse 驗證過）
#   「這是什麼形狀」→ VLM 只做封閉選擇題（單一字母作答，弱模型也答得準）
#   「這代表什麼意思」→ ISA 規則表解碼（零錯誤）
# 雲端模型只在導入期產出 rules（data/pid_rules），交付後現場全地端。
RULES_DIR = BASE_DIR / "data" / "pid_rules"


def _load_rules() -> dict:
    p = RULES_DIR / "default.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _rules_prompt() -> str:
    """判讀規範 → 注入模型 system prompt 的文字（規則移植）。"""
    r = _load_rules()
    if not r:
        return ""
    out = ["以下是本廠 P&ID 的判讀規範，請嚴格遵守："]
    for key in ("symbol_guide", "tag_format", "pitfalls"):
        for line in r.get(key, []):
            out.append("· " + line)
    return "\n".join(out)


def _ocr_region(filename: str, bbox: list) -> tuple[list, tuple]:
    """對指定區域跑 OCR → 完整位號命中（座標為底圖像素）。"""
    from PIL import Image

    from .pid_parse import _merge_fragments, _ocr, _rescue_orphans

    img_p, meta = _ensure_base(filename)
    W, H = meta["w"], meta["h"]
    x0, y0, x1, y1 = (float(v) for v in bbox)
    px0, py0 = int(max(0.0, x0) * W), int(max(0.0, y0) * H)
    px1, py1 = int(min(1.0, x1) * W), int(min(1.0, y1) * H)
    with Image.open(img_p) as im:
        crop = im.crop((px0, py0, px1, py1)).convert("RGB")
    # OCR 對小字需要放大；底圖已是 3x 渲染，區域再放大 2x 通常足夠
    k = 2.0 if crop.width < 2000 else 1.0
    if k > 1:
        crop = crop.resize((int(crop.width * k), int(crop.height * k)), Image.LANCZOS)
    # 碎片合併 → 孤兒救援。孤兒救援不可省——設備位號的單字母前綴常被吞掉
    # （V 613 只讀到 613），少了這步整區設備會全滅。
    #
    # 這裡刻意不用 parse_pid 的 _dedupe_hits：它把「鄰近的相同文字」視為
    # tile 邊界重複收掉，但同一區常有多個儀錶共用迴路號（PR/PIC/PT/HV 都是
    # 61301），近距離的重複號是真的，收掉會害這些位號配不到前綴而消失。
    # 全頁解析時這些重複相隔夠遠不受影響，區域掃描才會踩到。
    # 掃描結尾本來就會依 (tag, kind) 去重，tile 重複由那裡吸收。
    raw = _ocr(crop)
    hits, used = _merge_fragments(raw)
    hits += _rescue_orphans(crop, raw, used)
    # 座標換回底圖像素
    out = [(px0 + cx / k, py0 + cy / k, t, c, h / k) for cx, cy, t, c, h in hits]
    return out, (W, H)


def _classify_bubble(img_b64: str, provider: str) -> tuple[str, float, str]:
    """單一氣泡的外框形狀 → (選項字母, 模型自評信心, 原始回答)。

    要求模型連信心一起吐（格式 `A|85`）——本機 Ollama 拿不到 logprobs，
    自評雖然校準不佳，但至少讓「模型自己也不確定」浮出來給人工優先看。
    回答不成格式＝判讀不可靠，信心給 0.3。
    """
    r = _load_rules().get("bubble_choices", {})
    opts = r.get("options", {})
    if not opts:
        return "D", 0.0, ""
    q = r.get("question", "這個儀錶氣泡的外框是哪一種？")
    body = (q + "\n" + "\n".join(f"{k}. {v}" for k, v in sorted(opts.items()))
            + "\n\n回答格式：一個大寫字母，接一個直線，再接 0-100 的信心整數。"
              "例如 A|85。不要其他任何文字。")
    sysmsg = "你是 P&ID 判讀助手。嚴格以「字母|信心」格式作答。"
    try:
        txt = (_claude_chat(sysmsg, body, img_b64) if provider == "cloud"
               else _ollama_chat(sysmsg, body, img_b64, timeout=60))
    except HTTPException as e:
        return "D", 0.0, f"（引擎錯誤：{e.detail}）"
    raw = (txt or "").strip()
    m = re.search(r"([A-D])\s*\|\s*(\d{1,3})", raw.upper())
    if m:
        return m.group(1), max(0.0, min(1.0, int(m.group(2)) / 100)), raw[:80]
    m2 = re.search(r"\b([A-D])\b", raw.upper())     # 只給字母沒給信心
    return (m2.group(1) if m2 else "D"), 0.3, raw[:80]


_valve_cache: dict = {}          # {filename: (valves, pw, ph)}——全頁掃一次即可
_pipe_cache: dict = {}           # {filename: [polyline(正規化), ...]}

# 管線編號（本廠格式：口徑＋P＋線號＋等級碼，如 14P6029AE4B2、3P6041A2B2）
PIPE_NO_RE = re.compile(r"^\d{1,2}P\d{4}[A-Z]?[A-Z]\d[A-Z]\d$")


def _pipes_norm(filename: str) -> list:
    """全圖線段（正規化座標），供閥件歸屬用。

    刻意不用 extract_pipes——它的 PIPE_MIN_LEN=60pt 是為 3D 建模調的，
    會把閥件所在的短支管全濾掉（實測 10 顆閥只有 1 顆判得到管線）。
    這裡只濾掉比閥件本身還短的線（那是符號自己的邊）。
    """
    if filename in _pipe_cache:
        return _pipe_cache[filename]
    from .pid_parse import VALVE_MAX, page_segments, pdf_to_norm

    _, meta = _ensure_base(filename)
    rot = meta.get("rot", 0)
    try:
        segs, pw, ph = page_segments(_safe_pdf(filename))
    except Exception:  # noqa: BLE001
        segs, pw, ph = [], meta.get("pw", 1) or 1, meta.get("ph", 1) or 1
    out = [[pdf_to_norm(a[0], a[1], pw, ph, rot), pdf_to_norm(b[0], b[1], pw, ph, rot)]
           for a, b in segs if math.dist(a, b) > VALVE_MAX]   # 濾掉符號自身邊線
    _pipe_cache[filename] = out
    return out


def _pt_seg_dist(p, a, b) -> float:
    """點到線段距離（正規化座標，已依 W/H 換算成像素比例後呼叫）。"""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.dist(p, a)
    t = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)))
    return math.dist(p, (ax + t * dx, ay + t * dy))


def _valves_in(filename: str, bbox: list, hits: list, W: float, H: float) -> list:
    """區域內的閥件（向量幾何偵測）＋歸屬（在哪條管線上、最近哪台設備）。

    閥件沒有位號，光有座標只是一堆點；接上管線與設備之後，
    「管線—閥—設備」才構成可查詢的圖譜（Operon 型別化工廠圖譜的核心）。
    """
    from .pid_parse import EQUIP_RE, TYPE_MAP, detect_valves, pdf_to_norm

    _, meta = _ensure_base(filename)
    if filename not in _valve_cache:
        _valve_cache[filename] = detect_valves(_safe_pdf(filename))
    valves, pw, ph = _valve_cache[filename]
    rot = meta.get("rot", 0)
    x0, y0, x1, y1 = (float(v) for v in bbox)

    # 同區的管線編號標註與設備位號（OCR 命中），供就近綁定
    pipe_lbls, equip_lbls = [], []
    for cx, cy, text, conf, _hh in hits:
        t = text.replace(" ", "").replace("-", "")
        if PIPE_NO_RE.match(t):
            pipe_lbls.append((cx, cy, text.strip()))
        elif EQUIP_RE.match(t) and t[0] in TYPE_MAP:
            equip_lbls.append((cx, cy, t))
    polys = _pipes_norm(filename)

    out = []
    for vx, vy, size in valves:
        nx, ny = pdf_to_norm(vx, vy, pw, ph, rot)
        if not (x0 <= nx <= x1 and y0 <= ny <= y1):
            continue
        px, py = nx * W, ny * H          # 像素空間比距離才不會被長寬比扭曲
        rx = size / pw / 2 if rot in (0, 180) else size / ph / 2
        ry = size / ph / 2 if rot in (0, 180) else size / pw / 2
        # 貼線容差：CAD 會在閥件處把管線截斷讓符號插入，中心到線的距離
        # 約為符號半徑等級 → 取符號尺寸 1.5 倍（像素，底圖為 3x 渲染）
        tol = max(size * 3.0 * 1.5, 45)

        # ① 落在哪條管線上
        best_d, best_i = 1e9, -1
        for i, pl in enumerate(polys):
            for k in range(len(pl) - 1):
                d = _pt_seg_dist((px, py), (pl[k][0] * W, pl[k][1] * H),
                                 (pl[k + 1][0] * W, pl[k + 1][1] * H))
                if d < best_d:
                    best_d, best_i = d, i
        on_pipe = best_i >= 0 and best_d <= tol

        # ② 最近的管線編號標註 ③ 最近的設備
        def nearest(lbls):
            if not lbls:
                return None, 1e9
            c = min(lbls, key=lambda L: math.dist((px, py), (L[0], L[1])))
            return c[2], math.dist((px, py), (c[0], c[1]))

        pipe_no, pd = nearest(pipe_lbls)
        eq_tag, ed = nearest(equip_lbls)

        rel = []
        if on_pipe:
            rel.append(f"管線 #{best_i}")
        if pipe_no and pd < W * 0.12:
            rel.append(f"線號 {pipe_no}")
        if eq_tag and ed < W * 0.12:
            rel.append(f"鄰近設備 {eq_tag}")

        out.append({
            "tag": "", "kind": "valve", "symbol": "閥件（幾何偵測）",
            "note": ("｜".join(rel) if rel else "未接上管線，可能是圖例或註記符號")
                    + f"｜對角線 {size:.1f}pt，型式/口徑需人工確認",
            "mounting": "", "mount_conf": 0.0,
            "on_pipe": best_i if on_pipe else None,
            "pipe_no": pipe_no if (pipe_no and pd < W * 0.12) else "",
            "near_equip": eq_tag if (eq_tag and ed < W * 0.12) else "",
            # 貼在管線上才算可信；孤立的蝴蝶結多半是圖例
            "confidence": 0.92 if on_pipe else 0.55,
            "evidence": [
                {"stage": "向量幾何偵測", "ok": True, "score": 1.0,
                 "detail": f"兩條等長({size:.1f}pt)線段共用中點＝矩形對角線＝蝴蝶結"},
                {"stage": "管線歸屬", "ok": on_pipe,
                 "score": 0.9 if on_pipe else 0.2,
                 "detail": (f"距最近管線 {best_d:.0f}px（容差 {tol:.0f}px）→ 判定在線上"
                            if on_pipe else
                            f"距最近管線 {best_d:.0f}px 超過容差，未貼在任何管線")},
                {"stage": "就近綁定", "ok": bool(pipe_no or eq_tag), "score": 0.6,
                 "detail": (f"最近線號「{pipe_no}」({pd:.0f}px)；"
                            f"最近設備「{eq_tag}」({ed:.0f}px)")
                           if (pipe_no or eq_tag) else "附近沒有線號或設備位號可綁"},
            ],
            "bbox": [round(nx - rx, 4), round(ny - ry, 4),
                     round(nx + rx, 4), round(ny + ry, 4)],
        })
    return out


class ScanReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)
    provider: str = "local"
    classify: bool = True        # False＝只跑 OCR（純確定性基準線，供 A/B 對照）
    valves: bool = True          # 向量幾何抓閥件


@router.post("/scan")
def scan(req: ScanReq) -> dict:
    """混合掃描：OCR 定位 → VLM 選擇題認符號 → ISA 解碼語意。"""
    from PIL import Image

    from .pid_parse import EQUIP_RE, INST_RE, TYPE_MAP

    hits, (W, H) = _ocr_region(req.filename, req.bbox)
    rules = _load_rules().get("bubble_choices", {})
    mount_map = rules.get("mounting", {})

    insts, equips = {}, {}
    for cx, cy, text, conf, hh in hits:
        t = text.replace(" ", "").replace("-", "")
        if INST_RE.match(t):
            if t not in insts or conf > insts[t][2]:
                insts[t] = (cx, cy, conf, hh)
        elif EQUIP_RE.match(t) and t[0] in TYPE_MAP:
            if t not in equips or conf > equips[t][2]:
                equips[t] = (cx, cy, conf, hh)

    items, calls = [], 0
    img_p, _ = _ensure_base(req.filename)
    with Image.open(img_p) as im:
        for tag, (cx, cy, conf, hh) in insts.items():
            # 判讀依據鏈：每一步做了什麼、憑什麼——信心數字要可回溯，不能是黑盒
            ev = [{"stage": "OCR 定位", "ok": True, "score": round(float(conf), 2),
                   "detail": f"辨識出文字「{tag}」，位置 ({int(cx)}, {int(cy)})"}]
            decoded = _decode_isa(tag)
            ev.append({"stage": "ISA 5.1 規則解碼", "ok": bool(decoded),
                       "score": 1.0 if decoded else 0.0,
                       "detail": (f"字母碼 {re.match(r'^[A-Z]+', tag).group(0)} → {decoded}"
                                  if decoded else "字母碼不在 ISA 表中，語意無法規則判定")})
            mount, mconf = "", 0.0
            if req.classify:
                # 氣泡半徑約為字高的 2.2 倍；外加方框再放寬一點才框得住
                r = max(hh * 2.6, 26)
                box = (int(max(0, cx - r)), int(max(0, cy - r)),
                       int(min(W, cx + r)), int(min(H, cy + r)))
                c = im.crop(box)
                if c.width < 240:
                    k = 240 / max(c.width, 1)
                    c = c.resize((int(c.width * k), int(c.height * k)), Image.LANCZOS)
                buf = io.BytesIO()
                c.save(buf, format="JPEG", quality=92)
                letter, mconf, raw = _classify_bubble(
                    base64.b64encode(buf.getvalue()).decode(), req.provider)
                calls += 1
                mount = mount_map.get(letter, "")
                opt = (rules.get("options", {}) or {}).get(letter, "")
                ev.append({
                    "stage": f"AI 判外框（{'雲端' if req.provider == 'cloud' else '地端'}）",
                    "ok": letter != "D", "score": round(mconf, 2),
                    "detail": f"選 {letter}：{opt}｜模型原始回答「{raw}」"})
            items.append({
                "tag": tag, "kind": "instrument",
                "symbol": decoded or "儀錶",
                "note": ("安裝：" + mount) if mount else "",
                "mounting": mount, "mount_conf": round(mconf, 2),
                "confidence": round(float(conf), 2),
                "evidence": ev,
                "bbox": [round((cx - hh) / W, 4), round((cy - hh) / H, 4),
                         round((cx + hh) / W, 4), round((cy + hh) / H, 4)],
            })
        for tag, (cx, cy, conf, hh) in equips.items():
            dec = _decode_equip(tag)
            items.append({
                "tag": tag, "kind": "equipment",
                "symbol": dec or "設備", "note": "", "mounting": "", "mount_conf": 0.0,
                "confidence": round(float(conf), 2),
                "evidence": [
                    {"stage": "OCR 定位", "ok": True, "score": round(float(conf), 2),
                     "detail": f"辨識出文字「{tag}」，位置 ({int(cx)}, {int(cy)})"},
                    {"stage": "位號型別規則", "ok": bool(dec), "score": 1.0 if dec else 0.0,
                     "detail": (f"首字母 {tag[0]} → {dec}（沿用解析建模同一套 TYPE_MAP）"
                                if dec else "首字母不在設備型別表中")},
                ],
                "bbox": [round((cx - hh) / W, 4), round((cy - hh) / H, 4),
                         round((cx + hh) / W, 4), round((cy + hh) / H, 4)],
            })
    # 閥件：向量幾何偵測（無文字，OCR 幫不上；不用模型、零成本）
    if req.valves:
        try:
            items += _valves_in(req.filename, req.bbox, hits, W, H)
        except Exception:  # noqa: BLE001
            pass            # 閥件是加值資訊，抓不到不該讓整次掃描失敗

    # 迴路號離群標記：同區儀錶的迴路號通常同族（613xx），
    # 混進一個 552xx 幾乎都是 OCR 數字誤讀（實測 65201→55201）。
    # 規則抓得到的疑點就先標出來，不要讓工程師自己大海撈針。
    prefixes = {}
    for it in items:
        m = re.search(r"(\d{2})\d{2,3}$", it["tag"])
        if m:
            prefixes[m.group(1)] = prefixes.get(m.group(1), 0) + 1
    if prefixes:
        top = max(prefixes, key=lambda k: prefixes[k])
        if prefixes[top] >= 3:                      # 有明確主族才判離群
            for it in items:
                m = re.search(r"(\d{2})\d{2,3}$", it["tag"])
                if m and m.group(1) != top and prefixes.get(m.group(1), 0) == 1:
                    it["warn"] = f"迴路號與本區主族 {top}xxx 不同，OCR 可能誤讀，請人工確認"
                    it["confidence"] = min(it["confidence"], 0.5)
                    it.setdefault("evidence", []).append({
                        "stage": "迴路號一致性檢查", "ok": False, "score": 0.3,
                        "detail": f"本區主族為 {top}xxx，本項為 {m.group(1)}xxx 且僅出現一次"
                                  "→ 判定為 OCR 數字誤讀嫌疑，信心降至 0.5"})

    items.sort(key=lambda x: -x["confidence"])
    return {"items": items,
            "stats": {"ocr_hits": len(hits), "vlm_calls": calls,
                      "instruments": len(insts), "equipment": len(equips),
                      "valves": sum(1 for i in items if i["kind"] == "valve")}}


# ----------------------------------------------------- 標註存檔（人工驗證關卡）
def _annot_path(filename: str) -> Path:
    ANNOT_DIR.mkdir(parents=True, exist_ok=True)
    return ANNOT_DIR / f"{_slug(Path(filename).stem)}.json"


def _load_annots(filename: str) -> dict:
    p = _annot_path(filename)
    if not p.exists():
        return {"items": [], "audit": [], "zones": {}}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return {"items": d.get("items", []), "audit": d.get("audit", []),
                "zones": d.get("zones", {})}
    except (json.JSONDecodeError, OSError):
        return {"items": [], "audit": [], "zones": {}}


def _save_annots(filename: str, d: dict) -> None:
    _annot_path(filename).write_text(
        json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


class ZoneReq(BaseModel):
    zone: str                     # "r-c" 格號
    status: str = "done"          # done | todo


@router.post("/zone/{filename}")
def zone_mark(filename: str, req: ZoneReq) -> dict:
    """標記某一分區已巡完——導覽進度的分母來源（整廠完成度靠這個算）。"""
    from datetime import datetime, timezone

    _safe_pdf(filename)
    d = _load_annots(filename)
    if req.status == "todo":
        d["zones"].pop(req.zone, None)
    else:
        d["zones"][req.zone] = {
            "status": "done",
            "at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        }
    _save_annots(filename, d)
    return {"ok": True, "zones": d["zones"]}


@router.get("/annot/{filename}")
def annot_list(filename: str) -> dict:
    _safe_pdf(filename)
    return _load_annots(filename)


@router.post("/annot/{filename}")
def annot_add(filename: str, item: Annot) -> dict:
    """採納一筆標註。每筆都記稽核（誰、何時、來源）——模型輸出不會自己入庫。"""
    from datetime import datetime, timezone

    _safe_pdf(filename)
    d = _load_annots(filename)
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    rec = item.model_dump()
    rec["id"] = f"a{len(d['items']) + 1}-{int(len(d['audit']) + 1)}"
    rec["created_at"] = now
    d["items"].append(rec)
    d["audit"].append({"at": now, "action": "accept", "id": rec["id"],
                       "tag": rec.get("tag", ""), "source": rec.get("source", ""),
                       "by": rec.get("verified_by", "")})
    _save_annots(filename, d)
    return {"ok": True, "id": rec["id"], "count": len(d["items"])}


class RejectReq(BaseModel):
    tag: str = ""
    kind: str = ""
    reason: str = "人工判定非此元件"


@router.post("/reject/{filename}")
def annot_reject(filename: str, req: RejectReq) -> dict:
    """人工否決一筆候選——只寫稽核不入庫。

    一一審核的前提是「沒有東西被靜默丟掉」：AI 判錯了什麼、誰在什麼時候否決的，
    都要留痕，否則無法回頭檢討模型也無法對客戶交代覆核過程。
    """
    from datetime import datetime, timezone

    _safe_pdf(filename)
    d = _load_annots(filename)
    d["audit"].append({
        "at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "action": "reject", "tag": req.tag, "kind": req.kind, "reason": req.reason})
    _save_annots(filename, d)
    return {"ok": True, "rejected": sum(1 for a in d["audit"] if a.get("action") == "reject")}


@router.get("/export/{filename}")
def annot_export(filename: str):
    """已確認標註 → CSV（設備台帳交付物）。
    帶 UTF-8 BOM，Excel 直接雙擊開不會變亂碼。"""
    import csv

    from fastapi.responses import StreamingResponse

    _safe_pdf(filename)
    d = _load_annots(filename)
    buf = io.StringIO()
    buf.write("﻿")                       # BOM：Excel 中文相容
    w = csv.writer(buf)
    w.writerow(["圖面", "位號", "類型", "語意", "安裝位置", "信心度",
                "來源", "採納時間", "備註", "圖面X", "圖面Y"])
    kind_txt = {"equipment": "設備", "valve": "閥件", "instrument": "儀錶",
                "pipe": "管線", "other": "其他"}
    for a in d["items"]:
        bb = a.get("bbox") or [0, 0, 0, 0]
        cx = round((bb[0] + bb[2]) / 2, 4) if len(bb) == 4 else ""
        cy = round((bb[1] + bb[3]) / 2, 4) if len(bb) == 4 else ""
        w.writerow([Path(filename).stem, a.get("tag", ""),
                    kind_txt.get(a.get("kind", ""), a.get("kind", "")),
                    a.get("symbol", ""), a.get("mounting", ""),
                    a.get("confidence", ""), a.get("source", ""),
                    a.get("created_at", ""), a.get("note", ""), cx, cy])
    buf.seek(0)
    fn = f"{_slug(Path(filename).stem)}_tags.csv"
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fn}"'})


@router.delete("/annot/{filename}/{item_id}")
def annot_delete(filename: str, item_id: str) -> dict:
    from datetime import datetime, timezone

    _safe_pdf(filename)
    d = _load_annots(filename)
    before = len(d["items"])
    d["items"] = [i for i in d["items"] if i.get("id") != item_id]
    if len(d["items"]) == before:
        raise HTTPException(404, "標註不存在")
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    d["audit"].append({"at": now, "action": "delete", "id": item_id})
    _save_annots(filename, d)
    return {"ok": True, "count": len(d["items"])}
