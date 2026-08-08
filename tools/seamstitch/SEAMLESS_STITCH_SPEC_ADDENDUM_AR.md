# ADDENDUM to SEAMLESS_STITCH_SPEC.md — Aspect-Ratio Bug (§7.1 patch)

> **How to use:** keep this next to `SEAMLESS_STITCH_SPEC.md` and prompt:
> *"Apply `SEAMLESS_STITCH_SPEC_ADDENDUM_AR.md`. It supersedes §7.1 normalisation and adds a geometry gate to `verify.py`. Re-run the §10 test plan plus the new geometry cases."*

---

## 1. Observed defect

In a rendered output (1080×1920, SAR 1:1, 24 fps, 475 frames), content in the later part of the video is **horizontally compressed by ~1.2 % relative to the opening segment**, vertical geometry unchanged. Measured by aligning matched content across the loop point:

| test | result |
|---|---|
| best horizontal scale `sx` | **1.012 – 1.014** (later content must be widened to match) |
| best vertical scale `sy` | **1.000** |
| NCC uncorrected → corrected | 0.846 → **0.966** |
| per-tile x-displacement | linear in x, flat in y, residual **0.33 px** |

A tile displacement that is linear in x and constant in y is the signature of a **global horizontal scale**, i.e. an aspect-ratio squeeze introduced by the pipeline — not generative variation, not colour work, not the crossfade.

## 2. Root cause

Spec §7.1 says a segment whose dimensions differ from segment 1 gets `scale=W:H:flags=lanczos`. Bare `scale=W:H` **forces exact pixel dimensions and ignores aspect ratio**, and does not normalise SAR. Two ways that bites:

1. **Different display aspect ratio.** The generator emits jobs on its own resolution buckets (multiples of 16/32). `1080` is not a multiple of 16, so a job conditioned on a 1080×1920 frame can come back as e.g. `1088×1920`, `720×1264`, or `832×1456`. Forcing those to 1080×1920 squeezes horizontally by `(1080/W_src)/(1920/H_src)`. Buckets in that family give 0.7 %–1.6 % — the measured 1.2 % sits right in it.
2. **Non-square SAR silently dropped.** `scale` preserves the input SAR; nothing in §7.1 issues `setsar=1`, so a segment with SAR ≠ 1:1 gets flattened at mux time.

Distortion factor: `d = (W_out · H_src) / (H_out · W_src)`. `d < 1` ⇒ narrower.

## 3. Diagnose first

```bash
for f in seg*.mp4; do
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,sample_aspect_ratio,display_aspect_ratio \
    -of csv=p=0 "$f" | sed "s|^|$f: |"
done
```

If any row differs from the others, that segment is the one being squeezed.

## 4. Required change — §7.1 normalisation (supersedes the old rule)

**Never distort.** Replace the bare `scale` with one of two AR-preserving policies, selected by a new flag:

```
--fit {cover,contain,none}   default cover
```

**`cover` (default, correct for chained generation)** — scale up until the frame is covered, then centre-crop. No bars, no distortion; loses ~`|1−d|` of one axis (≈ 1 % here, invisible).

```
scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,
crop={W}:{H},
setsar=1
```

**`contain`** — fit inside and pad. No distortion, but adds visible bars; only for deliberate mixed-AR sources.

```
scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos,
pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,
setsar=1
```

**`none`** — error out on any DAR mismatch instead of scaling.

Additional rules:

- Emit `setsar=1` on **every** branch, including segment 1 and segments that need no scaling. This is the cheap insurance against failure mode 2.
- Both `crop` and `pad` must round to even offsets for yuv420p — use `crop={W}:{H}:(iw-{W})/2:(ih-{H})/2` and let ffmpeg floor, or compute even offsets in Python.
- Ordering inside each branch is fixed: `scale → crop/pad → setsar=1 → settb=AVTB → fps → format=yuv420p`.
- **Warn loudly, per segment**, with the numbers: `segment 3: 720x1264 (DAR 0.5696) != target 1080x1920 (DAR 0.5625) — cover-fit will crop 1.2% off height`.
- **Abort** if `|d − 1| > 0.08` — that is a genuinely different framing, not a bucket rounding, and silently cropping 8 % is worse than stopping.
- Choose the target from the **modal** dimensions across segments, not blindly from segment 1, so one odd job doesn't force every other segment through a resample. Log the chosen target and which segments are being refitted.
- Add `--target-res WxH` to override.

## 5. Better: stop resampling at all (upstream note for README)

The resample is only needed because the jobs disagree. Two habits remove the problem at source:

- Pick a **native bucket resolution** for the whole video (one the model returns unmodified — verify empirically with a probe job) and generate every segment at it. `1088×1920` and `720×1280` are far safer targets than `1080×1920`.
- When extracting the last frame to condition the next job, **hand it over at the segment's native dimensions**. Resizing that PNG to 1080×1920 invites the model to snap back to a bucket and re-introduce the mismatch.

If every segment then reports identical `width,height,sample_aspect_ratio`, no branch gets a `scale` at all and the geometry is bit-exact across joints.

## 6. New geometry gate in `verify.py`

Colour-only verification (§9) passes a squeezed render — it must not. Add a geometry check, run per joint:

1. Take frame `F_before` = last frame before the joint's fade window, `F_after` = first frame after it. In chained generation these are near-identical content.
2. Convert to gray, downscale the long edge to ≤ 480, compute gradient magnitude.
3. Grid into 5×6 tiles. Per tile, find the integer x-shift in ±8 px maximising NCC; keep tiles with NCC > 0.35.
4. Least-squares fit `dx = k·(x − x_centre) + b` over kept tiles. Implied horizontal scale `sx = 1/(1+k)`.
5. Repeat transposed for `sy`.
6. **FAIL** if `|sx/sy − 1| > 0.004` (0.4 %) with fit residual std < 1.0 px. Report as `joint 3: horizontal squeeze 1.2% (sx=0.988, sy=1.000)`.
7. If fewer than 8 tiles survive the NCC threshold, report `INCONCLUSIVE`, not PASS.

Loose residual + large `k` means the frames genuinely differ; tight residual + large `k` means the pipeline distorted geometry. Only the latter fails.

## 7. New test cases (append to §10.2)

| # | Setup | Expectation |
|---|---|---|
| 9 | fixture seg03 re-encoded at `720x1264` (AR 0.5696) | `--fit none` errors; default `cover` renders with **no** squeeze; geometry gate PASSes |
| 10 | same fixture, geometry gate run against a build using the **old** bare `scale=W:H` | geometry gate **FAILs** at joint 2 reporting ≈1.2 % — proves the gate detects the regression |
| 11 | seg02 re-encoded with `-vf setsar=32/33` (non-square SAR) | output SAR 1:1 and geometry gate PASSes |
| 12 | seg03 at `1088x1920` | warns, cover-fits, PASSes |
| 13 | all segments identical dimensions | no `scale`/`crop` in the graph at all (assert on `--dry-run` output) |

Fixture variants are generated with ffmpeg from the existing `base.mp4`, e.g.
`-vf scale=720:1264:flags=lanczos` and `-vf scale=1088:1920:flags=lanczos,setsar=1`.

## 8. Acceptance additions

- [ ] `--dry-run` prints, per segment: source `WxH`, SAR, DAR, distortion factor `d`, chosen fit action.
- [ ] No filter graph ever contains a bare `scale=W:H` without `force_original_aspect_ratio`.
- [ ] Every video branch ends with `setsar=1` before `settb`.
- [ ] Geometry gate runs under `--verify` and is wired into the non-zero exit condition.
- [ ] Cases 9–13 behave as tabled; cases 1–8 still pass.
