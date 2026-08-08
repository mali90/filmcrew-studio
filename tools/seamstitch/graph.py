"""Pure filter_complex builder + offset math (§7.5, patched by ADDENDUM_AR §4).

No ffmpeg, no I/O — inputs are probed metadata + options, outputs are the graph string, the ffmpeg
input ordering (segments, then one LUT PNG per corrected segment), the rounded joint offsets and the
expected output duration. Kept side-effect free so the offset math is unit-testable without ffmpeg.

Geometry (ADDENDUM_AR): normalisation NEVER distorts aspect ratio — a segment whose dimensions differ
from the target is fit with `--fit` (cover=scale-up+centre-crop, contain=scale-down+pad, none=error
upstream), and `setsar=1` is emitted on EVERY branch. An optional per-segment horizontal de-squeeze
(widen + centre-crop) corrects a baked-in horizontal squeeze in the source pixels.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple


def _num(x: float) -> str:
    """Compact number: integers stay integral, else 6 decimals (enough for durations)."""
    xf = float(x)
    if abs(xf - round(xf)) < 1e-9:
        return str(int(round(xf)))
    return "%.6f" % xf


def _even(n: float) -> int:
    """Round to the nearest even integer (yuv420p needs even dimensions)."""
    return int(round(n / 2.0)) * 2


def segment_lengths(nframes: List[int], fps: float) -> List[float]:
    """L_1 = nframes_1*fd; L_j = (nframes_j - 1)*fd for j>=2 (duplicate boundary frame dropped) (§7.5)."""
    fd = 1.0 / fps
    return [nframes[0] * fd] + [(nf - 1) * fd for nf in nframes[1:]]


def compute_offsets(nframes: List[int], fps: float, xfade: float) -> Tuple[List[float], List[float], float]:
    """Return (segment_lengths, rounded joint offsets, expected_duration) (§7.5).

    OFF_k = (sum of L_1..L_k) - k*xf, rounded to the frame grid. One offset per joint (N-1 total).
    """
    L = segment_lengths(nframes, fps)
    n = len(L)
    offsets: List[float] = []
    for k in range(1, n):
        off = sum(L[:k]) - k * xfade
        offsets.append(round(off * fps) / fps)  # snap to frame grid (§7.5/§12.5)
    expected = sum(L) - (n - 1) * xfade
    return L, offsets, expected


@dataclass
class StitchPlan:
    nframes: List[int]
    fps: float
    xfade: float                    # 0 => hard cut via concat
    ramp: float                     # 0 => full-clip correction (cascade)
    method: str                     # hybrid | mkl | quantile | none
    deflicker: bool
    target_wh: Tuple[int, int]      # chosen target (modal dims, or --target-res)
    fit: str                        # cover | contain | none
    seg_src_wh: List[Tuple[int, int]]  # each segment's native (w, h)
    seg_desqueeze: List[float]      # per-segment horizontal widen factor (1.0 = none)
    seg_has_audio: List[bool]
    audio_rate: int
    audio_layout: str


@dataclass
class GraphResult:
    filtergraph: str
    n_segments: int
    lut_input_index: dict           # seg index (>=1) -> ffmpeg input index of its LUT PNG
    offsets: List[float]
    expected_duration: float
    vmap: str = "[vout]"
    amap: str = "[aout]"


def _geometry_prefix(plan: StitchPlan, j: int) -> str:
    """AR-preserving fit-to-target + optional horizontal de-squeeze, as a comma-terminated prefix.

    Never a bare `scale=W:H`: fits use force_original_aspect_ratio; de-squeeze scales to a *wider*
    width and centre-crops back. Empty string when the segment already matches the target and needs
    no de-squeeze.
    """
    w, h = plan.target_wh
    sw, sh = plan.seg_src_wh[j]
    parts: List[str] = []

    # 1. Fit to target only when the source dimensions differ (ADDENDUM_AR §4).
    if (sw, sh) != (w, h):
        if plan.fit == "cover":
            parts.append("scale=%d:%d:force_original_aspect_ratio=increase:flags=lanczos" % (w, h))
            parts.append("crop=%d:%d" % (w, h))
        elif plan.fit == "contain":
            parts.append("scale=%d:%d:force_original_aspect_ratio=decrease:flags=lanczos" % (w, h))
            parts.append("pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black" % (w, h))
        # 'none' => mismatch already aborted upstream; no scale emitted.

    # 2. Horizontal de-squeeze: widen by `wx`, then centre-crop back to W (vertical untouched).
    wx = plan.seg_desqueeze[j]
    if abs(wx - 1.0) > 1e-6:
        parts.append("scale=%d:%d:flags=lanczos" % (_even(w * wx), h))
        parts.append("crop=%d:%d" % (w, h))

    return (",".join(parts) + ",") if parts else ""


def _video_common(plan: StitchPlan, j: int) -> str:
    # Fixed order: geometry -> fps -> format -> setsar=1 -> settb=AVTB.
    # setsar=1 on EVERY branch (ADDENDUM_AR §4/§8). settb=AVTB LAST: the fps filter resets the
    # timebase to 1/fps, so a settb placed before it is overridden and the joint xfade then sees
    # mismatched timebases (§12.1) — this deviates from ADDENDUM_AR §4's literal ordering, which is
    # not viable on this ffmpeg, while still satisfying §8 ("ends with setsar=1 before settb").
    return "%sfps=%s,format=yuv420p,setsar=1,settb=AVTB" % (_geometry_prefix(plan, j), _num(plan.fps))


def _video_branches(plan: StitchPlan, lut_index: dict) -> List[str]:
    parts: List[str] = []
    for j in range(len(plan.nframes)):
        common = _video_common(plan, j)
        if j == 0:
            parts.append("[0:v]%s[v0];" % common)
            continue
        # j>=1: drop the duplicated boundary frame (§7.5).
        head = "[%d:v]trim=start_frame=1,setpts=PTS-STARTPTS,%s" % (j, common)
        if plan.method == "none" or j not in lut_index:
            parts.append("%s[v%d];" % (head, j))
        elif plan.ramp > 0:
            # split -> corrected via haldclut, then xfade back to native over `ramp` (§7.5).
            parts.append("%s,split=2[o%d][r%d];" % (head, j, j))
            parts.append("[o%d][%d:v]haldclut[c%d];" % (j, lut_index[j], j))
            parts.append("[c%d][r%d]xfade=transition=fade:duration=%s:offset=0,settb=AVTB[v%d];"
                         % (j, j, _num(plan.ramp), j))
        else:
            # cascade: full-clip correction, no ramp.
            parts.append("%s[pre%d];" % (head, j))
            parts.append("[pre%d][%d:v]haldclut[v%d];" % (j, lut_index[j], j))
    return parts


def _video_joints(plan: StitchPlan, offsets: List[float]) -> List[str]:
    n = len(plan.nframes)
    parts: List[str] = []
    if plan.xfade == 0:
        ins = "".join("[v%d]" % j for j in range(n))
        parts.append("%sconcat=n=%d:v=1:a=0[vjoined];" % (ins, n))
    else:
        prev = "[v0]"
        for k in range(1, n):
            out = "[vjoined]" if k == n - 1 else "[vj%d]" % k
            parts.append("%s[v%d]xfade=transition=fade:duration=%s:offset=%.6f,settb=AVTB%s;"
                         % (prev, k, _num(plan.xfade), offsets[k - 1], out))
            prev = out
    if plan.deflicker:
        parts.append("[vjoined]deflicker=size=25[vout];")
    else:
        parts.append("[vjoined]null[vout];")
    return parts


def _audio_branches(plan: StitchPlan, lengths: List[float]) -> List[str]:
    parts: List[str] = []
    fd = 1.0 / plan.fps
    rate, layout = plan.audio_rate, plan.audio_layout
    for j in range(len(plan.nframes)):
        if not plan.seg_has_audio[j]:
            # Substitute exact-length silence so the audio graph stays uniform (§7.1).
            parts.append("anullsrc=r=%d:cl=%s,atrim=0:%.6f,asetpts=PTS-STARTPTS[a%d];"
                         % (rate, layout, lengths[j], j))
            continue
        base = "[%d:a]aresample=%d,aformat=sample_fmts=fltp:channel_layouts=%s" % (j, rate, layout)
        if j == 0:
            parts.append("%s,asetpts=PTS-STARTPTS[a0];" % base)
        else:
            # Trim exactly one video-frame duration to match the dropped video frame (§7.5/§12.2).
            parts.append("%s,atrim=start=%.9f,asetpts=PTS-STARTPTS[a%d];" % (base, fd, j))
    return parts


def _audio_joints(plan: StitchPlan) -> List[str]:
    n = len(plan.nframes)
    parts: List[str] = []
    if plan.xfade == 0:
        ins = "".join("[a%d]" % j for j in range(n))
        parts.append("%sconcat=n=%d:v=0:a=1[ajoined];" % (ins, n))
    else:
        prev = "[a0]"
        for k in range(1, n):
            out = "[ajoined]" if k == n - 1 else "[aj%d]" % k
            parts.append("%s[a%d]acrossfade=d=%s%s;" % (prev, k, _num(plan.xfade), out))
            prev = out
    parts.append("[ajoined]anull[aout];")
    return parts


def build_graph(plan: StitchPlan) -> GraphResult:
    n = len(plan.nframes)
    if n < 2:
        raise ValueError("need at least 2 segments")

    lengths, offsets, expected = compute_offsets(plan.nframes, plan.fps, plan.xfade)

    # LUT PNG inputs follow the N segment inputs, one per corrected segment (segs 1..N-1), in order.
    lut_index: dict = {}
    if plan.method != "none":
        nxt = n
        for j in range(1, n):
            lut_index[j] = nxt
            nxt += 1

    parts: List[str] = []
    parts += _video_branches(plan, lut_index)
    parts += _audio_branches(plan, lengths)
    parts += _video_joints(plan, offsets)
    parts += _audio_joints(plan)

    return GraphResult(
        filtergraph="".join(parts),
        n_segments=n,
        lut_input_index=lut_index,
        offsets=offsets,
        expected_duration=expected,
    )
