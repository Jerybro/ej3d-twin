"""下載示範用公開 3D 資產到 scans/（大檔不進版控，clone 後跑這支補齊）。

    python tools/fetch_demo_assets.py

- Poly Haven「Modular Industrial Pipes 01」（CC0，可商用）→ scans/pipes01/
- antimatter15/splat 公開 3DGS 樣本（nike 8MB / train 32MB）→ scans/
  nike 給筆電驗證；train（工業感場景、1.4M splats）建議在 RTX 桌機測
"""

from __future__ import annotations

import urllib.request
from pathlib import Path

SCANS = Path(__file__).resolve().parent.parent / "scans"

PH_GLTF = "https://dl.polyhaven.org/file/ph-assets/Models/gltf"
PH_JPG = "https://dl.polyhaven.org/file/ph-assets/Models/jpg/2k/modular_industrial_pipes_01"
HF = "https://huggingface.co/cakewalk/splat-data/resolve/main"

FILES = {
    "pipes01/modular_industrial_pipes_01_2k.gltf":
        f"{PH_GLTF}/2k/modular_industrial_pipes_01/modular_industrial_pipes_01_2k.gltf",
    "pipes01/modular_industrial_pipes_01.bin":
        f"{PH_GLTF}/8k/modular_industrial_pipes_01/modular_industrial_pipes_01.bin",
    "pipes01/textures/modular_industrial_pipes_01_group01_diff_2k.jpg":
        f"{PH_JPG}/modular_industrial_pipes_01_group01_diff_2k.jpg",
    "pipes01/textures/modular_industrial_pipes_01_group01_nor_gl_2k.jpg":
        f"{PH_JPG}/modular_industrial_pipes_01_group01_nor_gl_2k.jpg",
    "pipes01/textures/modular_industrial_pipes_01_group01_arm_2k.jpg":
        f"{PH_JPG}/modular_industrial_pipes_01_group01_arm_2k.jpg",
    "pipes01/textures/modular_industrial_pipes_01_group02_diff_2k.jpg":
        f"{PH_JPG}/modular_industrial_pipes_01_group02_diff_2k.jpg",
    "pipes01/textures/modular_industrial_pipes_01_group02_nor_gl_2k.jpg":
        f"{PH_JPG}/modular_industrial_pipes_01_group02_nor_gl_2k.jpg",
    "pipes01/textures/modular_industrial_pipes_01_group02_arm_2k.jpg":
        f"{PH_JPG}/modular_industrial_pipes_01_group02_arm_2k.jpg",
    "nike.splat": f"{HF}/nike.splat",
    "train.splat": f"{HF}/train.splat",
    # 實景背景：Poly Haven「Abandoned Tank Farm 03」全景（CC0）→ 天空盒 + 環境反射
    "env/abandoned_tank_farm_03.jpg":
        "https://dl.polyhaven.org/file/ph-assets/HDRIs/extra/Tonemapped%20JPG/abandoned_tank_farm_03.jpg",
    # 真實地坪：Poly Haven「Concrete Floor 02」戶外混凝土（CC0）→ 實景模式地面
    "ground/concrete_floor_02_diff_2k.jpg":
        "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/concrete_floor_02/concrete_floor_02_diff_2k.jpg",
    "ground/concrete_floor_02_nor_gl_2k.jpg":
        "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/concrete_floor_02/concrete_floor_02_nor_gl_2k.jpg",
    "ground/concrete_floor_02_arm_2k.jpg":
        "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/concrete_floor_02/concrete_floor_02_arm_2k.jpg",
}

# 真實施工場景道具（Poly Haven 照片掃描級 PBR，CC0）→ scans/ph/{slug}/
# 走 files API 自動解析 gltf + bin + 貼圖清單；1k 貼圖（道具尺寸夠用、省記憶體）
PH_PROPS = [
    "concrete_road_barrier",      # 混凝土護欄
    "modular_chainlink_fence",    # 鐵絲網圍籬
    "cement_bag",                 # 水泥袋
    "Barrel_01",                  # 工業桶
    "barrel_03",                  # 鏽蝕鋼桶
    "propane_tank",               # 瓦斯桶
    "wooden_ladder",              # 木梯
    "hand_truck",                 # 手推車
    "plastic_crate_01",           # 塑膠棧箱
    "WetFloorSign_01",            # 警示立牌
    "fire_hydrant",               # 消防栓
    "korean_fire_extinguisher_01",# 滅火器
    "security_camera_01",         # 監視器（AI 攝影機桿用）
    "street_lamp_01",             # 路燈
    "utility_box_01",             # 配電箱
]


UA = {"User-Agent": "ej3d-twin-demo/1.0 (asset fetcher)"}


def fetch_polyhaven_model(slug: str, res: str = "1k") -> None:
    import json

    dest = SCANS / "ph" / slug
    api = f"https://api.polyhaven.com/files/{slug}"
    with urllib.request.urlopen(urllib.request.Request(api, headers=UA)) as r:
        files = json.load(r)
    entry = files["gltf"].get(res) or next(iter(files["gltf"].values()))
    gltf = entry["gltf"]
    todo = {f"{slug}_{res}.gltf": gltf["url"]}
    for rel, meta in gltf.get("include", {}).items():
        todo[rel] = meta["url"]
    for rel, url in todo.items():
        out = dest / rel
        if out.exists():
            print(f"已存在: ph/{slug}/{rel}")
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        print(f"下載: ph/{slug}/{rel}")
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
            out.write_bytes(r.read())

if __name__ == "__main__":
    for rel, url in FILES.items():
        dest = SCANS / rel
        if dest.exists() and dest.stat().st_size > 0:
            print(f"skip（已存在）: {rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"下載: {rel} …")
        urllib.request.urlretrieve(url, dest)
    for slug in PH_PROPS:
        fetch_polyhaven_model(slug)
    print("完成。")
