"""將 plant.json 的設備階層匯出為 OpenUSD（.usda 文字格式）。

產出的 usda 可直接用 NVIDIA Omniverse USD Composer / usdview 開啟：
- 階層：Plant → Unit → Equipment（kind = assembly / group / component）
- 每台設備掛自訂屬性 ej:tag / ej:name / ej:type / ej:pid，供下游應用讀取
- 幾何用簡化的 Cylinder / Cube 佔位，之後可換成掃描或 CAD 轉出的模型
"""

from __future__ import annotations


def _safe(name: str) -> str:
    """USD prim 名稱只能是識別字：把 '-' 換成 '_'。"""
    return name.replace("-", "_").replace(" ", "_")


def _esc(s: str) -> str:
    return s.replace('"', '\\"')


def _equipment_prim(eq: dict, indent: str) -> str:
    tag = _safe(eq["tag"])
    x, y, z = eq["pos"]
    dims = eq.get("dims", {})
    etype = eq.get("type", "generic")
    lines = [
        f'{indent}def Xform "{tag}" (kind = "component")',
        f"{indent}{{",
        f'{indent}    custom string ej:tag = "{_esc(eq["tag"])}"',
        f'{indent}    custom string ej:name = "{_esc(eq.get("name", ""))}"',
        f'{indent}    custom string ej:type = "{etype}"',
        f'{indent}    custom string ej:pid = "{_esc(eq.get("pid_ref", ""))}"',
        f"{indent}    double3 xformOp:translate = ({x}, {y}, {z})",
        f'{indent}    uniform token[] xformOpOrder = ["xformOp:translate"]',
    ]

    if etype in ("reactor", "tank"):
        r, h = dims.get("r", 1.0), dims.get("h", 2.0)
        lines += [
            f'{indent}    def Cylinder "geom"',
            f"{indent}    {{",
            f"{indent}        double radius = {r}",
            f"{indent}        double height = {h}",
            f'{indent}        uniform token axis = "Y"',
            f"{indent}        double3 xformOp:translate = (0, {h / 2}, 0)",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate"]',
            f"{indent}        color3f[] primvars:displayColor = [(0.62, 0.67, 0.72)]",
            f"{indent}    }}",
        ]
    elif etype == "hx":
        r, length = dims.get("r", 0.5), dims.get("len", 3.0)
        lines += [
            f'{indent}    def Cylinder "geom"',
            f"{indent}    {{",
            f"{indent}        double radius = {r}",
            f"{indent}        double height = {length}",
            f'{indent}        uniform token axis = "X"',
            f"{indent}        double3 xformOp:translate = (0, {r + 0.3}, 0)",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate"]',
            f"{indent}        color3f[] primvars:displayColor = [(0.5, 0.55, 0.6)]",
            f"{indent}    }}",
        ]
    elif etype == "valve":
        s = dims.get("s", 0.5)
        lines += [
            f'{indent}    def Cube "geom"',
            f"{indent}    {{",
            f"{indent}        double size = 1",
            f"{indent}        double3 xformOp:translate = (0, {s / 2}, 0)",
            f"{indent}        double3 xformOp:scale = ({s}, {s}, {s})",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
            f"{indent}        color3f[] primvars:displayColor = [(0.85, 0.65, 0.23)]",
            f"{indent}    }}",
        ]
    elif etype == "detector":
        h = dims.get("h", 2.4)
        lines += [
            f'{indent}    def Cylinder "geom"',
            f"{indent}    {{",
            f"{indent}        double radius = 0.06",
            f"{indent}        double height = {h}",
            f'{indent}        uniform token axis = "Y"',
            f"{indent}        double3 xformOp:translate = (0, {h / 2}, 0)",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate"]',
            f"{indent}        color3f[] primvars:displayColor = [(0.27, 0.76, 0.88)]",
            f"{indent}    }}",
        ]
    else:  # pump / building / generic → Cube
        w = dims.get("w", 1.0)
        h = dims.get("h", 1.0)
        d = dims.get("d", 1.0)
        lines += [
            f'{indent}    def Cube "geom"',
            f"{indent}    {{",
            f"{indent}        double size = 1",
            f"{indent}        double3 xformOp:translate = (0, {h / 2}, 0)",
            f"{indent}        double3 xformOp:scale = ({w}, {h}, {d})",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
            f"{indent}        color3f[] primvars:displayColor = [(0.35, 0.42, 0.5)]",
            f"{indent}    }}",
        ]

    lines.append(f"{indent}}}")
    return "\n".join(lines)


def generate_usda(plant_data: dict) -> str:
    plant = plant_data["plant"]
    out = [
        "#usda 1.0",
        "(",
        f'    doc = "EJ_3D 數位孿生平台匯出 — {_esc(plant["name"])}"',
        '    defaultPrim = "Plant"',
        "    metersPerUnit = 1",
        '    upAxis = "Y"',
        ")",
        "",
        'def Xform "Plant" (kind = "assembly")',
        "{",
        f'    custom string ej:name = "{_esc(plant["name"])}"',
        f'    custom string ej:id = "{_esc(plant["id"])}"',
    ]
    for unit in plant["units"]:
        uname = _safe(unit["id"])
        out += [
            f'    def Xform "{uname}" (kind = "group")',
            "    {",
            f'        custom string ej:name = "{_esc(unit["name"])}"',
        ]
        for eq in unit["equipment"]:
            out.append(_equipment_prim(eq, "        "))
        out.append("    }")
    out.append("}")
    out.append("")
    return "\n".join(out)
