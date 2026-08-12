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

from fastapi import APIRouter, HTTPException, Request
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
    # 製程說明這種長文要比框選問答多的額度；沒帶圖時（純文字任務）
    # 也要能跑——原本硬塞空的 image 區塊會被 API 拒收。
    content: list = []
    if image_b64:
        content.append({"type": "image",
                        "source": {"type": "base64", "media_type": "image/jpeg",
                                   "data": image_b64}})
    content.append({"type": "text", "text": prompt})
    # ATP 的 sonnet-5 預設會產生 thinking 區塊，那些 token 也算在 max_tokens 裡。
    # 製程說明給 6000 時實測 stop_reason=max_tokens、思考吃光額度、正文被截斷
    # 甚至整個空掉。長文任務直接給足額度，別讓報告寫到一半斷掉。
    body = {
        "model": CLOUD_MODEL,
        "max_tokens": 16000 if timeout >= 300 else 2000,
        "system": system,
        "messages": [{"role": "user", "content": content}],
    }
    # ATPToken gateway（台灣 AI gateway，Anthropic 相容）走 Bearer 認證；
    # Anthropic 官方走 x-api-key。依 key 前綴自動切換，兩邊都能接。
    if key.startswith("atp-"):
        auth = {"Authorization": f"Bearer {key}"}
    else:
        auth = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    # UA 必帶：ATP 前面的 Cloudflare 會用 1010 擋掉無 User-Agent 的請求
    req = urllib.request.Request(
        f"{CLOUD_BASE}/v1/messages", data=json.dumps(body).encode(), method="POST",
        headers={**auth, "content-type": "application/json",
                 "user-agent": "ej3d-twin-pid/1.0"})
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
    user_note: str = ""      # 工程師手寫備註，優先於系統描述
    confidence: float = 0.0
    source: str = "vlm"          # vlm-cloud | vlm-local | manual | scan | locate
    verified_by: str = ""
    # 審核者選定的設備清冊列（L2 改配對）。定位器可能配錯，人改過的才算數——
    # 沒這個欄位，pydantic 會靜默丟掉改配對的結果（mounting 踩過同一個坑）。
    registry_item: str = ""


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


_bubble_ocr_cache: dict = {}


def _bubble_ocr(filename: str) -> dict:
    """氣泡錨定 OCR：只在偵測到的儀錶氣泡內讀字 → {tag: (cx, cy, r) 底圖像素}。

    與全頁掃描互為獨立驗證：全頁掃描到處找字，註記與尺寸標註會被誤收；
    這裡先由幾何鎖定元件位置再讀，位置由構造保證正確、註記進不來。
    """
    if filename in _bubble_ocr_cache:
        return _bubble_ocr_cache[filename]
    from PIL import Image

    from .pid_parse import INST_RE, _merge_fragments, _ocr

    img_p, meta = _ensure_base(filename)
    W, H = meta["w"], meta["h"]
    out: dict = {}
    with Image.open(img_p) as im:
        for nx, ny, rx, ry, _shape in _bubbles_norm(filename):
            px, py = nx * W, ny * H
            ex, ey = rx * W * 1.45, ry * H * 1.45      # 略放寬，圈邊的字才不被切
            c = im.crop((int(px - ex), int(py - ey), int(px + ex), int(py + ey)))
            if c.width < 8 or c.height < 8:
                continue
            k = max(1.0, 260 / c.width)                # 小圖放大，OCR 才讀得到
            if k > 1:
                c = c.resize((int(c.width * k), int(c.height * k)), Image.LANCZOS)
            try:
                merged, _ = _merge_fragments(_ocr(c))
            except Exception:  # noqa: BLE001
                continue
            for _cx, _cy, text, _conf, _hh in merged:
                t = text.replace(" ", "").replace("-", "")
                if INST_RE.match(t) and t not in out:
                    out[t] = (px, py, max(ex, ey))
                    break
    _bubble_ocr_cache[filename] = out
    return out


_bubble_cache: dict = {}


def _bubbles_norm(filename: str) -> list:
    """全圖儀錶氣泡 → [(cx, cy, rx, ry, shape)] 正規化座標
    （rx/ry 為正規化半徑，shape ∈ circle/hex/square）。"""
    if filename in _bubble_cache:
        return _bubble_cache[filename]
    from .pid_parse import detect_bubbles, pdf_to_norm

    _, meta = _ensure_base(filename)
    rot = meta.get("rot", 0)
    bl, pw, ph = detect_bubbles(_safe_pdf(filename))
    out = []
    for bx, by, r, shape in bl:
        nx, ny = pdf_to_norm(bx, by, pw, ph, rot)
        rx = r / ph if rot in (90, 270) else r / pw
        ry = r / pw if rot in (90, 270) else r / ph
        out.append((nx, ny, rx, ry, shape))
    _bubble_cache[filename] = out
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
                "symbol": dec or ("設備項次" if is_pfd else "設備"), "note": "", "mounting": "", "mount_conf": 0.0,
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

    _flag_text_zone_valves(items, hits, W, H)

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
# 台帳是整套人工驗證關卡的地基，寫入必須：
#   1. 上鎖——整張辨識後的自動入庫是同一秒七、八筆並行 POST，
#      無鎖的 read-modify-write 會互相蓋寫
#   2. 原子寫入（tmp + replace）——write_text 直接覆寫時，並行讀取
#      會讀到半截 JSON
#   3. 毀損檔先備份再重來——靜默當成空台帳等於讓下一筆寫入抹掉整份稽核
#      （實測 2026-08-11：54 筆稽核被自動入庫連發整份清空）
ANNOT_LOCK = threading.Lock()

# 分租：台帳按 email 網域分開存。同公司共用（同事接得下去、改得動），
# 跨公司互不可見——平台上同時有台化、中油、潤泰的圖，這條界線是必要的。
# 舊資料（分租前的平面檔）留在原處當**共用基線**：任何網域讀得到、
# 但寫入一律落到自己的網域目錄，不會互相蓋掉。
def _domain_dir(domain: str) -> Path:
    d = ANNOT_DIR / re.sub(r"[^a-z0-9.-]+", "-", (domain or "dev.local").lower())
    d.mkdir(parents=True, exist_ok=True)
    return d


def _annot_path(filename: str, domain: str = "") -> Path:
    slug = _slug(Path(filename).stem)
    if not domain:                      # 未分租的呼叫端（既有內部函式）
        ANNOT_DIR.mkdir(parents=True, exist_ok=True)
        return ANNOT_DIR / f"{slug}.json"
    return _domain_dir(domain) / f"{slug}.json"


def _hist_dir(filename: str, domain: str) -> Path:
    d = _domain_dir(domain) / "_history" / _slug(Path(filename).stem)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_ledger(p: Path) -> dict | None:
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return {"items": d.get("items", []), "audit": d.get("audit", []),
                "zones": d.get("zones", {})}
    except (json.JSONDecodeError, OSError):
        try:
            import time

            p.rename(p.with_name(f"{p.stem}.corrupt-{int(time.time())}.json"))
        except OSError:
            pass
        return None


def _load_annots(filename: str, domain: str = "") -> dict:
    if domain:
        d = _read_ledger(_annot_path(filename, domain))
        if d is not None:
            return d
        # 本網域還沒有自己的台帳 → 繼承共用基線（唯讀，寫入時才落地成自己的）
        base = _read_ledger(_annot_path(filename))
        if base is not None:
            return base
        return {"items": [], "audit": [], "zones": {}}
    d = _read_ledger(_annot_path(filename))
    return d if d is not None else {"items": [], "audit": [], "zones": {}}


def _save_annots(filename: str, d: dict, domain: str = "",
                 snapshot: str = "") -> None:
    """原子寫入＋版本快照。

    快照讓「回到上一動」與「看同一張圖的歷史建檔」成為可能——
    台帳是多人協作的東西，沒有版本史就等於每次寫入都在賭。
    """
    p = _annot_path(filename, domain)
    tmp = p.with_name(p.stem + ".tmp")
    body = json.dumps(d, ensure_ascii=False, indent=2)
    tmp.write_text(body, encoding="utf-8")
    os.replace(tmp, p)
    if not domain:
        return
    try:
        from datetime import datetime, timezone

        ts = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d-%H%M%S-%f")
        (_hist_dir(filename, domain) / f"{ts}.json").write_text(
            json.dumps({"at": ts, "action": snapshot, "items": d.get("items", []),
                        "audit": d.get("audit", []), "zones": d.get("zones", {})},
                       ensure_ascii=False), encoding="utf-8")
        # 只留最近 60 版，舊的滾掉（一張圖審一輪約 50~70 次寫入）
        vs = sorted(_hist_dir(filename, domain).glob("*.json"))
        for old in vs[:-60]:
            old.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass            # 快照失敗不能影響主寫入


class ZoneReq(BaseModel):
    zone: str                     # "r-c" 格號
    status: str = "done"          # done | todo


@router.post("/zone/{filename}")
def zone_mark(filename: str, req: ZoneReq, request: Request) -> dict:
    """標記某一分區已巡完——導覽進度的分母來源（整廠完成度靠這個算）。"""
    from datetime import datetime, timezone

    from .auth import current_domain

    _safe_pdf(filename)
    dom = current_domain(request)
    with ANNOT_LOCK:
        d = _load_annots(filename, dom)
        if req.status == "todo":
            d["zones"].pop(req.zone, None)
        else:
            d["zones"][req.zone] = {
                "status": "done",
                "at": datetime.now(timezone.utc).astimezone()
                      .isoformat(timespec="seconds"),
            }
        _save_annots(filename, d, dom, "zone")
    return {"ok": True, "zones": d["zones"]}


@router.get("/annot/{filename}")
def annot_list(filename: str, request: Request) -> dict:
    from .auth import current_domain

    _safe_pdf(filename)
    return _load_annots(filename, current_domain(request))


@router.get("/annot/{filename}/history")
def annot_history(filename: str, request: Request) -> dict:
    """同一張圖的歷史建檔——誰在什麼時候動了什麼，可回到任一版。

    台帳是多人協作的東西：同事昨天審過一輪、今天你接手，得看得到
    他改了什麼、也得能退回去。沒有版本史，協作就是互相覆蓋。
    """
    from .auth import current_domain

    _safe_pdf(filename)
    dom = current_domain(request)
    out = []
    for p in sorted(_hist_dir(filename, dom).glob("*.json"), reverse=True):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        au = d.get("audit", [])
        last = au[-1] if au else {}
        out.append({"version": p.stem, "at": last.get("at") or d.get("at", ""),
                    "action": d.get("action", ""), "items": len(d.get("items", [])),
                    "audit": len(au), "by": last.get("by", ""),
                    "tag": last.get("tag", "")})
    cur = _load_annots(filename, dom)
    return {"domain": dom, "current": {"items": len(cur["items"]),
                                       "audit": len(cur["audit"])},
            "versions": out}


@router.post("/annot/{filename}/undo")
def annot_undo(filename: str, request: Request) -> dict:
    """回到上一動——還原成前一個版本快照。"""
    from .auth import current_domain

    _safe_pdf(filename)
    dom = current_domain(request)
    with ANNOT_LOCK:
        vs = sorted(_hist_dir(filename, dom).glob("*.json"))
        if len(vs) < 2:
            raise HTTPException(409, "沒有可回復的上一動（本網域尚無足夠版本）")
        prev = json.loads(vs[-2].read_text(encoding="utf-8"))
        d = {"items": prev.get("items", []), "audit": prev.get("audit", []),
             "zones": prev.get("zones", {})}
        _save_annots(filename, d, dom, "undo")
    return {"ok": True, "restored": vs[-2].stem, "items": len(d["items"])}


@router.post("/annot/{filename}/restore/{version}")
def annot_restore(filename: str, version: str, request: Request) -> dict:
    """還原到指定的歷史版本（版本本身也會被記成一次快照，可再往回退）。"""
    from .auth import current_domain

    _safe_pdf(filename)
    dom = current_domain(request)
    p = _hist_dir(filename, dom) / f"{Path(version).name}.json"
    if not p.exists():
        raise HTTPException(404, "找不到這個版本")
    with ANNOT_LOCK:
        v = json.loads(p.read_text(encoding="utf-8"))
        d = {"items": v.get("items", []), "audit": v.get("audit", []),
             "zones": v.get("zones", {})}
        _save_annots(filename, d, dom, f"restore:{version}")
    return {"ok": True, "restored": version, "items": len(d["items"])}


@router.post("/annot/{filename}")
def annot_add(filename: str, item: Annot, request: Request) -> dict:
    """採納一筆標註。每筆都記稽核（誰、何時、來源）——模型輸出不會自己入庫。

    Upsert 語意：同位號且位置相近（或無位號但框幾乎重合）視為同一元件的
    重審，更新既有列而非疊加——重新辨識再審一輪不該讓台帳長出重複列。
    """
    from datetime import datetime, timezone

    from .auth import current_actor, current_domain

    _safe_pdf(filename)
    rec = item.model_dump()
    dom = current_domain(request)
    if not rec.get("verified_by"):
        rec["verified_by"] = current_actor(request)   # 簽名自動落到登入者
    with ANNOT_LOCK:
        d = _load_annots(filename, dom)
        now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        cx = (rec["bbox"][0] + rec["bbox"][2]) / 2
        cy = (rec["bbox"][1] + rec["bbox"][3]) / 2
        dup = None
        for old in d["items"]:
            ox = (old["bbox"][0] + old["bbox"][2]) / 2
            oy = (old["bbox"][1] + old["bbox"][3]) / 2
            close = math.hypot(ox - cx, oy - cy)
            if rec.get("tag") and old.get("tag") == rec["tag"] and close < 0.02:
                dup = old
                break
            if not rec.get("tag") and not old.get("tag") and close < 0.005:
                dup = old
                break
        if dup is not None:
            keep_id, keep_created = dup["id"], dup.get("created_at", now)
            dup.update(rec)
            dup["id"], dup["created_at"] = keep_id, keep_created
            dup["updated_at"] = now
            action, rid = "update", keep_id
        else:
            rec["id"] = f"a{len(d['items']) + 1}-{int(len(d['audit']) + 1)}"
            rec["created_at"] = now
            d["items"].append(rec)
            action, rid = "accept", rec["id"]
        d["audit"].append({"at": now, "action": action, "id": rid,
                           "tag": rec.get("tag", ""), "source": rec.get("source", ""),
                           "by": rec.get("verified_by", "")})
        _save_annots(filename, d, dom, f"{action}:{rec.get('tag', '')}")
    return {"ok": True, "id": rid, "count": len(d["items"])}


def _flag_text_zone_valves(items: list, hits: list, W: float, H: float) -> None:
    """標出「周圍全是文字、又沒接上管線」的閥件。

    閥件幾何判準（兩條等長線段共用中點）在密集文字的筆劃交錯中偶爾會湊巧
    成立，於是標題欄、圖例、註記區會冒出假閥件。這類位置周圍是文字而非管線，
    直接標出來，審核者一眼就能判斷——這是「幫 AI 說清楚它為什麼可疑」。
    """
    if not hits:
        return
    for it in items:
        if it.get("kind") != "valve" or it.get("on_pipe") is not None:
            continue
        bx0, by0, bx1, by1 = it["bbox"]
        cx, cy = (bx0 + bx1) / 2 * W, (by0 + by1) / 2 * H
        r = max((bx1 - bx0) * W, (by1 - by0) * H) * 4
        near = sum(1 for hx, hy, *_ in hits if abs(hx - cx) < r and abs(hy - cy) < r)
        if near >= 6:
            w = (f"周圍 {near} 處文字、且未接上管線 → 高度可能是標題欄／圖例／"
                 "註記區的筆劃湊巧構成蝴蝶結，並非真實閥件")
            it["warn"] = (it["warn"] + "｜" + w) if it.get("warn") else w
            it["confidence"] = min(it["confidence"], 0.3)
            it.setdefault("evidence", []).append({
                "stage": "文字密度檢查", "ok": False, "score": 0.2, "detail": w})


class ScanAllReq(BaseModel):
    filename: str


_profile_cache: dict = {}


def _profile_of(filename: str) -> str:
    """這張圖該套哪份規範（判一次就快取）。判錯圖種等於整套規則失效。"""
    if filename in _profile_cache:
        return _profile_cache[filename]
    try:
        r = convention(filename)
        rules = r.get("rules_file") or "default.json"
    except Exception:  # noqa: BLE001
        rules = "default.json"
    _profile_cache[filename] = rules
    return rules


@router.get("/linkset")
def linkset() -> dict:
    """整組圖面的跨圖串接關係——單張是孤島，串起來才是廠。

    三種互相獨立的證據：圖上的跨圖接續標記（OPC）、圖號連號、共用位號。
    未配對的接續標記一併回報——那代表圖組有缺口，這本身就是交付價值，
    客戶常不知道自己的圖少了哪幾張。
    """
    from .pid_linkset import build_set, extract_links
    from .pid_parse import EQUIP_RE, INST_RE, TYPE_MAP

    per: dict = {}
    for p in sorted(PID_DIR.glob("*.pdf")):
        try:
            hits, _ = _ocr_region(p.name, [0.0, 0.0, 1.0, 1.0])
        except Exception:  # noqa: BLE001
            continue
        words = [h[2] for h in hits]
        tags = []
        for h in hits:
            t = h[2].replace(" ", "").replace("-", "")
            if INST_RE.match(t) or (EQUIP_RE.match(t) and t[0] in TYPE_MAP):
                tags.append(t)
        d = extract_links(p.stem, words)
        d["tags"] = tags
        per[p.stem] = d
    return build_set(per)


@router.get("/convention/{filename}")
def convention(filename: str) -> dict:
    """判定這張圖走哪套繪製慣例——決定該套用哪份判讀規範。

    台灣沒有統一的 CNS P&ID 標準，實務是業主標準 > EPC > 授權商。
    一份 rules 打天下會在第二個客戶就破功，所以要自動判、不是手動設定。
    """
    from .pid_convention import detect
    from .pid_parse import EQUIP_RE, INST_RE, TYPE_MAP

    hits, _ = _ocr_region(filename, [0.0, 0.0, 1.0, 1.0])
    tags, equips, words = [], [], []
    for _cx, _cy, text, _c, _h in hits:
        t = text.replace(" ", "").replace("-", "")
        words.append(text)
        if INST_RE.match(t):
            tags.append(t)
        elif EQUIP_RE.match(t) and t[0] in TYPE_MAP:
            equips.append(t)
    d = _load_annots(filename)
    kinds: dict = {}
    for a in d["items"]:
        if a.get("mounting"):
            kinds[a["mounting"]] = kinds.get(a["mounting"], 0) + 1
    return detect(tags, sorted(set(equips)), title_text=" ".join(words),
                  notes_text=" ".join(words), bubble_kinds=kinds)


@router.post("/scan_all")
def scan_all(req: ScanAllReq) -> dict:
    """整張圖一次辨識——位號、設備、閥件全出，每項都帶精確座標。

    只跑確定性管線（OCR＋規則＋向量幾何），全頁一次掃完約 1-2 分鐘。
    氣泡外框的判定改成審核時逐項即時處理（見 /classify_one），
    這樣使用者不必等一百多次推論才看得到東西。
    """
    from .pid_parse import EQUIP_RE, INST_RE, TYPE_MAP

    _, meta = _ensure_base(req.filename)
    W, H = meta["w"], meta["h"]

    # 整頁一次 OCR 會漏字：底圖 3572px 寬不會被放大，小字讀不到
    # （實測整頁 73 儀錶，分塊後 100+）。改成分塊掃描各自放大再合併，
    # 塊間重疊讓壓在切線上的位號至少被完整看到一次，重複由 tag 去重吸收。
    TC, TR, OV = 4, 3, 0.06
    hits = []
    for r in range(TR):
        for c in range(TC):
            box = [max(0.0, c / TC - OV), max(0.0, r / TR - OV),
                   min(1.0, (c + 1) / TC + OV), min(1.0, (r + 1) / TR + OV)]
            try:
                h, _ = _ocr_region(req.filename, box)
                hits += h
            except Exception:  # noqa: BLE001
                continue

    # 整頁 OCR 花 ~30 秒，是全流程最貴的一步。落地快取讓建模階段
    # （pid_model 的屬性充實：閥件尺寸、管線編號都要查鄰近文字）直接重用。
    try:
        hp = VLM_DIR / f"{_slug(Path(req.filename).stem)}.hits.json"
        hp.write_text(json.dumps(
            {"w": W, "h": H,
             "hits": [[round(cx, 1), round(cy, 1), t, round(float(cf), 3),
                       round(hh, 1)] for cx, cy, t, cf, hh in hits]},
            ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass            # 快取失敗不影響掃描本身，建模時會自己重跑 OCR

    # ---- 方法二：氣泡錨定 OCR（與全頁掃描互為獨立驗證）----
    # 全頁掃描是「到處找字再猜哪個是位號」，註記會變假位號、座標也會飄；
    # 氣泡錨定是「先用幾何找到元件，只在元件內讀字」，位置由構造保證正確、
    # 註記根本進不來（實測 R101/T108/D181/E653 四個誤讀全部消失）。
    # 兩者召回互補（掃描 92 / 錨定 84），合併後用「被幾種方法找到」定信心。
    try:
        bub_tags = _bubble_ocr(req.filename)
    except Exception:  # noqa: BLE001
        bub_tags = {}

    # 圖種決定用哪套位號規則。PFD 沒有 ISA 功能字母，硬套會把設備項次號
    # 解成假儀錶；P&ID 則相反。判錯圖種等於整套規則失效，所以先判再掃。
    is_pfd = _profile_of(req.filename) == "pfd.json"

    insts, equips = {}, {}
    for cx, cy, text, conf, hh in hits:
        t = text.replace(" ", "").replace("-", "")
        if is_pfd:
            # PFD：3 碼項次號，可帶小數分項（201、202.1）
            if re.fullmatch(r"\d{3}(\.\d)?", text.strip()):
                k = text.strip()
                if k not in equips or conf > equips[k][2]:
                    equips[k] = (cx, cy, conf, hh)
            continue
        if INST_RE.match(t):
            if t not in insts or conf > insts[t][2]:
                insts[t] = (cx, cy, conf, hh)
        elif EQUIP_RE.match(t) and t[0] in TYPE_MAP:
            if t not in equips or conf > equips[t][2]:
                equips[t] = (cx, cy, conf, hh)

    # 氣泡錨定找到、但全頁掃描漏掉的 → 補進來（座標用氣泡中心，更準）
    for t, (bx, by, br) in (bub_tags.items() if not is_pfd else []):
        if t not in insts:
            insts[t] = (bx, by, 0.9, br * 0.55)

    # 位號被截斷的收尾：OCR 常把 65101 讀成 6510、PI61301E 讀成 PI01301E。
    # 若某個位號是另一個位號的前綴、且位置相近，視為同一個的殘缺版本丟棄——
    # 留著會讓審核清單多出一堆看起來像真的假位號。
    for pool in (insts, equips):
        drop = []
        for a in pool:
            for b in pool:
                if a == b or len(a) >= len(b) or not b.startswith(a):
                    continue
                if math.dist(pool[a][:2], pool[b][:2]) < max(pool[b][3] * 6, 60):
                    drop.append(a)
                    break
        for a in drop:
            pool.pop(a, None)

    items = []
    for tag, (cx, cy, conf, hh) in insts.items():
        # 交叉驗證：兩種獨立方法都找到 → 最可信；只有一種找到 → 降級
        both = tag in bub_tags
        dec = _decode_isa(tag)
        items.append({
            "tag": tag, "kind": "instrument", "symbol": dec or "儀錶",
            "note": "", "mounting": "", "mount_conf": 0.0,
            "confidence": round(float(conf), 2),
            "evidence": [
                {"stage": "位號定位", "ok": True, "score": round(float(conf), 2),
                 "detail": f"辨識出「{tag}」，位置 ({int(cx)}, {int(cy)})"},
                {"stage": "ISA 5.1 語意", "ok": bool(dec), "score": 1.0 if dec else 0.0,
                 "detail": f"{tag[:len(re.match(r'^[A-Z]+', tag).group(0))]} → {dec}"
                           if dec else "字母碼不在 ISA 表中"},
                {"stage": "雙法交叉驗證", "ok": both, "score": 1.0 if both else 0.55,
                 "detail": ("全頁掃描與氣泡錨定兩種獨立方法都讀到此位號 → 雙重確認"
                            if both else
                            "僅單一方法讀到（另一方法未命中）→ 可信度降一級")},
            ],
            "methods": 2 if both else 1,
            "bbox": [round((cx - hh) / W, 4), round((cy - hh) / H, 4),
                     round((cx + hh) / W, 4), round((cy + hh) / H, 4)],
        })
        if not both:
            items[-1]["confidence"] = min(items[-1]["confidence"], 0.85)
    for tag, (cx, cy, conf, hh) in equips.items():
        # PFD 的項次號本身不帶語意——語意在圖面設備清單表裡，
        # 硬用首字母對照表會給出假型別（項次號根本沒有字母）
        dec = "" if is_pfd else _decode_equip(tag)
        items.append({
            "tag": tag, "kind": "equipment", "symbol": dec or ("設備項次" if is_pfd else "設備"),
            "note": "", "mounting": "", "mount_conf": 0.0,
            "confidence": round(float(conf), 2),
            "evidence": [
                {"stage": "位號定位", "ok": True, "score": round(float(conf), 2),
                 "detail": f"辨識出「{tag}」，位置 ({int(cx)}, {int(cy)})"},
                {"stage": "設備型別", "ok": bool(dec), "score": 1.0 if dec else 0.0,
                 "detail": (f"首字母 {tag[0]} → {dec}" if dec else
                                ("PFD 項次號，語意須對照圖面設備清單表"
                                 if is_pfd else "首字母不在設備型別表中"))},
            ],
            "bbox": [round((cx - hh) / W, 4), round((cy - hh) / H, 4),
                     round((cx + hh) / W, 4), round((cy + hh) / H, 4)],
        })
    try:
        items += _valves_in(req.filename, [0.0, 0.0, 1.0, 1.0], hits, W, H)
        _flag_text_zone_valves(items, hits, W, H)
    except Exception:  # noqa: BLE001
        pass

    # ---- 氣泡幾何檢查（與 OCR 完全獨立的證據，零推論零延遲）----
    # P&ID 鐵律：儀錶位號畫在氣泡（圓/六角）裡，設備位號不會。
    # 於是兩條互補規則就能抓出兩類誤讀：
    #   儀錶卻不在圈內 → 多半是把註記、尺寸標註誤讀成位號
    #   設備卻在圈內   → 多半是把儀錶位號誤讀成設備（R101 其實是 FR 65101）
    try:
        bubbles = _bubbles_norm(req.filename)
    except Exception:  # noqa: BLE001
        bubbles = []
    if bubbles:
        for it in items:
            if it["kind"] not in ("instrument", "equipment"):
                continue
            bx0, by0, bx1, by1 = it["bbox"]
            cx2, cy2 = (bx0 + bx1) / 2, (by0 + by1) / 2
            inside = any(abs(cx2 - bx) < rx * 1.25 and abs(cy2 - by) < ry * 1.25
                         for bx, by, rx, ry, _s in bubbles)
            want = it["kind"] == "instrument"
            ok = (inside == want)
            it.setdefault("evidence", []).append({
                "stage": "氣泡幾何檢查", "ok": ok, "score": 1.0 if ok else 0.15,
                "detail": (("位號落在儀錶氣泡內" if inside else "位號不在任何氣泡內")
                           + "，" + ("與判定的類型相符" if ok else
                                    ("但儀錶位號應該畫在氣泡裡 → 可能是註記或尺寸標註被誤讀"
                                     if want else
                                     "但設備位號不會畫在儀錶氣泡裡 → 可能是儀錶位號被誤讀成設備")))})
            if not ok:
                it["confidence"] = min(it["confidence"], 0.4)
                w = ("此處無氣泡，可能是註記文字被誤讀成儀錶位號"
                     if want else "此處是儀錶氣泡，可能把儀錶位號誤讀成設備")
                it["warn"] = (it["warn"] + "｜" + w) if it.get("warn") else w

    # 設備編號族群一致性：同一張圖的設備編號通常同族（本圖 E651/E652/V613 皆 6xx）。
    # 混進 R101/T108/D181 這種 1xx 幾乎都是把註記或圖框文字誤讀成位號。
    # 這比信心度可靠——OCR 給 R101 的信心是 1.0，它只是確定「字元讀對了」，
    # 不代表「這是有效設備位號」。
    fam = {}
    for t in equips:
        m = re.search(r"(\d)\d{2}$", t)
        if m:
            fam[m.group(1)] = fam.get(m.group(1), 0) + 1
    top_fam = max(fam, key=lambda k: fam[k]) if fam else None
    if top_fam and fam[top_fam] >= 2:
        for it in items:
            if it["kind"] != "equipment":
                continue
            m = re.search(r"(\d)\d{2}$", it["tag"])
            if m and m.group(1) != top_fam:
                it["warn"] = (f"設備編號 {m.group(1)}xx 與本圖主族 {top_fam}xx 不同，"
                              "可能是註記或圖框文字被誤讀成位號，請對照原圖確認")
                it["confidence"] = min(it["confidence"], 0.45)
                it.setdefault("evidence", []).append({
                    "stage": "設備編號族群檢查", "ok": False, "score": 0.3,
                    "detail": f"本圖設備多為 {top_fam}xx（{fam[top_fam]} 個），"
                              f"本項為 {m.group(1)}xx → 誤讀嫌疑"})

    # 自動通過規則：只有「儀錶」且信心滿分、無警示才免審。
    # 儀錶位號受 INST_RE 嚴格約束（已知功能字母＋3-5 碼），誤判率低；
    # 設備只有「單字母＋3 碼」太鬆，一律要人工看。
    for it in items:
        it["auto_ok"] = (it["kind"] == "instrument"
                         and it["confidence"] >= 1.0 and not it.get("warn"))

    order = {"equipment": 0, "instrument": 1, "valve": 2}
    items.sort(key=lambda x: (order.get(x["kind"], 9), x["tag"]))
    return {"items": items,
            "stats": {"instruments": len(insts), "equipment": len(equips),
                      "valves": sum(1 for i in items if i["kind"] == "valve"),
                      "total": len(items)}}


# ------------------------------------------------------ 缺口掃描（第二輪）
SYSTEM_GAP = (
    "你是 P&ID 判讀引擎，正在做「缺口掃描」（第二輪辨識）。"
    "這張圖是一張 P&ID／PFD 的一塊區域，上面疊了**藍色半透明方框**："
    "藍框＝第一輪辨識＋人工審核已經入庫的元件。\n"
    "你的任務：只找出**還沒被藍框蓋到**的工程元件，已有藍框的一律不要再列。\n"
    "要找的類別：\n"
    "1) instrument＝儀錶氣泡：圓圈（或圓加方框／六角）內的位號，圈內上半是"
    "功能字母、下半是編號，合併成一個 tag。\n"
    "2) valve＝閥件：閘閥／球閥／蝶閥／逆止閥／控制閥（帶執行器）／安全閥等，"
    "沒有位號 tag 留空字串。無位號的手動閥常被第一輪漏掉，請特別留意。\n"
    "3) equipment＝設備：槽、塔、換熱器、泵、壓縮機、風機等（PFD 為 3 碼項次號，"
    "可帶小數分項如 303.1）。\n"
    "4) pipe＝管線編號字串。\n"
    "每一項回報位置 box=[x0,y0,x1,y1]，數值 0-1000、相對**這張圖片**的寬高，"
    "框住元件本體即可，不必很精準。\n"
    "只列你真的看得到的；看不清楚就不要列，寧缺勿濫；confidence 誠實給低分。"
)
GAP_SCHEMA_HINT = (
    '輸出格式（僅輸出 JSON，不要其他文字）：\n'
    '{"items":[{"tag":"位號或空字串","kind":"instrument|valve|equipment|pipe|other",'
    '"symbol":"中文說明","confidence":0.0,"note":"","box":[0,0,0,0]}]}'
)
_GAP_KIND_TXT = {"instrument": "儀錶", "valve": "閥件", "equipment": "設備",
                 "pipe": "管線", "other": "元件"}


class GapScanReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)   # 分塊（0-1 全圖座標）
    known: list = []      # [{bbox,tag,kind}] 已入庫＋佇列中全部（含已否決）
    provider: str = "cloud"


@router.post("/gap_scan")
def gap_scan(req: GapScanReq) -> dict:
    """缺口掃描：把已入庫標註疊回原圖，視覺模型只獵「沒被標到的」。

    第一輪（scan_all）是確定性管線——OCR 讀得到位號、幾何抓得到氣泡閥件
    才找得到，沒有清楚文字的元件（無位號手動閥、設備圖形、模糊小字）天生漏。
    第二輪反向操作：把「資料庫已知」畫成藍框疊在原圖上（＝盲重建與原圖的
    雙圖對比，合成同一張所以空間對位天生正確），模型對照著已知的標註格式
    找漏網之魚。已否決項也畫框——否決是結論，不該被重新翻案排進佇列。
    找到的全部進待審，與第一輪同一條人工驗證關卡。
    """
    from PIL import Image, ImageDraw

    img_p, meta = _ensure_base(req.filename)
    W, H = meta["w"], meta["h"]
    x0, y0, x1, y1 = (float(v) for v in req.bbox)
    x0, x1 = sorted((max(0.0, x0), min(1.0, x1)))
    y0, y1 = sorted((max(0.0, y0), min(1.0, y1)))
    px0, py0, px1, py1 = int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)
    if px1 - px0 < 8 or py1 - py0 < 8:
        raise HTTPException(422, "分塊範圍太小")

    with Image.open(img_p) as im:
        crop = im.crop((px0, py0, px1, py1)).convert("RGB")
    cw, ch = crop.size
    ov = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    dr = ImageDraw.Draw(ov)
    n_marks = 0
    for k in req.known:
        kb = k.get("bbox") or []
        if len(kb) != 4:
            continue
        mx0, my0 = kb[0] * W - px0, kb[1] * H - py0
        mx1, my1 = kb[2] * W - px0, kb[3] * H - py0
        if mx1 < 0 or my1 < 0 or mx0 > cw or my0 > ch:
            continue
        pad = max(3.0, (my1 - my0) * 0.15)
        dr.rectangle([mx0 - pad, my0 - pad, mx1 + pad, my1 + pad],
                     fill=(4, 106, 251, 64), outline=(4, 106, 251, 230), width=3)
        n_marks += 1
    crop = Image.alpha_composite(crop.convert("RGBA"), ov).convert("RGB")

    if crop.width < CROP_MIN:
        k2 = min(CROP_MIN / crop.width, 4.0)
        crop = crop.resize((int(crop.width * k2), int(crop.height * k2)),
                           Image.LANCZOS)
    if crop.width > CROP_MAX:
        k2 = CROP_MAX / crop.width
        crop = crop.resize((CROP_MAX, int(crop.height * k2)), Image.LANCZOS)
    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=90)
    b64 = base64.b64encode(buf.getvalue()).decode()

    prompt = (f"這塊區域已入庫 {n_marks} 項（藍色半透明框）。"
              "請找出所有還沒被藍框蓋到的元件。\n" + GAP_SCHEMA_HINT)
    raw = _vlm(req.provider, SYSTEM_GAP, prompt, b64, want_json=True)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        m2 = re.search(r"\{.*\}", raw, re.S)
        try:
            data = json.loads(m2.group(0)) if m2 else None
        except json.JSONDecodeError:
            data = None
    if not isinstance(data, dict):
        raise HTTPException(502, f"模型輸出無法解析：{raw[:160]}")

    # 防呆去重：畫了藍框模型仍可能重報——位號撞已知、或中心落在已知框
    # （外擴 30%）內就丟。分塊重疊區的跨塊重複也靠這層吸收（前端每掃完
    # 一塊就把新項加進 known）。
    known_tags = {re.sub(r"[\s\-]", "", str(k.get("tag") or "").upper())
                  for k in req.known if k.get("tag")}

    def _hit_known(cx: float, cy: float) -> bool:
        for k in req.known:
            kb = k.get("bbox") or []
            if len(kb) != 4:
                continue
            padx = (kb[2] - kb[0]) * 0.3 + 0.002
            pady = (kb[3] - kb[1]) * 0.3 + 0.002
            if kb[0] - padx <= cx <= kb[2] + padx and \
               kb[1] - pady <= cy <= kb[3] + pady:
                return True
        return False

    items, dups = [], 0
    for r_ in (data.get("items") or [])[:40]:
        kind = str(r_.get("kind") or "other").strip()
        if kind not in _GAP_KIND_TXT:
            kind = "other"
        box = r_.get("box") or []
        if len(box) != 4:
            continue
        try:
            bx0, by0, bx1, by1 = (min(max(float(v) / 1000.0, 0.0), 1.0)
                                  for v in box)
        except (TypeError, ValueError):
            continue
        bx0, bx1 = sorted((bx0, bx1))
        by0, by1 = sorted((by0, by1))
        # 換回全圖 0-1 座標；點狀回報給最小可審框（審核卡要裁得出局部圖）
        gx0 = x0 + bx0 * (x1 - x0)
        gx1 = x0 + bx1 * (x1 - x0)
        gy0 = y0 + by0 * (y1 - y0)
        gy1 = y0 + by1 * (y1 - y0)
        if gx1 - gx0 < 0.004:
            c = (gx0 + gx1) / 2
            gx0, gx1 = c - 0.005, c + 0.005
        if gy1 - gy0 < 0.004:
            c = (gy0 + gy1) / 2
            gy0, gy1 = c - 0.005, c + 0.005
        cx, cy = (gx0 + gx1) / 2, (gy0 + gy1) / 2
        tagn = re.sub(r"[\s\-]", "", str(r_.get("tag") or "").upper())
        if (tagn and tagn in known_tags) or _hit_known(cx, cy):
            dups += 1
            continue
        conf = min(max(float(r_.get("confidence") or 0.5), 0.05), 0.85)
        dec = (_decode_isa(tagn) if kind == "instrument" else
               _decode_equip(tagn) if kind == "equipment" else "")
        eng = "雲端" if req.provider == "cloud" else "地端"
        items.append({
            "tag": tagn, "kind": kind,
            "symbol": str(r_.get("symbol") or "") or dec or _GAP_KIND_TXT[kind],
            "note": str(r_.get("note") or ""), "mounting": "", "mount_conf": 0.0,
            "confidence": round(conf, 2),
            "evidence": [
                {"stage": f"缺口掃描（{eng}）", "ok": True, "score": round(conf, 2),
                 "detail": f"以已入庫 {len(req.known)} 項的標記圖為對照，"
                           f"AI 判定此處尚有未入庫的{_GAP_KIND_TXT[kind]}"
                           + (f"「{tagn}」" if tagn else "")},
                {"stage": "AI 位置估計", "ok": True, "score": 0.5,
                 "detail": "座標由模型目測換算，可能偏移——審核時請以圖上"
                           "高亮環的位置為準"},
            ],
            "auto_ok": False,
            "bbox": [round(gx0, 4), round(gy0, 4), round(gx1, 4), round(gy1, 4)],
            "source": f"gap-{req.provider}",
        })
    return {"items": items, "skipped_dup": dups, "marks": n_marks}


# ------------------------------------------------------ 錨定問答（第一輪強化）
# 架構：向量幾何宣告「這裡有個東西」（座標像素級、零成本），VLM 只回答
# 「它是什麼」。模型答語意、不答座標——各用各的強項。
@router.get("/anchors/{filename}")
def anchors(filename: str) -> dict:
    """全圖候選錨點：儀錶氣泡＋閥件＋設備本體（向量層）。"""
    from .pid_parse import detect_bodies, detect_valves, pdf_to_norm

    _, meta = _ensure_base(filename)
    rot = meta.get("rot", 0)
    out = []
    for cx, cy, rx, ry, shape in _bubbles_norm(filename):
        out.append({"bbox": [cx - rx, cy - ry, cx + rx, cy + ry],
                    "hint": "bubble", "shape": shape})
    try:
        vl, pw, ph = detect_valves(_safe_pdf(filename))
        for x, y, s in vl:
            r = max(float(s) * 0.7, 6.0)
            rx = r / (ph if rot in (90, 270) else pw)
            ry = r / (pw if rot in (90, 270) else ph)
            u, v = pdf_to_norm(x, y, pw, ph, rot)
            out.append({"bbox": [u - rx, v - ry, u + rx, v + ry], "hint": "valve"})
    except Exception:  # noqa: BLE001
        pass
    try:
        bl, pw, ph = detect_bodies(_safe_pdf(filename))
        for x0, y0, x1, y1, kind in bl:
            u0, v0 = pdf_to_norm(x0, y0, pw, ph, rot)
            u1, v1 = pdf_to_norm(x1, y1, pw, ph, rot)
            out.append({"bbox": [min(u0, u1), min(v0, v1),
                                 max(u0, u1), max(v0, v1)],
                        "hint": "body", "shape": kind})
    except Exception:  # noqa: BLE001
        pass
    for i, a in enumerate(out):
        a["id"] = i
        a["bbox"] = [round(v, 4) for v in a["bbox"]]
    return {"anchors": out, "count": len(out)}


SYSTEM_ANCHOR = (
    "你是 P&ID 判讀引擎，正在做「錨定問答」。圖上有多個紅色編號標記，"
    "每個編號框住一個由幾何偵測到的候選元件。逐一回答每個編號是什麼：\n"
    "· instrument＝儀錶氣泡（圓／六角／方框）。圈內有位號請合成 tag："
    "上排功能字母＋下排數字，如 PI 61301 → PI61301。\n"
    "· valve＝閥件（閘閥/球閥/蝶閥/逆止/控制閥/安全閥）。有位號才填 tag，"
    "symbol 填閥型；看得到口徑（如 3/4\"、2\"）寫進 note。\n"
    "· equipment＝設備本體（塔/槽/泵/換熱器/壓縮機/過濾器）。symbol 填"
    "設備類型；框內或緊鄰有位號（V612、P632A 這類）就填 tag。\n"
    "· pipe＝其實是管線元件（縮管、盲板、軟管等）。\n"
    "· none＝誤偵測：圖框、表格、註記文字、箭頭、裝飾——不是元件。\n"
    "只依據圖面可見內容回答；看不清楚 confidence 給低分；絕不臆造位號。"
)
ANCHOR_SCHEMA_HINT = (
    '輸出格式（僅輸出 JSON，不要其他文字）：\n'
    '{"items":[{"n":1,"kind":"instrument|valve|equipment|pipe|none",'
    '"tag":"位號或空","symbol":"中文說明","confidence":0.0,"note":""}]}'
)


class AnchorAskReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)   # 分塊（0-1 全圖座標）
    anchors: list = []      # [{id, bbox, hint}] 本塊未結案錨點（建議 ≤25）
    provider: str = "cloud"


@router.post("/anchor_ask")
def anchor_ask(req: AnchorAskReq) -> dict:
    """錨定問答：編號標記疊上圖塊，模型逐號答身分。

    回傳 items（同 scan_all schema，bbox＝錨點框＝向量精度）與
    dismissed（模型判「none」的錨點 id——結案為非元件，不進佇列）。
    """
    from PIL import Image, ImageDraw, ImageFont

    if not req.anchors:
        return {"items": [], "dismissed": [], "asked": 0}
    img_p, meta = _ensure_base(req.filename)
    W, H = meta["w"], meta["h"]
    x0, y0, x1, y1 = (float(v) for v in req.bbox)
    x0, x1 = sorted((max(0.0, x0), min(1.0, x1)))
    y0, y1 = sorted((max(0.0, y0), min(1.0, y1)))
    px0, py0, px1, py1 = int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)
    if px1 - px0 < 8 or py1 - py0 < 8:
        raise HTTPException(422, "分塊範圍太小")

    with Image.open(img_p) as im:
        crop = im.crop((px0, py0, px1, py1)).convert("RGB")
    cw, ch = crop.size
    scale = 1.0
    if crop.width < CROP_MIN:
        scale = min(CROP_MIN / crop.width, 4.0)
    elif crop.width > CROP_MAX:
        scale = CROP_MAX / crop.width
    if scale != 1.0:
        crop = crop.resize((int(cw * scale), int(ch * scale)), Image.LANCZOS)

    dr = ImageDraw.Draw(crop)
    try:
        fnt = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf",
                                 max(14, int(crop.width / 70)))
    except OSError:
        fnt = ImageFont.load_default()
    asked = []                      # 依編號順序對回 anchor
    for a in req.anchors[:25]:
        ab = a.get("bbox") or []
        if len(ab) != 4:
            continue
        mx0 = (ab[0] * W - px0) * scale
        my0 = (ab[1] * H - py0) * scale
        mx1 = (ab[2] * W - px0) * scale
        my1 = (ab[3] * H - py0) * scale
        if mx1 < 0 or my1 < 0 or mx0 > crop.width or my0 > crop.height:
            continue
        n = len(asked) + 1
        asked.append(a)
        dr.rectangle([mx0 - 3, my0 - 3, mx1 + 3, my1 + 3],
                     outline=(220, 30, 30), width=3)
        lab = str(n)
        tb = dr.textbbox((mx0, my0 - fnt.size - 6), lab, font=fnt)
        dr.rectangle([tb[0] - 3, tb[1] - 2, tb[2] + 3, tb[3] + 2],
                     fill=(220, 30, 30))
        dr.text((mx0, my0 - fnt.size - 6), lab, fill=(255, 255, 255), font=fnt)
    if not asked:
        return {"items": [], "dismissed": [], "asked": 0}

    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=90)
    b64 = base64.b64encode(buf.getvalue()).decode()
    prompt = (f"圖上共有 {len(asked)} 個紅色編號標記（1~{len(asked)}）。"
              "請逐號回答每個標記框住的是什麼。\n" + ANCHOR_SCHEMA_HINT)
    raw = _vlm(req.provider, SYSTEM_ANCHOR, prompt, b64, want_json=True)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        m2 = re.search(r"\{.*\}", raw, re.S)
        try:
            data = json.loads(m2.group(0)) if m2 else None
        except json.JSONDecodeError:
            data = None
    if not isinstance(data, dict):
        raise HTTPException(502, f"模型輸出無法解析：{raw[:160]}")

    items, dismissed = [], []
    eng = "雲端" if req.provider == "cloud" else "地端"
    for r_ in (data.get("items") or [])[:len(asked) + 5]:
        try:
            n = int(r_.get("n"))
        except (TypeError, ValueError):
            continue
        if not (1 <= n <= len(asked)):
            continue
        a = asked[n - 1]
        kind = str(r_.get("kind") or "").strip()
        conf = min(max(float(r_.get("confidence") or 0.5), 0.05), 0.9)
        if kind == "none":
            dismissed.append({"id": a.get("id"), "note": str(r_.get("note") or "")})
            continue
        if kind not in ("instrument", "valve", "equipment", "pipe"):
            continue
        tagn = re.sub(r"[\s\-]", "", str(r_.get("tag") or "").upper())
        dec = (_decode_isa(tagn) if kind == "instrument" else
               _decode_equip(tagn) if kind == "equipment" else "")
        hint_txt = {"bubble": "氣泡", "valve": "蝴蝶結", "body": "殼體輪廓"}.get(
            a.get("hint", ""), "幾何特徵")
        items.append({
            "tag": tagn, "kind": kind,
            "symbol": str(r_.get("symbol") or "") or dec
                      or _GAP_KIND_TXT.get(kind, "元件"),
            "note": str(r_.get("note") or ""), "mounting": "", "mount_conf": 0.0,
            "confidence": round(conf, 2),
            "evidence": [
                {"stage": "向量錨點", "ok": True, "score": 1.0,
                 "detail": f"幾何層以{hint_txt}宣告此處有元件——座標為向量"
                           "精度，非模型目測"},
                {"stage": f"錨定問答（{eng}）", "ok": True, "score": round(conf, 2),
                 "detail": f"模型判定編號 {n} 為{_GAP_KIND_TXT.get(kind, kind)}"
                           + (f"「{tagn}」" if tagn else "")},
            ],
            "auto_ok": False,
            "bbox": [round(float(v), 4) for v in a["bbox"]],
            "anchor_id": a.get("id"),
            "source": f"anchor-{req.provider}",
        })
    return {"items": items, "dismissed": dismissed, "asked": len(asked)}


class ClassifyOneReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)
    provider: str = "local"


@router.post("/classify_one")
def classify_one(req: ClassifyOneReq) -> dict:
    """單一儀錶氣泡的安裝別判定——審核到哪一項才算哪一項，不必先等全部。"""
    from PIL import Image

    img_p, meta = _ensure_base(req.filename)
    W, H = meta["w"], meta["h"]
    x0, y0, x1, y1 = (float(v) for v in req.bbox)
    cx, cy = (x0 + x1) / 2 * W, (y0 + y1) / 2 * H
    r = max((x1 - x0) * W, (y1 - y0) * H) * 1.6
    r = max(r, 26)
    with Image.open(img_p) as im:
        c = im.crop((int(max(0, cx - r)), int(max(0, cy - r)),
                     int(min(W, cx + r)), int(min(H, cy + r))))
        if c.width < 240:
            k = 240 / max(c.width, 1)
            c = c.resize((int(c.width * k), int(c.height * k)), Image.LANCZOS)
        buf = io.BytesIO()
        c.save(buf, format="JPEG", quality=92)
    letter, conf, raw = _classify_bubble(
        base64.b64encode(buf.getvalue()).decode(), req.provider)
    rules = _load_rules().get("bubble_choices", {})
    return {"mounting": rules.get("mounting", {}).get(letter, ""),
            "mount_conf": round(conf, 2),
            "detail": f"選 {letter}：{(rules.get('options', {}) or {}).get(letter, '')}"
                      f"｜原始回答「{raw}」"}


class DescribeReq(BaseModel):
    filename: str
    feedback: str = ""       # 使用者意見（要求修正／補充）
    previous: str = ""       # 前一版描述——有的話就是「修訂」而不是重寫
    provider: str = "local"  # cloud＝雲端（引用標記才跟得住）｜local＝地端（NDA）


# 製程說明落地：一份四千字報告要跑好幾十秒、燒不少 token，
# 產出來就該存著。重開圖面、重整頁面都直接拿既有的，
# 只有工程師明確按「重新產生」或提意見時才重跑。
def _desc_path(filename: str, domain: str) -> Path:
    d = ANNOT_DIR / re.sub(r"[^a-z0-9.-]+", "-", (domain or "dev.local").lower())
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{_slug(Path(filename).stem)}.desc.json"


def _load_desc(filename: str, domain: str) -> dict | None:
    p = _desc_path(filename, domain)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


@router.get("/describe/{filename}")
def describe_get(filename: str, request: Request) -> dict:
    """取既有的製程說明——沒有就回 204 語意（empty），不觸發生成。"""
    from .auth import current_domain

    _safe_pdf(filename)
    d = _load_desc(filename, current_domain(request))
    return d or {"text": "", "notes": [], "empty": True}


DESCRIBE_SYS = (
    "你是資深製程工程師，要為同事寫一份這張 P&ID 的完整判讀報告。\n"
    "你會同時拿到**整張圖面影像**與圖上**經工程師逐項人工確認過**的位號清單。\n"
    "務必先看圖，特別是：右下角**標題欄**（會寫明是哪個廠、哪個製程單元、圖號）、"
    "圖面上的**中文/英文註記 note**（常是變更履歷與設計決策）、"
    "設備之間的**管線連接與流向箭頭**、管線編號。"
    "清單只給你位號，看不出流程走向與單元名稱——那些要靠看圖。\n"
    "請以繁體中文寫一份**詳盡**的報告，涵蓋下列七個部分，每部分至少一段、"
    "內容要具體到位號層級，不要只給空泛的通則：\n"
    "一、製程單元判定：這是什麼單元？從設備組合與位號編碼規則推斷，"
    "並說明你的判斷依據。\n"
    "二、主要流程走向：物料從哪裡進、經過哪些設備、往哪裡出，"
    "盡量把設備串成一條或多條路徑。\n"
    "三、關鍵設備逐台說明：每一台設備各自的作用、在流程中的位置與角色。\n"
    "四、控制策略：逐一分析控制迴路。從儀錶字母碼推斷"
    "（LIC＝液位指示控制、PIC＝壓力指示控制、TIC＝溫度指示控制、"
    "FIC＝流量指示控制、LV/FV/TV＝對應的控制閥），"
    "說明每個迴路在控什麼、量測點在哪、操作端是哪顆閥。\n"
    "五、量測佈署分析：哪些是就地表、哪些上盤面/DCS，"
    "從這個分佈看出操作員在控制室看得到什麼、必須到現場看什麼。\n"
    "六、安全與連鎖：安全閥、警報（字尾 H/L/HH/LL）、開關類儀錶"
    "（字母含 S）代表的保護邏輯與可能的連鎖動作。\n"
    "七、操作與維護重點：開俥停俥、日常巡檢、易故障點的提醒。\n"
    "規則：只根據清單推論，**絕對不要編造清單裡沒有的設備、位號或數值**；"
    "凡是推論都要明說「研判／推測」；清單資訊不足以判斷的部分，"
    "直接寫明「此圖清單不足以判斷，需再查閱原圖某某處」。"
    "不要 markdown 標題符號與粗體，用「一、」「二、」這種中文編號分段。"
)

REVISE_SYS = (
    "你是資深製程工程師，正在**修訂**一份既有的 P&ID 製程說明。\n"
    "你會拿到三樣東西：(1) 目前已確認的位號清單（可能已被工程師更正過）、"
    "(2) 前一版說明、(3) 工程師的意見。\n"
    "請輸出修訂後的完整說明，並遵守：\n"
    "· 只要是這次**有更動或修正**的句子，整句用 ⟪ 與 ⟫ 包起來"
    "（例：⟪這一段原本寫錯了，實際上是液位控制。⟫），沒動到的句子不要加。\n"
    "· 如果前一版有與清單牴觸的敘述（例如提到清單裡不存在的設備），"
    "必須改掉並包在 ⟪⟫ 裡。\n"
    "· 若採用了「現場工程師評註」的內容，該句句尾要標 ⟦N1⟧ 這種引用編號；"
    "前一版已有的引用標記若該句仍成立就保留。\n"
    "· 不要編造清單裡沒有的東西；不要 markdown 標題與粗體；"
    "不要輸出「修訂說明」之類的前言，直接給正文。"
)


@router.post("/describe")
def describe(req: DescribeReq, request: Request) -> dict:
    """依已確認標註生成製程說明。

    刻意要求審核完成才可呼叫——說明是給人看的結論，
    建立在未經確認的模型輸出上就是把幻覺包裝成報告。
    """
    from datetime import datetime, timezone

    from .auth import current_domain

    _safe_pdf(req.filename)
    dom = current_domain(request)
    d = _load_annots(req.filename, dom)
    items = d["items"]
    if len(items) < 3:
        raise HTTPException(422, "已確認的標註太少（至少 3 項），無法據以描述製程")

    def fmt(kind, label):
        rows = [i for i in items if i.get("kind") == kind]
        if not rows:
            return ""
        body = "、".join(
            f"{i.get('tag') or '(無位號)'}"
            + (f"［{i.get('symbol')}" + (f"／{i['mounting']}" if i.get("mounting") else "") + "］"
               if i.get("symbol") else "")
            for i in rows[:80])
        return f"{label}（{len(rows)}）：{body}\n"

    ctx = (f"圖面：{Path(req.filename).stem}\n"
           + fmt("equipment", "設備") + fmt("instrument", "儀錶") + fmt("valve", "閥件"))

    # 連圖面一起餵——只給位號清單等於要模型腦補流程走向。
    # 標題欄、圖面註記（常是 MOC 變更履歷）、管線怎麼串、符號外框，
    # 這些只有看圖才讀得到，清單裡一個字都沒有。
    sheet_b64 = None
    try:
        sheet_b64 = _sheet_b64(req.filename)
    except Exception:  # noqa: BLE001
        pass

    # 分塊導讀：整張 A3 縮到 1800px 餵進 7B，只剩標題欄那種大字讀得到
    # （實測位號氣泡、管線編號、中文 note 全糊掉）。先讓模型逐塊細看再彙總，
    # 圖面註記與管線走向才進得了報告。
    survey = ""
    if sheet_b64 and not (req.previous.strip() or req.feedback.strip()):
        try:
            survey = _tile_survey(req.filename, "local")
        except Exception:  # noqa: BLE001
            survey = ""
    if survey:
        ctx += ("\n【分塊細看圖面所得（同一張圖放大後逐塊判讀）】\n" + survey)

    # 知識庫檢索：給模型本廠既有的製程判讀慣例當依據，而不是讓它自由發揮。
    # 這是製程說明穩定度的根本——同一張圖每次跑，引用的參考條文都一樣。
    kb = _kb_retrieve(items, survey)
    if kb:
        ctx += "\n\n" + kb

    # 現場評註（RAG）：走過現場的人留下的知識，模型從圖上永遠讀不到
    # 「這台去年改過」「這條線停用了」。可信度高於任何圖面推論，
    # 且要求逐句標引用編號，讀者才查得回是誰說的、來自圖上哪裡。
    from .pid_notes import list_notes, rag_block

    notes = list_notes(req.filename, dom)
    nb = rag_block(notes)
    if nb:
        ctx += "\n\n" + nb

    if req.previous.strip() or req.feedback.strip():
        # 修訂模式：帶上前一版與工程師意見，要求標出改動處
        user = (f"【目前已確認清單】\n{ctx}\n"
                f"【前一版說明】\n{req.previous.strip() or '（無）'}\n"
                f"【工程師意見】\n{req.feedback.strip() or '（無特別意見，請依最新清單自行校正牴觸之處）'}")
        out = {"text": _clean_md(_describe_llm(REVISE_SYS, user, sheet_b64, req.provider)),
               "based_on": len(items), "revised": True, "provider": req.provider,
               "with_image": bool(sheet_b64), "notes": notes}
    else:
        out = {"text": _clean_md(_describe_llm(DESCRIBE_SYS, ctx, sheet_b64, req.provider)),
               "based_on": len(items), "revised": False, "provider": req.provider,
               "with_image": bool(sheet_b64), "notes": notes}
    out["at"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    if out["text"]:
        try:
            _desc_path(req.filename, dom).write_text(
                json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            pass            # 存檔失敗不該讓已經產好的報告消失
    return out


def _describe_llm(system: str, user: str, sheet_b64: str | None,
                  provider: str) -> str:
    """製程說明的引擎分派。

    地端 7B 跟不住「句尾標 ⟦N1⟧ 引用編號」這種格式指令（實測整篇零標記），
    引用來源是這份報告可查證性的根本，所以雲端可用時走雲端；
    NDA 場域切回地端，代價是失去引用標記——UI 上會講明白。
    """
    if provider == "cloud" and _cloud_key():
        try:
            txt = _claude_chat(system, user, sheet_b64 or "", timeout=300)
            if txt.strip():
                return txt
        except Exception:  # noqa: BLE001
            pass                        # 雲端不通就退回地端，不要整個失敗
        # 雲端回空字串也要退回地端——回空等於整份報告消失，比降級更糟
    return _complete_text(system, user, image_b64=sheet_b64)


CROSS_SYS = (
    "你是 P&ID 判讀助手。畫面正中央有一個元件，請只回答它的位號本身。\n"
    "規則：\n"
    "· 儀錶氣泡的位號分上下兩半（上為功能字母如 PI/TT/LIC，下為編號如 65103），"
    "請合併成一個，中間留一個空白，例如「PI 65103」。\n"
    "· 設備位號如「V 613」「E 651」也照樣輸出。\n"
    "· **只輸出位號本身，不要任何說明文字。**\n"
    "· 畫面裡可能同時出現好幾個位號（P&ID 上元件很密），"
    "**一律回答最靠近畫面正中心的那一個**，不要回答旁邊的鄰居。\n"
    "· 如果正中央沒有位號（是純文字註記、尺寸標註、管線或空白），"
    "只回答「NONE」。\n"
    "· 看得到但讀不清楚，只回答「UNCLEAR」。"
)


class CrossReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)
    tag: str = ""
    provider: str = "local"


def _norm_tag(t: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (t or "").upper())


@router.post("/crosscheck")
def crosscheck(req: CrossReq) -> dict:
    """OCR × VLM 雙重檢查：同一塊區域讓 VLM 獨立再讀一次位號，與 OCR 結果比對。

    兩個獨立方法一致 ＝ 真正可信；只有 OCR 說「我很確定字元讀對了」不算數
    （實測 R101 的 OCR 信心 1.0，但圖上根本沒這個位號）。
    """
    x0, y0, x1, y1 = (float(v) for v in req.bbox)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bw, bh = max(x1 - x0, 0.006), max(y1 - y0, 0.006)

    # 多尺度投票：同一個位置裁三種大小各判一次，取眾數。
    # 單一裁切兩面不討好——框小了讀不到、框大了讀到隔壁（實測 3.2 倍時
    # E651 被讀成鄰居的 PDI 65106）。三塊投票同時解掉兩個問題，
    # 而且票數本身就是信心度：3/3 一致遠比 2/3 可信。
    votes, reads = [], []
    for scale in (1.6, 2.4, 3.4):
        w, h = bw * scale, bh * scale
        box = [max(0.0, cx - w / 2), max(0.0, cy - h / 2),
               min(1.0, cx + w / 2), min(1.0, cy + h / 2)]
        try:
            b64, _ = _crop_b64(req.filename, box)
            raw = (_vlm(req.provider, CROSS_SYS, "這個元件的位號是什麼？", b64) or "").strip()
        except Exception:  # noqa: BLE001
            continue
        t = raw.splitlines()[0].strip()[:24] if raw else ""
        reads.append(f"{scale:g}x→{t or '(空)'}")
        if t:
            votes.append(t)

    if not votes:
        return {"vlm_tag": "", "verdict": "unclear", "delta": 0.0, "agree": False,
                "detail": "三次裁切均無回應，無法交叉驗證", "reads": reads}

    # 依正規化後的字串投票，取票數最高者
    tally: dict = {}
    for v in votes:
        k = _norm_tag(v)
        tally.setdefault(k, {"n": 0, "raw": v})
        tally[k]["n"] += 1
    best = max(tally.values(), key=lambda x: x["n"])
    vlm_tag, n_agree = best["raw"], best["n"]
    vote_txt = f"三塊投票 {n_agree}/{len(votes)}（{'、'.join(reads)}）"

    a, b = _norm_tag(req.tag), _norm_tag(vlm_tag)
    # 票數不足（三塊各說各話）代表這塊本來就難判，不該拿來下結論
    weak = n_agree < 2
    if b == "NONE":
        verdict, delta = ("unclear", -0.1) if weak else ("none", -0.45)
        detail = (f"{vote_txt}｜VLM 判定該處沒有位號（OCR 讀成「{req.tag}」）"
                  + ("——但票數不足，僅供參考" if weak else "→ 高度可疑"))
    elif b in ("UNCLEAR", "") or not b:
        verdict, delta = "unclear", 0.0
        detail = f"{vote_txt}｜VLM 讀不清楚，無法交叉驗證（OCR 讀為「{req.tag}」）"
    elif a == b:
        verdict = "agree" if n_agree >= 2 else "partial"
        delta = 0.0 if n_agree >= 2 else -0.05
        detail = (f"{vote_txt}｜VLM 獨立判讀為「{vlm_tag}」，與 OCR 一致"
                  + ("→ 雙重確認通過" if n_agree >= 2 else "，但票數僅 1/3"))
    elif a and (a.startswith(b) or b.startswith(a)):
        verdict, delta = "partial", -0.15
        detail = f"{vote_txt}｜VLM 讀為「{vlm_tag}」，與 OCR「{req.tag}」部分相符"
    else:
        verdict, delta = ("unclear", -0.1) if weak else ("conflict", -0.35)
        detail = (f"{vote_txt}｜VLM 讀為「{vlm_tag}」，與 OCR「{req.tag}」不一致"
                  + ("——但票數不足，需人工看" if weak else "→ 需人工判定"))
    return {"vlm_tag": vlm_tag, "verdict": verdict, "delta": delta, "detail": detail,
            "agree": verdict == "agree", "votes": n_agree, "reads": reads}


@router.get("/crop/{filename}")
def crop_image(filename: str, bbox: str, z: float = 7.0):
    """回傳以該元件為中心的局部圖——審核時最有用的東西其實是「讓人自己看」。
    任何文字描述都可能出錯，像素不會。"""
    from fastapi.responses import Response

    try:
        x0, y0, x1, y1 = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(422, "bbox 格式須為 x0,y0,x1,y1") from None
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w = max(x1 - x0, 0.010) * z
    h = max(y1 - y0, 0.010) * z
    box = [max(0.0, cx - w / 2), max(0.0, cy - h / 2),
           min(1.0, cx + w / 2), min(1.0, cy + h / 2)]
    b64, _ = _crop_b64(filename, box)
    return Response(content=base64.b64decode(b64), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=3600"})


# 有警示的項目不能用「描述它的功能」問法——那等於預設它存在，模型只好編。
# 改成查核問法：先問「這裡到底有沒有這個位號」。
VERIFY_SYS = (
    "你是資深製程工程師，正在**查核**一個可疑的 P&ID 判讀結果。"
    "系統宣稱畫面正中央有一個位號，但這個判讀被標記為可疑，很可能是"
    "把圖面註記、標題欄、尺寸標註或其他文字誤讀成位號。\n"
    "請用繁體中文 2～4 句回答：\n"
    "① 畫面正中央實際上是什麼？（是儀錶氣泡／設備輪廓／純文字註記／尺寸標註？）\n"
    "② 那個宣稱的位號，圖上真的有嗎？如果有，長什麼樣；如果沒有，"
    "那個位置實際寫的是什麼字？\n"
    "**不要假設它存在。看不清楚就直說看不清楚，絕對不要臆造連接關係或功能。**"
    "不要 markdown 標題與粗體。"
)


class ContextReq(BaseModel):
    filename: str
    bbox: list = Field(..., min_length=4, max_length=4)
    tag: str = ""
    kind: str = ""
    symbol: str = ""
    provider: str = "local"
    verify: bool = False       # True＝可疑項目，改用查核問法而非功能描述


CONTEXT_SYS = (
    "你是資深製程工程師。使用者正在審核 P&ID 上的某一個元件，"
    "畫面是以該元件為中心、往外擴大的一塊區域，元件大約在正中央。\n"
    "請用繁體中文寫 2～4 句，說明：這顆元件裝在哪條管線或哪台設備上、"
    "它的前後接什麼、放在這個位置的作用是什麼。\n"
    "看得到的鄰近位號與管線編號請直接引用。"
    "**看不清楚就說看不清楚，絕對不要臆造位號或數值。**"
    "不要 markdown 標題與粗體。"
)


@router.post("/context")
def context(req: ContextReq) -> dict:
    """單一元件的情境描述——審到哪一項，就說明它在圖上扮演什麼角色。

    裁切以元件為中心往外放大數倍，讓模型看得到前後接了什麼；
    只看元件本身的小框是講不出上下游關係的。
    """
    x0, y0, x1, y1 = (float(v) for v in req.bbox)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w = max(x1 - x0, 0.012) * 9      # 往外拉 9 倍，含得到上下游管線與鄰居
    h = max(y1 - y0, 0.012) * 9
    box = [max(0.0, cx - w / 2), max(0.0, cy - h / 2),
           min(1.0, cx + w / 2), min(1.0, cy + h / 2)]
    img_b64, _ = _crop_b64(req.filename, box)
    if req.verify:
        txt = _vlm(req.provider, VERIFY_SYS,
                   f"系統宣稱畫面正中央是「{req.tag}」"
                   + (f"（判定為{req.symbol}）" if req.symbol else "")
                   + "。請查核這個判讀是否成立。", img_b64)
    else:
        who = f"元件位號 {req.tag}" + (f"（{req.symbol}）" if req.symbol else "")
        txt = _vlm(req.provider, CONTEXT_SYS + "\n\n" + _rules_prompt(),
                   f"{who}，位於畫面中央。請說明它在這張圖上的角色與前後連接。", img_b64)
    return {"text": txt or "（模型沒有回應，可放大框選範圍再試）", "verify": req.verify}


TILE_SYS = (
    "你是資深製程工程師，正在逐塊細看一張 P&ID。"
    "這是整張圖的其中一塊（已放大）。請用繁體中文條列你在這塊看到的："
    "設備名稱與說明文字、圖面註記（note）、管線編號與流向、"
    "標題欄資訊（若這塊含標題欄）。"
    "**只寫你真的看得到的文字，看不清楚就略過，絕對不要臆造。**"
    "最多 6 行，每行一則。不要 markdown 標題與粗體。"
)


def _tile_survey(filename: str, provider: str, tc: int = 3, tr: int = 2) -> str:
    """把整張圖切塊放大逐塊判讀 → 彙整成文字，供撰寫報告時參考。"""
    out = []
    for r in range(tr):
        for c in range(tc):
            box = [max(0.0, c / tc - 0.02), max(0.0, r / tr - 0.02),
                   min(1.0, (c + 1) / tc + 0.02), min(1.0, (r + 1) / tr + 0.02)]
            try:
                b64, _ = _crop_b64(filename, box)
                t = _vlm(provider, TILE_SYS, "請條列這一塊看到的內容。", b64)
            except Exception:  # noqa: BLE001
                continue
            if t:
                out.append(f"[第 {r * tc + c + 1} 塊]\n{t.strip()}")
    return "\n".join(out)


def _kb_retrieve(items: list, survey: str = "") -> str:
    """依偵測到的位號／設備檢索製程知識庫 → 注入提示詞的參考條文。

    用規則比對而非向量檢索：知識庫是人工策展的小型結構化資料，
    位號前綴與關鍵字的比對既精確又可稽核，不需要 embedding 也不會檢索錯。
    目的是讓模型「有據可循」而不是憑空推論——這是穩定度的根本。
    """
    p = RULES_DIR / "process_kb.json"
    if not p.exists():
        return ""
    try:
        kb = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return ""

    tags = [str(i.get("tag") or "").upper() for i in items]
    prefixes = {re.match(r"^[A-Z]+", t).group(0) for t in tags if re.match(r"^[A-Z]+", t)}
    equip_pfx = {t[0] for i, t in zip(items, tags)
                 if i.get("kind") == "equipment" and t}
    blob = (survey + " " + " ".join(
        str(i.get("symbol", "")) + str(i.get("note", "")) for i in items)).upper()

    picked = []
    for sig in kb.get("unit_signatures", []):
        w = sig.get("when", {})
        hit = (any(e in equip_pfx for e in w.get("equip_prefix", []))
               or any(a in prefixes for a in w.get("any_tag", []))
               or any(k.upper() in blob for k in w.get("keywords", [])))
        if hit:
            picked.append(sig["text"])
    for group in ("control_patterns", "safety_patterns", "mounting_meaning"):
        for e in kb.get(group, []):
            if any(k.upper() in prefixes or k.upper() in blob for k in e.get("key", [])):
                picked.append(e["text"])
    picked += kb.get("cautions", [])

    if not picked:
        return ""
    seen, out = set(), []
    for t in picked:
        if t not in seen:
            seen.add(t)
            out.append("· " + t)
    return ("【製程判讀參考（由本廠知識庫依本圖位號檢索而得，"
            "請據此判斷，不要與之牴觸）】\n" + "\n".join(out))


_MD_HEAD = re.compile(r"^\s{0,3}#{1,6}\s*", re.M)
_MD_BULLET = re.compile(r"^\s{0,4}[-*+]\s+", re.M)
_MD_BOLD = re.compile(r"\*\*(.+?)\*\*|__(.+?)__", re.S)
_MD_FENCE = re.compile(r"^\s*```.*$", re.M)


def _clean_md(t: str) -> str:
    """清掉模型硬要輸出的 markdown 記號。

    提示詞已明說不要，但 7B 模型照樣吐 ####、**粗體**、- 項目符號。
    這種事不該靠模型自律——在輸出端清掉才是可靠的做法。
    """
    if not t:
        return t
    t = _MD_FENCE.sub("", t)
    t = _MD_HEAD.sub("", t)
    t = _MD_BOLD.sub(lambda m: m.group(1) or m.group(2) or "", t)
    t = _MD_BULLET.sub("· ", t)
    t = re.sub(r"^\s*[-–—=]{3,}\s*$", "", t, flags=re.M)   # 分隔線
    t = re.sub(r"`([^`]+)`", r"\1", t)                      # 行內程式碼
    t = re.sub(r"\n{3,}", "\n\n", t)                        # 過多空行
    return t.strip()


def _sheet_b64(filename: str, width: int = 1800) -> str:
    """整張圖面縮圖 → base64，餵給模型看標題欄／註記／管線走向。"""
    from PIL import Image

    img_p, _ = _ensure_base(filename)
    with Image.open(img_p) as im:
        if im.width > width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        im.convert("RGB").save(buf, format="JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


def _complete_text(system: str, user: str, timeout: int = 240,
                   image_b64: str | None = None) -> str:
    """製程說明推論。

    帶圖時走 Ollama 視覺模型（純文字的 Qwen3.6 看不到圖）；
    沒帶圖才優先用 8787 的大模型。
    """
    if image_b64:
        body = {"model": VLM_MODEL, "stream": False,
                "options": {"temperature": 0.4, "num_predict": 3000},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user, "images": [image_b64]}]}
        req = urllib.request.Request(
            f"{OLLAMA}/api/chat", data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                out = json.loads(resp.read())
            txt = (out.get("message", {}).get("content") or "").strip()
            if txt:
                return txt
        except Exception:  # noqa: BLE001
            pass                      # 看圖失敗 → 退回純文字

    key = os.environ.get("AI_API_KEY")
    if not key:
        p = Path.home() / "llamacpp" / "api_key.txt"
        key = p.read_text(encoding="utf-8").strip() if p.exists() else None
    base = os.environ.get("AI_BASE_URL", "http://127.0.0.1:8787/v1")
    if key:
        body = {"model": "qwen3.6", "max_tokens": 3000, "temperature": 0.4,
                "chat_template_kwargs": {"enable_thinking": False},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user}]}
        r = urllib.request.Request(
            f"{base}/chat/completions", data=json.dumps(body).encode(), method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                out = json.loads(resp.read())
            txt = (out["choices"][0]["message"].get("content") or "").strip()
            if txt:
                return txt
        except Exception:  # noqa: BLE001
            pass                      # 落到 Ollama

    body = {"model": VLM_MODEL, "stream": False,
            "options": {"temperature": 0.4, "num_predict": 3000},
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}]}
    req = urllib.request.Request(
        f"{OLLAMA}/api/chat", data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            out = json.loads(resp.read())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            503, f"文字引擎皆無回應（{type(e).__name__}）——"
                 "請啟動本機 Qwen3.6（8787）或確認 Ollama 運作中") from None
    return (out.get("message", {}).get("content") or "").strip()


class RejectReq(BaseModel):
    tag: str = ""
    kind: str = ""
    reason: str = "人工判定非此元件"


@router.post("/reject/{filename}")
def annot_reject(filename: str, req: RejectReq, request: Request) -> dict:
    """人工否決一筆候選——只寫稽核不入庫。

    一一審核的前提是「沒有東西被靜默丟掉」：AI 判錯了什麼、誰在什麼時候否決的，
    都要留痕，否則無法回頭檢討模型也無法對客戶交代覆核過程。
    """
    from datetime import datetime, timezone

    from .auth import current_actor, current_domain

    _safe_pdf(filename)
    dom = current_domain(request)
    with ANNOT_LOCK:
        d = _load_annots(filename, dom)
        d["audit"].append({
            "at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "action": "reject", "tag": req.tag, "kind": req.kind,
            "reason": req.reason, "by": current_actor(request)})
        _save_annots(filename, d, dom, f"reject:{req.tag}")
    return {"ok": True, "rejected": sum(1 for a in d["audit"] if a.get("action") == "reject")}


@router.get("/export/{filename}")
def annot_export(filename: str, request: Request):
    """已確認標註 → CSV（設備台帳交付物）。
    帶 UTF-8 BOM，Excel 直接雙擊開不會變亂碼。"""
    import csv

    from fastapi.responses import StreamingResponse

    from .auth import current_domain

    _safe_pdf(filename)
    d = _load_annots(filename, current_domain(request))
    buf = io.StringIO()
    buf.write("﻿")                       # BOM：Excel 中文相容
    w = csv.writer(buf)
    w.writerow(["圖面", "位號", "類型", "語意", "安裝位置", "信心度",
                "來源", "採納時間", "備註", "備註來源", "審核者", "圖面X", "圖面Y"])
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
                    a.get("created_at", ""), a.get("note", ""),
                    "人工" if a.get("user_note") else ("系統" if a.get("note") else ""),
                    a.get("verified_by", ""), cx, cy])
    buf.seek(0)
    fn = f"{_slug(Path(filename).stem)}_tags.csv"
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fn}"'})


@router.delete("/annot/{filename}/{item_id}")
def annot_delete(filename: str, item_id: str, request: Request) -> dict:
    from datetime import datetime, timezone

    from .auth import current_domain

    _safe_pdf(filename)
    dom = current_domain(request)
    with ANNOT_LOCK:
        d = _load_annots(filename, dom)
        before = len(d["items"])
        d["items"] = [i for i in d["items"] if i.get("id") != item_id]
        if len(d["items"]) == before:
            raise HTTPException(404, "標註不存在")
        now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        d["audit"].append({"at": now, "action": "delete", "id": item_id})
        _save_annots(filename, d, dom, f"delete:{item_id}")
    return {"ok": True, "count": len(d["items"])}
