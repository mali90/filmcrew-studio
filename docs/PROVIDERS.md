# Providers reference — render backend, LLM planners, voices

`npm run init` walks you through all of this interactively and validates each key live. This file is
the manual reference: the exact accounts, keys, and `.env` lines, for when you want to set them by
hand or troubleshoot.

> `.env` rules: a value goes **right after the `=` with no spaces** and **no quotes**
> (`FAL_KEY=abc123`, not `FAL_KEY = "abc123"`). No leftover `<placeholder>` brackets, no trailing
> spaces. The wizard writes these correctly for you.

---

## Render backends — fal.ai (Kling & Seedance)

All rendering runs on **fal.ai** and needs one `FAL_KEY`. Two video models are available; pick a
default in `.env` or switch per run with `--backend`.

1. Create an account and get a key at **https://fal.ai/dashboard/keys** (pay-per-second; commercial
   use permitted).
2. In `.env`:
   ```
   FAL_KEY=paste_your_fal_key_here
   RENDER_BACKEND=kling-o3@fal  # kling-o3@fal (default) | seedance-2.0@fal
   ```

**Backend ids are `<model>@<provider>`.** A backend names the *model* and the *provider that runs
it*, so the same model can later be offered by a second provider without touching any plumbing. The
old one-word names **`kling`** and **`seedance`** stay accepted forever — on the CLI, in `.env`, and
in spec/manifest files already on disk — and simply resolve to `kling-o3@fal` and `seedance-2.0@fal`.
Nothing needs migrating; whichever spelling you type, the planned spec records the canonical id in
`render_backend`.

Selection precedence at render time: `--backend` flag → `render_backend` in the spec →
`RENDER_BACKEND` in `.env` → `kling-o3@fal`.

Each model carries its own caps — job window, reference-image budget, cast ceiling and aspect-ratio
list — and the planner is told *that model's* numbers, so a plan is written to the limits of the
backend it will actually render on.

| | **Kling 3.0 Omni** (default) | **Seedance 2.0** (ByteDance) |
|---|---|---|
| Backend id (legacy alias) | `kling-o3@fal` (`kling`) | `seedance-2.0@fal` (`seedance`) |
| One generation renders | up to 6 storyboard segments (≤15s) | one rich multi-shot prompt (4–15s) |
| Starred cast members (max) | 1 | 2 |
| Aspect ratios | `16:9`, `9:16`, `1:1` | `16:9`, `9:16`, `1:1` |
| Identity pinning | `elements` (frontal + reference images) | flat `@Image1..9` reference images |
| Character voices | persistent minted `voice_id` bound per element | lip-sync to the mint-time **clip** (`@Audio1..3`) |
| Seam continuity (>15s videos) | `start_image_url` = previous last frame | same frame, appended as a ref and **prompt-pinned** |
| Regen variation | per-job `seed` | `--take <n>` prompt nonce (the endpoint rejects `seed`) |
| Endpoint (env override) | `FAL_KLING_ENDPOINT` | `FAL_SEEDANCE_ENDPOINT` / `FAL_SEEDANCE_PROBE_ENDPOINT` |

Kling default endpoint: `fal-ai/kling-video/o3/standard/reference-to-video` (a text prompt +
character `elements`, no first frame required; ~720p output — the approve-time upscale delivers
1080p). For native 1080p at a higher rate set
`FAL_KLING_ENDPOINT=fal-ai/kling-video/o3/pro/reference-to-video`. For large reference images set
`FAL_UPLOAD_MODE=storage` to upload to fal's CDN instead of inlining them.

Seedance endpoint (note: **no `fal-ai/` prefix** on the id):
`bytedance/seedance-2.0/reference-to-video` — the standard tier only; mini/fast are deliberately
not used (they drift character fidelity). A `--probe` (multi-job plans: first job only) rides the
same standard endpoint at `SEEDANCE_PROBE_RESOLUTION` (default 480p).
Two Seedance quirks worth knowing: the endpoint accepts **no `seed` and no `negative_prompt`**
(both are rejected with HTTP 422), so retakes use the `--take <n>` prompt nonce and appearance
guards ride the prompt itself (`SEEDANCE_AVOID`, `SEEDANCE_TEXT_RULE`, `SEEDANCE_STYLE`). Jobs must
total **at least 4 seconds** — the planner packs to this automatically.

**Caps are checked before you spend.** Starring more characters than the chosen model can carry is
rejected before any LLM call (Kling 3.0 Omni takes 1 starred character, Seedance 2.0 takes 2 — each
one costs reference-image slots), and an aspect ratio or resolution the model does not offer is
refused before the render request goes out rather than after paying for a round trip. Home's cast
pills and **Aspect** control show the selected model's limits and re-pick for you when switching
models invalidates a choice.

> The registry also declares **Seedance 2.5** (4 starred characters; six aspect ratios) ahead of the
> endpoints that will run it — it is not selectable as a backend until a provider entry lands.

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
| `KLING_RESOLUTION` | `1080p` | `720p`, `1080p`, or `4k` (higher = more cost). |
| `KLING_ASPECT` | `9:16` | The default aspect ratio for a run. Six numeric ratios exist — `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9` — but a run may only use one the chosen model renders (both shipping models: `16:9`, `9:16`, `1:1`). `adaptive`/`auto` are deliberately not offered: the stitcher needs a deterministic ratio. |
| `KLING_MULTI_SHOT` | `true` | one generation holds up to 6 shots vs one shot per generation. |
| `KLING_GENERATE_AUDIO` | `true` | Kling's native synced sound (dialogue/SFX/ambience). |
| `KLING_CHAIN_FRAMES` | `true` | for >15s videos, seed each job with the previous clip's last frame (seam continuity). |
| `UPSCALE_ENABLED` | `false` | upscale **every** render with fal Topaz (extra cost). |
| `FAL_TOPAZ_MODEL` | `Proteus` | fal Topaz upscale model. |
| `FAL_TOPAZ_MAX_FACTOR` | `4` | maximum upscale factor for fal Topaz. |

`config.js` holds the full list and the ultimate defaults.
