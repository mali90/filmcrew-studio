# Changelog

## Unreleased

### Added
- **Seam-invisible stitching.** A video over the model's window renders as several *chained* jobs —
  each seeded with the previous clip's last frame — and the local stitch now colour-matches every
  chained joint, drops the duplicated boundary frame (trimming one frame of audio to match) and
  crossfades, instead of hard-cutting and leaving a lighting "pop" plus a 1-frame hitch. Scene cuts
  in the same timeline stay cuts. It is pure local ffmpeg: no API call, no spend. The stitcher
  (`tools/seamstitch`, vendored — see its `PROVENANCE.md`) is extended here with per-joint continuity,
  per-joint crossfade lengths and a JSON report; the Node side adds `src/lib/seamstitch.js`,
  `src/lib/stitch-math.js` (an independent re-derivation of the offset math, used to check the
  tool's output), a `stitch` config block (`STITCH_*`), a SOFT doctor check,
  `npm run assemble -- --continuity/--stitcher`, and `stitcher`/`joints`/`matched` on cut records.
  See [docs/STITCHING.md](docs/STITCHING.md).

  It is **optional and self-disabling**: without python3 + numpy + pillow — or if anything at all
  goes wrong — assembly logs one warning and falls back to the hard-cut stitch, unchanged.
  **Today the fallback still runs for most renders**: the seamless path only fires when the run can
  say which joints are chained, which is recorded as one all-or-nothing flag. Per-joint seam lineage
  is the next piece of work; when it lands, mixed timelines start stitching seamlessly on their own.
- **Segmind is a second render provider.** Both Seedance models now render on **fal.ai or Segmind** —
  `seedance-2.0@segmind` and `seedance-2.5@segmind` join the backend list, and you only need a key
  for the provider you actually use. A **Segmind-only install needs no fal account at all**: set
  `SEGMIND_API_KEY`, `SEGMIND_UPLOAD_MODE=data-uri` and `UPSCALE_PROVIDER=segmind` and the whole path
  from idea to finished 1080p master works. Kling 3.0 Omni stays fal-only, and minting persistent
  character voices still needs `FAL_KEY` — Segmind's own voice model is not wired up, so a
  Segmind-only setup has no minted voices. The same model can differ per provider and the planner is
  told the right numbers: Seedance 2.0 renders three aspect ratios on fal and six on Segmind, takes a
  `seed` on Segmind but not on fal, and has real first/last-frame slots there (mutually exclusive
  with reference images, so a job with cast refs carries the seam frame as its last reference, exactly
  as on fal). Full matrix in [docs/PROVIDERS.md](docs/PROVIDERS.md).
- **Segmind never pays twice for the same job.** Its transport resubmits only when something proves
  nothing was queued — an error Segmind answered with, or a connection that failed before the request
  could land. Once a `request_id` exists nothing re-POSTs (that would buy a second render), and a
  submit that dies mid-flight (timeout, reset socket) stops with a message pointing at the Segmind
  console, because it may already have been accepted and billed; only the polling GETs retry. Insufficient credits, content-policy rejections and expired result
  records each get their own actionable message instead of a generic failure, and every finished job
  records its `request_id`, reported cost and remaining credits in the run's `prompts.json` sidecar.
- **Seedance 2.5 on fal** (`seedance-2.5@fal`): 4–30s jobs, 4 starred cast members, all six aspect
  ratios, 480p/720p output, `[Image1]`-style reference citations, `Shot N:` prompt syntax, a `seed`
  the endpoint actually accepts, and a 50-reference combined budget across images, audio and video.
- **Topaz upscale runs on either provider.** `UPSCALE_PROVIDER=auto|fal|segmind` (default `auto` =
  wherever the run rendered, falling back to whichever provider has a key). Segmind's Topaz takes a
  `target_resolution` (`UPSCALE_TARGET_RESOLUTION`, default `1080p`) instead of fal's factor — and its
  `target_fps` is **pinned to the probed source frame rate**, because Segmind defaults it to 60 and
  would otherwise hand back a frame-interpolated clip with motion the take never had.
- **New setup checks.** `npm run doctor` gained `segmind-key` (blocking when your default backend
  renders on Segmind, informational otherwise) and `render-assets`, which catches the one broken
  combination — `SEGMIND_UPLOAD_MODE=fal-storage` with no `FAL_KEY` — instead of letting it fail on
  the first upload of a render, and recognises the keyless `data-uri` setup as valid.
>>>>>>> c42f597 (docs: provider matrix, Segmind-only setup, CHANGELOG entry)

### Changed
- **The estimator is provider-aware, and says so when it doesn't know a price.** Seedance 2.5 on fal
  carries real rates ($0.2205/s at 480p, $0.473/s at 720p). Segmind does **not** publish a public
  per-second rate for either Seedance model or its Topaz upscale, so those rows are deliberately
  empty: the estimate comes back as unknown rather than borrowing a sibling backend's rate or
  guessing one. The UI shows an amber **"Price not set"** note and **warns without blocking** — the
  render still costs real money, the rate just isn't on file yet. A genuinely unknown *backend* still
  fails loudly, as before.
- **Home's backend picker chooses a model and a provider.** Models with more than one provider
  (Seedance 2.0 and 2.5) offer the choice; Kling shows honestly that it runs on fal only. Cast
  ceilings, aspect lists and per-model hints follow the selected pair, and switching pairs re-picks
  anything the new one can't carry — the fal 2.5 entry shows its real per-second rate, the Segmind
  entries say the rate isn't on file rather than inventing a figure.
- **Render backends are now named `<model>@<provider>`** (`kling-o3@fal`, `seedance-2.0@fal`), and a
  planned spec records that canonical id in `render_backend` whichever spelling you typed, as does
  each rendered job's `prompts.json` sidecar — so an old clip can still say which *model* made it.
  The old one-word `kling`/`seedance` names stay accepted forever — on the CLI, in `.env`, and in every spec
  or manifest already on disk — so nothing needs migrating. Planning is now told the *rendering
  model's own* caps (Seedance 2.0's 9 reference images instead of Kling's 7, its own 4–15s job
  window and its own aspect-ratio list) instead of one hardcoded set for every backend.
- **Cost estimates follow the rename.** A CLI-created run now records the canonical id in its
  `render.json`, so the web app prices `kling-o3@fal`/`seedance-2.0@fal` off the same rate rows as
  the old one-word names — including Kling's cheaper audio-off tier, which a literal name check
  would have quietly overcharged. A model/provider pair with no rate table (`kling-o3@segmind`)
  still fails loudly instead of guessing a price.
- **Seedance renders fail fast on an argument the chosen model does not accept** — an aspect ratio or
  resolution outside that model's list, more reference images than it takes, or a kind of reference
  it has no input for — instead of paying for a provider round trip to be told the same thing.
- **Starring more characters than the chosen model can carry is now rejected before any LLM spend.**
  Each model has its own cast ceiling (Kling 3.0 Omni 1, Seedance 2.0 2) because every starred
  character costs reference-image slots. Over-starring used to plan a full 8-agent spec that could
  only ever fail at the renderer; the engine now stops at the flag with a message naming the model,
  its limit and the characters you picked, and `POST /api/runs` refuses the same request before it
  queues anything. On Home, the **Starring** row states the cap ("up to 1 for Kling 3.0 Omni"),
  greys out the pills you have no room for, and switching model unstars whoever no longer fits and
  says so — the cap is now unhittable rather than explained after the fact.
- **Aspect ratios are per model.** The app now understands six numeric ratios — `16:9`, `9:16`,
  `1:1`, `4:3`, `3:4` and `21:9` — and each run may only pick from the ones its own model renders
  (Kling 3.0 Omni and Seedance 2.0 keep today's three). Home's **Aspect** control offers exactly the
  selected model's ratios and re-picks for you if a switch invalidates your choice. The stitch canvas
  shapes itself for all six, never upscaling past the source clips. `adaptive`/`auto` are deliberately
  not offered: the stitcher needs a deterministic ratio.

### Fixed
- **Finalize/upscale now uses the cut you selected**, not always the newest. In review, switching to
  an earlier cut and clicking Approve (with or without upscale) previously finalized/upscaled the
  latest take instead — the preview selection never reached the server. The previewed cut is now
  threaded into `POST /api/runs/:id/approve`, and the finalize points at that cut's master while the
  upscale runs Topaz on that cut's own render (omitting the cut still finalizes the latest, unchanged).

## 1.4.0 — 2026-07-11

### Added
- **Environments** — a reusable, purely descriptive setting (world, mood, look): create/edit an
  environment bible (`environments/<slug>.md` — a name heading plus prose, no images or voice) in the
  new **Environments** section of the Cast page, then set exactly one per idea from Home's **Set in**
  picker and the 8-agent engine anchors the plan's look to it (its world/style takes precedence over a
  starred character's own world notes). New engine flag: `--environment <name>` (an unknown environment
  fails before any LLM spend; the spec records its environment so revisions re-inject the same setting).
  `ENVIRONMENTS_DIR` is env-overridable and the web demo isolates it; a sample environment, **Neon
  City**, ships in the box.

## 1.3.0 — 2026-07-08

### Added
- **Graceful Seedance content-policy handling.** When a benign render trips ByteDance's output
  moderation (`content_policy_violation` / "Output video has sensitive content" — a common false
  positive), the run no longer dies with an opaque "No rendered clips found". The flag surfaces a
  clear, actionable message, `finishRender` names the failed job and its reason, and — per the
  no-extra-cost rule — it is **never auto-retried** (a resubmit is a fresh paid generation).
- **"Revise to pass content check"** — a content-policy render failure now offers a one-click revise
  in the web app's Attention banner that re-plans with benign rewording + Seedance prompt guidance
  (uses your LLM, **no render spend**), so the next render dodges the false positive. New endpoint
  `POST /runs/:id/revise-content-policy`.
- **Seedance 2.0 prompt guidance during planning** — for a *guaranteed* text-to-video render
  (Seedance, no cast, no reference images on disk), the planner writes director-style shot prose
  from the start (subject + one action → one camera move → a concrete sound cue; no keyword/tag
  lists), per [fal.ai's Seedance guide](https://fal.ai/learn/tools/how-to-use-seedance-2-0).
  Image-to-video (cast/reference) and Kling planning are unchanged.

### Fixed
- `runFal` now classifies a transient fal fetch race (retryable) separately from a content-policy
  flag (fail-fast) and a genuine bad-argument 422 — a momentary "timeout while fetching resource"
  no longer kills a render.

## 1.2.0 — 2026-07-07

### Added
- **Text-to-video mode** — an idea that calls for no reference image now renders from the prompt
  alone. `kling.elements` may be empty; the Casting agent attaches only references relevant to the
  idea (and none when nothing fits), and the Seedance/Kling renderers submit to the text-to-video
  endpoint with no image refs. Previously every spec was forced to carry ≥1 reference, so an
  unrelated idea pulled in whatever images happened to sit in `elements/references/`.
- **A bundled voice clip auto-registers as a staged voice** — drop `voices/<name>.mp3` and the
  character is recognized as a staged (un-minted) voice in both the engine and the Cast page, ready
  to mint. The sample cast member **Wren** now ships with a voice.

### Changed
- **Relicensed MIT → FSL-1.1-MIT** (Functional Source License — source-available; converts to MIT
  two years after each release).
- **The Claude CLI installs via Anthropic's official native script**, not npm, in the setup wizard.
- The bundled example (ocean-lighthouse) and test fixtures now star **Wren**
  (`elements/references/wren-01.png`); the old 6 MB `subject.png` was removed.
- **Get started needs only Node.js** — the browser wizard installs and validates everything else.

### Fixed
- **Homebrew-installed ffmpeg is now detected** — the web server's child PATH gains the standard
  system tool dirs (`/opt/homebrew/bin`, `~/.local/bin`, …), so a GUI/launchd-started server finds
  brew's ffmpeg for both the health check and the render stitch.
- The live planning view no longer misses a spec block on a very short plan or when a client
  connects mid-planning (spec blocks replay on SSE connect).

## 1.1.0 — 2026-07-07

### Changed
- **Renamed the project to Filmcrew Studio** (`filmcrew-studio`). The old `kling-video-agents`
  name predated Seedance support and implied a Kling-only, Kuaishou-affiliated tool; the project
  is backend-neutral (Kling 3.0 Omni **or** Seedance 2.0) and the 8-agent planning engine is the
  star. All brand strings (package name + CLI bin, README, web app title/wordmark/About, CLI
  banners, LICENSE) now read Filmcrew Studio; every Kling/Seedance **model/backend** reference
  (`--backend`, `FAL_KLING_ENDPOINT`, `RENDER_BACKEND`, the spec's `kling` field, `src/lib/fal-kling.js`)
  is unchanged. Repo moved to `github.com/mali90/filmcrew-studio` (GitHub redirects the old path).

### Added
- **Library page** — the run library is its own top-nav destination (`/library`): intent filters
  with live counts (All / Waiting on you / Complete), runs needing attention pinned above the rest
  with a one-line error hint on their cards, and per-card delete. Home keeps the create hero, the
  queue strip, and a read-only Recent row (4 newest) with a See-all link.
- **Character profiles** — first-class characters (Cast page): create/edit a subject bible
  (`profiles/<slug>.md`), link reference images (filename-prefix convention the engine already
  matches), and attach a minted voice — then optionally **star characters in an idea** and the
  8-agent engine builds the plan around exactly those profiles. New engine flag: `--cast "a,b"`
  (filters injected profiles; unknown names fail before any LLM spend; the spec records its cast
  so revisions re-inject the same characters). All cast paths (`PROFILES_DIR`,
  `ELEMENTS_REFERENCES_DIR`, `VOICES_DIR`) are env-overridable; the web demo isolates them.
- **Settings, not .env** — the Seedance render resolution (480p/720p/1080p, priced) is now a
  first-class control on the web app's Settings page; nothing in the normal flow requires
  hand-editing `.env`.
- **Web app** (`npm run web`): a localhost studio UI over the whole pipeline — first-run setup
  wizard, idea → live 8-agent planning view (agent rail + spec inspector), backend/aspect/duration
  controls, cost estimates on every paid button, per-job render monitor with live logs, review
  player with per-clip strip and take history, change requests that re-run the planning engine,
  scoped job re-renders with seam-cascade warnings, approve + optional Topaz upscale, cast
  management (references, voice minting), settings with live key validation and health checks.
  See `web/README.md`.
- `npm run revise` (`src/cli/revise.js`): revise an existing spec from director feedback — routed
  back through the owning agents (explicit `--owners` > block `--scope` > an LLM router) + QC.
- `npm run render-job` (`src/cli/render-job.js`): re-render ONE job as a new take, with seam
  chaining from a prior render (`--seam-from`) and per-take `--feedback` (Seedance director note).
- `--aspect` on `npm run engine` — plans for 16:9 / 9:16 / 1:1 and stamps it onto the spec.
- `--out-name` on `render`/`assemble` — name the `out/` master explicitly.
- `doctor --json` — machine-readable health checks (used by the web app).
- `RUNS_DIR` / `OUT_DIR` / `WORK_DIR` / `CACHE_DIR` env overrides for the working paths.

### Changed
- **Probes are multi-job-only.** A probe renders just the first job, so on a single-job plan it
  was the full render at the same price shown twice. The plan-ready screen now offers only
  **Full render** on single-job plans (the server refuses `mode: probe` with a 409), the `--probe`
  CLI flag errors on a single-job spec, and `engine --render --probe` downgrades to a full render
  with a warning when the plan comes out single-job.
- **The zero-spend demo is no longer a user-facing mode** — it never produced a real video, so
  `npm run web:demo` is gone. The mock server lives on as the dev/e2e harness
  (`web/server/dev/demo.js`, started automatically by the Playwright suite).
- **Kling renders on the o3 STANDARD endpoint by default** (~720p at $0.112/s with audio,
  $0.084/s without — ~20% under pro) — approve's optional Topaz upscale delivers the 1080p final.
  `FAL_KLING_ENDPOINT` restores the pro endpoint (native 1080p, $0.14/s). With this, Kling is now
  the cheaper backend per second.
- **Resolution pickers are gone from Settings** for both backends: renders are deliberately small
  (Kling ~720p, Seedance 480p) and full quality comes from the approve-time upscale.
  `SEEDANCE_RESOLUTION` remains as an advanced env override.
- **Masters keep their aspect.** The stitch canvas was a fixed 1080x1920 portrait (inherited from
  the original 9:16-shorts pipeline) — every 16:9 and 1:1 master was silently center-cropped into
  9:16. The canvas now takes the run's aspect shape at `VIDEO_SHORT_SIDE` scale (default 1080);
  setting BOTH `VIDEO_WIDTH`/`VIDEO_HEIGHT` remains a full explicit override. Existing runs are
  repairable for free: `npm run assemble -- --from runs/<id>/renders/<take>` re-stitches from the
  intact clips.
- **The Kling resolution setting is gone — it never did anything.** fal's Kling o3 endpoints
  accept no resolution parameter (verified against the live API schema); output is the model's
  native 1080p at a flat price. The Settings/wizard controls that pretended otherwise were
  removed and replaced with a truthful note. Seedance resolution (a real API knob) is unchanged.
- **Approve's upscale disables itself when the master is already ≥1080p** — assembly now stamps
  the delivered size (`masterShortSide` in render.json, `shortSide` on cut records), and the UI
  refuses to sell a paid no-op ("This video is already 1080p — there's nothing to upscale.").
- **Seedance defaults to 480p** (`SEEDANCE_RESOLUTION`, was 1080p). fal bills Seedance 2.0 by
  pixel-seconds, so native 1080p is ≈ $0.68/s — about twice Kling — while 480p is ≈ $0.14/s; the
  approve step's Topaz upscale still delivers a 1080p master. Set `SEEDANCE_RESOLUTION=1080p` to
  restore native rendering. Probes now use the **standard** endpoint at 480p — the mini/fast tiers
  are no longer used anywhere (they drift character fidelity). The web app's cost estimates are
  resolution-aware and reflect the configured `SEEDANCE_RESOLUTION`.
- **Specs now remember their backend.** The engine stamps `render_backend` into every spec it
  plans (and revisions preserve it), so a spec planned for Seedance renders on Seedance even when
  your `.env` default says Kling. An explicit `--backend` flag still wins.
- Revisions default their aspect context to the aspect **the spec was planned with** (previously
  the config default could contradict the spec mid-revision), and a typo'd `--scope` now errors
  instead of silently widening to a whole-spec revision.
- `render-job` merges its result into the take's `render.json` instead of clobbering it (a cascade
  renders several jobs into one take dir), and Kling re-renders warn loudly that per-render
  `--feedback` is ignored (route feedback through `revise` — Kling has no prompt budget for notes).
- **`out/` masters are never overwritten.** Repeat renders of the same title now get `-2`, `-3`, …
  suffixes (previously the newest silently clobbered the file). If you scripted around the old
  fixed name, read the `master` path from the render's JSON output instead.
- `--upscale` now Topaz-lifts **each sub-1080p clip before stitching** (previously the post-stitch
  upscale silently no-opped because assembly had already scaled the master). This makes the
  480p-render + upscale path real — and it is real per-clip spend; see `docs/COST.md`.

## Earlier
- Seedance 2.0 (fal.ai) render backend alongside Kling — `--backend kling|seedance`,
  spec `render_backend`, `RENDER_BACKEND` env; per-job prompts, prompt-pinned seam frames,
  lip-sync from minted voice clips, `--take` retake nonce. (2026-07-02)
- Complete automated test suite (node:test) + CI; fal.ai as the only render backend; AI-guided
  `npm run init` setup wizard.
