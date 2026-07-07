# Limits & cost

## Kling's hard limits (per single generation — a "job")

- at most **6 shots**
- at most **15 seconds** total
- at most **512 characters** per shot prompt
- at most **7 reference images**

If you ask for a longer video, the tool automatically **splits** it into several jobs and stitches
them back together in order (with a faded audio seam and last-frame continuity) — you don't do anything.

## Seedance's hard limits (per single generation — a "job")

- **4 to 15 seconds** total (note the 4s *minimum* — the planner merges shorter jobs)
- at most **9 reference images** (one slot is reserved for the seam frame on chained jobs)
- at most **3 voice-ref clips**, combined ≤ 15s (they're auto-trimmed to fit)
- no per-shot character squeeze — the whole job is one rich prompt (byte-clamped at ~5000)

The same splitting/stitching applies; the shared spec caps are the intersection of both backends,
so any valid spec renders on either.

## Cost 💳

The render backends are **paid, pay-as-you-go** services — **every render spends money**, and
upscaling spends more. There is no free usage.

- **fal.ai** — billed per generated second (see fal's pricing for your endpoint, standard vs pro).
  fal Topaz upscaling adds extra cost. Minting a character voice is a **one-time ≈ $0.007** per character.
- **Seedance 2.0** — also billed per generated second, and the price **scales with resolution**:
  fal charges $0.014 per 1000 tokens where tokens = height × width × seconds × 24 / 1024, so on
  the standard tier (July 2026, check fal's pricing page for current numbers):

  | Resolution | ≈ $/second | 15s job |
  |---|---|---|
  | 480p (default) | $0.14 | ≈ $2.00 |
  | 720p | $0.30 | ≈ $4.50 |
  | 1080p | $0.68 | ≈ $10.20 |

  Native 1080p Seedance costs several times Kling (fal prices Kling o3 STANDARD — the default
  endpoint — flat at ≈ $0.112/s with audio, $0.084/s without, outputting ~720p; the pro endpoint
  is 1080p at $0.14/s via FAL_KLING_ENDPOINT) — that's why the default for BOTH backends is
  **render small + Topaz
  upscale on approve** (the finished master is still 1080p). Only the **standard** endpoint is
  used; the mini/fast tiers are deliberately not supported (they drift character fidelity).
  `--probe` uses the same standard endpoint at `SEEDANCE_PROBE_RESOLUTION` (480p) and renders
  only the first job.

### Keep costs down

- On a **long, multi-job plan**, test with **`--probe`** first — it renders only the **first job**
  and skips the final stitch, so you judge the direction for a fraction of the full price.
  Probes exist *only* on multi-job plans: a short single-job video renders whole either way, so
  there is no probe to offer — at the economical default resolutions the full render IS the cheap
  test (`--probe` on a single-job spec is refused; `engine --render --probe` falls back to the
  full render with a warning if the plan comes out single-job). If you've pinned
  `SEEDANCE_RESOLUTION` above 480p, drop it back for a genuinely cheap single-job test render.
- If a probe gave you a take you like, finish it for **free** with
  `npm run assemble -- --from runs/<run-id>` (no re-render). A probe clip is low-res, so add `--upscale`
  for higher quality, or do a full `npm run render` to regenerate at full resolution.
- **The cheap Seedance path**: set `SEEDANCE_RESOLUTION=480p` and render with `--upscale` — Topaz
  lifts each sub-1080p clip to ~1080p before the stitch. Compare the combined cost against a native
  1080p render for your clip lengths before adopting it.
- Only add **`--upscale`** when you're happy with the result — it now really upscales **every
  sub-1080p clip** (one Topaz job per clip), which is real extra spend on probe/480p renders.

> `npm run init` connects your keys and can run a small test render of the bundled example to
> confirm everything works end-to-end.
