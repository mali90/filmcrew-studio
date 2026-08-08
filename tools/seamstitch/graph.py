"""Pure filter_complex builder + offset math (§7.5, patched by ADDENDUM_AR §4).

No ffmpeg, no I/O — inputs are probed metadata + options, outputs are the graph string, the ffmpeg
input ordering (segments, then one LUT PNG per corrected segment), the rounded joint offsets and the
expected output duration. Kept side-effect free so the offset math is unit-testable without ffmpeg.

Continuity is per joint (`StitchPlan.seg_match`), so one timeline can carry both chained joints
(duplicated boundary frame dropped, colour matched) and scene cuts (nothing dropped, no match),
each with its own crossfade length (`StitchPlan.xfades`).

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


def segment_lengths(nframes: List[int], fps: float,
                    drop_first: Optional[List[bool]] = None) -> List[float]:
    """L_1 = nframes_1*fd; L_j = (nframes_j - 1)*fd when segment j's first frame duplicates its
    predecessor's last one, else nframes_j*fd (§7.5).

    `drop_first[j]` is that per-segment continuation flag (entry 0 is unused). Default: every joint
    is a chained continuation — the original §7.5 rule. The duplicated boundary frame only EXISTS at
    a real continuation; dropping one at a scene cut would throw away a frame of real content.
    """
    fd = 1.0 / fps
    if drop_first is None:
        drop_first = [False] + [True] * (len(nframes) - 1)
    return [nframes[0] * fd] + [((nf - 1) if drop_first[j] else nf) * fd
                                for j, nf in enumerate(nframes[1:], start=1)]


def resolve_xfades(xfades: List[float], fps: float) -> List[float]:
    """Promote a per-joint xfade of 0 to one frame duration.

    ffmpeg's `xfade` filter rejects duration=0, and a 1-frame dissolve is visually a hard cut, so a
    "cut this joint" request inside an xfade chain becomes the shortest legal fade. A GLOBAL
    `--xfade 0` takes the concat path instead and never reaches here.
    """
    fd = 1.0 / fps
    return [fd if x == 0 else float(x) for x in xfades]


def compute_offsets(nframes: List[int], fps: float, xfades,
                    drop_first: Optional[List[bool]] = None) -> Tuple[List[float], List[float], float]:
    """Return (segment_lengths, rounded joint offsets, expected_duration) (§7.5).

    OFF_k = (sum of L_1..L_k) - (sum of xf_1..xf_k), rounded to the frame grid. One offset per joint
    (N-1 total). `xfades` is either a single value used for every joint or a per-joint list; with a
    single value this is exactly the original `sum(L[:k]) - k*xf`.
    """
    L = segment_lengths(nframes, fps, drop_first)
    n = len(L)
    xf = [float(x) for x in xfades] if isinstance(xfades, (list, tuple)) else [float(xfades)] * (n - 1)
    if len(xf) != n - 1:
        raise ValueError("need %d xfade value(s) for %d segments, got %d" % (n - 1, n, len(xf)))
    offsets: List[float] = []
    for k in range(1, n):
        off = sum(L[:k]) - sum(xf[:k])
        offsets.append(round(off * fps) / fps)  # snap to frame grid (§7.5/§12.5)
    expected = sum(L) - sum(xf)
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
    # Per-joint continuity, one entry per SEGMENT: seg_match[j] is True when segment j's first frame
    # duplicates segment j-1's last one (a chained continuation), False at a scene cut. seg_match[0]
    # is always False (no predecessor). It doubles as `drop_first` — only a continuation has a
    # duplicated frame to drop — and gates colour matching, which is meaningless across a cut.
    # None => every joint is a continuation (the original behaviour).
    seg_match: Optional[List[bool]] = None
    # Per-joint crossfade seconds (N-1 entries). None => `xfade` at every joint.
    xfades: Optional[List[float]] = None

    def __post_init__(self) -> None:
        n = len(self.nframes)
        if self.seg_match is None:
            self.seg_match = [False] + [True] * (n - 1)
        if len(self.seg_match) != n:
            raise ValueError("seg_match needs %d entries (one per segment), got %d" % (n, len(self.seg_match)))
        self.seg_match = [False] + [bool(m) for m in self.seg_match[1:]]

        if self.xfades is None:
            self.xfades = [self.xfade] * (n - 1)
        if len(self.xfades) != n - 1:
            raise ValueError("xfades needs %d entries (one per joint), got %d" % (n - 1, len(self.xfades)))
        self.xfades = [float(x) for x in self.xfades]
        if self.xfade != 0:
            self.xfades = resolve_xfades(self.xfades, self.fps)


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
        # j>=1: drop the duplicated boundary frame (§7.5) — but only at a chained continuation. At a
        # scene cut there is no duplicate, and trimming would drop a frame of real content.
        head = ("[%d:v]trim=start_frame=1,setpts=PTS-STARTPTS,%s" % (j, common)) if plan.seg_match[j] \
            else ("[%d:v]%s" % (j, common))
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
                         % (prev, k, _num(plan.xfades[k - 1]), offsets[k - 1], out))
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
        if j == 0 or not plan.seg_match[j]:
            parts.append("%s,asetpts=PTS-STARTPTS[a%d];" % (base, j))
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
            parts.append("%s[a%d]acrossfade=d=%s%s;" % (prev, k, _num(plan.xfades[k - 1]), out))
            prev = out
    parts.append("[ajoined]anull[aout];")
    return parts


def build_graph(plan: StitchPlan) -> GraphResult:
    n = len(plan.nframes)
    if n < 2:
        raise ValueError("need at least 2 segments")

    lengths, offsets, expected = compute_offsets(plan.nframes, plan.fps, plan.xfades, plan.seg_match)

    # LUT PNG inputs follow the N segment inputs, one per corrected segment, in order. A scene-cut
    # joint gets no LUT (nothing to match to), so it also claims no input slot — this must stay in
    # step with the LUTs actually handed to render.build_ffmpeg_args.
    lut_index: dict = {}
    if plan.method != "none":
        nxt = n
        for j in range(1, n):
            if not plan.seg_match[j]:
                continue
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
