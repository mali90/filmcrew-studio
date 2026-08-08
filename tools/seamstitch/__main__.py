"""seamstitch CLI (§6, patched by ADDENDUM_AR). `python -m seamstitch SEG1 SEG2 [SEG3 ...] -o OUT`."""
from __future__ import annotations

import argparse
import glob
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import frames as fr
from . import graph as gr
from . import loopwrap as lw
from . import lut as lu
from . import render as rd
from . import verify as vf
from .probe import VideoInfo, probe

# De-squeeze safety cap: a measured horizontal widen beyond this is treated as a bad measurement.
DESQUEEZE_MAX = 1.05


def _log(msg: str) -> None:
    print("seamstitch: %s" % msg, file=sys.stderr)


def _natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def _resolve_segments(raw: List[str]) -> List[Path]:
    if len(raw) == 1:
        hits = sorted(glob.glob(raw[0]), key=_natural_key)
        if len(hits) >= 2:
            _log("resolved glob -> %s" % ", ".join(Path(h).name for h in hits))
            return [Path(h) for h in hits]
    return [Path(p) for p in raw]


def _check_ffmpeg(ffmpeg: str, ffprobe: str) -> None:
    for tool in (ffmpeg, ffprobe):
        if shutil.which(tool) is None:
            raise SystemExit("error: '%s' not found on PATH. Install ffmpeg >= 5.0." % tool)
    out = subprocess.run([ffmpeg, "-hide_banner", "-version"], capture_output=True, text=True).stdout
    m = re.search(r"ffmpeg version n?(\d+)\.", out)
    if m and int(m.group(1)) < 5:
        raise SystemExit("error: ffmpeg >= 5.0 required (found %s)." % out.splitlines()[0])


def _choose_target(infos: List[VideoInfo], target_res: Optional[str]) -> Tuple[int, int]:
    """Target dims: --target-res if given, else the MODAL (w,h) across segments (ADDENDUM_AR §4)."""
    if target_res:
        m = re.match(r"^\s*(\d+)\s*[xX]\s*(\d+)\s*$", target_res)
        if not m:
            raise SystemExit("error: --target-res must be WxH, e.g. 1080x1920")
        return int(m.group(1)), int(m.group(2))
    counts = Counter((i.width, i.height) for i in infos)
    # Most common dims; ties break toward the first segment's dims.
    best = max(counts.items(), key=lambda kv: (kv[1], kv[0] == (infos[0].width, infos[0].height)))
    return best[0]


def _distortion(target: Tuple[int, int], src: Tuple[int, int]) -> float:
    """d = (W_out*H_src)/(H_out*W_src); d<1 => a bare force-to-target would squeeze horizontally (§2)."""
    (w, h), (sw, sh) = target, src
    return (w * sh) / (h * sw) if (h and sw) else 1.0


def _extract_boundaries(infos: List[VideoInfo], tmp: Path, ffmpeg: str) -> List[Tuple[Path, Path]]:
    """Per joint j->j+1: (last frame of seg j, first frame of seg j+1). Shared by de-squeeze + LUTs."""
    out: List[Tuple[Path, Path]] = []
    for j in range(1, len(infos)):
        last_prev = fr.extract_last_frame(infos[j - 1].path, tmp / ("last_%d.png" % (j - 1)), ffmpeg)
        first_j = fr.extract_first_frame(infos[j].path, tmp / ("first_%d.png" % j), ffmpeg)
        out.append((last_prev, first_j))
    return out


def _measure_desqueeze(boundaries: List[Tuple[Path, Path]], mode: str) -> List[float]:
    """Per-segment horizontal widen factor. seg0 is the reference (1.0). Modes: off | auto | <float>."""
    n = len(boundaries) + 1
    if mode == "off":
        return [1.0] * n
    if mode != "auto":
        try:
            factor = float(mode)
        except ValueError:
            raise SystemExit("error: --desqueeze must be off, auto, or a number (e.g. 1.005)")
        return [1.0] + [factor] * (n - 1)

    # auto: measure per-joint horizontal anisotropy (sx/sy) from the boundary frames and accumulate
    # relative to seg0, widening each segment by that ratio to restore an isotropic match. Trust the
    # measurement only when BOTH axes are cleanly resolved (same gate as geometry_joint) so a noisy or
    # sy-unmeasured fit can't push real content off-frame or mistake an isotropic zoom for a squeeze
    # (review findings 4, 5). Only widen (crop-based, can't narrow).
    widen = [1.0] * n
    cumulative_aniso = 1.0
    for j, (last_prev, first_j) in enumerate(boundaries, start=1):
        est = vf.estimate_scale(fr.load_rgb(last_prev), fr.load_rgb(first_j))
        if vf.scale_is_trustworthy(est):
            aniso = est["sx"] / est["sy"]                # >1 => seg_j horizontally squeezed vs its predecessor
        else:
            aniso = 1.0
            _log("de-squeeze auto: segment %d measurement not trustworthy (n_x=%d res_x=%.2f n_y=%d res_y=%.2f)"
                 " — no correction" % (j + 1, est["n_x"], est["res_x"], est["n_y"], est["res_y"]))
        cumulative_aniso *= aniso
        # cumulative<1 means this segment is STRETCHED vs seg0; crop-based de-squeeze can't narrow it, so
        # the correction clamps to 1.0 and a later squeezed segment can retain residual anisotropy (finding 6).
        if cumulative_aniso < 1.0 - 1e-6:
            _log("de-squeeze auto: segment %d cumulative anisotropy %.4f < 1 (stretched vs seg0) — cannot widen;"
                 " a following squeezed joint may keep residual anisotropy" % (j + 1, cumulative_aniso))
        wx = max(1.0, cumulative_aniso)
        if wx > DESQUEEZE_MAX:
            _log("warning: measured de-squeeze %.4f for segment %d exceeds cap %.3f (tiles n_x=%d) — clamping"
                 % (wx, j + 1, DESQUEEZE_MAX, est["n_x"]))
            wx = DESQUEEZE_MAX
        widen[j] = wx
        if aniso != 1.0 or wx != 1.0:
            _log("de-squeeze auto: segment %d sx=%.5f sy=%.5f aniso=%.5f -> widen x%.5f (%.2f%%)"
                 % (j + 1, est["sx"], est["sy"], aniso, wx, (wx - 1) * 100))
    return widen


def _build_plan(infos: List[VideoInfo], args, target: Tuple[int, int], seg_desqueeze: List[float]) -> gr.StitchPlan:
    fps = float(args.fps) if args.fps else infos[0].fps
    w, h = target
    fd = 1.0 / fps

    for i, info in enumerate(infos):
        src = (info.width, info.height)
        d = _distortion(target, src)
        if src != (w, h):
            _log("warning: segment %d: %dx%d (SAR %s, DAR %.4f) != target %dx%d (DAR %.4f), d=%.4f — %s-fit"
                 % (i + 1, info.width, info.height, info.sar or "1:1", info.dar_value, w, h, w / h, d, args.fit))
            if args.fit == "none":
                raise SystemExit("error: segment %d dimensions differ from target and --fit none was set" % (i + 1))
            if abs(d - 1.0) > 0.08:
                raise SystemExit("error: segment %d d=%.4f is >8%% off target framing — refusing to crop/pad that much"
                                 % (i + 1, d))
        if abs(info.fps - fps) > 1e-6:
            _log("warning: segment %d is %.4f fps, retiming to %.4f" % (i + 1, info.fps, fps))
        if info.nframes * fd < 2 * args.xfade + fd:
            raise SystemExit("error: segment %d too short (%.3fs) for xfade %.3fs (needs >= 2*xfade + 1 frame)"
                             % (i + 1, info.nframes * fd, args.xfade))

    audio_rate, audio_layout = 48000, "stereo"
    for info in infos:
        if info.has_audio:
            audio_rate = info.sample_rate or 48000
            audio_layout = info.channel_layout or "stereo"
            break

    ramp = float(args.ramp)
    if ramp > 0:
        lengths = gr.segment_lengths([i.nframes for i in infos], fps)
        max_ramp = min(lengths[j] - args.xfade for j in range(1, len(lengths)))
        if ramp > max_ramp:
            _log("warning: clamping ramp %.3f -> %.3f (L_j - xfade)" % (ramp, max_ramp))
            ramp = max(0.0, max_ramp)

    return gr.StitchPlan(
        nframes=[i.nframes for i in infos],
        fps=fps,
        xfade=float(args.xfade),
        ramp=ramp,
        method=args.method,
        deflicker=bool(args.deflicker),
        target_wh=(w, h),
        fit=args.fit,
        seg_src_wh=[(i.width, i.height) for i in infos],
        seg_desqueeze=seg_desqueeze,
        seg_has_audio=[i.has_audio for i in infos],
        audio_rate=audio_rate,
        audio_layout=audio_layout,
    )


def _bake_luts(infos: List[VideoInfo], plan: gr.StitchPlan, boundaries: List[Tuple[Path, Path]],
               tmp: Path, ffmpeg: str, verbose: bool) -> dict:
    """Build per-segment colour transforms + bake one LUT PNG per corrected seg (reuses boundary frames)."""
    if plan.method == "none":
        return {}
    identity = tmp / "hald_identity.png"
    lut_paths: dict = {}
    prev_f: lu.Transform = lambda frame: frame
    for j in range(1, len(infos)):
        last_prev_png, first_j_png = boundaries[j - 1]
        last_prev = fr.load_rgb(last_prev_png)
        first_j = fr.load_rgb(first_j_png)
        mad = fr.luma_mad(last_prev, first_j)
        if mad > 35:
            _log("warning: boundary frames for joint %d->%d differ a lot (luma MAD %.1f) — check segment order"
                 % (j, j + 1, mad))
        elif verbose:
            _log("joint %d->%d boundary luma MAD %.2f" % (j, j + 1, mad))
        ref = last_prev if plan.ramp > 0 else prev_f(last_prev)
        f_j = lu.build_transform(first_j, ref, plan.method)
        lut_paths[j] = lu.bake_hald_clut(f_j, identity, tmp / ("lut_%d.png" % j), ffmpeg)
        prev_f = f_j
    return lut_paths


def _probe_duration(path: Path, ffprobe: str) -> Optional[float]:
    r = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def _fit_action(info: VideoInfo, target: Tuple[int, int], fit: str, wx: float) -> str:
    parts = []
    if (info.width, info.height) != target:
        parts.append("%s-fit" % fit)
    if abs(wx - 1.0) > 1e-6:
        parts.append("de-squeeze x%.4f" % wx)
    return ", ".join(parts) or "none"


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="seamstitch", description="Seam-invisible stitcher for chained AI video segments.")
    p.add_argument("segments", nargs="+", help="2+ input segments in order, or a single glob (natural-sorted)")
    p.add_argument("-o", "--output", required=True, type=Path)
    p.add_argument("--xfade", type=float, default=0.25, help="video+audio crossfade seconds per joint (0 = hard cut)")
    p.add_argument("--ramp", type=float, default=2.0, help="seconds to ease colour correction back to native (0 = cascade)")
    p.add_argument("--method", choices=["hybrid", "mkl", "quantile", "none"], default="hybrid")
    p.add_argument("--fit", choices=["cover", "contain", "none"], default="cover",
                   help="AR-preserving fit for dimension mismatches: cover=scale-up+crop, contain=scale-down+pad, none=error")
    p.add_argument("--target-res", default=None, help="override target resolution WxH (default: modal segment dims)")
    p.add_argument("--desqueeze", default="off",
                   help="correct a baked-in horizontal squeeze: off | auto (measure) | <factor> (e.g. 1.005)")
    p.add_argument("--loop", action="store_true",
                   help="make the output loop seamlessly: colour-match + crossfade the last->first wrap "
                        "(a single input video is loop-wrapped directly)")
    p.add_argument("--deflicker", action="store_true")
    p.add_argument("--crf", type=int, default=17)
    p.add_argument("--preset", default="slow")
    p.add_argument("--audio-bitrate", default="192k")
    p.add_argument("--fps", type=float, default=None, help="override target fps (default: first segment's)")
    p.add_argument("--temp-dir", type=Path, default=None)
    p.add_argument("--keep-temp", action="store_true")
    p.add_argument("--verify", action="store_true", help="run the seam metric + geometry gate; non-zero exit on FAIL")
    p.add_argument("--dry-run", action="store_true", help="print plan + ffmpeg args + graph; render nothing")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--ffprobe", default="ffprobe")
    args = p.parse_args(argv)

    _check_ffmpeg(args.ffmpeg, args.ffprobe)

    seg_paths = _resolve_segments(args.segments)
    for sp in seg_paths:
        if not sp.exists():
            raise SystemExit("error: segment not found: %s" % sp)

    # Single input + --loop: seamless loop-wrap of an already-assembled video (no stitch needed).
    if len(seg_paths) == 1:
        if not args.loop:
            raise SystemExit("error: need at least 2 segments (or one video with --loop)")
        tmp = Path(args.temp_dir) if args.temp_dir else Path(tempfile.mkdtemp(prefix="seamstitch_"))
        tmp.mkdir(parents=True, exist_ok=True)
        try:
            dur = lw.make_seamless_loop(seg_paths[0], args.output, args.xfade, args.method, args.crf,
                                        args.preset, args.audio_bitrate, tmp, args.ffmpeg, args.ffprobe,
                                        args.verbose, args.dry_run)
            if not args.dry_run:
                out_dur = _probe_duration(args.output, args.ffprobe)
                _log("wrote %s (seamless loop, %.3fs)" % (args.output, out_dur if out_dur is not None else (dur or 0.0)))
            return 0
        finally:
            if not args.keep_temp and args.temp_dir is None:
                shutil.rmtree(tmp, ignore_errors=True)
            elif args.keep_temp:
                _log("kept temp dir %s" % tmp)

    infos = [probe(sp, args.ffprobe) for sp in seg_paths]
    target = _choose_target(infos, args.target_res)

    tmp = Path(args.temp_dir) if args.temp_dir else Path(tempfile.mkdtemp(prefix="seamstitch_"))
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        # Boundary frames feed colour-match (LUTs) and de-squeeze measurement; skip the decodes if neither
        # is active (finding 7).
        need_boundaries = (args.desqueeze != "off") or (args.method != "none")
        boundaries = _extract_boundaries(infos, tmp, args.ffmpeg) if need_boundaries else []
        seg_desqueeze = (_measure_desqueeze(boundaries, args.desqueeze)
                         if args.desqueeze != "off" else [1.0] * len(infos))
        plan = _build_plan(infos, args, target, seg_desqueeze)
        graph = gr.build_graph(plan)
        lut_paths = _bake_luts(infos, plan, boundaries, tmp, args.ffmpeg, args.verbose)
        stitched = (tmp / "stitched.mp4") if args.loop else args.output   # loop-wrap needs a temp to read+write
        ff_args = rd.build_ffmpeg_args(
            seg_paths, lut_paths, graph, stitched, infos[0],
            args.crf, args.preset, args.audio_bitrate, args.ffmpeg,
        )

        if args.dry_run or args.verbose:
            _log("plan: fps=%s  target=%dx%d  fit=%s  method=%s  xfade=%s  ramp=%s  loop=%s  deflicker=%s"
                 % (plan.fps, target[0], target[1], plan.fit, plan.method, plan.xfade, plan.ramp, args.loop, plan.deflicker))
            for i, info in enumerate(infos):
                _log("  segment %d: %s  %dx%d  SAR=%s  DAR=%.4f  d=%.4f  action=%s"
                     % (i + 1, info.path.name, info.width, info.height, info.sar or "1:1",
                        info.dar_value, _distortion(target, (info.width, info.height)),
                        _fit_action(info, target, plan.fit, seg_desqueeze[i])))
            _log("joint offsets: " + ", ".join("%.6f" % o for o in graph.offsets)
                 + "   expected duration: %.6f s" % graph.expected_duration)
            _log("LUT pngs: " + (", ".join("seg%d=%s" % (j, lut_paths[j].name) for j in sorted(lut_paths)) or "(none)"))
            print("\n# ffmpeg command:\n" + rd.format_command(ff_args), file=sys.stderr)
            print("\n# filter_complex:\n" + graph.filtergraph.replace(";", ";\n"), file=sys.stderr)

        if args.dry_run:
            if args.loop:
                lw.make_seamless_loop(stitched, args.output, args.xfade, args.method, args.crf, args.preset,
                                      args.audio_bitrate, tmp, args.ffmpeg, args.ffprobe, args.verbose, True)
            return 0

        rd.render(ff_args, verbose=args.verbose)

        exit_code = 0
        if args.verify:
            # Verify the internal seams on the stitched result (before any loop-wrap reorders the timeline).
            seam = vf.verify(stitched, graph.offsets, plan.xfade, plan.fps, target[0], target[1], args.ffmpeg)
            print("\nseam verification:\n" + vf.format_report(seam), file=sys.stderr)
            geom = vf.geometry_gate(stitched, graph.offsets, plan.xfade, plan.fps, target[0], target[1], args.ffmpeg)
            print("\ngeometry gate:\n" + vf.format_geometry_report(geom), file=sys.stderr)
            seam_fail = any(not r.passed for r in seam)
            geom_fail = any(r.verdict == "FAIL" for r in geom)
            if seam_fail or geom_fail:
                _log("VERIFY FAILED (%s%s%s)"
                     % ("seam" if seam_fail else "", " + " if seam_fail and geom_fail else "",
                        "geometry" if geom_fail else ""))
                exit_code = 2
            else:
                _log("VERIFY PASSED")

        if args.loop:
            lw.make_seamless_loop(stitched, args.output, args.xfade, args.method, args.crf, args.preset,
                                  args.audio_bitrate, tmp, args.ffmpeg, args.ffprobe, args.verbose, False)
            _log("applied seamless loop-wrap -> %s" % args.output)
        else:
            out_dur = _probe_duration(args.output, args.ffprobe)
            if out_dur is not None:
                fd = 1.0 / plan.fps
                delta = abs(out_dur - graph.expected_duration)
                _log("output duration %.3fs (expected %.3fs, delta %.3fs) %s"
                     % (out_dur, graph.expected_duration, delta, "OK" if delta <= fd + 0.05 else "WARN"))

        _log("wrote %s" % args.output)
        return exit_code
    finally:
        if not args.keep_temp and args.temp_dir is None:
            shutil.rmtree(tmp, ignore_errors=True)
        elif args.keep_temp:
            _log("kept temp dir %s" % tmp)


if __name__ == "__main__":
    sys.exit(main())
