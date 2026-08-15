# Providers reference — render backend, LLM planners, voices

`npm run init` walks you through all of this interactively and validates each key live. This file is
the manual reference: the exact accounts, keys, and `.env` lines, for when you want to set them by
hand or troubleshoot.

> `.env` rules: a value goes **right after the `=` with no spaces** and **no quotes**
> (`FAL_KEY=abc123`, not `FAL_KEY = "abc123"`). No leftover `<placeholder>` brackets, no trailing
> spaces. The wizard writes these correctly for you.

---

## Render backends — fal.ai and Segmind

Rendering runs on **fal.ai** or on **Segmind**. Three video models are available across the two
providers; pick a default in `.env` or switch per run with `--backend`. You only need a key for the
provider you actually render on — a Segmind-only install never needs `FAL_KEY` (see
[Segmind-only setup](#segmind-only-setup-no-fal-account) below).

1. **fal.ai** — create an account and get a key at **https://fal.ai/dashboard/keys**
   (pay-per-second; commercial use permitted).
2. **Segmind** — create an account and get a key at **https://www.segmind.com** → Console → API
   keys. Segmind bills **per job in credits**, not per second.
3. In `.env` — set the key(s) for the provider(s) you use, and the default backend:
   ```
   FAL_KEY=paste_your_fal_key_here
   SEGMIND_API_KEY=paste_your_segmind_key_here
   RENDER_BACKEND=kling-o3@fal  # see the table below for every id
   ```

**Backend ids are `<model>@<provider>`.** A backend names the *model* and the *provider that runs
it*, which is why both Seedance models can be rendered on either vendor without a second set of
plumbing. The old one-word names **`kling`** and **`seedance`** stay accepted forever — on the CLI,
in `.env`, and in spec/manifest files already on disk — and simply resolve to `kling-o3@fal` and
`seedance-2.0@fal`. Nothing needs migrating; whichever spelling you type, the planned spec records
the canonical id in `render_backend`.

Selection precedence at render time: `--backend` flag → `render_backend` in the spec →
`RENDER_BACKEND` in `.env` → `kling-o3@fal`.

Each model carries its own caps — job window, reference-image budget, cast ceiling and aspect-ratio
list — and the planner is told *that model's* numbers, so a plan is written to the limits of the
backend it will actually render on.

### Provider × model matrix

Every renderable backend id, with the caps the planner is actually told. These figures come from the
registry in `src/lib/render-models.js` — `capsFor('<id>')` is the source of truth, and this table is
kept in step with it.

| | `kling-o3@fal` | `seedance-2.0@fal` | `seedance-2.0@segmind` | `seedance-2.5@fal` | `seedance-2.5@segmind` |
|---|---|---|---|---|---|
| Model | Kling 3.0 Omni | Seedance 2.0 | Seedance 2.0 | Seedance 2.5 | Seedance 2.5 |
| Legacy alias | `kling` | `seedance` | — | — | — |
| Job window | 1–15s (up to 6 storyboard segments) | 4–15s | 4–15s | 4–30s | 4–30s |
| Starred cast (max) | 1 | 2 | 2 | 4 | 4 |
| Aspect ratios | `16:9` `9:16` `1:1` | `16:9` `9:16` `1:1` | `16:9` `9:16` `1:1` `4:3` `3:4` `21:9` | `16:9` `9:16` `1:1` `4:3` `3:4` `21:9` | `16:9` `9:16` `1:1` `4:3` `3:4` `21:9` |
| Resolutions (default) | `720p` standard / `1080p` pro | `480p` `720p` `1080p` `4k` (**480p**) | `480p` `720p` `1080p` `4k` (**480p**) | `480p` `720p` (**720p**) | `480p` `720p` (**720p**) |
| Image refs (max) | 7 (≤3 per element) | 9 | 9 | 50 | 30 |
| Audio refs (max) | — (voice is a bound `voice_id`) | 3, ≤15s total | 3, ≤15s total | 10, ≤30s total | 10, ≤30s total, **each clip 2–30s** |
| Video refs (max) | — | — | 3 | 50 | 10 |
| Combined ref budget | — | per-kind only | per-kind only | **50 across all kinds** | per-kind only |
| Ref citation style | `elements` (no in-prompt citation) | `@Image1` (compact) | `@Image 1` (spaced) | `[Image1]` (bracket) | `@Image 1` (spaced) |
| Shot syntax | storyboard segments | connectors ("then…") | connectors ("then…") | `Shot N:` numbered | `Shot N:` numbered |
| `seed` | not accepted | **rejected (422)** — retakes use `--take <n>` | accepted — **chosen per re-render** (fix vs fresh, [below](#fix-this-take-vs-a-fresh-take-segmind-seed-control)) | accepted (always the deterministic default) | accepted — **chosen per re-render** (fix vs fresh, [below](#fix-this-take-vs-a-fresh-take-segmind-seed-control)) |
| Native first/last frame | yes | no (seam frame demoted to a trailing ref) | yes, but **mutually exclusive with reference images** | no (seam frame demoted to a trailing ref) | yes, but **mutually exclusive with reference images** |
| Seam mode applied | `native` (start anchored; **end best-effort**, see below) — `none` on a text-to-video job | `soft` always | `native` only on a **cast-less** job, else `soft` | `soft` always | `native` only on a **cast-less** job, else `soft` |
| Duration field | string | string | integer | string | integer |
| Addressed by (env override) | `FAL_KLING_ENDPOINT` | `FAL_SEEDANCE_ENDPOINT` / `FAL_SEEDANCE_PROBE_ENDPOINT` | slug `SEGMIND_SEEDANCE20_SLUG` | `FAL_SEEDANCE25_ENDPOINT` / `FAL_SEEDANCE25_PROBE_ENDPOINT` | slug `SEGMIND_SEEDANCE25_SLUG` |
| Knobs block | `KLING_*` | `SEEDANCE_*` | `SEEDANCE_*` | `SEEDANCE25_*` (falls back to `SEEDANCE_*`) | `SEEDANCE25_*` (falls back to `SEEDANCE_*`) |

Two rows deserve a second look, because they are where the same model genuinely diverges between
vendors:

- **Native frames vs references.** On Segmind both Seedance models have real `first_frame_url` /
  `last_frame_url` slots — but a first frame and `reference_images` cannot be sent together. So a
  job with starred cast refs carries the seam frame as its **last reference**, prompt-pinned,
  exactly as the fal endpoints do; a castless job uses the native slot. This is automatic; there is
  nothing to configure.
- **Reference budgets.** fal's 2.5 endpoint budgets references *across* modalities — 50 combined,
  images + audio + video together — while Segmind publishes per-kind limits instead. The builder
  enforces whichever shape the backend declares. Segmind's 2.5 also states a **2-second floor** per
  reference audio clip; a shorter clip is a hard rejection on an already-paid submit, so a clip
  under 2s is dropped with a warning rather than shipped.

### Seam modes: how a boundary frame is actually applied

When a segment is pinned to its neighbour — chained inside a long render, or re-rendered with
`--first-frame-from` / `--last-frame-from` — the frame reaches the model in one of two ways, and
which one you get is not a preference. `src/lib/seam-rule.js` decides it once — `chooseSeamMode()`
from the backend's declared caps, then `planSeamRefs()` for whether the reference budget can hold the
pin at all — and the renderer, the prompt preview, the browser bundle and the re-render dialog's
wording all import that one module rather than mirroring it.

| Mode | What happens | What the UI may call it |
|---|---|---|
| `native` | The frame goes in the model's own first/last-frame input. The generator is anchored to those exact pixels. | **seamless** |
| `soft` | The frame rides as an extra **reference image**, cited by a prompt sentence pinning it as the literal first/last frame. Close, not guaranteed frame-perfect. | **near-seamless (reference-guided)** |
| `none` | Nothing was pinned — a scene cut by design, a job with nothing to attach a frame to, or a soft pin the image budget could not hold. | a cut |
| `unsupported` | Sent natively and rejected by the provider; the render went through without it. | a cut (and it says so) |

Per backend:

- **fal Seedance (2.0 and 2.5) — always `soft`.** These endpoints have no frame-anchor input at all,
  so a seam frame is appended as a trailing reference with a prompt pin. There is no configuration
  that makes them native, and nothing in the app may describe one of these joins as seamless.
- **Segmind Seedance — `native` only for a cast-less segment.** The native slots are mutually
  exclusive with `reference_images`, so a job that stars a character faces a real trade: the exact
  frame, or the character's identity. It keeps the **cast** and soft-pins the frame, because a
  perfect seam onto a stranger is not the join you wanted. Cast-less jobs take the native slot.
- **Kling on fal — `native`, with the closing frame best-effort.** `start_image_url` is anchored
  through the Elements set, so a text-to-video job (no reference element at all) has nothing to seed
  a frame from and gets `none`. `end_image_url` is documented on the model's API tab but unverified
  in practice: if a submit is rejected by a validation error **naming that field**, the identical
  payload is re-submitted once without it and the seam is recorded as `unsupported`. Any other
  rejection propagates on the first attempt — fal bills per accepted submit, so nothing retries
  blindly.

At the reference cap the closing pin is dropped first, then the opening pin, and only then a cast
reference — a dropped frame takes its prompt sentence with it, so the prompt never cites an image
that was not sent.

### Upscale and voice minting

| Step | fal | Segmind |
|---|---|---|
| **Topaz upscale** (`--upscale`, or `UPSCALE_ENABLED` on anything you finish from a terminal; the web app upscales at approve) | `fal-ai/topaz/upscale/video` — takes an `upscale_factor` (1–`FAL_TOPAZ_MAX_FACTOR`, default 4) derived from the clip's short side, plus a `model` (`FAL_TOPAZ_MODEL`, default `Proteus`) | `topaz-video-upscale` slug — takes `target_resolution` (`720p`/`1080p`/`4k`, from `UPSCALE_TARGET_RESOLUTION`, default `1080p`) and `target_fps`; no factor, no model |
| **Voice minting** (`npm run mint-voice`) | `fal-ai/kling-video/create-voice` — a persistent `voice_id` per character | **not implemented** — see the gap note below |

Which provider upscales is `UPSCALE_PROVIDER=auto|fal|segmind` (default `auto`). `auto` upscales
wherever the run **rendered**, so a master never round-trips through a second vendor, and falls back
to whichever provider actually has a key — that fallback is what lets a Segmind-only install finish
a 1080p film with no fal account at all.

> **`target_fps` is pinned on purpose.** Segmind's Topaz **defaults `target_fps` to 60**, and both
> Seedance models render at 24fps — an unpinned call would hand back a frame-**interpolated** clip
> with motion your take never had, and you would only find out after paying for it. The upscale
> therefore probes the source clip's real frame rate and pins `target_fps` to it (falling back to 24,
> never 60, if the probe fails). fal's factor-based API has no such knob and needs no such guard.

> **Voice minting is fal-only today.** Persistent minted voices need `FAL_KEY`, whichever provider
> renders. Segmind does publish a `kling-create-voice` model, but this build does **not** use it — a
> Segmind-only install has no minted voices at all, and Seedance falls back to its reference-clip
> voice mode. That is a real gap, not parity; wiring it is a follow-up.

Kling default endpoint: `fal-ai/kling-video/o3/standard/reference-to-video` (a text prompt +
character `elements`, no first frame required; ~720p output — the approve-time upscale delivers
1080p). For native 1080p at a higher rate set
`FAL_KLING_ENDPOINT=fal-ai/kling-video/o3/pro/reference-to-video`. For large reference images set
`FAL_UPLOAD_MODE=storage` to upload to fal's CDN instead of inlining them.

Seedance endpoints on fal (note: **no `fal-ai/` prefix** on the ids):
`bytedance/seedance-2.0/reference-to-video` and `bytedance/seedance-2.5/reference-to-video` — the
standard tiers only; mini/fast are deliberately not used (they drift character fidelity). A
`--probe` (multi-job plans: first job only) rides the *same* endpoint at a lower resolution
(`SEEDANCE_PROBE_RESOLUTION` / `SEEDANCE25_PROBE_RESOLUTION`, both default 480p). Seedance 2.5 has
no separate text-to-video tier, so an idea with no image references rides the same endpoint.
Two **2.0-on-fal** quirks worth knowing: that endpoint accepts **no `seed` and no `negative_prompt`**
(both are rejected with HTTP 422), so retakes use the `--take <n>` prompt nonce and appearance
guards ride the prompt itself (`SEEDANCE_AVOID`, `SEEDANCE_TEXT_RULE`, `SEEDANCE_STYLE`). Seedance
2.5 and both Segmind backends *do* take a seed — and on the Segmind pair that seed is a choice you
make per re-render ([below](#fix-this-take-vs-a-fresh-take-segmind-seed-control)). Jobs must total **at least 4 seconds** — the planner
packs to this automatically.

### How Segmind's transport differs

Segmind is an **async job queue** addressed by model **slug**, not by a fal-style endpoint path:
`POST https://api.segmind.com/v2/<slug>` with an `x-api-key` header returns a `request_id`, then the
run polls for status and fetches the finished video from a public CDN link.

Three consequences worth knowing about:

- **A submitted job is never re-submitted.** Once Segmind has accepted a request, a resubmit would be
  a *second billable render*, so nothing re-POSTs after a successful submit — only the polling GETs
  retry. `SEGMIND_MAX_RETRIES` (default 3) therefore governs **submit attempts before the job exists**
  and nothing after that. A submit is retried only when something *proves* nothing was queued: an
  error Segmind itself answered with, or a connection that failed before the request could land (DNS,
  refused, TLS). If the submit dies mid-flight — a timeout, a reset socket — the job may already exist
  and be billed, so the run stops and tells you to check your Segmind console rather than guessing.
- **Results expire.** Segmind keeps a finished record for roughly an hour, so the clip is downloaded
  as soon as it is ready. A poll that 404s on an old request means the record aged out, and the
  message says so rather than reporting a generic failure.
- **Credits, not seconds.** Each finished job reports its cost and your remaining credits, and both
  are logged and recorded in the run's `prompts.json` sidecar alongside the `request_id`. Running out
  of credits is reported as exactly that, with the fix, and is never retried.

References reach Segmind one of two ways, set by `SEGMIND_UPLOAD_MODE`:

| Mode | What it does | Needs |
|---|---|---|
| `fal-storage` | uploads references to fal's CDN and sends links (small request bodies, reuses the shared ref cache) | `FAL_KEY` |
| `data-uri` | inlines each reference in the request | nothing else |

The default follows what you have: `fal-storage` when a fal key is present, `data-uri` when it is
not — so a Segmind-only install works out of the box, and `npm run doctor` flags the one broken
combination (`fal-storage` with no `FAL_KEY`) instead of letting it fail on the first upload.

### Fix this take vs a fresh take (Segmind seed control)

Segmind documents `seed` as a reproducibility control, and both its Seedance models accept one — so
re-rendering a single segment in the web app asks **what the re-render should change**, right under
the boundary plan:

- **Fix this take** re-sends the seed the clip on screen actually rendered from. The number is read
  back out of that take's own `prompts.json` rather than recomputed from a formula, so "the same
  starting point" means one that really happened — including on a take rendered by an older build or
  with an explicit `--seed`. An edited prompt then lands as a change *to that footage* and the rest
  stays close. Close, not guaranteed: the vendor promises no more than that, and neither does the
  wording in the dialog.
- **Fresh take** draws a new seed, so the model interprets the segment from scratch. It is the
  default — the dialog is opened by someone who did not like the clip — and it is genuinely fresh: a
  draw that came back equal to the seed already on disk is re-drawn rather than sold as a new take.

**A fix costs exactly what a fresh take costs.** Both render the same segment for the same duration
at the same rate, so the seed decides where the render starts and never what it bills; the price on
the button does not move when you switch between the two.

The choice belongs to **one re-render, not to the run**: there is no `.env` knob, nothing is
persisted, and every re-render asks again with *Fresh take* pre-selected. A cascade carries no seed
either — the choice applies to the segment you picked, and the downstream jobs are re-rendered to
rebuild the chain exactly as they always were.

The control appears only where the registry declares the capability (`capsFor('<id>').seedControl`,
true on the two `@segmind` ids). Everywhere else it is not shown at all rather than shown greyed out,
because those re-renders send no seed field and their request bodies are unchanged:
`seedance-2.5@fal` accepts a seed but is deliberately given no control, `kling-o3@fal` takes none,
and `seedance-2.0@fal` rejects one outright (422, above) — all three keep rendering from the
deterministic per-job seed they always used. Asking for a seed mode on a backend without the cap is
refused with a 400 *before* a take directory or a cost-ledger row exists, rather than being quietly
ignored, because silently dropping it would sell a paid "fresh take" that re-sent the same starting
point.

From a terminal the same lever is a flag with none of the gating —
`npm run render-job -- --from runs/<id> --job K2 --seed 12345` — validated before the render is
queued, and independent of `--take <n>`, which varies the *words* rather than the starting point.
Every take records what it was sent in its `prompts.json` sidecar: `seed` where the endpoint took
one, `seed_unused` where it did not.

### Segmind-only setup (no fal account)

You can run this project entirely on Segmind. In `.env`:

```
SEGMIND_API_KEY=paste_your_segmind_key_here
SEGMIND_UPLOAD_MODE=data-uri
UPSCALE_PROVIDER=segmind
RENDER_BACKEND=seedance-2.5@segmind   # or seedance-2.0@segmind
```

**What works:** planning, rendering either Seedance model, the local ffmpeg stitch, and the
approve-time Topaz upscale — the whole path from idea to finished 1080p `.mp4`, with no `FAL_KEY`
anywhere. `npm run doctor` treats this as a valid setup and will not ask you for a fal key.

**What does not:** **Kling 3.0 Omni** (fal-only — `kling-o3@fal` is the only backend that renders it)
and **minted character voices** (`npm run mint-voice` needs `FAL_KEY`). Without minted voices,
Seedance uses its reference-clip voice mode, so recurring characters are best-effort rather than
identical across videos.

> **Segmind is about half fal's price for the same model.** Checked 2026-08-10 (16:9, the convention
> the whole price table uses): `seedance-2.0` is **$0.0703/s** at 480p and **$0.1512/s** at 720p
> ($0.34 at 1080p, $1.3721 at 4k); `seedance-2.5` is **$0.1065/s** at 480p and **$0.2389/s** at 720p,
> with **no 1080p or 4k tier published**; `topaz-video-upscale` is **$0.125/s flat**, billed on the
> input clip's duration. Compare with fal's $0.135/$0.3024 (2.0) and $0.2205/$0.4730 (2.5) — the gap
> is real, not a typo. **These renders cost real money**, and the estimator quotes them like any other
> backend; re-check the model's own page at `segmind.com/models/<slug>/pricing` before a long run, and
> watch the credit balance, which is what actually gets debited. Rates live in
> `web/server/lib/prices.json`, one row per `<model>@<provider>` pair.

**Caps are checked before you spend.** Starring more characters than the chosen model can carry is
rejected before any LLM call (Kling 3.0 Omni takes 1 starred character, Seedance 2.0 takes 2 and
Seedance 2.5 takes 4 — each one costs reference-image slots), and an aspect ratio or resolution the
model does not offer is
refused before the render request goes out rather than after paying for a round trip. Home's cast
pills and **Aspect** control show the selected model's limits and re-pick for you when switching
models invalidates a choice — and because those limits are per *(model, provider)*, switching the
same model from fal to Segmind can widen them (Seedance 2.0 renders three aspect ratios on fal and
six on Segmind).

---

## Character voices

Characters **speak their lines automatically** — with `KLING_GENERATE_AUDIO=true` (the default) Kling
voices each line natively and lip-synced. No extra account needed.

Give each recurring character a **persistent, distinct voice**: mint it once from a clean
reference clip (**5–30 s, single speaker, no music/SFX** — `.mp3`/`.wav`/`.mp4`/`.mov`) and it's
reused on every future render — the audio analog of the Elements reference images that lock the look.

```
npm run mint-voice -- <character-name> path/to/<name>_reference.wav
```

This prints a `voice_id` and saves it to `voices/voices.json` (one entry per character; ≈ $0.007 each).
At render time, any spec element tagged with a matching `character` speaks in its minted voice; a
speaking character with no minted voice falls back to Kling's default voice. **Max 2 distinct voiced
characters per job.** Full detail in [../voices/README.md](../voices/README.md).

> **For consistent character voices, prefer the Kling backend.** Kling's minted `voice_id` is replayed
> on every render, so a character sounds identical across videos. **Seedance has no `voice_id`** — it
> can only take the reference *clip* as a voice hint (`SEEDANCE_VOICE_MODE=reference`, the default),
> so its voice consistency is best-effort. If a Seedance render's dialogue sounds wrong, set
> `SEEDANCE_VOICE_MODE=native` to have it voice the written lines cleanly (correct words, no timbre
> match). Choose **Kling** for dialogue-heavy work where the voice must stay consistent.

> **Minting needs `FAL_KEY`, whichever provider renders.** `mint-voice` runs on fal only, so a
> Segmind-only install has no minted voices — Seedance's reference-clip mode is all that is
> available there. See [Segmind-only setup](#segmind-only-setup-no-fal-account).

---

## AI planner (LLM) — pick ONE provider

The engine uses an AI text model to write the movie plan. Three lines in `.env` control the choice:

```
LLM_PROVIDER=claude        # claude | openai | gemini | copilot
LLM_TRANSPORT=api          # api | cli
LLM_MODEL=claude-opus-4-8  # the model id for your provider
```

For Claude / OpenAI / Gemini you can use **either** an API key **or** the logged-in CLI. Copilot is
**CLI-only**. If you install a CLI (including from the setup wizard), **open a new terminal window
before running it** — the install adds it to your PATH via a shell startup file, so a terminal you
already had open will say "command not found" until you reopen it. Model ids change over time — if one
is rejected, copy whatever the provider's own models page lists.

### Claude (Anthropic)
- **API key:** get one at https://console.anthropic.com → **API Keys**; set `LLM_PROVIDER=claude`,
  `LLM_TRANSPORT=api`, `LLM_MODEL=claude-opus-4-8`, `ANTHROPIC_API_KEY=sk-ant-...`
  (cheaper/faster: `claude-sonnet-4-6`).
- **CLI:** install with Anthropic's official native installer — `curl -fsSL https://claude.ai/install.sh | bash`
  (macOS/Linux/WSL) or `irm https://claude.ai/install.ps1 | iex` (Windows PowerShell); the setup wizard's
  one-click install runs this for you. Then run `claude` to log in (needs a Claude
  Pro/Max/Team/Enterprise or Console account — free Claude.ai does not include Claude Code); set
  `LLM_TRANSPORT=cli`, leave `ANTHROPIC_API_KEY` blank.

### OpenAI / Codex
- **API key:** https://platform.openai.com → **API keys**; set `LLM_PROVIDER=openai`,
  `LLM_TRANSPORT=api`, `LLM_MODEL=gpt-5.1` (or `gpt-5-mini`), `OPENAI_API_KEY=sk-...`.
- **CLI:** `npm install -g @openai/codex`, run `codex` → "Sign in with ChatGPT"; set
  `LLM_TRANSPORT=cli`.

### Google Gemini
- **API key:** https://aistudio.google.com → **Get API key**; set `LLM_PROVIDER=gemini`,
  `LLM_TRANSPORT=api`, `LLM_MODEL=gemini-2.5-pro` (cheaper: `gemini-2.5-flash`), `GEMINI_API_KEY=...`.
- **CLI:** `npm install -g @google/gemini-cli`, run `gemini` → "Login with Google"; set
  `LLM_TRANSPORT=cli`.

### GitHub Copilot (CLI-only)
No API-key option; needs **Node.js 22+** and an active Copilot subscription.
1. `npm install -g @github/copilot`
2. Run `copilot`, then `/login` (or set a fine-grained PAT with the **Copilot Requests** permission
   in `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`).
3. In `.env`: `LLM_PROVIDER=copilot`, `LLM_TRANSPORT=cli`, `LLM_MODEL=claude-sonnet-4.5` (or blank for
   Copilot's default). Copilot model ids use dots (`claude-sonnet-4.5`), unlike Anthropic's API ids.

> Advanced: `LLM_CLI_BIN` overrides which CLI is launched; `LLM_CLI_ARGS` passes extra args. Ignore
> both unless you need them.

---

## Optional overrides (`.env`)

Uncomment (remove the leading `#`) and set any of these to change a default:

| Setting | Default | What it does |
|---|---|---|
| `KLING_MODEL` | `kling-v3-omni` | `kling-v3-omni` or `kling-video-o1`. |
| `KLING_RESOLUTION` | — | **Ignored.** fal's Kling o3 endpoint takes no resolution parameter — output size is the endpoint's own, and the delivered master's measured size is what the UI reports. The variable is tolerated in old `.env` files as the no-op it always was. |
| `KLING_ASPECT` | `9:16` | The default aspect ratio for a run. Six numeric ratios exist — `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9` — but a run may only use one the chosen backend renders (see the matrix above; `kling-o3@fal` and `seedance-2.0@fal` render three, the rest render all six). `adaptive`/`auto` are deliberately not offered: the stitcher needs a deterministic ratio. |
| `KLING_MULTI_SHOT` | `true` | one generation holds up to 6 shots vs one shot per generation. |
| `KLING_GENERATE_AUDIO` | `true` | Kling's native synced sound (dialogue/SFX/ambience). |
| `KLING_CHAIN_FRAMES` | `true` | for >15s videos, seed each job with the previous clip's last frame (seam continuity). |
| `SEEDANCE25_RESOLUTION` | `720p` | Seedance 2.5 render resolution — `480p` or `720p` only, on either provider. |
| `SEEDANCE25_PROBE_RESOLUTION` | `480p` | resolution a Seedance 2.5 `--probe` job rides at. |
| `SEGMIND_UPLOAD_MODE` | follows your keys | `data-uri` (inline; needs no fal account) or `fal-storage` (fal CDN links; needs `FAL_KEY`). Defaults to `fal-storage` when a fal key exists, else `data-uri`. |
| `SEGMIND_MAX_RETRIES` | `3` | **submit** attempts, and only before Segmind accepts the job — once it has, nothing re-POSTs (that would buy a second render). Polls retry on their own. |
| `SEGMIND_SEEDANCE25_SLUG` / `SEGMIND_SEEDANCE20_SLUG` / `SEGMIND_TOPAZ_SLUG` | `seedance-2.5` / `seedance-2.0` / `topaz-video-upscale` | model slugs — copy each verbatim from the model's page on segmind.com. |
| `UPSCALE_ENABLED` | `false` | upscale **every sub-1080p clip of anything you finish from a terminal** with Topaz (extra cost) — every CLI render, and every `npm run assemble` too, as if `--upscale` were typed each time. Clips already at or above the target are skipped without an upload or a charge. **The web app ignores it**: it pins the flag off in the environment of every job it enqueues (plan, revise, render, probe, job re-render, assemble and the approve-time upscale — everything that can reach a render) and upscales only at approve, where you pick it, see the price first and get a cost-ledger row for it. Two of the app's children are deliberately left outside that pin, and neither can spend on an upscale: the `npm run doctor` button, whose job is to report what *your* `.env` says, so it answers about your box rather than about the app; and `mint-voice`, which mints a voice and renders no clip. |
| `UPSCALE_PROVIDER` | `auto` | `auto` \| `fal` \| `segmind` — which Topaz runs it. `auto` = wherever the run rendered, falling back to whichever provider has a key. |
| `UPSCALE_TARGET_RESOLUTION` | `1080p` | `720p`, `1080p` or `4k` — **Segmind Topaz only** (fal's takes a factor derived from the clip). `4k` is 4× the pixels and 4× the bill, so it only happens if you set it here. |
| `FAL_TOPAZ_MODEL` | `Proteus` | fal Topaz upscale model (Segmind's Topaz has no model parameter). |
| `FAL_TOPAZ_MAX_FACTOR` | `4` | maximum upscale factor for fal Topaz. |

`config.js` holds the full list and the ultimate defaults.
