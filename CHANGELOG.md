# Changelog

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
