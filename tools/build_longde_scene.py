"""龍德公用廠（燃煤汽電共生）示範場景產生器。

流程（簡介 PPT 敘述，無製程數據——位號為示範自編，非客戶位號）：
煤場 → 鍋爐 → SCR 脫硝 → E/P 靜電集塵 → FGD 濕式脫硫 → 煙囪
＋ 汽機島（汽輪發電機＋冷卻水塔）。

用法：python tools/build_longde_scene.py  →  data/scenes/longde-utility.json
（提供焚化爐/公用廠類場景的底稿；細節在 3D 編輯器繼續修。）
"""

from __future__ import annotations

import json
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
OUT = BASE / "data" / "scenes" / "longde-utility.json"

FLOW_Y = 6.0     # 煙氣主管高度
STEAM_Y = 7.5    # 蒸汽管高度


def eq(tag, name, etype, pos, dims, **design):
    return {"tag": tag, "name": name, "type": etype, "pos": pos, "rot_y": 0,
            "dims": dims, "pid_ref": "LONGDE-PPT", "design": design,
            "instruments": []}


units = [
    {"id": "U-COAL", "name": "煤場｜貯運", "equipment": [
        eq("CB-101", "煤倉", "building", [-58, 0, -6], {"w": 10, "h": 8, "d": 8}),
        eq("CV-101", "輸煤帶 1", "conveyor", [-48, 0, -2], {"len": 12, "h": 2.5, "w": 1.2}),
        eq("CV-102", "輸煤帶 2", "conveyor", [-37, 0, 2], {"len": 10, "h": 4.5, "w": 1.2}),
    ]},
    {"id": "U-BLR", "name": "鍋爐島", "equipment": [
        eq("B-201", "燃煤鍋爐 1 號", "furnace", [-24, 0, -8], {"w": 9, "h": 16, "d": 9}, 型式="CFB 循環流化床"),
        eq("B-202", "燃煤鍋爐 2 號", "furnace", [-24, 0, 8], {"w": 9, "h": 16, "d": 9}, 型式="CFB 循環流化床"),
        eq("P-201", "鍋爐給水泵 A", "pump", [-33, 0, -1], {"w": 1.4, "h": 1.0, "d": 0.9}),
        eq("P-202", "鍋爐給水泵 B", "pump", [-33, 0, 1.8], {"w": 1.4, "h": 1.0, "d": 0.9}),
    ]},
    {"id": "U-AQC", "name": "煙氣淨化", "equipment": [
        eq("R-301", "SCR 脫硝反應器 1", "block", [-9, 0, -8], {"w": 6, "h": 9, "d": 6}, 觸媒="V2O5-WO3/TiO2"),
        eq("R-302", "SCR 脫硝反應器 2", "block", [-9, 0, 8], {"w": 6, "h": 9, "d": 6}, 觸媒="V2O5-WO3/TiO2"),
        eq("EP-401", "靜電集塵器 1", "block", [4, 0, -8], {"w": 10, "h": 10, "d": 7}),
        eq("EP-402", "靜電集塵器 2", "block", [4, 0, 8], {"w": 10, "h": 10, "d": 7}),
        eq("K-401", "引風機 1", "blower", [13, 0, -8], {"w": 2.2, "h": 2.0, "d": 1.6}),
        eq("K-402", "引風機 2", "blower", [13, 0, 8], {"w": 2.2, "h": 2.0, "d": 1.6}),
        eq("A-501", "FGD 濕式脫硫塔", "packedcol", [24, 0, 0], {"r": 4.5, "h": 20}, 吸收劑="石灰石漿液"),
        eq("T-501", "石灰石漿液槽", "tank", [24, 0, 14], {"r": 3, "h": 6}),
        eq("ST-601", "煙囪", "stack", [40, 0, 0], {"r": 2.4, "h": 42}, CEMS="SOx/NOx/粉塵 連續監測"),
    ]},
    {"id": "U-TG", "name": "汽機島", "equipment": [
        eq("TG-701", "汽輪發電機廠房", "building", [-10, 0, 30], {"w": 16, "h": 9, "d": 12}),
        eq("E-701", "表面式冷凝器", "hx", [-1, 0, 30], {"r": 1.4, "len": 8}),
        eq("CT-701", "冷卻水塔 1", "coolingtower", [14, 0, 26], {"w": 6, "h": 6, "d": 6}),
        eq("CT-702", "冷卻水塔 2", "coolingtower", [14, 0, 34], {"w": 6, "h": 6, "d": 6}),
        eq("P-701", "循環水泵", "pump", [7, 0, 30], {"w": 1.6, "h": 1.1, "d": 1.0}),
    ]},
]

# 煙氣主線（鍋爐→SCR→EP→引風機→FGD→煙囪）＋蒸汽/循環水線
pipes = []
for z in (-8, 8):
    pipes.append({"pts": [[-19.5, FLOW_Y, z], [-12, FLOW_Y, z], [-9, FLOW_Y, z],
                          [-1, FLOW_Y, z], [4, FLOW_Y, z], [11.8, FLOW_Y, z],
                          [13, 1.2, z]], "r": 0.55})
    pipes.append({"pts": [[14.2, 1.2, z], [17, FLOW_Y, z], [24, FLOW_Y, z * 0.25]],
                  "r": 0.55})
pipes.append({"pts": [[24, 16, 0], [32, 16, 0], [40, 16, 0], [40, 20, 0]], "r": 0.6})   # FGD→煙囪
pipes.append({"pts": [[-24, 14, -8], [-24, STEAM_Y, -20], [-16, STEAM_Y, -20],
                      [-16, STEAM_Y, 26], [-12, 5, 28]], "r": 0.3})                      # 主蒸汽 1
pipes.append({"pts": [[-24, 14, 8], [-20, STEAM_Y, 8], [-20, STEAM_Y, 24],
                      [-14, 5, 28]], "r": 0.3})                                          # 主蒸汽 2
pipes.append({"pts": [[7, 1.0, 30], [14, 1.0, 26]], "r": 0.35})                          # 循環水
pipes.append({"pts": [[24, 3, 14], [24, 3, 4.6]], "r": 0.18})                            # 漿液

instruments = {
    "TI-201": {"name": "鍋爐 1 爐膛溫度", "unit": "°C", "base": 880, "equipment": "B-201", "alarm_hi": 950},
    "TI-202": {"name": "鍋爐 2 爐膛溫度", "unit": "°C", "base": 875, "equipment": "B-202", "alarm_hi": 950},
    "PI-201": {"name": "主蒸汽壓力", "unit": "kg/cm²g", "base": 88, "equipment": "B-201", "alarm_hi": 96},
    "TI-301": {"name": "SCR 入口溫度", "unit": "°C", "base": 345, "equipment": "R-301"},
    "AI-601N": {"name": "煙囪 NOx", "unit": "ppm", "base": 28, "equipment": "ST-601", "alarm_hi": 60},
    "AI-601S": {"name": "煙囪 SOx", "unit": "ppm", "base": 12, "equipment": "ST-601", "alarm_hi": 40},
    "PI-501": {"name": "FGD 漿液泵壓", "unit": "kg/cm²g", "base": 4.2, "equipment": "A-501"},
    "LI-501": {"name": "石灰石漿液槽液位", "unit": "%", "base": 62, "equipment": "T-501", "alarm_lo": 15},
}
for itag, inst in instruments.items():
    for u in units:
        for e in u["equipment"]:
            if e["tag"] == inst["equipment"]:
                e["instruments"].append(itag)

scene = {
    "plant": {"id": "LONGDE-UTIL", "name": "龍德公用廠｜燃煤汽電共生（示範建模）",
              "units": units},
    "pipes": pipes,
    "instruments": instruments,
    "scenarios": [{"id": "normal", "name": "正常運轉", "kind": "normal", "desc": ""}],
    "source": "龍德簡介 PPT 流程示意（無製程數據；位號為示範自編）",
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(scene, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"OK -> {OUT}  equipment="
      f"{sum(len(u['equipment']) for u in units)} pipes={len(pipes)} inst={len(instruments)}")
