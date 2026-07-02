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
}

if __name__ == "__main__":
    for rel, url in FILES.items():
        dest = SCANS / rel
        if dest.exists() and dest.stat().st_size > 0:
            print(f"skip（已存在）: {rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"下載: {rel} …")
        urllib.request.urlretrieve(url, dest)
    print("完成。")
