"""seamstitch — seam-invisible stitcher for chained AI video segments.

Concatenate N image-conditioned video segments (Seedance-style chaining: the last frame of
segment i seeds the first frame of segment i+1) into a single video with visually and audibly
invisible joints. Fixes the per-segment exposure / white-balance drift with a baked Hald CLUT
colour match ramped back to native grade, drops the duplicated boundary frame, and crossfades
video + audio in a single encode.

Implements SEAMLESS_STITCH_SPEC.md. Public library entry points live in `graph` (pure filter
graph + offset math) and `verify` (seam metric); the CLI is `python -m seamstitch`.
"""
from __future__ import annotations

__version__ = "0.1.0"
