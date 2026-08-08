"""ffprobe helpers — one VideoInfo per segment (§7.1)."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def _clean(v: Optional[str]) -> Optional[str]:
    """Normalise ffprobe's 'unknown'/'N/A'/'' placeholders to None."""
    if v is None:
        return None
    s = str(v).strip()
    if s == "" or s.lower() in ("unknown", "n/a", "und"):
        return None
    return s


def _run_json(args: list) -> dict:
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffprobe failed: %s\n%s" % (" ".join(args), r.stderr))
    return json.loads(r.stdout or "{}")


def parse_fps(rate: Optional[str]) -> float:
    """Parse ffprobe rational rate strings ('24/1', '30000/1001') to float fps."""
    s = _clean(rate)
    if not s:
        return 0.0
    if "/" in s:
        n, d = s.split("/", 1)
        d = float(d)
        return float(n) / d if d else 0.0
    return float(s)


@dataclass
class VideoInfo:
    path: Path
    width: int
    height: int
    fps: float
    nframes: int
    pix_fmt: str
    color_range: Optional[str]
    color_space: Optional[str]
    color_primaries: Optional[str]
    color_transfer: Optional[str]
    has_audio: bool
    sample_rate: Optional[int]
    channel_layout: Optional[str]
    sar: Optional[str] = None   # sample aspect ratio, e.g. "1:1" (None => square/unspecified)
    dar: Optional[str] = None   # display aspect ratio, e.g. "9:16"

    @property
    def duration(self) -> float:
        return self.nframes / self.fps if self.fps else 0.0

    @property
    def dar_value(self) -> float:
        """Display aspect ratio W/H as a float (from SAR*W/H; defaults to square pixels)."""
        num, den = 1, 1
        if self.sar and ":" in self.sar:
            a, b = self.sar.split(":", 1)
            try:
                num, den = int(a), int(b)
            except ValueError:
                num, den = 1, 1
        sar = num / den if den else 1.0
        return (self.width * sar) / self.height if self.height else 0.0


def probe(path, ffprobe: str = "ffprobe") -> VideoInfo:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)

    v = _run_json([
        ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets",
        "-show_entries",
        "stream=width,height,r_frame_rate,avg_frame_rate,pix_fmt,color_range,"
        "color_space,color_primaries,color_transfer,nb_read_packets,nb_frames,"
        "sample_aspect_ratio,display_aspect_ratio",
        "-show_entries", "format=duration",
        "-of", "json", str(path),
    ])
    streams = v.get("streams", [])
    if not streams:
        raise RuntimeError("no video stream in %s" % path)
    s = streams[0]

    fps = parse_fps(s.get("r_frame_rate")) or parse_fps(s.get("avg_frame_rate"))
    if not fps:
        raise RuntimeError("could not determine fps for %s" % path)

    # Frame count: prefer counted packets, then nb_frames, then duration*fps (§7.1).
    nframes: Optional[int] = None
    for key in ("nb_read_packets", "nb_frames"):
        raw = _clean(s.get(key))
        if raw is not None:
            try:
                nframes = int(raw)
                break
            except ValueError:
                pass
    if nframes is None:
        dur = float(_clean(v.get("format", {}).get("duration")) or 0.0)
        nframes = int(round(dur * fps))
    if nframes <= 0:
        raise RuntimeError("non-positive frame count for %s" % path)

    a = _run_json([
        ffprobe, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channel_layout,channels",
        "-of", "json", str(path),
    ])
    astreams = a.get("streams", [])
    has_audio = bool(astreams)
    sample_rate: Optional[int] = None
    channel_layout: Optional[str] = None
    if has_audio:
        a0 = astreams[0]
        sr = _clean(a0.get("sample_rate"))
        sample_rate = int(sr) if sr else None
        channel_layout = _clean(a0.get("channel_layout"))
        if not channel_layout:
            ch = _clean(a0.get("channels"))
            channel_layout = {"1": "mono", "2": "stereo"}.get(ch or "2", "stereo")

    return VideoInfo(
        path=path,
        width=int(s["width"]),
        height=int(s["height"]),
        fps=fps,
        nframes=nframes,
        pix_fmt=_clean(s.get("pix_fmt")) or "yuv420p",
        color_range=_clean(s.get("color_range")),
        color_space=_clean(s.get("color_space")),
        color_primaries=_clean(s.get("color_primaries")),
        color_transfer=_clean(s.get("color_transfer")),
        has_audio=has_audio,
        sample_rate=sample_rate,
        channel_layout=channel_layout,
        sar=_clean(s.get("sample_aspect_ratio")),
        dar=_clean(s.get("display_aspect_ratio")),
    )
