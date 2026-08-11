# 現場評註 — 工程師寫在圖上的知識，是製程說明的第一手來源
#
# 為什麼要做這個：模型看得到圖面畫了什麼，但看不到「這台去年改過」
# 「這條線實際上停用了」「這顆閥現場鎖死」。這些只有走過現場的人知道，
# 而且往往是製程說明裡最關鍵的一句。
#
# 三個設計決定：
#   ① 評註綁定「目標」——某個元件（位號）或某塊框選區域，不是滿天飛的便利貼。
#      綁了目標，說明裡引用它時才回得去原圖位置。
#   ② 每則都記作者與時間，且只能由作者或管理員刪——這是署名的工程判斷，
#      不是匿名塗鴉。
#   ③ 生成製程說明時當檢索來源（RAG），並要求模型逐句標出引用編號，
#      前端就能把「這句話是誰說的、來自圖上哪裡」直接顯示出來。
#      沒有出處的說明等於無法查證，那是報告最要命的缺陷。
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/pid/notes", tags=["pid-notes"])

BASE_DIR = Path(__file__).resolve().parent.parent
NOTES_DIR = BASE_DIR / "data" / "pid_notes"


def _path(filename: str, domain: str) -> Path:
    from .pid_vlm import _slug

    d = NOTES_DIR / re.sub(r"[^a-z0-9.-]+", "-", (domain or "dev.local").lower())
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{_slug(Path(filename).stem)}.json"


def _load(filename: str, domain: str) -> dict:
    p = _path(filename, domain)
    if not p.exists():
        return {"notes": []}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"notes": []}


def _save(filename: str, domain: str, d: dict) -> None:
    p = _path(filename, domain)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class NoteReq(BaseModel):
    text: str
    bbox: list = Field(default_factory=list)     # 框選區域（正規化），可空
    tag: str = ""                                # 綁定的元件位號，可空
    kind: str = "region"                         # region | element


class NotePatch(BaseModel):
    text: str


def list_notes(filename: str, domain: str) -> list:
    """給 describe() 用的內部取用（不經 HTTP）。"""
    return _load(filename, domain).get("notes", [])


def rag_block(notes: list) -> str:
    """把評註整理成可引用的檢索區塊——每則給固定編號，模型才引得回來。

    引用規則**寫在這個區塊裡面**而不是系統提示的結尾：實測放在長提示的
    第八點時，模型會採用評註內容卻不標編號（內容進去了、出處掉了）。
    指令貼著它所規範的資料，跟隨率才高。
    """
    if not notes:
        return ""
    lines = []
    for n in notes:
        where = (f"元件 {n['tag']}" if n.get("tag")
                 else (f"圖面座標 ({n['bbox'][0]:.2f}, {n['bbox'][1]:.2f})"
                       if n.get("bbox") else "全圖"))
        who = (n.get("by") or "").split("@")[0] or "工程師"
        lines.append(f"[{n['id']}]（{where}｜{who}）{n['text']}")
    return ("【現場工程師評註｜必須引用並標註出處】\n"
            "以下是實際走過現場的人所留，**可信度高於任何從圖面推論出來的結論**；"
            "與圖面判讀衝突時一律以評註為準。\n"
            "⚠ 硬性格式要求：只要某一句話用到了下列任何一則評註的內容，"
            "**該句句尾必須緊接寫上該則的編號標記**，格式為 ⟦N1⟧（多則寫 ⟦N1⟧⟦N3⟧）。"
            "例：「209 捏和擠出機實際產能約 2.4T/hr，低於清冊標示。⟦N1⟧」\n"
            "沒有用到評註的句子不要加標記。這是為了讓讀者查得出每句話的出處——"
            "採用了內容卻不標出處，等於把工程師的判斷當成 AI 自己的推論，這是不允許的。\n"
            + "\n".join(lines))


@router.get("/{filename}")
def get_notes(filename: str, request: Request) -> dict:
    from .auth import current_actor, current_domain
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    return {"notes": _load(filename, current_domain(request))["notes"],
            "me": current_actor(request)}


@router.post("/{filename}")
def add_note(filename: str, req: NoteReq, request: Request) -> dict:
    from .auth import current_actor, current_domain
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(422, "評註內容不可空白")
    dom = current_domain(request)
    d = _load(filename, dom)
    nid = f"N{len(d['notes']) + 1}"
    while any(x["id"] == nid for x in d["notes"]):        # 刪過再新增不撞號
        nid = f"N{int(nid[1:]) + 1}"
    n = {"id": nid, "text": text[:600], "tag": req.tag.strip(),
         "bbox": [round(float(v), 4) for v in req.bbox[:4]] if req.bbox else [],
         "kind": "element" if req.tag.strip() else "region",
         "by": current_actor(request), "at": _now(), "edited_at": ""}
    d["notes"].append(n)
    _save(filename, dom, d)
    return n


@router.patch("/{filename}/{nid}")
def edit_note(filename: str, nid: str, req: NotePatch, request: Request) -> dict:
    from .auth import current_actor, current_domain, current_user
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    dom = current_domain(request)
    d = _load(filename, dom)
    n = next((x for x in d["notes"] if x["id"] == nid), None)
    if not n:
        raise HTTPException(404, "評註不存在")
    me = current_actor(request)
    if n.get("by") and me and n["by"] != me and \
            (current_user(request) or {}).get("role") != "admin":
        raise HTTPException(403, "只有作者或管理員能修改這則評註")
    n["text"] = (req.text or "").strip()[:600]
    n["edited_at"] = _now()
    _save(filename, dom, d)
    return n


@router.delete("/{filename}/{nid}")
def del_note(filename: str, nid: str, request: Request) -> dict:
    from .auth import current_actor, current_domain, current_user
    from .pid_vlm import _safe_pdf

    _safe_pdf(filename)
    dom = current_domain(request)
    d = _load(filename, dom)
    n = next((x for x in d["notes"] if x["id"] == nid), None)
    if not n:
        raise HTTPException(404, "評註不存在")
    me = current_actor(request)
    if n.get("by") and me and n["by"] != me and \
            (current_user(request) or {}).get("role") != "admin":
        raise HTTPException(403, "只有作者或管理員能刪除這則評註")
    d["notes"] = [x for x in d["notes"] if x["id"] != nid]
    _save(filename, dom, d)
    return {"ok": True}
