"""案例圖匯入：把掃描 JPG 轉成 PDF 放進 uploads/pid。

現有管線入口吃 PDF（pypdfium2 渲染），掃描圖轉封裝成 PDF 即可共用同一條路徑。
注意：掃描圖沒有向量圖元，detect_valves / detect_bubbles 會全數落空，
只有 OCR 路徑有效——這正是要拿它來驗證向量路線邊界的原因。
"""
from pathlib import Path

from PIL import Image

SRC = Path.home() / "Downloads" / "gdrive_download" / "HDS11"
DST = Path(__file__).resolve().parent.parent / "uploads" / "pid"

PICKS = [
    "P2201AB/P-2001.PID.jpg",
    "C2201/C-2201 (Compressor).30.jpg",
    "C2201/C-2201 (Oil System).34.jpg",
    "C2301AB/C-2301A (Process Gas).36.jpg",
]


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    for rel in PICKS:
        p = SRC / rel
        if not p.exists():
            print(f"缺檔：{rel}")
            continue
        im = Image.open(p).convert("RGB")
        stem = Path(rel).stem.replace(" ", "_").replace("(", "").replace(")", "")
        out = DST / f"DALIN-{stem}.pdf"
        im.save(out, "PDF", resolution=200.0)
        print(f"{out.name:<46} {im.size[0]}x{im.size[1]}")


if __name__ == "__main__":
    main()
