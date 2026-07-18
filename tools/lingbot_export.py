#!/usr/bin/env python3
"""LingBot-Map -> PLY point cloud exporter for J.S_3D Studio.

Runs LingBot-Map (github.com/Robbyant/lingbot-map, feed-forward streaming 3D
reconstruction) on a video or image folder, then exports the fused point cloud
as a binary little-endian PLY (x y z red green blue) readable by the editor.

Must be executed on a CUDA machine inside the lingbot-map conda environment:

    python tools/lingbot_export.py --model_path /path/to/checkpoint.pt \
        --video walkthrough.mp4 --fps 10 --conf 50 --voxel 0.02

Coordinates are the model's world frame, assumed meters. Monocular
reconstruction is up-to-scale; the true scale must be calibrated in the
editor's alignment tool (noted in the PLY header comment).
"""

import argparse
import glob
import os
import sys
import time

# Reduce reserved-vs-allocated CUDA memory gap (must be set before torch import).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

INSTALL_GUIDE = """\
[lingbot_export] Missing dependency: {missing}

This tool must run inside the lingbot-map environment on a CUDA machine.
Install steps (see https://github.com/Robbyant/lingbot-map for details):

    git clone https://github.com/Robbyant/lingbot-map
    cd lingbot-map
    conda create -n lingbot-map python=3.10 -y
    conda activate lingbot-map
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
    pip install -e .
    pip install opencv-python pillow tqdm

Then re-run:  python tools/lingbot_export.py --model_path <ckpt> --video <mp4>
Original import error: {err}
"""


def die_missing(missing, err):
    sys.stderr.write(INSTALL_GUIDE.format(missing=missing, err=err))
    sys.exit(1)


try:
    import numpy as np
except ImportError as e:  # pragma: no cover
    die_missing("numpy", e)


# =============================================================================
# CLI
# =============================================================================

def parse_args():
    p = argparse.ArgumentParser(
        description="LingBot-Map reconstruction -> PLY point cloud export")
    # Input
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--video", type=str, default=None,
                     help="Input video; frames are extracted at --fps")
    src.add_argument("--image_folder", type=str, default=None,
                     help="Folder of input images (.jpg/.png)")
    p.add_argument("--fps", type=int, default=10,
                   help="Frame sampling rate for --video (default 10)")
    p.add_argument("--stride", type=int, default=1,
                   help="Keep every N-th sampled frame (default 1)")
    # Model (required) + lingbot-map defaults mirrored from official demo.py
    p.add_argument("--model_path", type=str, required=True,
                   help="LingBot-Map checkpoint (.pt)")
    p.add_argument("--image_size", type=int, default=518)
    p.add_argument("--patch_size", type=int, default=14)
    p.add_argument("--num_scale_frames", type=int, default=8)
    p.add_argument("--keyframe_interval", type=int, default=None,
                   help="Keyframe interval; default auto "
                        "(1 if frames<=320 else ceil(frames/320))")
    p.add_argument("--max_frame_num", type=int, default=1024)
    p.add_argument("--kv_cache_sliding_window", type=int, default=64)
    p.add_argument("--camera_num_iterations", type=int, default=4)
    p.add_argument("--use_sdpa", action="store_true", default=False,
                   help="Force SDPA attention backend (auto-enabled when "
                        "flashinfer is unavailable)")
    # Export
    p.add_argument("--out", type=str, default=None,
                   help="Output .ply (default static/scans/scan_<timestamp>.ply)")
    p.add_argument("--conf", type=float, default=50.0,
                   help="Confidence percentile filter 0-100: keep points whose "
                        "world_points_conf is above this percentile (default 50)")
    p.add_argument("--voxel", type=float, default=0.02,
                   help="Voxel downsample size in meters, 0 disables (default 0.02)")
    p.add_argument("--max_points", type=int, default=3_000_000,
                   help="Hard cap on exported points; random-thinned if exceeded "
                        "(default 3,000,000)")
    return p.parse_args()


# =============================================================================
# Image loading (mirrors official demo.py load_images, crop mode)
# =============================================================================

def load_images(args):
    try:
        import cv2
    except ImportError as e:
        die_missing("opencv-python (cv2)", e)
    try:
        from lingbot_map.utils.load_fn import load_and_preprocess_images
    except ImportError as e:
        die_missing("lingbot_map", e)

    if args.video is not None:
        if not os.path.isfile(args.video):
            sys.stderr.write(f"[lingbot_export] video not found: {args.video}\n")
            sys.exit(1)
        video_name = os.path.splitext(os.path.basename(args.video))[0]
        out_dir = os.path.join(os.path.dirname(os.path.abspath(args.video)),
                               f"{video_name}_frames")
        os.makedirs(out_dir, exist_ok=True)
        cap = cv2.VideoCapture(args.video)
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30
        interval = max(1, round(src_fps / max(args.fps, 1)))
        idx, paths = 0, []
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if idx % interval == 0:
                path = os.path.join(out_dir, f"{len(paths):06d}.jpg")
                cv2.imwrite(path, frame)
                paths.append(path)
            idx += 1
        cap.release()
        print(f"Extracted {len(paths)} frames from video (interval={interval})")
    else:
        if not os.path.isdir(args.image_folder):
            sys.stderr.write(
                f"[lingbot_export] image folder not found: {args.image_folder}\n")
            sys.exit(1)
        paths = []
        for ext in (".jpg", ".jpeg", ".png", ".JPG", ".JPEG", ".PNG"):
            paths.extend(glob.glob(os.path.join(args.image_folder, f"*{ext}")))
        paths = sorted(set(paths))

    if args.stride > 1:
        paths = paths[::args.stride]
    if not paths:
        sys.stderr.write("[lingbot_export] no input frames found\n")
        sys.exit(1)

    print(f"Loading {len(paths)} images...")
    images = load_and_preprocess_images(
        paths, mode="crop", image_size=args.image_size, patch_size=args.patch_size)
    h, w = images.shape[-2:]
    print(f"Preprocessed to {w}x{h}")
    return images


# =============================================================================
# Model loading (mirrors official demo.py load_model, streaming mode)
# =============================================================================

def load_model(args, torch, device):
    try:
        from lingbot_map.models.gct_stream import GCTStream
    except ImportError as e:
        die_missing("lingbot_map", e)

    use_sdpa = args.use_sdpa
    if not use_sdpa:
        try:
            import flashinfer  # noqa: F401
        except ImportError:
            use_sdpa = True
            print("flashinfer not available -> falling back to SDPA backend")

    print("Building model...")
    model = GCTStream(
        img_size=args.image_size,
        patch_size=args.patch_size,
        enable_3d_rope=True,
        max_frame_num=args.max_frame_num,
        kv_cache_sliding_window=args.kv_cache_sliding_window,
        kv_cache_scale_frames=args.num_scale_frames,
        kv_cache_cross_frame_special=True,
        kv_cache_include_scale_frames=True,
        use_sdpa=use_sdpa,
        camera_num_iterations=args.camera_num_iterations,
    )

    print(f"Loading checkpoint: {args.model_path}")
    ckpt = torch.load(args.model_path, map_location=device, weights_only=False)
    state_dict = ckpt.get("model", ckpt) if isinstance(ckpt, dict) else ckpt
    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    if missing:
        print(f"  Missing keys: {len(missing)}")
    if unexpected:
        print(f"  Unexpected keys: {len(unexpected)}")
    return model.to(device).eval()


# =============================================================================
# Tensor helpers
# =============================================================================

def to_numpy(t):
    import torch
    if isinstance(t, torch.Tensor):
        return t.detach().float().cpu().numpy()
    return np.asarray(t)


def squeeze_batch(a, batched_ndim):
    """Drop leading batch dim for single-sequence outputs."""
    if a.ndim == batched_ndim and a.shape[0] == 1:
        return a[0]
    return a


# =============================================================================
# Point cloud assembly
# =============================================================================

def collect_points(predictions, images, conf_percentile):
    """Gather world points + RGB across frames, filtered by confidence.

    world_points: [S, H, W, 3] (model world frame, meters assumed)
    world_points_conf: [S, H, W]
    images: [S, 3, H, W] float in [0, 1]
    """
    wp = squeeze_batch(to_numpy(predictions["world_points"]), 5)
    conf = squeeze_batch(to_numpy(predictions["world_points_conf"]), 4)
    imgs = squeeze_batch(to_numpy(images), 5)

    pts = wp.reshape(-1, 3).astype(np.float32)
    conf_flat = conf.reshape(-1).astype(np.float32)
    cols = (np.transpose(imgs, (0, 2, 3, 1)).reshape(-1, 3)
            .clip(0.0, 1.0) * 255.0).astype(np.uint8)

    n = min(len(pts), len(conf_flat), len(cols))
    pts, conf_flat, cols = pts[:n], conf_flat[:n], cols[:n]

    mask = np.isfinite(pts).all(axis=1)
    if conf_percentile > 0:
        thr = np.percentile(conf_flat[mask], conf_percentile) if mask.any() else 0.0
        mask &= conf_flat >= thr
        print(f"Confidence filter: percentile {conf_percentile} -> "
              f"threshold {thr:.4f}")
    pts, cols = pts[mask], cols[mask]
    print(f"Points after confidence filter: {len(pts):,}")
    return pts, cols


def voxel_downsample(pts, cols, voxel):
    """Voxel-grid downsample. Uses open3d when available, else numpy grid keys."""
    if voxel <= 0 or len(pts) == 0:
        return pts, cols
    try:
        import open3d as o3d
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(pts.astype(np.float64))
        pcd.colors = o3d.utility.Vector3dVector(cols.astype(np.float64) / 255.0)
        pcd = pcd.voxel_down_sample(voxel_size=voxel)
        out_pts = np.asarray(pcd.points, dtype=np.float32)
        out_cols = (np.asarray(pcd.colors) * 255.0).clip(0, 255).astype(np.uint8)
        print(f"Voxel downsample (open3d, {voxel} m): {len(out_pts):,} points")
        return out_pts, out_cols
    except ImportError:
        pass
    # numpy fallback: keep first point per occupied voxel
    keys = np.floor(pts / voxel).astype(np.int64)
    _, idx = np.unique(keys, axis=0, return_index=True)
    idx.sort()
    print(f"Voxel downsample (numpy, {voxel} m): {len(idx):,} points")
    return pts[idx], cols[idx]


def cap_points(pts, cols, max_points):
    if max_points and len(pts) > max_points:
        rng = np.random.default_rng(0)
        idx = rng.choice(len(pts), size=max_points, replace=False)
        idx.sort()
        print(f"Thinned to max_points cap: {max_points:,}")
        return pts[idx], cols[idx]
    return pts, cols


# =============================================================================
# PLY writer (binary little-endian, x y z red green blue)
# =============================================================================

def write_ply(path, pts, cols):
    n = len(pts)
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment generated by tools/lingbot_export.py (LingBot-Map)\n"
        "comment scale: arbitrary (monocular); calibrate in editor\n"
        f"element vertex {n}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "property uchar red\n"
        "property uchar green\n"
        "property uchar blue\n"
        "end_header\n"
    )
    rec = np.empty(n, dtype=[
        ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
        ("red", "u1"), ("green", "u1"), ("blue", "u1"),
    ])
    rec["x"], rec["y"], rec["z"] = pts[:, 0], pts[:, 1], pts[:, 2]
    rec["red"], rec["green"], rec["blue"] = cols[:, 0], cols[:, 1], cols[:, 2]
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        rec.tofile(f)
    print(f"Wrote {n:,} points -> {path} "
          f"({os.path.getsize(path) / 1e6:.1f} MB)")


# =============================================================================
# Main
# =============================================================================

def main():
    args = parse_args()

    try:
        import torch
    except ImportError as e:
        die_missing("torch", e)

    if args.out is None:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        stamp = time.strftime("%Y%m%d_%H%M%S")
        args.out = os.path.join(repo_root, "static", "scans", f"scan_{stamp}.ply")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        print("WARNING: CUDA not available -- inference will be extremely slow "
              "or unsupported. This tool is meant for a CUDA machine.")

    # ── Load images & model ──────────────────────────────────────────────
    t0 = time.time()
    images = load_images(args)
    model = load_model(args, torch, device)
    print(f"Load time: {time.time() - t0:.1f}s")

    if device.type == "cuda":
        dtype = (torch.bfloat16
                 if torch.cuda.get_device_capability()[0] >= 8 else torch.float16)
    else:
        dtype = torch.float32
    if dtype != torch.float32 and getattr(model, "aggregator", None) is not None:
        model.aggregator = model.aggregator.to(dtype=dtype)

    images = images.to(device)
    num_frames = int(images.shape[0])
    print(f"Input: {num_frames} frames, shape {tuple(images.shape)}")

    keyframe_interval = args.keyframe_interval
    if keyframe_interval is None:
        keyframe_interval = 1 if num_frames <= 320 else (num_frames + 319) // 320
        if keyframe_interval > 1:
            print(f"Auto keyframe_interval={keyframe_interval} "
                  f"(num_frames={num_frames})")

    # ── Streaming inference (same path as official demo.py) ─────────────
    print(f"Running streaming inference (dtype={dtype})...")
    t0 = time.time()
    with torch.no_grad(), torch.amp.autocast("cuda", dtype=dtype,
                                             enabled=device.type == "cuda"):
        predictions = model.inference_streaming(
            images,
            num_scale_frames=args.num_scale_frames,
            keyframe_interval=keyframe_interval,
            output_device=torch.device("cpu"),  # offload per-frame outputs
        )
    print(f"Inference done in {time.time() - t0:.1f}s")

    # RGB source: prefer offloaded copy in predictions, else the input tensor.
    images_for_rgb = predictions.get("images", images)

    # ── Assemble, filter, downsample, cap ────────────────────────────────
    pts, cols = collect_points(predictions, images_for_rgb, args.conf)
    if len(pts) == 0:
        sys.stderr.write("[lingbot_export] no points survived filtering; "
                         "try lowering --conf\n")
        sys.exit(1)
    pts, cols = voxel_downsample(pts, cols, args.voxel)
    pts, cols = cap_points(pts, cols, args.max_points)

    # ── Export ───────────────────────────────────────────────────────────
    # Coordinates are the model's world frame (meters assumed; monocular
    # scale is arbitrary -- see PLY header comment). Axis convention is left
    # as-is; the editor's alignment tool handles orientation/scale.
    write_ply(args.out, pts, cols)


if __name__ == "__main__":
    main()
