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
- no per-shot character squeeze — the whole job is one rich prompt, sent uncapped (no provider
  documents a prompt-length limit; `SEEDANCE_PROMPT_MAX_BYTES` clamps it only if you set one)

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
- **Seedance on Segmind** — the same two models at roughly **half fal's rate**. Segmind bills **per
  job in credits** rather than per generated second, but publishes the equivalent per-second rate for
  each resolution — see [Segmind: about half fal's rate](#segmind-about-half-fals-rate) just below.

### Segmind: about half fal's rate

Segmind publishes a per-second rate for both Seedance models and for its Topaz upscale, so those
backends are estimated like any other. The figures below are the **16:9** column checked on
2026-08-10 — the same 16:9-derived convention the fal rows use. 9:16 is identical; the other ratios
differ by under 3%.

- **Seedance 2.0 on Segmind** (`seedance-2.0@segmind`):

  | Resolution | ≈ $/second | 15s job |
  |---|---|---|
  | 480p (default) | $0.0703 | ≈ $1.05 |
  | 720p | $0.1512 | ≈ $2.27 |
  | 1080p | $0.34 | ≈ $5.10 |
  | 4k | $1.3721 | ≈ $20.58 |

- **Seedance 2.5 on Segmind** (`seedance-2.5@segmind`), **720p by default** like its fal twin:

  | Resolution | ≈ $/second | 15s job |
  |---|---|---|
  | 480p | $0.1065 | ≈ $1.60 |
  | 720p (default) | $0.2389 | ≈ $3.58 |

  Segmind publishes **no 1080p and no 4k tier for 2.5** — those two rates are the whole table, so
  pinning a higher resolution is refused rather than estimated at a tier that does not exist. Turning
  audio generation on does **not** change the price. A request carrying **video references** bills a
  ~40% cheaper video-to-video tier ($0.0637/s at 480p, $0.1429/s at 720p); the estimate does not model
  that discount, so it reads high rather than low for those runs.

- **Segmind's Topaz upscale** — **$0.125 per second, flat**, billed on the **input** video's duration.
  Segmind publishes this one rate and no per-target breakdown, so `UPSCALE_TARGET_RESOLUTION` changes
  what you get, not what you pay. (fal's Topaz is tiered instead — see below — and lands at $0.08/s
  for this app's default 9:16 shape, so it is the cheaper of the two there.)

- **fal's Topaz upscale** — **tiered by the OUTPUT frame**: $0.01/s up to 720p, $0.02/s for
  720p–1080p, **$0.08/s above 1080p**. The default 9:16 shape lands in that top tier: lifting a 480p
  vertical clip to a 1080 short side delivers a **1080×1920** frame, and fal bills the 1920 (a real
  invoice for a 15s clip came to ≈ $1.28). A **landscape** clip lifted the same way is 1920×1080 and
  bills at $0.02/s — the same upscale, a quarter of the money, because the frame is not as tall.
  Where the estimate cannot measure the source it quotes the top tier deliberately: a cautious quote
  costs less trust than a surprise bill. The tier boundary for portrait output is **inferred from
  that invoice, not documented by fal** — `web/server/lib/prices.json` records the reasoning so a
  future invoice can correct it.

Comparing like for like, Segmind is about half fal's price for the same model (fal 2.0: $0.135/$0.3024;
fal 2.5: $0.2205/$0.4730). That gap is real, not a typo — it is worth re-checking on the model's own
page (`segmind.com/models/<slug>/pricing`) before committing to a long run rather than assumed stale.

These are **estimates, not invoices**. Segmind bills in credits, and every finished Segmind job
reports its actual cost and your remaining credit balance, which are logged and recorded in the run's
`prompts.json` — that is the number that actually left your account.

### The lowest-cost setup, priced

Three choices decide most of a bill, and each has a cheapest answer in the tables above. The `.env`
lines live in [PROVIDERS.md](PROVIDERS.md#the-lowest-cost-setup-segmind-renders-fal-upscales); this is
why they are the cheap ones.

| Leg | The cheap answer | Why, per the tables above |
|---|---|---|
| **Planner** | a CLI whose vendor already covers you | Planning bills LLM usage — never free on our side, and nothing in this repo prices it. A CLI planner bills through that CLI's own sign-in: a plan you already pay for, or a free tier the vendor publishes for it (Google publishes one for the Gemini CLI). Quotas are the vendor's to state. |
| **Render** | `seedance-2.0@segmind` at 480p | The lowest per-second rate on file: Segmind bills about half fal's for the same model, and 2.0 at 480p is the cheaper of its two models' default tiers. |
| **Upscale** | fal.ai, picked at approve | fal tiers by the output frame ($0.01 / $0.02 / $0.08 per second); Segmind is $0.125 per second flat. Even fal's dearest tier — the one the default 9:16 shape lands in — is under that flat rate. |

Three things keep this from being a law. Rates move, and these are a July/August 2026 snapshot.
fal's portrait tier boundary is **inferred from one real invoice**, not documented by fal —
`web/server/lib/prices.json` records the reasoning, and a future invoice can correct it. And the two
Topaz jobs are not the same product: Segmind honours `UPSCALE_TARGET_RESOLUTION`, a 4k target fal's
factor plan never reaches, so above 1080p you are comparing different deliveries. The approve card
quotes both vendors live on your own cut — compare there rather than trusting this row.

Rendering small and upscaling is not automatically cheaper than rendering big, either: compare the
combined cost against a native 1080p render for your own clip lengths, as **The cheap Seedance path**
below says.

### Keep costs down

- **Start from [the lowest-cost setup](#the-lowest-cost-setup-priced)** — planner, render provider
  and upscale vendor, each at the cheapest answer these tables support.
- On a **long, multi-job plan**, test with **`--probe`** first — it renders only the **first job**
  and skips the final stitch, so you judge the direction for a fraction of the full price.
  Probes exist *only* on multi-job plans: a short single-job video renders whole either way, so
  there is no probe to offer — at the economical default resolutions the full render IS the cheap
  test (`--probe` on a single-job spec is refused; `engine --render --probe` falls back to the
  full render with a warning if the plan comes out single-job). If you've pinned
  `SEEDANCE_RESOLUTION` above 480p, drop it back for a genuinely cheap single-job test render.
- If a probe gave you a take you like, finish it for **free** with
  `npm run assemble -- --from runs/<run-id>` (no re-render). A probe clip is low-res, so add `--upscale`
  for higher quality, or do a full `npm run render` to regenerate at full resolution. One caveat, and
  it is the expensive one: `UPSCALE_ENABLED=true` in your `.env` means "as if `--upscale` had been
  typed", and that covers everything you finish from a terminal — the stitch as much as the render —
  so that free finish is no longer free. Topaz runs on every clip in the take that is still under
  1080p, and a probe's clips usually are. How far under depends on the backend, and the two answer
  differently:
  - **Seedance** probes ride the cheap 480p tier (`SEEDANCE_PROBE_RESOLUTION` /
    `SEEDANCE25_PROBE_RESOLUTION`, both `480p` by default), so every clip is a paid Topaz job.
  - **Kling** — the default backend — has no resolution knob that reaches the endpoint: fal's Kling o3
    endpoint takes no resolution parameter, so whatever `KLING_RESOLUTION` says is never sent, and a
    probe comes out at whatever the endpoint renders natively (~720p on the default `o3/standard`,
    1080p on `o3/pro`). Those knobs above do nothing here, so on a standard Kling probe every clip is
    a paid Topaz job too, and only `o3/pro` escapes it.

  Either way the test is the clip against the target, not the knob: anything that already clears the
  target is skipped without an upload or a charge. The target is 1080p unless you set
  `UPSCALE_TARGET_RESOLUTION`, which only Segmind's Topaz reads — at `4k` a 1080p clip no longer
  clears it, so it is uploaded and billed. (The web app is unaffected: it pins the flag off for every
  child that could act on it — every job it queues, plus the one it spawns directly — bar two that
  cannot spend on an upscale at all, the doctor button and `mint-voice`; it upscales at approve,
  where it is priced first.)
- **The cheap Seedance path**: set `SEEDANCE_RESOLUTION=480p` (or `SEEDANCE25_RESOLUTION=480p` for
  2.5, which otherwise renders 720p) and render with `--upscale` — Topaz lifts each sub-1080p clip to
  ~1080p before the stitch. Compare the combined cost against a native 1080p render for your clip
  lengths before adopting it.
- Only add **`--upscale`** when you're happy with the result — it now really upscales **every
  sub-1080p clip** (one Topaz job per clip), which is real extra spend on probe/480p renders.
- **Leave `UPSCALE_TARGET_RESOLUTION` at `1080p`.** It applies to Segmind's Topaz, whose published
  rate is **flat per input second** — so `4k` does not change the estimate, even though it is 4× the
  pixels and a far heavier job. What Segmind's credits actually charge for it is the vendor's
  business, not this table's, so check the balance if you turn it up; nothing derives it for you, and
  4k only ever happens because you asked. `UPSCALE_PROVIDER` (default `auto`) upscales wherever the
  run rendered, which is the fewest moving parts — but after a Segmind render that is Segmind's flat
  rate; `UPSCALE_PROVIDER=fal` buys the tiered one (see
  [The lowest-cost setup, priced](#the-lowest-cost-setup-priced)). The web app asks at approve and
  shows both figures, so this line governs terminal finishes.
- **A re-render that "fixes this take" is not a cheaper re-render.** On the Segmind backends the
  dialog lets you re-send the clip's own seed so an edited prompt lands as a change to *that*
  footage — it costs exactly what a fresh take costs, and buys likelihood of landing, not a discount
  ([how it works](PROVIDERS.md#fix-this-take-vs-a-fresh-take-segmind-seed-control)).

> `npm run init` connects your keys and can run a small test render of the bundled example to
> confirm everything works end-to-end.
