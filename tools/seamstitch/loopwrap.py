"""Seamless loop-wrap: make a video loop with no seam at the last->first frame boundary.

For a looping video the wrap (tail -> head) is just another joint. This applies the same treatment as
the internal joints — colour-match the tail's grade to the head, then crossfade — using the reorder
trick so the output's first and last frames are ADJACENT source frames (truly seamless):

    body = V[df : N-df]                       (the video minus the crossfade frames at each end)
    wrap = xfade(colour_matched(V[N-df:N]), V[0:df])
    output = concat(body, wrap)               (length N-df; starts at V[df], ends at V[df-1])

The head V[0:df] is consumed into the wrap, so the loop restarts ~`xfade` seconds in — negligible for
a near-static opening, and the seam itself is frame-adjacent.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import List, Optional

from . import frames as fr
from . import lut as lu
from .graph import _num
from .probe import probe


def _fmt(x: float) -> str:
    return "%.6f" % float(x)


def make_seamless_loop(video, out, xfade: float, method: str, crf: int, preset: str, audio_bitrate: str,
                       tmp: Path, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
                       verbose: bool = False, dry_run: bool = False) -> Optional[float]:
    info = probe(video, ffprobe)
    n, fps, w, h = info.nframes, info.fps, info.width, info.height
    df = max(1, int(round(xfade * fps)))
    if n <= 2 * df + 2:
        raise SystemExit("error: video too short (%d frames) for a %.3fs loop crossfade" % (n, xfade))
    d = df / fps  # crossfade duration snapped to the frame grid

    # Colour-match the tail (loop end) toward the head (loop start) so the wrap has no grade pop.
    lut_path: Optional[Path] = None
    if method != "none":
        head_png = fr.extract_first_frame(video, tmp / "lw_head.png", ffmpeg)
        tail_png = fr.extract_last_frame(video, tmp / "lw_tail.png", ffmpeg)
        mad = fr.luma_mad(fr.load_rgb(tail_png), fr.load_rgb(head_png))
        if mad > 35:
            print("seamstitch: warning: loop tail/head differ a lot (luma MAD %.1f) — not a clean loop?" % mad,
                  file=sys.stderr)
        elif verbose:
            print("seamstitch: loop tail->head luma MAD %.2f" % mad, file=sys.stderr)
        f = lu.build_transform(fr.load_rgb(tail_png), fr.load_rgb(head_png), method)  # src=tail, ref=head
        lut_path = lu.bake_hald_clut(f, tmp / "lw_identity.png", tmp / "lw_lut.png", ffmpeg)

    # Reorder wrap: body = V[df:N-df]; the tail V[N-df:N] (colour-matched to the head) crossfades into
    # the head V[0:df], so the extension's garden-end dissolves into the original's garden-start over
    # `xfade` seconds. Output starts at V[df] and ends inside the head region — the loop point lands in
    # the original's continuous opening, so the take-mismatch seam is hidden in the dissolve, not at the
    # cut. (Head and tail are genuinely different takes, so the dissolve is what makes it read as one.)
    vcommon = "fps=%s,format=yuv420p,setsar=1,settb=AVTB" % _num(fps)
    v: List[str] = [
        "[0:v]split=3[vb][vt][vh];",
        "[vb]trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS,%s[body];" % (df, n - df, vcommon),
        "[vt]trim=start_frame=%d,setpts=PTS-STARTPTS,%s[tail];" % (n - df, vcommon),
        "[vh]trim=start_frame=0:end_frame=%d,setpts=PTS-STARTPTS,%s[head];" % (df, vcommon),
    ]
    v.append("[tail][1:v]haldclut[tailc];" if lut_path is not None else "[tail]null[tailc];")
    v.append("[tailc][head]xfade=transition=fade:duration=%s:offset=0,settb=AVTB[wrap];" % _num(d))
    v.append("[body][wrap]concat=n=2:v=1:a=0[vout];")

    a: List[str] = []
    if info.has_audio:
        rate = info.sample_rate or 48000
        layout = info.channel_layout or "stereo"
        af = "aresample=%d,aformat=sample_fmts=fltp:channel_layouts=%s" % (rate, layout)
        a = [
            "[0:a]asplit=3[ab][at][ah];",
            "[ab]%s,atrim=start=%s:end=%s,asetpts=PTS-STARTPTS[bodya];" % (af, _fmt((df + 1) / fps), _fmt((n - df) / fps)),
            "[at]%s,atrim=start=%s,asetpts=PTS-STARTPTS[taila];" % (af, _fmt((n - df) / fps)),
            "[ah]%s,atrim=start=0:end=%s,asetpts=PTS-STARTPTS[heada];" % (af, _fmt((df + 1) / fps)),
            "[taila][heada]acrossfade=d=%s[wrapa];" % _num(d),
            "[bodya][wrapa]concat=n=2:v=0:a=1[aout];",
        ]

    graph = "".join(v + a)
    args = [ffmpeg, "-y", "-i", str(video)]
    if lut_path is not None:
        args += ["-i", str(lut_path)]
    args += ["-filter_complex", graph, "-map", "[vout]"]
    if info.has_audio:
        args += ["-map", "[aout]"]
    args += ["-c:v", "libx264", "-crf", str(crf), "-preset", preset, "-pix_fmt", "yuv420p"]
    for flag, val in (("-colorspace", info.color_space), ("-color_primaries", info.color_primaries),
                      ("-color_trc", info.color_transfer), ("-color_range", info.color_range)):
        if val:
            args += [flag, val]
    if info.has_audio:
        args += ["-c:a", "aac", "-b:a", audio_bitrate]
    args += ["-movflags", "+faststart", "-shortest", str(out)]

    expected = (n - df) / fps
    if dry_run or verbose:
        import shlex
        print("seamstitch: loop-wrap: %d frames, df=%d (%.3fs xfade), colour=%s -> expected %.3fs"
              % (n, df, d, "match" if lut_path else "none", expected), file=sys.stderr)
        print("\n# ffmpeg command:\n" + " ".join(shlex.quote(x) for x in args), file=sys.stderr)
        print("\n# filter_complex:\n" + graph.replace(";", ";\n"), file=sys.stderr)
    if dry_run:
        return None

    r = subprocess.run(args)
    if r.returncode != 0:
        raise RuntimeError("loop-wrap ffmpeg failed (exit %d)" % r.returncode)
    return expected
