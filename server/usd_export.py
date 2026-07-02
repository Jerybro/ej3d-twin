"""將 plant.json 匯出為 OpenUSD（.usda 文字格式）— Omniverse 前導平台的交換層。

產出的 usda 可直接用 NVIDIA Omniverse USD Composer / usdview 開啟，內容對齊
Three.js 前導平台看到的同一座廠（無痛遷移的關鍵：資料層只有一份）：

- 階層：Plant → Unit → Equipment（kind = assembly / group / component）
- 幾何 + UsdPreviewSurface 材質（開起來不是灰盒，是同配色的廠）
- 管線：/Plant/Piping 逐段 Cylinder（含方位四元數）
- AI 攝影機：/Plant/Surveillance 匯成真的 UsdGeomCamera —— 可直接放進
  Isaac Sim 產工安辨識的合成訓練影像
- 工安情境：/Plant/Scenarios（預設 invisible），每個情境含危險區、洩漏點、
  疏散路徑，Composer 裡切 visibility 即重現前導平台的情境
- 電子圍籬：/Plant/Safety
- 施工規劃：/Plant/Construction（purpose = guide，正式渲染不出現）
- 自訂屬性 ej:*（tag / pid / instruments / alarm 設定），供下游應用綁即時數據
"""

from __future__ import annotations

import math

# ------------------------------------------------------------------ 小工具


def _safe(name: str) -> str:
    """USD prim 名稱只能是識別字：把 '-' 換成 '_'。"""
    return name.replace("-", "_").replace(" ", "_").replace("（", "_").replace("）", "")


def _esc(s: str) -> str:
    return s.replace('"', '\\"')


def _f(v: float) -> str:
    return f"{v:.5g}"


def _quat_y_to(d) -> tuple[float, float, float, float]:
    """旋轉 (0,1,0) → 單位向量 d 的四元數 (w, x, y, z)。"""
    dot = d[1]
    if dot > 0.99999:
        return (1.0, 0.0, 0.0, 0.0)
    if dot < -0.99999:
        return (0.0, 1.0, 0.0, 0.0)  # 180° 繞 X
    # axis = cross((0,1,0), d) = (d_z, 0, -d_x)
    w = 1.0 + dot
    q = (w, d[2], 0.0, -d[0])
    n = math.sqrt(sum(c * c for c in q))
    return tuple(c / n for c in q)


def _quat_from_basis(x, y, z) -> tuple[float, float, float, float]:
    """由正交基底（行向量 = 世界軸）組旋轉矩陣再轉四元數 (w,x,y,z)。"""
    m00, m01, m02 = x[0], y[0], z[0]
    m10, m11, m12 = x[1], y[1], z[1]
    m20, m21, m22 = x[2], y[2], z[2]
    tr = m00 + m11 + m22
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        return (s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s)
    if m00 > m11 and m00 > m22:
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2
        return ((m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s)
    if m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2
        return ((m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s)
    s = math.sqrt(1.0 + m22 - m00 - m11) * 2
    return ((m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4)


# ------------------------------------------------------------------ 材質庫

MATERIALS = {
    "SteelGray": {"color": (0.62, 0.67, 0.72), "metallic": 0.6, "roughness": 0.45},
    "SteelDark": {"color": (0.50, 0.55, 0.60), "metallic": 0.6, "roughness": 0.5},
    "ValveBrass": {"color": (0.85, 0.65, 0.23), "metallic": 0.7, "roughness": 0.4},
    "PumpBlue": {"color": (0.18, 0.50, 0.75), "metallic": 0.5, "roughness": 0.5},
    "DetectorCyan": {"color": (0.27, 0.76, 0.88), "metallic": 0.3, "roughness": 0.4, "emissive": (0.05, 0.2, 0.25)},
    "ConcreteDark": {"color": (0.17, 0.20, 0.25), "metallic": 0.05, "roughness": 0.9},
    "PipeGray": {"color": (0.39, 0.44, 0.48), "metallic": 0.6, "roughness": 0.5},
    "PlannedCyan": {"color": (0.27, 0.76, 0.88), "metallic": 0.2, "roughness": 0.6, "opacity": 0.35},
    "DangerRed": {"color": (1.0, 0.16, 0.18), "metallic": 0.0, "roughness": 1.0, "opacity": 0.25},
    "EvacGreen": {"color": (0.20, 0.88, 0.55), "metallic": 0.0, "roughness": 1.0},
    "FenceYellow": {"color": (1.0, 0.82, 0.24), "metallic": 0.0, "roughness": 1.0, "opacity": 0.4},
}

TYPE_MATERIAL = {
    "reactor": "SteelGray",
    "tank": "SteelGray",
    "hx": "SteelDark",
    "valve": "ValveBrass",
    "pump": "PumpBlue",
    "detector": "DetectorCyan",
    "building": "ConcreteDark",
}


def _materials_block() -> list[str]:
    out = ['    def Scope "Materials"', "    {"]
    for name, m in MATERIALS.items():
        c = m["color"]
        out += [
            f'        def Material "{name}"',
            "        {",
            f"            token outputs:surface.connect = </Plant/Materials/{name}/pbr.outputs:surface>",
            '            def Shader "pbr"',
            "            {",
            '                uniform token info:id = "UsdPreviewSurface"',
            f"                color3f inputs:diffuseColor = ({_f(c[0])}, {_f(c[1])}, {_f(c[2])})",
            f"                float inputs:metallic = {_f(m.get('metallic', 0.5))}",
            f"                float inputs:roughness = {_f(m.get('roughness', 0.5))}",
        ]
        if "emissive" in m:
            e = m["emissive"]
            out.append(f"                color3f inputs:emissiveColor = ({_f(e[0])}, {_f(e[1])}, {_f(e[2])})")
        if "opacity" in m:
            out.append(f"                float inputs:opacity = {_f(m['opacity'])}")
        out += [
            "                token outputs:surface",
            "            }",
            "        }",
        ]
    out.append("    }")
    return out


def _bind(indent: str, mat: str) -> str:
    return f"{indent}rel material:binding = </Plant/Materials/{mat}>"


# ------------------------------------------------------------------ 設備幾何


def _equipment_prim(eq: dict, indent: str, mat_override: str | None = None, status: str | None = None) -> str:
    tag = _safe(eq["tag"])
    x, y, z = eq["pos"]
    dims = eq.get("dims", {})
    etype = eq.get("type", "generic")
    mat = mat_override or TYPE_MATERIAL.get(etype, "SteelDark")
    lines = [
        f'{indent}def Xform "{tag}" (kind = "component")',
        f"{indent}{{",
        f'{indent}    custom string ej:tag = "{_esc(eq["tag"])}"',
        f'{indent}    custom string ej:name = "{_esc(eq.get("name", ""))}"',
        f'{indent}    custom string ej:type = "{etype}"',
        f'{indent}    custom string ej:pid = "{_esc(eq.get("pid_ref", ""))}"',
    ]
    if eq.get("instruments"):
        insts = ", ".join(f'"{_esc(t)}"' for t in eq["instruments"])
        lines.append(f"{indent}    custom string[] ej:instruments = [{insts}]")
    if status:
        lines.append(f'{indent}    custom string ej:status = "{status}"')
    lines += [
        f"{indent}    double3 xformOp:translate = ({_f(x)}, {_f(y)}, {_f(z)})",
        f'{indent}    uniform token[] xformOpOrder = ["xformOp:translate"]',
    ]

    geom_n = 0

    def geom_open(kind: str) -> list[str]:
        nonlocal geom_n
        geom_n += 1
        return [
            f'{indent}    def {kind} "geom_{geom_n}" (prepend apiSchemas = ["MaterialBindingAPI"])',
            f"{indent}    {{",
            _bind(f"{indent}        ", mat),
        ]

    if etype in ("reactor", "tank"):
        r, h = dims.get("r", 1.0), dims.get("h", 2.0)
        lines += geom_open("Cylinder") + [
            f"{indent}        double radius = {_f(r)}",
            f"{indent}        double height = {_f(h)}",
            f'{indent}        uniform token axis = "Y"',
            f"{indent}        double3 xformOp:translate = (0, {_f(h / 2)}, 0)",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate"]',
            f"{indent}    }}",
        ]
        if etype == "reactor":  # 頂部半球
            lines += geom_open("Sphere") + [
                f"{indent}        double radius = {_f(r)}",
                f"{indent}        double3 xformOp:translate = (0, {_f(h)}, 0)",
                f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate"]',
                f"{indent}    }}",
            ]
    elif etype == "hx":
        r, length = dims.get("r", 0.5), dims.get("len", 3.0)
        lines += geom_open("Cylinder") + [
            f"{indent}        double radius = {_f(r)}",
            f"{indent}        double height = {_f(length)}",
            f'{indent}        uniform token axis = "X"',
            f"{indent}        double3 xformOp:translate = (0, {_f(r + 0.3)}, 0)",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate"]',
            f"{indent}    }}",
        ]
    elif etype == "valve":
        s = dims.get("s", 0.5)
        lines += geom_open("Cube") + [
            f"{indent}        double size = 1",
            f"{indent}        double3 xformOp:translate = (0, {_f(s / 2)}, 0)",
            f"{indent}        double3 xformOp:scale = ({_f(s)}, {_f(s * 0.8)}, {_f(s)})",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
            f"{indent}    }}",
        ]
    elif etype == "detector":
        h = dims.get("h", 2.4)
        lines += geom_open("Cylinder") + [
            f"{indent}        double radius = 0.06",
            f"{indent}        double height = {_f(h)}",
            f'{indent}        uniform token axis = "Y"',
            f"{indent}        double3 xformOp:translate = (0, {_f(h / 2)}, 0)",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate"]',
            f"{indent}    }}",
        ]
    else:  # pump / building / generic → Cube
        w = dims.get("w", 1.0)
        h = dims.get("h", 1.0)
        d = dims.get("d", 1.0)
        lines += geom_open("Cube") + [
            f"{indent}        double size = 1",
            f"{indent}        double3 xformOp:translate = (0, {_f(h / 2)}, 0)",
            f"{indent}        double3 xformOp:scale = ({_f(w)}, {_f(h)}, {_f(d)})",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
            f"{indent}    }}",
        ]

    lines.append(f"{indent}}}")
    return "\n".join(lines)


# ------------------------------------------------------------------ 管線


def _pipe_segments(pipe_id: str, r: float, pts: list, indent: str, mat: str = "PipeGray") -> list[str]:
    out = [f'{indent}def Xform "{_safe(pipe_id)}"', f"{indent}{{"]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        dvec = [b[j] - a[j] for j in range(3)]
        length = math.sqrt(sum(c * c for c in dvec))
        if length < 1e-6:
            continue
        d = [c / length for c in dvec]
        mid = [(a[j] + b[j]) / 2 for j in range(3)]
        w, qx, qy, qz = _quat_y_to(d)
        out += [
            f'{indent}    def Cylinder "seg_{i}" (prepend apiSchemas = ["MaterialBindingAPI"])',
            f"{indent}    {{",
            _bind(f"{indent}        ", mat),
            f"{indent}        double radius = {_f(r)}",
            f"{indent}        double height = {_f(length)}",
            f'{indent}        uniform token axis = "Y"',
            f"{indent}        double3 xformOp:translate = ({_f(mid[0])}, {_f(mid[1])}, {_f(mid[2])})",
            f"{indent}        quatf xformOp:orient = ({_f(w)}, {_f(qx)}, {_f(qy)}, {_f(qz)})",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient"]',
            f"{indent}    }}",
        ]
    out.append(f"{indent}}}")
    return out


# ------------------------------------------------------------------ 攝影機


def _camera_prim(cam: dict, indent: str) -> list[str]:
    pos = cam["pos"]
    look = cam["look"]
    fwd = [look[i] - pos[i] for i in range(3)]
    n = math.sqrt(sum(c * c for c in fwd))
    fwd = [c / n for c in fwd]
    zax = [-c for c in fwd]  # USD 相機朝 -Z 看
    up = (0.0, 1.0, 0.0)
    xax = [up[1] * zax[2] - up[2] * zax[1], up[2] * zax[0] - up[0] * zax[2], up[0] * zax[1] - up[1] * zax[0]]
    xn = math.sqrt(sum(c * c for c in xax))
    xax = [c / xn for c in xax]
    yax = [zax[1] * xax[2] - zax[2] * xax[1], zax[2] * xax[0] - zax[0] * xax[2], zax[0] * xax[1] - zax[1] * xax[0]]
    w, qx, qy, qz = _quat_from_basis(xax, yax, zax)
    aperture = 20.955  # mm，USD 預設 horizontal aperture
    focal = (aperture / 2) / math.tan(math.radians(cam["fov"] / 2))
    return [
        f'{indent}def Camera "{_safe(cam["id"])}"',
        f"{indent}{{",
        f'{indent}    custom string ej:name = "{_esc(cam.get("name", ""))}"',
        f"{indent}    custom double ej:range = {_f(cam.get('range', 20))}",
        f"{indent}    float focalLength = {_f(focal)}",
        f"{indent}    float horizontalAperture = {_f(aperture)}",
        f"{indent}    float2 clippingRange = (0.1, 200)",
        f"{indent}    double3 xformOp:translate = ({_f(pos[0])}, {_f(pos[1])}, {_f(pos[2])})",
        f"{indent}    quatf xformOp:orient = ({_f(w)}, {_f(qx)}, {_f(qy)}, {_f(qz)})",
        f'{indent}    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient"]',
        f"{indent}}}",
    ]


# ------------------------------------------------------------------ 曲線


def _curve_prim(name: str, pts: list, width: float, mat: str, indent: str, y_override: float | None = None) -> list[str]:
    p3 = [(p[0], y_override if y_override is not None else (p[1] if len(p) > 2 else 0.1), p[-1]) for p in pts]
    pts_str = ", ".join(f"({_f(p[0])}, {_f(p[1])}, {_f(p[2])})" for p in p3)
    return [
        f'{indent}def BasisCurves "{_safe(name)}" (prepend apiSchemas = ["MaterialBindingAPI"])',
        f"{indent}{{",
        _bind(f"{indent}    ", mat),
        f'{indent}    uniform token type = "linear"',
        f"{indent}    int[] curveVertexCounts = [{len(p3)}]",
        f"{indent}    point3f[] points = [{pts_str}]",
        f'{indent}    float[] widths = [{_f(width)}] (interpolation = "constant")',
        f"{indent}}}",
    ]


# ------------------------------------------------------------------ 情境層


def _scenario_prim(sc: dict, indent: str) -> list[str]:
    sid = _safe(sc["id"])
    out = [
        f'{indent}def Xform "{sid}"',
        f"{indent}{{",
        f'{indent}    custom string ej:name = "{_esc(sc["name"])}"',
        f'{indent}    custom string ej:kind = "{sc["kind"]}"',
        f'{indent}    custom string ej:message = "{_esc(sc.get("message", ""))}"',
    ]
    dz = sc.get("danger_zone")
    if dz:
        c = dz["center"]
        out += [
            f'{indent}    def Cylinder "danger_zone" (prepend apiSchemas = ["MaterialBindingAPI"])',
            f"{indent}    {{",
            _bind(f"{indent}        ", "DangerRed"),
            f"{indent}        double radius = 1",
            f"{indent}        double height = 0.02",
            f'{indent}        uniform token axis = "Y"',
            f"{indent}        double3 xformOp:translate = ({_f(c[0])}, 0.05, {_f(c[2])})",
            f"{indent}        double3 xformOp:scale = ({_f(dz['rx'])}, 1, {_f(dz['rz'])})",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
            f"{indent}    }}",
        ]
    lp = sc.get("leak_point")
    if lp:
        out += [
            f'{indent}    def Sphere "leak_point" (prepend apiSchemas = ["MaterialBindingAPI"])',
            f"{indent}    {{",
            _bind(f"{indent}        ", "DangerRed"),
            f"{indent}        double radius = 0.3",
            f"{indent}        double3 xformOp:translate = ({_f(lp[0])}, {_f(lp[1])}, {_f(lp[2])})",
            f'{indent}        uniform token[] xformOpOrder = ["xformOp:translate"]',
            f"{indent}    }}",
        ]
    if sc.get("evac_path"):
        out += _curve_prim("evac_path", sc["evac_path"], 0.25, "EvacGreen", f"{indent}    ", y_override=0.1)
    out.append(f"{indent}}}")
    return out


# ------------------------------------------------------------------ 主匯出


def generate_usda(plant_data: dict) -> str:
    plant = plant_data["plant"]
    out = [
        "#usda 1.0",
        "(",
        f'    doc = "EJ_3D 數位孿生平台匯出 — {_esc(plant["name"])}（Omniverse 前導平台交換層）"',
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

    out += _materials_block()

    # 設備階層
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

    # 管線
    pipes = plant_data.get("pipes", [])
    if pipes:
        out += ['    def Scope "Piping"', "    {"]
        for i, pipe in enumerate(pipes):
            out += _pipe_segments(f"P_{i:02d}", pipe["r"], pipe["pts"], "        ")
        out.append("    }")

    # AI 攝影機 → UsdGeomCamera（可直接進 Isaac Sim 出合成訓練影像）
    cameras = plant_data.get("cameras", [])
    if cameras:
        out += ['    def Scope "Surveillance"', "    {"]
        for cam in cameras:
            out += _camera_prim(cam, "        ")
        out.append("    }")

    # 電子圍籬
    fence = plant_data.get("fence")
    if fence and fence.get("polygon"):
        ring = [*fence["polygon"], fence["polygon"][0]]
        out += ['    def Xform "Safety"', "    {"]
        out += _curve_prim("fence", ring, 0.12, "FenceYellow", "        ", y_override=1.4)
        out.append("    }")

    # 工安情境層（預設 invisible，Composer 裡切 visibility 重現前導平台情境）
    scenarios = [s for s in plant_data.get("scenarios", []) if s.get("kind") != "normal"]
    if scenarios:
        out += ['    def Xform "Scenarios"', "    {", '        token visibility = "invisible"']
        for sc in scenarios:
            out += _scenario_prim(sc, "        ")
        out.append("    }")

    # 施工規劃層（purpose = guide：正式渲染不出現，檢視時打開 guide 即見）
    con = plant_data.get("construction")
    if con:
        out += [
            '    def Xform "Construction"',
            "    {",
            '        uniform token purpose = "guide"',
            f"        custom double ej:clearance = {_f(con.get('clearance', 1.0))}",
        ]
        for eq in con.get("planned_equipment", []):
            out.append(_equipment_prim(eq, "        ", mat_override="PlannedCyan", status="planned"))
        for pipe in con.get("planned_pipes", []):
            out += _pipe_segments(pipe["id"], pipe["r"], pipe["pts"], "        ", mat="PlannedCyan")
        out.append("    }")

    out.append("}")
    out.append("")
    return "\n".join(out)
