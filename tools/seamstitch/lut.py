"""Colour transforms + Hald CLUT baking (§7.3).

Each transform is a callable ``f(frame_uint8) -> frame_uint8`` on (H, W, 3) RGB. The same callable
is baked into a Hald CLUT PNG (applied by ffmpeg's ``haldclut``) AND used directly in numpy for
cascade-mode reference computation (§7.4).
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable

import numpy as np

from .frames import load_rgb, save_rgb

Transform = Callable[[np.ndarray], np.ndarray]


def _downsample(img: np.ndarray, max_edge: int = 512) -> np.ndarray:
    """Stride-subsample so the long edge is <= max_edge; statistics only, LUT stays full-res (§7.3)."""
    long_edge = max(img.shape[0], img.shape[1])
    if long_edge <= max_edge:
        return img
    stride = int(np.ceil(long_edge / max_edge))
    return img[::stride, ::stride]


def quantile_lut_8bit(src_ch: np.ndarray, ref_ch: np.ndarray, n_q: int = 1024) -> np.ndarray:
    """Per-channel monotone quantile map (§7.3); handles nonlinear tone shifts."""
    qs = np.linspace(0.0, 1.0, n_q)
    s = np.quantile(src_ch, qs).astype(np.float64)
    r = np.quantile(ref_ch, qs).astype(np.float64)
    s = s + np.linspace(0.0, 1e-4, n_q)          # strictly increasing xp for np.interp (§7.3/§12.10)
    lut = np.interp(np.arange(256), s, r)
    lut = np.maximum.accumulate(lut)              # enforce monotonic
    return np.clip(np.round(lut), 0, 255).astype(np.uint8)


def mkl_transform(src_px: np.ndarray, ref_px: np.ndarray, eps: float = 1e-6):
    """Monge-Kantorovich linear colour transport (§7.3). src_px/ref_px: (N,3) float in [0,1]."""
    mu_s, mu_r = src_px.mean(0), ref_px.mean(0)
    cov_s = np.cov(src_px, rowvar=False) + eps * np.eye(3)
    cov_r = np.cov(ref_px, rowvar=False) + eps * np.eye(3)

    def psd_sqrt(m):
        w, v = np.linalg.eigh(m)
        return (v * np.sqrt(np.clip(w, eps, None))) @ v.T

    cs = psd_sqrt(cov_s)
    cs_inv = np.linalg.inv(cs)
    T = cs_inv @ psd_sqrt(cs @ cov_r @ cs) @ cs_inv   # symmetric MKL matrix
    return T, mu_s, mu_r


def _apply_mkl(x01: np.ndarray, T: np.ndarray, mu_s: np.ndarray, mu_r: np.ndarray) -> np.ndarray:
    """Apply an MKL transform to a [0,1] array whose last axis is RGB. Broadcasts over any leading shape."""
    return np.clip((x01 - mu_s) @ T + mu_r, 0.0, 1.0)


def build_transform(src_img: np.ndarray, ref_img: np.ndarray, method: str = "hybrid") -> Transform:
    """Return f mapping the *src* segment's colours toward the *ref* grade (§7.3).

    src_img = first frame of the segment being corrected; ref_img = reference frame (§7.4).
    """
    if method == "none":
        return lambda frame: frame

    src = _downsample(src_img).reshape(-1, 3).astype(np.float64)
    ref = _downsample(ref_img).reshape(-1, 3).astype(np.float64)

    if method == "quantile":
        luts = [quantile_lut_8bit(src[:, c], ref[:, c]) for c in range(3)]

        def f_q(frame: np.ndarray) -> np.ndarray:
            out = np.empty_like(frame)
            for c in range(3):
                out[..., c] = luts[c][frame[..., c]]
            return out

        return f_q

    if method == "mkl":
        T, mu_s, mu_r = mkl_transform(src / 255.0, ref / 255.0)

        def f_m(frame: np.ndarray) -> np.ndarray:
            y = _apply_mkl(frame.astype(np.float64) / 255.0, T, mu_s, mu_r)
            return np.round(y * 255.0).astype(np.uint8)

        return f_m

    if method == "hybrid":
        # MKL first (cross-channel cast), then per-channel quantile refinement of the MKL'd source.
        T, mu_s, mu_r = mkl_transform(src / 255.0, ref / 255.0)
        src_mkl = _apply_mkl(src / 255.0, T, mu_s, mu_r) * 255.0
        luts = [quantile_lut_8bit(src_mkl[:, c], ref[:, c]) for c in range(3)]

        def f_h(frame: np.ndarray) -> np.ndarray:
            y = _apply_mkl(frame.astype(np.float64) / 255.0, T, mu_s, mu_r)
            yb = np.clip(np.round(y * 255.0).astype(np.int64), 0, 255)
            out = np.empty(frame.shape, dtype=np.uint8)
            for c in range(3):
                out[..., c] = luts[c][yb[..., c]]
            return out

        return f_h

    raise ValueError("unknown method: %s" % method)


def bake_hald_clut(f: Transform, identity_png, out_png, ffmpeg: str = "ffmpeg", level: int = 8) -> Path:
    """Apply f to a fresh haldclutsrc identity image and write the LUT PNG as uint8 RGB (§7.3)."""
    identity_png = Path(identity_png)
    if not identity_png.exists():
        r = subprocess.run(
            [ffmpeg, "-y", "-f", "lavfi", "-i", "haldclutsrc=%d" % level, "-frames:v", "1", str(identity_png)],
            capture_output=True, text=True,
        )
        if r.returncode != 0 or not identity_png.exists():
            raise RuntimeError("haldclutsrc identity generation failed\n%s" % r.stderr[-400:])
    ident = load_rgb(identity_png)
    return save_rgb(f(ident), out_png)
