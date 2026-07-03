"""場景系統 — 3D 編輯器與孿生檢視共用的場景 CRUD。

場景檔存 data/scenes/{id}.json，schema 與 plant.json 同源；
編輯器存的最小場景會被補全預設鍵（instruments/scenarios），讓孿生檢視能直接載入。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

BASE_DIR = Path(__file__).resolve().parent.parent
SCENES_DIR = BASE_DIR / "data" / "scenes"
SCENES_DIR.mkdir(parents=True, exist_ok=True)

router = APIRouter(prefix="/api/scenes", tags=["scenes"])

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

SCENE_DEFAULTS = {
    "pipes": [],
    "instruments": {},
    "scenarios": [{"id": "normal", "name": "正常運轉", "kind": "normal", "desc": ""}],
    "scan_models": [],
    "props": [],
    "underlays": [],  # 圖紙底圖（P&ID 地毯）：{image,x,z,w,h}
}


def _path(sid: str) -> Path:
    if not _ID_RE.match(sid):
        raise HTTPException(422, "場景 id 僅允許小寫英數、-、_")
    return SCENES_DIR / f"{sid}.json"


def _normalize(scene: dict) -> dict:
    """補全預設鍵＋基本 schema 驗證。"""
    plant = scene.get("plant")
    if not isinstance(plant, dict) or not isinstance(plant.get("units"), list):
        raise HTTPException(422, "場景缺少 plant.units")
    for unit in plant["units"]:
        if not isinstance(unit.get("equipment"), list):
            raise HTTPException(422, f"單元 {unit.get('id')} 缺 equipment 清單")
        for eq in unit["equipment"]:
            for key in ("tag", "type", "pos", "dims"):
                if key not in eq:
                    raise HTTPException(422, f"設備缺必要鍵 {key}: {eq.get('tag', '?')}")
            eq.setdefault("name", eq["tag"])
            eq.setdefault("pid_ref", "")
            eq.setdefault("design", {})
            eq.setdefault("instruments", [])
    for k, v in SCENE_DEFAULTS.items():
        scene.setdefault(k, json.loads(json.dumps(v)))
    return scene


def load_scene(sid: str) -> dict:
    p = _path(sid)
    if not p.exists():
        raise HTTPException(404, f"場景不存在: {sid}")
    return json.loads(p.read_text(encoding="utf-8"))


@router.get("")
def list_scenes() -> list:
    out = []
    for p in sorted(SCENES_DIR.glob("*.json")):
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
            n_eq = sum(len(u.get("equipment", [])) for u in s.get("plant", {}).get("units", []))
            out.append({"id": p.stem, "name": s.get("plant", {}).get("name", p.stem),
                        "equipment": n_eq, "pipes": len(s.get("pipes", []))})
        except (ValueError, OSError):
            continue
    return out


@router.get("/{sid}")
def get_scene(sid: str) -> dict:
    return load_scene(sid)


@router.put("/{sid}")
def put_scene(sid: str, scene: dict) -> dict:
    scene = _normalize(scene)
    _path(sid).write_text(json.dumps(scene, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "id": sid}


@router.post("")
def create_scene(body: dict) -> dict:
    sid = body.get("id", "")
    name = body.get("name", sid)
    p = _path(sid)
    if p.exists():
        raise HTTPException(409, f"場景已存在: {sid}")
    scene = {
        "plant": {"id": sid.upper(), "name": name, "units": [{"id": "U-100", "name": "主區", "equipment": []}]},
        **json.loads(json.dumps(SCENE_DEFAULTS)),
    }
    p.write_text(json.dumps(scene, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "id": sid}


@router.delete("/{sid}")
def delete_scene(sid: str) -> dict:
    if sid == "demo":
        raise HTTPException(403, "demo 場景不可刪除")
    p = _path(sid)
    if not p.exists():
        raise HTTPException(404, f"場景不存在: {sid}")
    p.unlink()
    return {"ok": True}
