# Limits & cost

Every limit below belongs to a **model on a provider**, not to the tool. Each backend id names both
(`kling-o3@fal`, `seedance-2.0@fal`, `seedance-2.5@fal`, `seedance-2.0@segmind`,
`seedance-2.5@segmind`; the old `kling`/`seedance` spellings still work), and the planner is given
the caps of the backend the run will actually render on. The same model can differ between vendors —
the per-backend matrix in [PROVIDERS.md](PROVIDERS.md#provider--model-matrix) is the full list.

## Kling's hard limits (per single generation — a "job")

- at most **6 shots**
- at most **15 seconds** total
- at most **512 characters** per shot prompt
- at most **7 reference images**
- at most **1 starred cast member** (each one costs reference-image slots)

If you ask for a longer video, the tool automatically **splits** it into several jobs and stitches
them back together in order (with a faded audio seam and last-frame continuity) — you don't do anything.

## Seedance 2.0's hard limits (per single generation — a "job")

- **4 to 15 seconds** total (note the 4s *minimum* — the planner merges shorter jobs)
- at most **9 reference images** (one slot is reserved for the seam frame on chained jobs)
- at most **3 voice-ref clips**, combined ≤ 15s (they're auto-trimmed to fit)
- at most **2 starred cast members**
- no per-shot character squeeze — the whole job is one rich prompt (byte-clamped at ~5000)

## Seedance 2.5's hard limits (per single generation — a "job")

- **4 to 30 seconds** total — twice 2.0's window, so long videos split into fewer jobs
- at most **4 starred cast members**
- **480p or 720p only** (default 720p); 1080p comes from the approve-time upscale, not the render
- reference budget differs by provider: **on fal, 50 references combined** across images, audio and
  video together; **on Segmind, per-kind** — 30 images, 10 audio, 10 video
- at most **10 voice-ref clips**, combined ≤ 30s. On Segmind each clip must also be **at least 2
  seconds**; a shorter one is a hard rejection on an already-paid submit, so it is dropped with a
  warning rather than shipped

The same splitting/stitching applies to every model. A plan is written and validated against **its own backend's**
caps rather than one hardcoded set, so a spec planned for one model can exceed another's window —
re-plan (or revise) after switching instead of assuming every spec renders anywhere. Over-cap casts
and unsupported aspect ratios are refused **before any LLM or render spend**, not after.

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
- **Seedance 2.5 on fal** — same token formula, higher rate, and it renders at **720p by default**
  rather than 480p, so an unchanged plan costs noticeably more per second than 2.0 does:

  | Resolution | ≈ $/second | 15s job |
  |---|---|---|
  | 480p | $0.2205 | ≈ $3.31 |
  | 720p (default) | $0.473 | ≈ $7.10 |

  Its longer 30s job window means *fewer* jobs for a long video, not a cheaper one — you pay per
  generated second either way. `SEEDANCE25_RESOLUTION=480p` is the cheap setting, and
  `--probe` rides `SEEDANCE25_PROBE_RESOLUTION` (480p).
- **Segmind** — billed **per job in credits**, not per generated second, and it does **not publish** a
  public rate for `seedance-2.0`, `seedance-2.5` or `topaz-video-upscale` — see
  [Segmind: no rate on file](#segmind-no-rate-on-file) just below.

### Segmind: no rate on file

Segmind does not publish a public per-second rate for either Seedance model or its Topaz upscale, and
this project **will not invent one or borrow fal's**. So for `seedance-2.0@segmind`,
`seedance-2.5@segmind` and Segmind upscaling the estimator returns **no figure** — the UI shows an
amber **"Price not set"** note and **warns without blocking**.

**These renders still cost real money.** Check the current price on the model's own page
(`segmind.com/models/<slug>/pricing`) before committing to a long run, and watch the credit balance:
every finished Segmind job reports its cost and your remaining credits, which are logged and recorded
in the run's `prompts.json`. Filling a rate in is a one-line edit to `web/server/lib/prices.json` —
each Segmind row carries a `PRICE CHECK REQUIRED` note.

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
- **The cheap Seedance path**: set `SEEDANCE_RESOLUTION=480p` (or `SEEDANCE25_RESOLUTION=480p` for
  2.5, which otherwise renders 720p) and render with `--upscale` — Topaz lifts each sub-1080p clip to
  ~1080p before the stitch. Compare the combined cost against a native 1080p render for your clip
  lengths before adopting it.
- Only add **`--upscale`** when you're happy with the result — it now really upscales **every
  sub-1080p clip** (one Topaz job per clip), which is real extra spend on probe/480p renders.
- **Leave `UPSCALE_TARGET_RESOLUTION` at `1080p`.** It applies to Segmind's Topaz, whose `4k` setting
  is 4× the pixels and roughly 4× the bill; nothing derives it for you, so 4k only ever happens
  because you asked. `UPSCALE_PROVIDER` (default `auto`) upscales wherever the run rendered, which
  also avoids paying a second vendor to move the file.

> `npm run init` connects your keys and can run a small test render of the bundled example to
> confirm everything works end-to-end.
