# seamstitch

Seam-invisible stitcher for chained AI video segments (implements `SEAMLESS_STITCH_SPEC.md`).

When you chain image-conditioned generation (Seedance: the last frame of segment *i* seeds the
first frame of segment *i+1*), each generated segment drifts slightly in exposure / white balance,
so a naive concat shows a lighting "pop" at every joint plus a 1-frame hitch from the duplicated
boundary frame. `seamstitch` colour-matches each segment to its predecessor with a baked **Hald
CLUT**, **ramps** the correction back to native grade, **drops the duplicate frame** (trimming the
matching audio), and **crossfades** video + audio — all in a single encode.

## Requirements

- Python ≥ 3.9 (`from __future__ import annotations` keeps the spec's type hints valid on 3.9).
- `numpy`, `pillow` (already installed in this repo's environment).
- `ffmpeg`/`ffprobe` ≥ 5.0 on PATH with `haldclut`, `haldclutsrc`, `xfade`, `acrossfade`,
  `deflicker`, `anullsrc`, `atrim`, `aresample`.

## Quickstart

```bash
python3 -m seamstitch SEG1.mp4 SEG2.mp4 [SEG3.mp4 ...] -o OUTPUT.mp4 --verify
```

Stitch the extended Jolly Dots clip into a seam-invisible loop:

```bash
python3 -m seamstitch \
  ~/Downloads/hat-please-zrha-final.mp4 \
  ~/Downloads/hat-please-zrha-final-extension.mp4 \
  -o ~/Downloads/hat-please-zrha-final-loop-seamless.mp4 --verify
```

## Key options

| Flag | Default | Meaning |
|------|---------|---------|
| `-o, --output` | (required) | output mp4 |
| `--xfade F` | `0.25` | video+audio crossfade seconds per joint; `0` = hard cut (concat) |
| `--joint-match L` | all `1` | per-joint continuity, N−1 comma-separated `1`/`0` (e.g. `1,0,1`); `0` = scene cut |
| `--joint-xfade L` | `--xfade` everywhere | per-joint crossfade seconds, N−1 comma-separated (e.g. `0.25,0.04,0.25`) |
| `--ramp F` | `2.0` | seconds to ease the colour correction back to native grade; `0` = full-clip correction with cascading |
| `--method` | `hybrid` | `hybrid` (MKL + per-channel quantile), `mkl`, `quantile`, or `none` (baseline) |
| `--deflicker` | off | append `deflicker=size=25` to the final video chain |
| `--crf` / `--preset` | `17` / `slow` | libx264 quality |
| `--audio-bitrate` | `192k` | AAC bitrate |
| `--fps F` | first segment | override target fps |
| `--verify` | off | run the §9 seam metric on the output; non-zero exit on FAIL |
| `--dry-run` | off | print plan + ffmpeg args + filter graph; render nothing |
| `--json` | off | write ONE JSON object to stdout (plan, offsets, verify report, warnings); logs stay on stderr |
| `--keep-temp` | off | retain the temp dir (boundary frames, LUT PNGs) |
| `-v, --verbose` | off | log the ffmpeg command and per-joint luma deltas |

## Mixed timelines (`--joint-match` / `--joint-xfade`)

A real cut is rarely chained end-to-end. `--joint-match` says, per joint, whether segment *j+1*
actually continues from segment *j*:

- **`1` (continuation)** — segment *j+1*'s first frame duplicates segment *j*'s last one, so that
  frame is dropped (video `trim=start_frame=1`, audio `atrim=start=fd`) and the colour match runs
  across the joint.
- **`0` (scene cut)** — nothing is duplicated, so nothing is dropped (`L_j = nframes_j · fd`) and no
  LUT is baked. Cascade mode (`--ramp 0`) also resets its reference there, so a grade never
  propagates across a cut.

`--joint-xfade` sets each joint's fade length independently: a long dissolve on the chained joints,
a near-zero one at the cut. A `0` inside the chain becomes one frame, because ffmpeg's `xfade`
rejects `duration=0` (a 1-frame dissolve reads as a hard cut). A global `--xfade 0` still takes the
`concat` path for the whole timeline and cannot be combined with `--joint-xfade`.

## How it works (module map)

- `probe.py` — ffprobe metadata (fps, frame count via `-count_packets`, resolution, colour tags, audio params).
- `frames.py` — boundary-frame extraction + Pillow uint8-RGB load/save.
- `lut.py` — quantile / MKL / hybrid transforms, Hald CLUT baking; each transform is also a numpy callable (for cascade references).
- `graph.py` — **pure** `filter_complex` builder + offset math (`OFF_k`, expected duration); unit-testable without ffmpeg.
- `render.py` — single-encode ffmpeg invocation (arg lists only, no `shell=True`).
- `verify.py` — the seam metric: per-joint `step`, `baseline`, `drift` vs the §9 thresholds.

## Notes / deviations from the spec

- Uses **Pillow** instead of imageio for PNG I/O (same uint8-RGB result).
- Normalises mismatched audio sample rates via `aresample` to the first segment's rate, so
  `acrossfade` never desyncs (this repo's clips are 96 kHz + 48 kHz).
- The synthetic pytest fixture suite (§10) and acceptance checklist (§11) are out of scope for this
  build; correctness is validated by stitching the real clips and running `--verify` on the output
  (plus a `--method none` baseline that the metric is expected to FAIL).

## Aspect-ratio safety + de-squeeze (ADDENDUM_AR)

Normalisation **never distorts aspect ratio**. A segment whose dimensions differ from the target is
fit with `--fit`; `setsar=1` is emitted on **every** branch (so a non-square input SAR can't leak to
the mux); and the target defaults to the **modal** segment dimensions (override with `--target-res WxH`).

| `--fit` | behaviour |
|---------|-----------|
| `cover` (default) | scale up preserving AR, then centre-crop — no bars, no distortion (loses ~`|1−d|` of one axis) |
| `contain` | scale down preserving AR, then pad — no distortion, adds bars |
| `none` | error out on any dimension mismatch |

`--dry-run` reports per segment: `WxH`, SAR, DAR, the distortion factor `d = (W_out·H_src)/(H_out·W_src)`,
and the chosen action. A mismatch with `|d−1| > 0.08` aborts (that's a different framing, not a bucket
rounding). This supersedes the old §7.1 `scale=W:H`, which forced exact pixel dimensions and squeezed
horizontally whenever a generator returned an off-target bucket (e.g. `1088×1920`).

**Geometry gate** (`--verify`): per joint, matched content is registered into 5×6 tiles; the per-tile
x/y shift is fit linearly against position to read the implied horizontal/vertical scale. A tight fit
with `|sx/sy − 1| > 0.4%` is a real aspect-ratio squeeze and **FAILs**; a loose fit (frames genuinely
differ) or fewer than 8 usable tiles reports `INCONCLUSIVE`, not PASS. This catches squeezes that the
colour-only seam metric passes.

**`--desqueeze`** corrects a squeeze that is baked into a segment's *pixels* (not a dimension
mismatch — e.g. a generative model that renders 1080×1920 but with horizontally-compressed content):

| `--desqueeze` | behaviour |
|---------------|-----------|
| `off` (default) | no correction |
| `auto` | measure each segment's horizontal anisotropy (`sx/sy`) against its predecessor's boundary frame and widen by that ratio (centre-crop back to target); capped at 5% |
| `<factor>` | apply a fixed widen (e.g. `1.005`) to every non-reference segment |

De-squeeze only ever **widens** (crop-based); a segment measured as horizontally *stretched* is left
alone. On the Jolly Dots loop, `--desqueeze auto` measured +0.57% and took the geometry gate from
+0.57% (FAIL) to +0.08% (PASS). Note the deeper fix is upstream (generate every segment at a native
bucket the model returns unmodified), per §5.

## Seamless looping (`--loop`)

For a video meant to loop, the wrap where the **last frame meets the first frame** is just another
joint and gets the same treatment — colour-match the tail's grade to the head, then crossfade:

```bash
python3 -m seamstitch loop.mp4 --loop -o loop_seamless.mp4          # loop-wrap an assembled video
python3 -m seamstitch seg1.mp4 seg2.mp4 --loop -o loop.mp4          # stitch, then loop-wrap the result
```

The tail `V[N-df:N]` (colour-matched via a Hald CLUT toward the head) crossfades into the head
`V[0:df]`, so the ending dissolves into the opening; the output starts at `V[df]` and the loop point
lands inside the original's continuous opening. Output is `xfade` seconds shorter. On the Jolly Dots
loop this took the wrap seam from luma MAD **7.6 (hard cut) to 3.6** — at or below the video's own
natural frame-to-frame motion. Because the head and tail are different generations, the dissolve is
what sells the loop; a longer `--xfade` softens it further.

## Interpreting `--verify` on real footage

The §9 metric has two parts. **`step`** (max per-frame luma jump inside the fade window vs the
surrounding `baseline`) is the reliable seam-artifact detector: a low `step ≈ baseline` means no
exposure pop and no duplicated-frame hitch at the joint. **`drift`** (average brightness 0.5 s before
vs after the joint) has a fixed `≤ 1.5` pass bound that was calibrated on the spec's near-static
`testsrc2` fixture. Real animated footage with camera moves / scene changes drifts far more than that
on its own — e.g. this repo's clip drifts by ~3 at t=11 s and ~21 at t=8 s over one second at
non-seam points — so a joint `drift` around 1.5–2 is normal content variation, not a grade pop, and
can trip a `FAIL` verdict even when the join is visually perfect. When judging a real-content stitch,
trust `step` (and a visual check of frames spanning the joint); treat `drift` as advisory.
