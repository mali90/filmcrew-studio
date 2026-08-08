"""Boundary-frame extraction (§7.2) and Pillow-backed uint8 RGB I/O.

Pillow is used in place of imageio (spec §5/§12.6): Image.convert('RGB') collapses RGBA / 16-bit
PNGs to the uint8 RGB the statistics expect.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

_REC709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)


def _ffmpeg(args: list, ffmpeg: str) -> subprocess.CompletedProcess:
    return subprocess.run([ffmpeg, *args], capture_output=True, text=True)


def extract_first_frame(video, out_png, ffmpeg: str = "ffmpeg") -> Path:
    out_png = Path(out_png)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    r = _ffmpeg(["-y", "-i", str(video), "-frames:v", "1", str(out_png)], ffmpeg)
    if r.returncode != 0 or not out_png.exists():
        raise RuntimeError("first-frame extraction failed for %s\n%s" % (video, r.stderr[-400:]))
    return out_png


def extract_last_frame(video, out_png, ffmpeg: str = "ffmpeg") -> Path:
    """Write the final decoded frame (§7.2 / §12.4): -sseof seeks before EOF, -update 1 overwrites."""
    out_png = Path(out_png)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    for sseof in ("-0.2", "-0.5", "-1.0"):  # widen the tail window if a build decodes zero frames
        r = _ffmpeg(["-y", "-sseof", sseof, "-i", str(video), "-frames:v", "1", "-update", "1", str(out_png)], ffmpeg)
        if r.returncode == 0 and out_png.exists():
            return out_png
    raise RuntimeError("last-frame extraction failed for %s\n%s" % (video, r.stderr[-400:]))


def load_rgb(png) -> np.ndarray:
    """Load a PNG as an (H, W, 3) uint8 array, dropping alpha / normalising bit depth."""
    with Image.open(png) as im:
        return np.asarray(im.convert("RGB"), dtype=np.uint8)


def save_rgb(arr: np.ndarray, png) -> Path:
    Image.fromarray(np.asarray(arr, dtype=np.uint8), mode="RGB").save(str(png))
    return Path(png)


def luma_mad(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute Rec.709-luma difference between two RGB frames (8-bit scale).

    Crops to common dimensions first so boundary frames from differently-sized segments still compare.
    """
    h = min(a.shape[0], b.shape[0])
    w = min(a.shape[1], b.shape[1])
    ya = a[:h, :w].astype(np.float64) @ _REC709
    yb = b[:h, :w].astype(np.float64) @ _REC709
    return float(np.mean(np.abs(ya - yb)))
