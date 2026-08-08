"""Verification: the colour seam metric (§9) plus the geometry gate (ADDENDUM_AR §6).

The geometry gate registers matched content across a joint into 5x6 tiles, fits the per-tile x/y
shift as a linear function of position, and reads off the implied horizontal/vertical scale. A tight
fit with a non-unit sx/sy ratio is a pipeline aspect-ratio squeeze; a loose fit means the frames
genuinely differ (not a distortion). `estimate_scale` is also used by `--desqueeze auto`.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np


# ---------------------------------------------------------------------------
# Colour seam metric (§9)
# ---------------------------------------------------------------------------
@dataclass
class JointReport:
    joint: int
    offset: float
    step: float
    baseline: float
    drift: float
    passed: bool


def _decode_gray(path: Path, start: float, dur: float, w: int, h: int, ffmpeg: str) -> np.ndarray:
    args = [
        ffmpeg, "-v", "error", "-ss", "%.6f" % max(0.0, start), "-t", "%.6f" % dur,
        "-i", str(path), "-vf", "format=gray", "-f", "rawvideo", "-",
    ]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("verify decode failed: %s" % r.stderr.decode(errors="replace")[-400:])
    buf = np.frombuffer(r.stdout, dtype=np.uint8)
    nf = buf.size // (w * h)
    if nf < 2:
        raise RuntimeError("verify decoded < 2 frames around a joint (window too small?)")
    return buf[: nf * w * h].reshape(nf, h, w).astype(np.float64)


def verify_joint(path: Path, joint: int, offset: float, xfade: float, fps: float, w: int, h: int,
                 ffmpeg: str = "ffmpeg") -> JointReport:
    fd = 1.0 / fps
    pad = 0.6
    start = max(0.0, offset - pad)
    dur = xfade + 2 * pad
    y = _decode_gray(path, start, dur, w, h, ffmpeg)

    means = y.reshape(y.shape[0], -1).mean(1)
    diffs = np.abs(np.diff(y, axis=0)).reshape(y.shape[0] - 1, -1).mean(1)
    t_frame = start + np.arange(len(means)) * fd
    t_diff = start + (np.arange(len(diffs)) + 0.5) * fd

    fade_lo, fade_hi = offset - 0.1, offset + xfade + 0.1
    in_fade = (t_diff >= fade_lo) & (t_diff <= fade_hi)
    step = float(np.max(diffs[in_fade])) if in_fade.any() else 0.0
    baseline = float(np.median(diffs[~in_fade])) if (~in_fade).any() else 0.0

    before = (t_frame >= offset - 0.5) & (t_frame < offset)
    after = (t_frame >= offset) & (t_frame < offset + 0.5)
    mb = float(means[before].mean()) if before.any() else 0.0
    ma = float(means[after].mean()) if after.any() else 0.0
    drift = abs(mb - ma)

    passed = (step <= max(2.0, 1.5 * baseline)) and (drift <= 1.5)
    return JointReport(joint=joint, offset=offset, step=step, baseline=baseline, drift=drift, passed=passed)


def verify(path, offsets: List[float], xfade: float, fps: float, w: int, h: int,
           ffmpeg: str = "ffmpeg") -> List[JointReport]:
    path = Path(path)
    return [verify_joint(path, k + 1, off, xfade, fps, w, h, ffmpeg) for k, off in enumerate(offsets)]


def format_report(reports: List[JointReport]) -> str:
    lines = ["  joint   offset      step    baseline   drift   verdict",
             "  -----   --------   -------   --------   -----   -------"]
    for r in reports:
        lines.append("  %5d   %8.4f   %7.3f   %8.3f   %5.3f   %s"
                     % (r.joint, r.offset, r.step, r.baseline, r.drift, "PASS" if r.passed else "FAIL"))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Geometry gate (ADDENDUM_AR §6) + shared scale estimator
# ---------------------------------------------------------------------------
def _decode_rgb_frame(path: Path, t: float, w: int, h: int, ffmpeg: str) -> np.ndarray:
    args = [ffmpeg, "-v", "error", "-ss", "%.6f" % max(0.0, t), "-i", str(path),
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("geometry decode failed: %s" % r.stderr.decode(errors="replace")[-300:])
    buf = np.frombuffer(r.stdout, dtype=np.uint8)
    if buf.size < w * h * 3:
        raise RuntimeError("geometry decode returned %d bytes, expected %d" % (buf.size, w * h * 3))
    return buf[: w * h * 3].reshape(h, w, 3)


def _gradient_gray(rgb: np.ndarray, max_edge: int = 480) -> np.ndarray:
    g = rgb.astype(np.float64) @ np.array([0.299, 0.587, 0.114])
    long_edge = max(g.shape)
    if long_edge > max_edge:
        s = int(np.ceil(long_edge / max_edge))
        g = g[::s, ::s]
    gy, gx = np.gradient(g)
    return np.hypot(gx, gy)


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = np.sqrt(float((a * a).sum()) * float((b * b).sum()))
    return float((a * b).sum() / d) if d > 1e-9 else 0.0


def _best_xshift(tile_a: np.ndarray, tile_b: np.ndarray, max_shift: int = 8):
    """Integer horizontal shift of tile_b (compared over a common interior) maximising NCC vs tile_a."""
    h, w = tile_a.shape
    if w <= 2 * max_shift + 2:
        return None
    core_a = tile_a[:, max_shift: w - max_shift]
    best_n, best_s = -2.0, 0
    # Visit shifts nearest zero first so a flat / tied NCC (low-texture or axis-aligned tile) resolves
    # to the smallest |shift|, not to -max_shift — a strict `>` then keeps that zero-biased choice.
    for s in sorted(range(-max_shift, max_shift + 1), key=abs):
        core_b = tile_b[:, max_shift + s: w - max_shift + s]
        n = _ncc(core_a, core_b)
        if n > best_n:
            best_n, best_s = n, s
    return best_s, best_n


def _fit_scale(centers: List[float], shifts: List[float]):
    """Fit dx = k*(x - xc) + b; return (scale = 1/(1+k), residual_std)."""
    x = np.asarray(centers, float)
    d = np.asarray(shifts, float)
    xc = x.mean()
    A = np.column_stack([x - xc, np.ones_like(x)])
    coef, *_ = np.linalg.lstsq(A, d, rcond=None)
    resid = d - (A @ coef)
    k = float(coef[0])
    scale = 1.0 / (1.0 + k) if abs(1.0 + k) > 1e-9 else 1.0
    return scale, float(np.std(resid))


def estimate_scale(frame_before: np.ndarray, frame_after: np.ndarray,
                   rows: int = 5, cols: int = 6, ncc_thresh: float = 0.35, max_shift: int = 8) -> Dict:
    """Implied horizontal (sx) and vertical (sy) scale of `frame_after` relative to `frame_before`."""
    ga = _gradient_gray(frame_before)
    gb = _gradient_gray(frame_after)
    H, W = min(ga.shape[0], gb.shape[0]), min(ga.shape[1], gb.shape[1])
    ga, gb = ga[:H, :W], gb[:H, :W]
    th, tw = H / rows, W / cols

    xs: List[float] = []
    dxs: List[float] = []
    ys: List[float] = []
    dys: List[float] = []
    for r in range(rows):
        for c in range(cols):
            y0, y1 = int(r * th), int((r + 1) * th)
            x0, x1 = int(c * tw), int((c + 1) * tw)
            ta, tb = ga[y0:y1, x0:x1], gb[y0:y1, x0:x1]
            rx = _best_xshift(ta, tb, max_shift)
            if rx is not None and rx[1] > ncc_thresh:
                xs.append((x0 + x1) / 2.0)
                dxs.append(float(rx[0]))
            ry = _best_xshift(ta.T.copy(), tb.T.copy(), max_shift)
            if ry is not None and ry[1] > ncc_thresh:
                ys.append((y0 + y1) / 2.0)
                dys.append(float(ry[0]))

    sx, res_x = (_fit_scale(xs, dxs) if len(xs) >= 2 else (1.0, 0.0))
    sy, res_y = (_fit_scale(ys, dys) if len(ys) >= 2 else (1.0, 0.0))
    return {"sx": sx, "sy": sy, "res_x": res_x, "res_y": res_y, "n_x": len(xs), "n_y": len(ys)}


@dataclass
class GeomReport:
    joint: int
    sx: float
    sy: float
    residual: float
    n_tiles: int
    verdict: str   # PASS | FAIL | INCONCLUSIVE

    @property
    def squeeze_pct(self) -> float:
        return (self.sx / self.sy - 1.0) * 100.0 if self.sy else 0.0


def scale_is_trustworthy(est: dict) -> bool:
    """Both axes measured with enough tiles and a tight fit — the precondition for reading sx/sy as a
    real geometric scale rather than 'the frames genuinely differ' (ADDENDUM_AR §6)."""
    return (est["n_x"] >= 8 and est["res_x"] < 1.0 and est["n_y"] >= 8 and est["res_y"] < 1.0)


def geometry_joint(path: Path, joint: int, offset: float, xfade: float, fps: float, w: int, h: int,
                   ffmpeg: str = "ffmpeg") -> GeomReport:
    fd = 1.0 / fps
    fb = _decode_rgb_frame(path, max(0.0, offset - fd), w, h, ffmpeg)          # last frame before fade
    fa = _decode_rgb_frame(path, offset + xfade + fd, w, h, ffmpeg)            # first frame after fade
    est = estimate_scale(fb, fa)
    n = min(est["n_x"], est["n_y"])
    # A squeeze is anisotropy: it can only be told apart from an isotropic zoom (or from frames that
    # genuinely differ) when BOTH axes are measured cleanly. If either axis is under-sampled or loose,
    # we cannot classify -> INCONCLUSIVE, never a silent PASS or a false FAIL (review findings 2,3,5).
    if not scale_is_trustworthy(est):
        return GeomReport(joint, est["sx"], est["sy"], est["res_x"], n, "INCONCLUSIVE")
    ratio = est["sx"] / est["sy"]
    fail = abs(ratio - 1.0) > 0.004
    return GeomReport(joint, est["sx"], est["sy"], est["res_x"], n, "FAIL" if fail else "PASS")


def geometry_gate(path, offsets: List[float], xfade: float, fps: float, w: int, h: int,
                  ffmpeg: str = "ffmpeg") -> List[GeomReport]:
    path = Path(path)
    return [geometry_joint(path, k + 1, off, xfade, fps, w, h, ffmpeg) for k, off in enumerate(offsets)]


def format_geometry_report(reports: List[GeomReport]) -> str:
    lines = ["  joint     sx        sy      squeeze   resid   tiles   verdict",
             "  -----   -------   -------   -------   -----   -----   -------"]
    for r in reports:
        lines.append("  %5d   %7.4f   %7.4f   %+6.2f%%   %5.2f   %5d   %s"
                     % (r.joint, r.sx, r.sy, r.squeeze_pct, r.residual, r.n_tiles, r.verdict))
    return "\n".join(lines)
