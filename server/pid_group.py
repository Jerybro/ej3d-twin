# P&ID 圖組 — 把一疊單張圖當成一套圖來處理
#
# 動機：一套廠的圖從來不是一張。潤泰礦化造粒／混合／燒結是三張連續的
# 系統圖，物料一路流過去；台化 C12070-1 的 OPC 角旗指向 -2 / -3。
# 單張處理會漏掉「答案寫在下一張」的東西——實測潤泰 R-M0200 圖上有
# 500~508 這批設備，但本張的清冊查無，很可能屬於燒結系統（R-M0400）。
#
# 圖組提供三件事：
#   ① 共用清冊：查不到的項次號自動到同組其他圖的清冊找（跨圖參照）
#   ② 整組彙總：一套圖的資產、迴路、接續一次看完
#   ③ 接續證據：沿用 pid_linkset 的 OPC／圖號序列／共用位號
#
# 群組由**人定義**（自動只給建議）——圖跟圖的歸屬是工程判斷，
# 猜錯會讓跨圖參照把不相干的設備牽在一起，那比沒有更糟。
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/pid/group", tags=["pid-group"])

BASE_DIR = Path(__file__).resolve().parent.parent
GROUPS_PATH = BASE_DIR / "data" / "pid_groups.json"


def _load() -> dict:
    if not GROUPS_PATH.exists():
        return {"groups": []}
    try:
        return json.loads(GROUPS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"groups": []}


def _save(d: dict) -> None:
    GROUPS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = GROUPS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(GROUPS_PATH)


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _slugify(name: str) -> str:
    s = re.sub(r"[^0-9a-z一-鿿]+", "-", name.lower()).strip("-")
    return s or "group"


# --------------------------------------------------------------- 自動建議
# 圖號的「族」：R-M0200-00-... → R-M；C12070-1 → C。同族多張＝很可能同一套。
_FAM = re.compile(r"^([A-Za-z]+[-_]?[A-Za-z]?)\s*(\d{3,6})")


def suggest_groups(filenames: list) -> list:
    """依圖號族群給出建議分組——只是建議，仍要人按下「建立」才算數。"""
    fam: dict = {}
    for f in filenames:
        stem = Path(f).stem
        m = _FAM.match(stem.strip())
        key = (m.group(1).upper().rstrip("-_") if m else stem[:4].upper())
        fam.setdefault(key, []).append(f)
    out = []
    for key, files in fam.items():
        if len(files) < 2:
            continue                  # 單張不成組
        out.append({"key": key, "files": sorted(files),
                    "reason": f"圖號同族「{key}」共 {len(files)} 張，研判為同一套圖"})
    return sorted(out, key=lambda g: -len(g["files"]))


# ------------------------------------------------------------- 跨圖清冊
def group_of(filename: str) -> dict | None:
    """這張圖屬於哪一組（一張圖只歸一組，避免跨圖參照互相汙染）。"""
    name = Path(filename).name
    for g in _load().get("groups", []):
        if name in g.get("files", []):
            return g
    return None


def sibling_registries(filename: str) -> list:
    """同組其他圖的設備清冊 → [{drawing, items}]。

    這是「欄位寫在下一張」的解法：本圖清冊查不到的項次號，
    到同組其他圖的清冊找，找到就標成跨圖參照（而非誤讀）。
    """
    from .pid_model import _registry_of

    g = group_of(filename)
    if not g:
        return []
    me = Path(filename).name
    out = []
    for f in g.get("files", []):
        if f == me:
            continue
        reg = _registry_of(f)
        if reg and reg.get("items"):
            out.append({"drawing": f, "items": reg["items"]})
    return out


def crosssheet_lookup(item_no: str, filename: str) -> dict | None:
    """本圖查無的項次號 → 同組其他圖的清冊查找。

    回傳 {drawing, row}；查不到回 None。找到代表這是**跨圖參照**，
    不是 OCR 誤讀——這個區別對審核者很重要（前者要保留，後者要否決）。
    """
    from .pid_model import _registry_match

    for sib in sibling_registries(filename):
        row = _registry_match(item_no, sib["items"])
        if row:
            return {"drawing": sib["drawing"], "row": row}
    return None


# ---------------------------------------------------------------- models
class GroupReq(BaseModel):
    name: str
    files: list = []
    plant: str = ""


class GroupPatch(BaseModel):
    name: str | None = None
    plant: str | None = None
    files: list | None = None


# ------------------------------------------------------------- endpoints
@router.get("")
def list_groups() -> dict:
    from .pid_vlm import PID_DIR

    d = _load()
    files = sorted(p.name for p in PID_DIR.glob("*.pdf")) if PID_DIR.exists() else []
    grouped = {f for g in d["groups"] for f in g.get("files", [])}
    return {"groups": d["groups"],
            "ungrouped": [f for f in files if f not in grouped],
            "suggestions": [s for s in suggest_groups([f for f in files
                                                       if f not in grouped])]}


@router.post("")
def create_group(req: GroupReq) -> dict:
    d = _load()
    gid = _slugify(req.name)
    if any(g["id"] == gid for g in d["groups"]):
        raise HTTPException(409, "已有同名圖組")
    # 一張圖只能屬於一組——先從別組移除，避免跨圖參照互相汙染
    for g in d["groups"]:
        g["files"] = [f for f in g.get("files", []) if f not in req.files]
    g = {"id": gid, "name": req.name.strip(), "plant": req.plant.strip(),
         "files": list(req.files), "created": _now()}
    d["groups"].append(g)
    _save(d)
    return g


@router.patch("/{gid}")
def patch_group(gid: str, req: GroupPatch) -> dict:
    d = _load()
    g = next((x for x in d["groups"] if x["id"] == gid), None)
    if not g:
        raise HTTPException(404, "圖組不存在")
    if req.name is not None:
        g["name"] = req.name.strip()
    if req.plant is not None:
        g["plant"] = req.plant.strip()
    if req.files is not None:
        for other in d["groups"]:
            if other["id"] != gid:
                other["files"] = [f for f in other.get("files", [])
                                  if f not in req.files]
        g["files"] = list(req.files)
    _save(d)
    return g


@router.delete("/{gid}")
def delete_group(gid: str) -> dict:
    d = _load()
    n = len(d["groups"])
    d["groups"] = [x for x in d["groups"] if x["id"] != gid]
    if len(d["groups"]) == n:
        raise HTTPException(404, "圖組不存在")
    _save(d)
    return {"ok": True}


@router.get("/{gid}/overview")
def group_overview(gid: str) -> dict:
    """整組彙總：各圖的資產統計、跨圖接續、共用清冊涵蓋範圍。

    這是「整體辨識」的入口——工程師先在這裡看見一套圖的全貌，
    再決定要進哪一張去審。
    """
    from .pid_linkset import build_set, parse_dwg_no
    from .pid_model import MODEL_DIR, _registry_of
    from .pid_vlm import _slug

    d = _load()
    g = next((x for x in d["groups"] if x["id"] == gid), None)
    if not g:
        raise HTTPException(404, "圖組不存在")

    sheets, per_dwg = [], {}
    tot = {"equipment": 0, "instruments": 0, "valves": 0, "loops": 0,
           "registry_rows": 0, "registry_located": 0}
    for f in g.get("files", []):
        stem = Path(f).stem
        reg = _registry_of(f)
        n_reg = len((reg or {}).get("items", []))
        p = MODEL_DIR / f"{_slug(stem)}.json"
        s = {"file": f, "built": p.exists(), "registry_rows": n_reg}
        if p.exists():
            try:
                m = json.loads(p.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                m = {}
            st = m.get("stats", {})
            loc = m.get("locate", {})
            s.update({"equipment": st.get("equipment", 0),
                      "instruments": st.get("instruments", 0),
                      "valves": st.get("valves", 0),
                      "loops": st.get("loops", 0),
                      "registry_located": loc.get("registry_located", 0),
                      "profile": m.get("profile", "")})
            for k in ("equipment", "instruments", "valves", "loops"):
                tot[k] += st.get(k, 0)
            tot["registry_located"] += loc.get("registry_located", 0)
            per_dwg[stem] = {
                "opc": [{"raw": o["code"], "target_dwg": o["target_dwg"],
                         "point": o["point"]} for o in m.get("opcs", [])],
                "flow_notes": [],
                "series": parse_dwg_no(stem),
                "tags": [e.get("tag") for e in m.get("equipment", []) if e.get("tag")],
            }
        tot["registry_rows"] += n_reg
        sheets.append(s)

    links = build_set(per_dwg) if per_dwg else {"edges": [], "unmatched": []}
    return {"group": g, "sheets": sheets, "totals": tot,
            "links": {"edges": links.get("edges", [])[:60],
                      "unmatched": links.get("unmatched", [])}}
