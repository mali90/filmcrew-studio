// ─────────────────────────────────────────────────────────────────────────────
// THE single config file. Everything the pipeline needs lives here.
// Secrets (API keys) are read from the environment (.env) and never committed.
// A render spec's own `project`/`kling` fields (written by the engine agents)
// carry per-video values and override these defaults at render time.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelDefault } from './src/lib/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (this file lives at the root). */
export const ROOT = __dirname;
/** Resolve a possibly-relative path against the repo root. */
export const resolvePath = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

/**
 * Build the config object from an environment map. The module-level default export snapshots
 * process.env at import time (what every caller has always used); the factory exists so a caller
 * that must judge the CURRENT environment rather than the one this process started in — the doctor,
 * which is re-run after keys are edited — can re-derive the same values by the SAME rules instead of
 * duplicating the defaults (`SEGMIND_UPLOAD_MODE`’s fal-key-dependent default is exactly the kind of
 * rule that must not be written twice).
 * @param {Record<string,string|undefined>} [env]
 */
export function buildConfig(env = process.env) {
  // numEnv/boolEnv read from THIS call's env, so buildConfig(someEnv) is fully self-contained.
  const numEnv = (key, dflt) => {
    const v = env[key];
    return v === undefined || v === '' ? dflt : Number(v);
  };
  const boolEnv = (key, dflt) => {
    const v = env[key];
    if (v === undefined || v === '') return dflt;
    return /^(1|true|yes|on)$/i.test(v.trim());
  };

  const config = {
    root: ROOT,

    // ── The engine's LLM. Provider-agnostic: Claude, OpenAI (Codex), or Gemini,
    //    over the HTTP API ('api', most portable) or a logged-in CLI ('cli'). ──
    llm: {
      provider: env.LLM_PROVIDER || 'claude', // 'claude' | 'openai' | 'gemini' | 'copilot'
      transport: env.LLM_TRANSPORT || 'api',  // 'api' | 'cli'  (copilot is cli-only)
      model: env.LLM_MODEL || modelDefault(env.LLM_PROVIDER || 'claude'), // blank → the provider's default
      apiKey:
        env.LLM_API_KEY ||
        env.ANTHROPIC_API_KEY ||
        env.OPENAI_API_KEY ||
        env.GEMINI_API_KEY ||
        '',
      temperature: numEnv('LLM_TEMPERATURE', 0.7),
      maxTokens: numEnv('LLM_MAX_TOKENS', 8192),
      // transport:'cli' — the binary to spawn (claude | codex | gemini | copilot). Empty = provider default.
      // LLM_CLI_ARGS (space-separated) is appended to the provider's CLI args (escape hatch for flag quirks).
      cli: { bin: env.LLM_CLI_BIN || '', args: (env.LLM_CLI_ARGS || '').split(' ').filter(Boolean) },
      // Optional: run the CLI on a remote host over SSH (the repo must exist there).
      ssh: { host: env.LLM_SSH_HOST || '', user: env.LLM_SSH_USER || '', key: env.LLM_SSH_KEY || '' },
    },

    // ── The 8-agent engine ──
    engine: {
      maxFix: numEnv('ENGINE_MAX_FIX', 3),   // per-agent validation-retry attempts
      maxQc: numEnv('ENGINE_MAX_QC', 2),     // QC re-run cycles
      profilesDir: env.PROFILES_DIR || './profiles', // optional subject 'bible' markdown (one file per character)
      environmentsDir: env.ENVIRONMENTS_DIR || './environments', // optional world/mood/style 'bible' markdown (one file per environment)
    },

    // ── Render backend selector — which video model renders spec.kling.jobs[] (both ride the fal
    //    transport below). Dispatch table: RENDERERS in src/lib/pipeline.js. Precedence at render
    //    time: --backend flag > spec.render_backend > this default. ──
    render: {
      // '<model>@<provider>' (see src/lib/render-models.js); legacy 'kling'/'seedance' stay accepted.
      backend: env.RENDER_BACKEND || 'kling', // → canonicalized to 'kling-o3@fal'
    },

    // ── fal.ai render transport (direct HTTP; persistent voice_ids for consistent character voices) ──
    //    Endpoint ids MUST be copied verbatim from each model's "API" tab on fal.ai — don't guess them.
    fal: {
      apiKey: env.FAL_KEY || env.FAL_API_KEY || '',
      baseUrl: (env.FAL_BASE_URL || 'https://queue.fal.run').replace(/\/+$/, ''),
      // reference-to-video takes a TEXT prompt + `elements` (per-character look + a bound voice_id) and
      // needs NO first-frame image — verified against the model's fal API tab. (text-to-video has no
      // elements/voice; image-to-video requires a start frame.) o3 is the generation that carries voice_id.
      // STANDARD tier: same inputs as pro, ~720p output at $0.112/s with audio ($0.084 off) vs
      // pro's 1080p at $0.14/s — approve's optional Topaz upscale delivers 1080p for less overall.
      klingEndpoint: env.FAL_KLING_ENDPOINT || 'fal-ai/kling-video/o3/standard/reference-to-video',
      // TEXT-TO-VIDEO tier (no elements/voice) — used when a spec has zero reference images (Casting
      // attached none because nothing in the folder fit the idea). Same o3 family, `text-to-video`
      // suffix; VERIFY against the model's fal API tab and override via FAL_KLING_TEXT_ENDPOINT if it differs.
      klingTextEndpoint: env.FAL_KLING_TEXT_ENDPOINT || 'fal-ai/kling-video/o3/standard/text-to-video',
      // Seedance 2.0 (ByteDance) reference-to-video — a TEXT prompt + flat image_urls (@Image1..N) +
      // optional audio_urls (@Audio1..N lip-sync refs). NOTE: these endpoint ids have NO `fal-ai/`
      // prefix (verified on fal.ai). Standard tier ONLY — mini/fast drift character fidelity (wrong
      // anatomy, added props), so probes ride the SAME standard endpoint and save money by rendering
      // just the first job at SEEDANCE_PROBE_RESOLUTION instead of dropping to a cheaper tier.
      seedanceEndpoint: env.FAL_SEEDANCE_ENDPOINT || 'bytedance/seedance-2.0/reference-to-video',
      seedanceProbeEndpoint: env.FAL_SEEDANCE_PROBE_ENDPOINT || 'bytedance/seedance-2.0/reference-to-video',
      // TEXT-TO-VIDEO tier — used when a job has zero image refs (image-less idea). Rides at both full
      // and probe resolution (probe just lowers resolution, like the reference-to-video tiers above).
      // VERIFY against the model's fal API tab; override via FAL_SEEDANCE_TEXT_ENDPOINT if it differs.
      seedanceTextEndpoint: env.FAL_SEEDANCE_TEXT_ENDPOINT || 'bytedance/seedance-2.0/text-to-video',
      // Seedance 2.5 reference-to-video — a DIFFERENT model with its own endpoint, prompt syntax and
      // limits (4–30s, 480p/720p, bracket [Image1] refs, a seed it actually accepts), so it gets its
      // own settings rather than sharing 2.0's. This endpoint has NO text-to-video sibling: a job with
      // no image refs rides the same endpoint. Probe = the SAME endpoint at a lower resolution
      // (SEEDANCE25_PROBE_RESOLUTION), exactly as 2.0 probes.
      seedance25Endpoint: env.FAL_SEEDANCE25_ENDPOINT || 'bytedance/seedance-2.5/reference-to-video',
      seedance25ProbeEndpoint: env.FAL_SEEDANCE25_PROBE_ENDPOINT || 'bytedance/seedance-2.5/reference-to-video',
      createVoiceEndpoint: env.FAL_CREATE_VOICE_ENDPOINT || 'fal-ai/kling-video/create-voice',
      // The CDN upload handshake (initiate + PUT) lives on a different host than the queue — env
      // override exists mostly so tests can point it at the mock server.
      storageInitiateUrl: env.FAL_STORAGE_INITIATE_URL || 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
      uploadMode: env.FAL_UPLOAD_MODE || 'data-uri', // 'data-uri' (inline; verified accepted) | 'storage' (fal CDN upload)
      maxRetries: numEnv('FAL_MAX_RETRIES', 3), // resubmit on transient fal-side infra errors
      retryBackoffMs: numEnv('FAL_RETRY_BACKOFF_MS', 8000), // base backoff between resubmits (× attempt)
      // Topaz video upscale (fal) — lifts a rendered master toward 1080p while preserving the take.
      // Output is { video:{url} } (same shape as Kling). Input: video_url + upscale_factor (1–4) + model.
      topazEndpoint: env.FAL_TOPAZ_ENDPOINT || 'fal-ai/topaz/upscale/video',
      topazModel: env.FAL_TOPAZ_MODEL || 'Proteus', // Proteus | Artemis* | Gaia* | Starlight* (see fal docs)
      topazMaxFactor: numEnv('FAL_TOPAZ_MAX_FACTOR', 4),    // Topaz supports up to 4× per pass
    },

    // ── Segmind render transport (the second provider; async v2 queue, `x-api-key` auth) ──
    //    Models are addressed by SLUG, not by a fal-style endpoint path: POST {baseUrl}/v2/<slug>.
    //    A Segmind-only install (no fal key at all) renders AND upscales here — see docs/PROVIDERS.md.
    segmind: {
      apiKey: env.SEGMIND_API_KEY || '',
      baseUrl: (env.SEGMIND_BASE_URL || 'https://api.segmind.com').replace(/\/+$/, ''),
      // Model slugs — copy them verbatim from each model's page on segmind.com; don't guess.
      seedance25Slug: env.SEGMIND_SEEDANCE25_SLUG || 'seedance-2.5',
      seedance20Slug: env.SEGMIND_SEEDANCE20_SLUG || 'seedance-2.0',
      topazSlug: env.SEGMIND_TOPAZ_SLUG || 'topaz-video-upscale',
      // How a local reference reaches Segmind. 'data-uri' inlines it (no other service involved, so a
      // Segmind-only setup works with NO fal key); 'fal-storage' reuses fal's CDN + the cloud-refs
      // cache, which keeps the POST body small but needs FAL_KEY. Default follows what you have.
      uploadMode: env.SEGMIND_UPLOAD_MODE
        || ((env.FAL_KEY || env.FAL_API_KEY) ? 'fal-storage' : 'data-uri'),
      // POST attempts ONLY, and only before a request_id exists: once Segmind has accepted a job, a
      // resubmit is a SECOND BILLABLE RENDER, so src/lib/segmind.js never re-POSTs (polls retry freely).
      maxRetries: numEnv('SEGMIND_MAX_RETRIES', 3),
      retryBackoffMs: numEnv('SEGMIND_RETRY_BACKOFF_MS', 8000), // base backoff between submits (× attempt)
    },

    // ── Kling 3.0 Omni defaults (model hard caps are NOT user-tunable above the limits) ──
    kling: {
      model: env.KLING_MODEL || 'kling-v3-omni', // kling-v3-omni | kling-video-o1
      aspectRatio: env.KLING_ASPECT || '9:16',   // 16:9 | 9:16 | 1:1 (ignored when a first_frame is used)
      resolution: env.KLING_RESOLUTION || '1080p', // 4k | 1080p | 720p
      multiShot: boolEnv('KLING_MULTI_SHOT', true),      // true = storyboard up to 6 segments/generation; false = one shot/generation
      nativeAudio: boolEnv('KLING_GENERATE_AUDIO', true), // Kling generate_audio (native synced audio)
      maxStoryboards: 6,        // model hard cap
      maxJobSeconds: 15,        // model hard cap
      maxRefImages: 7,          // model hard cap
      // fal/Kling reject a 512-BYTE segment ('size must be between 0 and 512' is exclusive, and
      // segments ≤490 bytes are known-accepted) — 500 keeps a margin. Env knob for when fal moves.
      segmentMaxBytes: numEnv('KLING_SEGMENT_MAX_BYTES', 500),
      defaultShotSeconds: numEnv('KLING_DEFAULT_SHOT_SECONDS', 5),
      // Seam continuity for multi-job (>15s) renders: feed each job clip's LAST frame as the NEXT
      // job's start frame (start_image_url on fal / first_frame seed on cloud) so the cut is
      // continuous instead of the next job starting fresh from the reference Elements. ON by default;
      // only affects jobs after the first in a FULL render (never on --probe). KLING_CHAIN_FRAMES=false
      // reverts to independent jobs.
      chainFrames: boolEnv('KLING_CHAIN_FRAMES', true),
    },

    // ── Seedance 2.0 defaults (model hard caps are NOT user-tunable) ──
    seedance: {
      // 480p | 720p | 1080p | 4k. Default 480p: fal bills Seedance by pixel-seconds, so native 1080p
      // costs ~$0.68/s (2x Kling's ~$0.32/s) while 480p is ~$0.14/s — render cheap, let approve's
      // Topaz upscale lift the master to 1080p (docs/COST.md).
      resolution: env.SEEDANCE_RESOLUTION || '480p',
      probeResolution: env.SEEDANCE_PROBE_RESOLUTION || '480p',
      generateAudio: boolEnv('SEEDANCE_GENERATE_AUDIO', true),      // native (lip-synced) audio
      // Voice handling for scripted dialogue (Seedance has NO persistent voice_id, unlike Kling):
      //   'reference' (default) — attach the character's clip as an @Audio VOICE-IDENTITY reference and
      //     let the model speak the shot's written line in that voice (best-effort consistency).
      //   'native' — attach NO clip; the model voices the written line natively (guaranteed-correct
      //     words, no timbre consistency). The fallback if 'reference' still garbles. Kling's voice_id
      //     is the only guaranteed-consistent voice path (see docs/PROVIDERS.md).
      voiceMode: env.SEEDANCE_VOICE_MODE || 'reference',
      // Whole-prompt byte clamp, OFF by default (0). No provider documents a prompt-length limit for
      // Seedance — Segmind's 2.0/2.5 API pages state none, and ByteDance only recommends staying
      // under ~1000 words (quality guidance, not an API limit) — so a default here would shorten a
      // rich multi-shot prompt where nobody could see it. Set it to a number if a provider ever
      // answers 422 on prompt length; unset/empty/0 all mean uncapped.
      promptMaxBytes: numEnv('SEEDANCE_PROMPT_MAX_BYTES', 0),
      // Optional global style directive prepended to every Seedance prompt (e.g. "Rendered in
      // a glossy 3D-animation style — soft rounded surfaces…"). Empty = the look lives in each
      // shot's content_prompt, exactly as it does for Kling.
      style: env.SEEDANCE_STYLE || '',
      // Seedance accepts NO negative_prompt (HTTP 422), so guards are folded into the prompt itself:
      avoid: env.SEEDANCE_AVOID || '',        // optional appearance guard (e.g. "The mascot has no visible nose.")
      textRule: env.SEEDANCE_TEXT_RULE || '', // optional replacement for the default "No on-screen text…" rule
      // How image/audio refs travel: 'storage' (fal CDN upload; stable https URLs, small POST body —
      // the live-verified mode) | 'data-uri' (inline; the hermetic tests use this). Deliberately
      // independent of FAL_UPLOAD_MODE: a multi-ref Seedance body with inlined PNGs + audio gets huge.
      uploadMode: env.SEEDANCE_UPLOAD_MODE || 'storage',
      minJobSeconds: 4,   // model hard cap: duration '4'..'15' (a job under 4s fails validation)
      maxJobSeconds: 15,  // model hard cap
      maxImages: 9,       // model hard cap: image_urls ≤ 9
      maxAudioRefs: 3,    // model hard cap: audio_urls ≤ 3, combined ≤ 15s
    },

    // ── Seedance 2.5 overrides — ONLY what differs from the `seedance` block above. Everything else
    //    (style, avoid, textRule, voiceMode, uploadMode, promptMaxBytes, generateAudio) still comes
    //    from `seedance`, so one set of user preferences covers both models. Model hard caps live in
    //    the registry (src/lib/render-models.js), never here. ──
    seedance25: {
      // 480p | 720p only (the model renders no higher; approve's Topaz upscale delivers 1080p).
      // Default 720p, not 2.0's 480p: 2.5 bills ~$0.22/s at 480p vs ~$0.47/s at 720p, and its
      // reference fidelity is what you are paying for — see docs/COST.md.
      resolution: env.SEEDANCE25_RESOLUTION || '720p',
      probeResolution: env.SEEDANCE25_PROBE_RESOLUTION || '480p', // probes ride the cheap tier
    },

    // ── Element folders (all Kling Omni input types) ──
    elements: {
      referencesDir: env.ELEMENTS_REFERENCES_DIR || './elements/references', // the Elements batch (subject/object/scene refs, up to 7)
      firstFrameDir: './elements/first-frame', // optional opening-frame seeds
      lastFrameDir: './elements/last-frame',   // optional closing-frame (end_frame) seeds
    },

    // ── Persistent character voices (fal transport) — the audio analog of the Elements above.
    //    `mint-voice` writes <dir>/voices.json mapping a character name → its persistent voice_id. ──
    voices: {
      dir: env.VOICES_DIR || './voices',
    },

    // ── Final assembly (ffmpeg) ──
    video: {
      ffmpeg: env.FFMPEG_BIN || 'ffmpeg',
      ffprobe: env.FFPROBE_BIN || 'ffprobe',
      // Explicit canvas override (both must be set) — tests pin tiny exact sizes with these.
      // When unset, the stitch canvas takes the RUN'S aspect shape at `shortSide` scale — a fixed
      // 1080x1920 default silently center-cropped every 16:9/1:1 master into portrait.
      width: env.VIDEO_WIDTH ? Number(env.VIDEO_WIDTH) : null,
      height: env.VIDEO_HEIGHT ? Number(env.VIDEO_HEIGHT) : null,
      shortSide: numEnv('VIDEO_SHORT_SIDE', 1080),
      // null = match the source clips' frame rate (no conversion, no fabricated frames). Setting
      // VIDEO_FPS forces a specific rate. `interpolate` (motion-compensated frame synthesis) warps
      // fast motion, so it is OPT-IN — the stitch otherwise resamples plainly / passes through.
      fps: env.VIDEO_FPS ? numEnv('VIDEO_FPS', 30) : null,
      interpolate: boolEnv('VIDEO_INTERPOLATE', false),
    },

    // ── Seam-invisible stitching (tools/seamstitch, Python + numpy/pillow) ──
    // Chained renders (KLING_CHAIN_FRAMES) feed each job the previous clip's last frame, so adjacent
    // clips share a boundary frame but drift slightly in exposure/white balance. A hard concat shows
    // that as a lighting "pop" plus a 1-frame hitch. The stitcher colour-matches across each chained
    // joint, drops the duplicated frame and crossfades. 'auto' uses it when the deps are installed and
    // the clips qualify, and falls back to the plain concat otherwise; 'force' fails loudly instead.
    stitch: {
      seamless: env.STITCH_SEAMLESS || 'auto', // 'auto' | 'off' | 'force'
      python: env.PYTHON_BIN || 'python3',
      method: env.STITCH_METHOD || 'hybrid',   // 'hybrid' | 'mkl' | 'quantile' | 'none'
      xfade: numEnv('STITCH_XFADE', 0.25),             // crossfade seconds at a CHAINED joint
      cutXfade: numEnv('STITCH_CUT_XFADE', 0),         // ...and at a scene cut (0 → one frame)
      ramp: numEnv('STITCH_RAMP', 2.0),                // seconds to ease the correction back to native (0 = cascade)
      fit: env.STITCH_FIT || 'cover',          // AR-preserving refit: 'cover' | 'contain' | 'none'
      desqueeze: env.STITCH_DESQUEEZE || 'off', // 'off' | 'auto' | <factor>
      deflicker: boolEnv('STITCH_DEFLICKER', false),
      verify: env.STITCH_VERIFY || 'warn',     // 'off' | 'warn' (log failures) | 'strict' (reject the stitch)
      // TEST/DEBUG ONLY: treat every seam as chained even when nothing recorded the lineage. It asserts
      // a fact about the footage — wrong, it drops a real frame at a scene cut — so it is never a default.
      assumeContinuous: boolEnv('STITCH_ASSUME_CONTINUOUS', false),
      crf: numEnv('STITCH_CRF', 19),                   // matches assemble.js's own -crf
      preset: env.STITCH_PRESET || 'medium',
      timeoutMs: numEnv('STITCH_TIMEOUT_MS', 20 * 60 * 1000),
    },

    // ── Optional Topaz upscale of the rendered clips. It runs on EITHER provider: fal's factor-based
    //    endpoint (endpoint/model/factor live under `fal` above) or Segmind's `topaz-video-upscale`
    //    slug (under `segmind`), which takes a target resolution + fps instead of a factor. ──
    upscale: {
      enabled: boolEnv('UPSCALE_ENABLED', false), // auto-lift the master toward 1080p when it's smaller
      // 'auto' (default) upscales wherever the run RENDERED — so a master never round-trips through a
      // second vendor — and falls back to whichever provider actually has a key (that fallback is what
      // lets a Segmind-only install, with no FAL_KEY anywhere, still finish a 1080p film).
      provider: env.UPSCALE_PROVIDER || 'auto', // 'auto' | 'fal' | 'segmind'
      // Segmind's target_resolution enum ('720p' | '1080p' | '4k'). 4k is 4× the pixels and 4× the
      // bill, so it is only ever reached when someone sets it here on purpose — an auto-derived plan
      // stops at 1080p. (fal's Topaz has no resolution input; its factor comes from the source size.)
      targetResolution: env.UPSCALE_TARGET_RESOLUTION || '1080p',
    },

    // ── Working paths (env-overridable so wrappers/tests can isolate a workspace) ──
    paths: {
      out: env.OUT_DIR || './out',
      work: env.WORK_DIR || './work',
      runs: env.RUNS_DIR || './runs',
      cache: env.CACHE_DIR || './.cache',
    },
  };

  return config;
}

const config = buildConfig(process.env);

export default config;
