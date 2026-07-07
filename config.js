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

const config = {
  root: ROOT,

  // ── The engine's LLM. Provider-agnostic: Claude, OpenAI (Codex), or Gemini,
  //    over the HTTP API ('api', most portable) or a logged-in CLI ('cli'). ──
  llm: {
    provider: process.env.LLM_PROVIDER || 'claude', // 'claude' | 'openai' | 'gemini' | 'copilot'
    transport: process.env.LLM_TRANSPORT || 'api',  // 'api' | 'cli'  (copilot is cli-only)
    model: process.env.LLM_MODEL || modelDefault(process.env.LLM_PROVIDER || 'claude'), // blank → the provider's default
    apiKey:
      process.env.LLM_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      '',
    temperature: numEnv('LLM_TEMPERATURE', 0.7),
    maxTokens: numEnv('LLM_MAX_TOKENS', 8192),
    // transport:'cli' — the binary to spawn (claude | codex | gemini | copilot). Empty = provider default.
    // LLM_CLI_ARGS (space-separated) is appended to the provider's CLI args (escape hatch for flag quirks).
    cli: { bin: process.env.LLM_CLI_BIN || '', args: (process.env.LLM_CLI_ARGS || '').split(' ').filter(Boolean) },
    // Optional: run the CLI on a remote host over SSH (the repo must exist there).
    ssh: { host: process.env.LLM_SSH_HOST || '', user: process.env.LLM_SSH_USER || '', key: process.env.LLM_SSH_KEY || '' },
  },

  // ── The 8-agent engine ──
  engine: {
    maxFix: numEnv('ENGINE_MAX_FIX', 3),   // per-agent validation-retry attempts
    maxQc: numEnv('ENGINE_MAX_QC', 2),     // QC re-run cycles
    profilesDir: process.env.PROFILES_DIR || './profiles', // optional subject 'bible' markdown (one file per character)
  },

  // ── Render backend selector — which video model renders spec.kling.jobs[] (both ride the fal
  //    transport below). Dispatch table: RENDERERS in src/lib/pipeline.js. Precedence at render
  //    time: --backend flag > spec.render_backend > this default. ──
  render: {
    backend: process.env.RENDER_BACKEND || 'kling', // 'kling' | 'seedance'
  },

  // ── fal.ai render transport (direct HTTP; persistent voice_ids for consistent character voices) ──
  //    Endpoint ids MUST be copied verbatim from each model's "API" tab on fal.ai — don't guess them.
  fal: {
    apiKey: process.env.FAL_KEY || process.env.FAL_API_KEY || '',
    baseUrl: (process.env.FAL_BASE_URL || 'https://queue.fal.run').replace(/\/+$/, ''),
    // reference-to-video takes a TEXT prompt + `elements` (per-character look + a bound voice_id) and
    // needs NO first-frame image — verified against the model's fal API tab. (text-to-video has no
    // elements/voice; image-to-video requires a start frame.) o3 is the generation that carries voice_id.
    // STANDARD tier: same inputs as pro, ~720p output at $0.112/s with audio ($0.084 off) vs
    // pro's 1080p at $0.14/s — approve's optional Topaz upscale delivers 1080p for less overall.
    klingEndpoint: process.env.FAL_KLING_ENDPOINT || 'fal-ai/kling-video/o3/standard/reference-to-video',
    // TEXT-TO-VIDEO tier (no elements/voice) — used when a spec has zero reference images (Casting
    // attached none because nothing in the folder fit the idea). Same o3 family, `text-to-video`
    // suffix; VERIFY against the model's fal API tab and override via FAL_KLING_TEXT_ENDPOINT if it differs.
    klingTextEndpoint: process.env.FAL_KLING_TEXT_ENDPOINT || 'fal-ai/kling-video/o3/standard/text-to-video',
    // Seedance 2.0 (ByteDance) reference-to-video — a TEXT prompt + flat image_urls (@Image1..N) +
    // optional audio_urls (@Audio1..N lip-sync refs). NOTE: these endpoint ids have NO `fal-ai/`
    // prefix (verified on fal.ai). Standard tier ONLY — mini/fast drift character fidelity (wrong
    // anatomy, added props), so probes ride the SAME standard endpoint and save money by rendering
    // just the first job at SEEDANCE_PROBE_RESOLUTION instead of dropping to a cheaper tier.
    seedanceEndpoint: process.env.FAL_SEEDANCE_ENDPOINT || 'bytedance/seedance-2.0/reference-to-video',
    seedanceProbeEndpoint: process.env.FAL_SEEDANCE_PROBE_ENDPOINT || 'bytedance/seedance-2.0/reference-to-video',
    // TEXT-TO-VIDEO tier — used when a job has zero image refs (image-less idea). Rides at both full
    // and probe resolution (probe just lowers resolution, like the reference-to-video tiers above).
    // VERIFY against the model's fal API tab; override via FAL_SEEDANCE_TEXT_ENDPOINT if it differs.
    seedanceTextEndpoint: process.env.FAL_SEEDANCE_TEXT_ENDPOINT || 'bytedance/seedance-2.0/text-to-video',
    createVoiceEndpoint: process.env.FAL_CREATE_VOICE_ENDPOINT || 'fal-ai/kling-video/create-voice',
    // The CDN upload handshake (initiate + PUT) lives on a different host than the queue — env
    // override exists mostly so tests can point it at the mock server.
    storageInitiateUrl: process.env.FAL_STORAGE_INITIATE_URL || 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
    uploadMode: process.env.FAL_UPLOAD_MODE || 'data-uri', // 'data-uri' (inline; verified accepted) | 'storage' (fal CDN upload)
    maxRetries: numEnv('FAL_MAX_RETRIES', 3), // resubmit on transient fal-side infra errors
    retryBackoffMs: numEnv('FAL_RETRY_BACKOFF_MS', 8000), // base backoff between resubmits (× attempt)
    // Topaz video upscale (fal) — lifts a rendered master toward 1080p while preserving the take.
    // Output is { video:{url} } (same shape as Kling). Input: video_url + upscale_factor (1–4) + model.
    topazEndpoint: process.env.FAL_TOPAZ_ENDPOINT || 'fal-ai/topaz/upscale/video',
    topazModel: process.env.FAL_TOPAZ_MODEL || 'Proteus', // Proteus | Artemis* | Gaia* | Starlight* (see fal docs)
    topazMaxFactor: numEnv('FAL_TOPAZ_MAX_FACTOR', 4),    // Topaz supports up to 4× per pass
  },

  // ── Kling 3.0 Omni defaults (model hard caps are NOT user-tunable above the limits) ──
  kling: {
    model: process.env.KLING_MODEL || 'kling-v3-omni', // kling-v3-omni | kling-video-o1
    aspectRatio: process.env.KLING_ASPECT || '9:16',   // 16:9 | 9:16 | 1:1 (ignored when a first_frame is used)
    resolution: process.env.KLING_RESOLUTION || '1080p', // 4k | 1080p | 720p
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
    resolution: process.env.SEEDANCE_RESOLUTION || '480p',
    probeResolution: process.env.SEEDANCE_PROBE_RESOLUTION || '480p',
    generateAudio: boolEnv('SEEDANCE_GENERATE_AUDIO', true),      // native (lip-synced) audio
    // Voice handling for scripted dialogue (Seedance has NO persistent voice_id, unlike Kling):
    //   'reference' (default) — attach the character's clip as an @Audio VOICE-IDENTITY reference and
    //     let the model speak the shot's written line in that voice (best-effort consistency).
    //   'native' — attach NO clip; the model voices the written line natively (guaranteed-correct
    //     words, no timbre consistency). The fallback if 'reference' still garbles. Kling's voice_id
    //     is the only guaranteed-consistent voice path (see docs/PROVIDERS.md).
    voiceMode: process.env.SEEDANCE_VOICE_MODE || 'reference',
    promptMaxBytes: numEnv('SEEDANCE_PROMPT_MAX_BYTES', 5000),    // whole-prompt byte clamp (no documented model cap; 5000 carries a rich 6-shot prompt)
    // Optional global style directive prepended to every Seedance prompt (e.g. "Rendered in
    // a glossy 3D-animation style — soft rounded surfaces…"). Empty = the look lives in each
    // shot's content_prompt, exactly as it does for Kling.
    style: process.env.SEEDANCE_STYLE || '',
    // Seedance accepts NO negative_prompt (HTTP 422), so guards are folded into the prompt itself:
    avoid: process.env.SEEDANCE_AVOID || '',        // optional appearance guard (e.g. "The mascot has no visible nose.")
    textRule: process.env.SEEDANCE_TEXT_RULE || '', // optional replacement for the default "No on-screen text…" rule
    // How image/audio refs travel: 'storage' (fal CDN upload; stable https URLs, small POST body —
    // the live-verified mode) | 'data-uri' (inline; the hermetic tests use this). Deliberately
    // independent of FAL_UPLOAD_MODE: a multi-ref Seedance body with inlined PNGs + audio gets huge.
    uploadMode: process.env.SEEDANCE_UPLOAD_MODE || 'storage',
    minJobSeconds: 4,   // model hard cap: duration '4'..'15' (a job under 4s fails validation)
    maxJobSeconds: 15,  // model hard cap
    maxImages: 9,       // model hard cap: image_urls ≤ 9
    maxAudioRefs: 3,    // model hard cap: audio_urls ≤ 3, combined ≤ 15s
  },

  // ── Element folders (all Kling Omni input types) ──
  elements: {
    referencesDir: process.env.ELEMENTS_REFERENCES_DIR || './elements/references', // the Elements batch (subject/object/scene refs, up to 7)
    firstFrameDir: './elements/first-frame', // optional opening-frame seeds
    lastFrameDir: './elements/last-frame',   // optional closing-frame (end_frame) seeds
  },

  // ── Persistent character voices (fal transport) — the audio analog of the Elements above.
  //    `mint-voice` writes <dir>/voices.json mapping a character name → its persistent voice_id. ──
  voices: {
    dir: process.env.VOICES_DIR || './voices',
  },

  // ── Final assembly (ffmpeg) ──
  video: {
    ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
    ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
    // Explicit canvas override (both must be set) — tests pin tiny exact sizes with these.
    // When unset, the stitch canvas takes the RUN'S aspect shape at `shortSide` scale — a fixed
    // 1080x1920 default silently center-cropped every 16:9/1:1 master into portrait.
    width: process.env.VIDEO_WIDTH ? Number(process.env.VIDEO_WIDTH) : null,
    height: process.env.VIDEO_HEIGHT ? Number(process.env.VIDEO_HEIGHT) : null,
    shortSide: numEnv('VIDEO_SHORT_SIDE', 1080),
    // null = match the source clips' frame rate (no conversion, no fabricated frames). Setting
    // VIDEO_FPS forces a specific rate. `interpolate` (motion-compensated frame synthesis) warps
    // fast motion, so it is OPT-IN — the stitch otherwise resamples plainly / passes through.
    fps: process.env.VIDEO_FPS ? numEnv('VIDEO_FPS', 30) : null,
    interpolate: boolEnv('VIDEO_INTERPOLATE', false),
  },

  // ── Optional fal Topaz upscale of the final master (endpoint/model/factor live under `fal` above) ──
  upscale: {
    enabled: boolEnv('UPSCALE_ENABLED', false), // auto-lift the master toward 1080p when it's smaller
  },

  // ── Working paths (env-overridable so wrappers/tests can isolate a workspace) ──
  paths: {
    out: process.env.OUT_DIR || './out',
    work: process.env.WORK_DIR || './work',
    runs: process.env.RUNS_DIR || './runs',
    cache: process.env.CACHE_DIR || './.cache',
  },
};

function numEnv(key, dflt) {
  const v = process.env[key];
  return v === undefined || v === '' ? dflt : Number(v);
}
function boolEnv(key, dflt) {
  const v = process.env[key];
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export default config;
