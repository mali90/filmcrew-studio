"""ffmpeg invocation (§7.5/§7.6). Subprocess arg lists only — never shell=True."""
from __future__ import annotations

import shlex
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

from .graph import GraphResult
from .probe import VideoInfo


def build_ffmpeg_args(
    seg_paths: List[Path],
    lut_paths_by_seg: Dict[int, Path],
    graph: GraphResult,
    output: Path,
    color: VideoInfo,
    crf: int,
    preset: str,
    audio_bitrate: str,
    ffmpeg: str = "ffmpeg",
) -> List[str]:
    """Assemble the single-encode ffmpeg argv. LUT inputs follow the segments in ascending seg order,
    matching graph.lut_input_index."""
    args: List[str] = [ffmpeg, "-y"]
    for p in seg_paths:
        args += ["-i", str(p)]
    for j in sorted(lut_paths_by_seg):
        args += ["-i", str(lut_paths_by_seg[j])]

    args += [
        "-filter_complex", graph.filtergraph,
        "-map", graph.vmap, "-map", graph.amap,
        "-c:v", "libx264", "-crf", str(crf), "-preset", preset, "-pix_fmt", "yuv420p",
    ]
    # Propagate source colour metadata when present (§7.5/§12.9).
    for flag, val in (
        ("-colorspace", color.color_space),
        ("-color_primaries", color.color_primaries),
        ("-color_trc", color.color_transfer),
        ("-color_range", color.color_range),
    ):
        if val:
            args += [flag, val]
    args += ["-c:a", "aac", "-b:a", audio_bitrate, "-movflags", "+faststart", "-shortest", str(output)]
    return args


def format_command(args: List[str]) -> str:
    return " ".join(shlex.quote(a) for a in args)


def render(args: List[str], verbose: bool = False) -> None:
    if verbose:
        print(format_command(args), file=sys.stderr)
    # Stream ffmpeg stderr straight through so progress is visible (§7.6).
    r = subprocess.run(args)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg render failed (exit %d)" % r.returncode)
