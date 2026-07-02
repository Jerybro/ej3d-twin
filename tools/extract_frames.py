"""從錄影影片抽取 3D 重建用的畫格（capture → rebuild 管線第一步）。

用法：
    python tools/extract_frames.py 影片.mp4 -o frames/ -n 150

- 均勻取樣 + 清晰度過濾：每個取樣窗口內挑 Laplacian 變異數最高（最不糊）的一張
- 產出的 frames/ 資料夾可直接上傳 Luma AI / Polycam / KIRI Engine，
  或餵給 COLMAP / RealityCapture 做攝影測量
- 拍攝建議見 README「之後接真場景」一節：要「走動」不要原地環拍，
  橫式 4K、慢速移動、繞目標 2~3 圈不同高度
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2


def sharpness(frame) -> float:
    """Laplacian 變異數：值越高越清晰（模糊/晃動的畫格值低）。"""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def extract(video: Path, out_dir: Path, target: int, min_sharpness: float) -> int:
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise SystemExit(f"無法開啟影片：{video}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    print(f"影片：{total} 幀 / {fps:.1f} fps / {total / fps:.1f} 秒")

    window = max(total // target, 1)  # 每 window 幀挑一張最清晰的
    out_dir.mkdir(parents=True, exist_ok=True)

    saved = skipped_blurry = 0
    best, best_score = None, -1.0
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        score = sharpness(frame)
        if score > best_score:
            best, best_score = frame, score
        idx += 1
        if idx % window == 0:
            if best_score >= min_sharpness:
                cv2.imwrite(str(out_dir / f"frame_{saved:05d}.jpg"), best,
                            [cv2.IMWRITE_JPEG_QUALITY, 95])
                saved += 1
            else:
                skipped_blurry += 1
            best, best_score = None, -1.0
    cap.release()
    print(f"輸出 {saved} 張至 {out_dir}（{skipped_blurry} 個窗口因整段模糊被跳過）")
    if skipped_blurry > target * 0.2:
        print("⚠ 模糊比例偏高：拍攝時請放慢移動速度、確保光線充足")
    return saved


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="抽取 3D 重建用畫格")
    ap.add_argument("video", type=Path, help="輸入影片（mp4/mov）")
    ap.add_argument("-o", "--out", type=Path, default=Path("frames"), help="輸出資料夾")
    ap.add_argument("-n", "--num", type=int, default=150, help="目標張數（預設 150）")
    ap.add_argument("--min-sharpness", type=float, default=40.0,
                    help="清晰度門檻（Laplacian 變異數，預設 40）")
    args = ap.parse_args()
    extract(args.video, args.out, args.num, args.min_sharpness)
