# Stitching: how the clips become one video

A video longer than a model's window is rendered as several **jobs** and joined locally with ffmpeg.
That join is free — no API call, no spend — but *how* it joins matters, because a multi-job render is
generated as a chain: each job is seeded with the previous clip's **last frame**, so the two clips
overlap by one duplicated frame and drift slightly in exposure and white balance.

There are two paths. Both are pure local ffmpeg.

## The two paths

**Concat (always available).** Every clip is scaled to the canvas and hard-cut to the next, with a
short audio fade across each seam. On chained clips this shows: a small lighting "pop" at the join,
plus a 1-frame motion hitch from the duplicated frame. This is the fallback, and it always works.

**Seamless (`tools/seamstitch`, needs python3 + numpy + pillow).** For each *chained* joint it:

1. compares the two boundary frames — near-identical content, so matching them is well-posed;
2. bakes the correction into a Hald CLUT and applies it to the incoming clip, easing back to that
   clip's own grade over `STITCH_RAMP` seconds so corrections never cascade down the timeline;
3. drops the duplicated boundary frame (and trims exactly one frame of audio to match, or the two
   drift apart by ~42 ms per joint at 24 fps);
4. crossfades video and audio over `STITCH_XFADE` seconds.

Scene cuts in the same timeline stay cuts: nothing is dropped, no colour is matched across them, and
they get their own (usually zero) crossfade. One master can carry both.

The stitcher writes the video; a second ffmpeg pass **copies** that video untouched and rebuilds only
the audio (optional music bed, EBU R128 loudness). There is still exactly one video encode.

## When each one fires

The seamless path needs to know **which joints are chained** — and it declines rather than guesses,
because dropping a frame at a real scene cut destroys content. It runs only when all of these hold:

- the run recorded that it chained (`chained` in `render.json`), or you said so yourself;
- python3 with numpy and pillow is importable (`npm run doctor` tells you);
- there are 2+ clips and at least one chained joint;
- every clip outlasts the crossfades on its sides plus a frame;
- every clip's **display** aspect is within 8% of the canvas (a bigger gap is a genuinely different
  framing, and cropping 8%+ off a shot is worse than a visible seam).

Anything else — including a failure mid-run — logs **one** warning naming the reason and falls back
to concat. A stitch can never be the reason a render has nothing to deliver. Set
`STITCH_SEAMLESS=force` to turn those warnings into errors instead.

Today `chained` is all-or-nothing per run, because that is how rendering works: `KLING_CHAIN_FRAMES`
seeds every job after the first. Per-joint lineage (which seams actually got their frame, which clips
were re-rendered since) is upcoming; when it lands, mixed timelines start stitching correctly with no
change here.

Driving it by hand:

```bash
npm run assemble -- --from runs/render-… --continuity 1,0,1   # joint 2 is a scene cut
npm run assemble -- --from runs/render-… --stitcher off       # force the plain concat
STITCH_ASSUME_CONTINUOUS=1 npm run assemble -- --from runs/…  # test/debug: assume every seam chains
```

## Knobs

All optional; the defaults are the tuned ones. See `.env.example`.

| Variable | Default | What it does |
|---|---|---|
| `STITCH_SEAMLESS` | `auto` | `auto` (use it when possible), `off`, `force` (fail instead of falling back) |
| `PYTHON_BIN` | `python3` | interpreter to run the stitcher with |
| `STITCH_METHOD` | `hybrid` | `hybrid` (MKL + per-channel quantile), `mkl`, `quantile`, `none` (no matching — a baseline) |
| `STITCH_XFADE` | `0.25` | crossfade seconds at a chained joint |
| `STITCH_CUT_XFADE` | `0` | ...and at a scene cut (0 becomes one frame — ffmpeg rejects a zero-length fade) |
| `STITCH_RAMP` | `2.0` | seconds easing the correction back to the clip's own grade; `0` = correct the whole clip (cascade) |
| `STITCH_FIT` | `cover` | refit for odd bucket sizes: `cover` (scale + centre-crop), `contain` (pad), `none` (error) |
| `STITCH_DESQUEEZE` | `off` | fix a squeeze baked into the pixels: `off`, `auto`, or a factor like `1.005` |
| `STITCH_VERIFY` | `warn` | `off`, `warn` (log a failed gate, keep the stitch), `strict` (fall back instead) |
| `STITCH_CRF` / `STITCH_PRESET` | `19` / `medium` | x264 quality for the stitched video |
| `STITCH_TIMEOUT_MS` | `1200000` | give up after 20 minutes |

## Reading a verify report

With `--verify`, the stitcher measures each joint on the finished file and prints two tables (and, with
`--json`, the same numbers as data).

**Seam metric** — per joint: `step` is the largest frame-to-frame luma jump inside the fade window,
`baseline` the median jump outside it, `drift` the difference in mean luma between the half-second
before and after the joint. It PASSes when `step ≤ max(2.0, 1.5·baseline)` and `drift ≤ 1.5`, on the
8-bit scale. A failing `drift` means the grades still do not meet; a failing `step` means something
jumps at the join.

**Geometry gate** — registers matched content across the joint into tiles and fits the implied
horizontal and vertical scale. It FAILs when `sx/sy` differs from 1 by more than 0.4% with a tight fit
— the signature of an aspect-ratio squeeze. A loose fit reports `INCONCLUSIVE`, not PASS: the frames
genuinely differ (real motion), so the measurement says nothing either way. INCONCLUSIVE is normal and
is not a failure.

Under the default `STITCH_VERIFY=warn` a failed gate is logged and the stitch is still used — it is
still far better than a hard cut. `strict` falls back to concat instead.

## Better than fixing it afterwards: render on a native bucket

The refit machinery exists because generators return their own resolution buckets. You can make it
unnecessary:

- Pick a **bucket resolution the model returns unmodified** for the whole video and generate every
  job at it. `1088x1920` and `720x1280` are far safer targets than `1080x1920` (1080 is not a multiple
  of 16, so a job conditioned on a 1080-wide frame often comes back 1088 wide).
- When handing the last frame to the next job, pass it at the segment's **native** dimensions.
  Resizing that PNG invites the model to snap back to a bucket and re-introduce the mismatch.

If every clip then reports identical `width,height,sample_aspect_ratio`, no clip gets scaled at all and
the geometry is bit-exact across every joint.

## Provenance

`tools/seamstitch` is vendored from the author's own private repo; `tools/seamstitch/PROVENANCE.md`
records where from, what was changed here, and how it was validated. The design lives in
`tools/seamstitch/SEAMLESS_STITCH_SPEC.md` and its aspect-ratio addendum.
