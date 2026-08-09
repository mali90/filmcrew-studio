// Video upscale via Topaz — on EITHER provider (fal `fal-ai/topaz/upscale/video`, or Segmind's
// `topaz-video-upscale` slug). Enhances an EXISTING clip toward 1080p while PRESERVING the take — no
// diffusion regeneration, so the exact rendered take is kept (unlike re-rendering at a higher
// resolution, which diverges). Topaz can drop the audio track, so we re-mux the source audio back on
// when that happens — on BOTH providers.
//
// The two APIs are NOT the same shape, and merging them would be a bug:
//   fal     — `upscale_factor` (1–4) + `model`; the plan derives the factor from the source's short side.
//   Segmind — `target_resolution` ('720p'|'1080p'|'4k') + `target_fps` (15–120); NO factor, no model.
//
// `target_fps` is the dangerous one: SEGMIND DEFAULTS IT TO 60. Both Seedance models render 24fps, so
// an unpinned call hands back a frame-INTERPOLATED clip — motion the take never had — and you only
// find out after paying for the upscale. It is therefore pinned to the PROBED source rate, falling
// back to 24 (never 60) when the probe fails. fal's factor-based API has no such knob, so nothing in
// the fal path protects against this.
//
// Which provider runs it: UPSCALE_PROVIDER=auto|fal|segmind (config.upscale.provider). `auto` follows
// the RUN's render provider so a master never round-trips through a second vendor, then falls back to
// whichever provider actually has a key. Both transports are imported LAZILY: a Segmind-only install
// (no FAL_KEY anywhere) must never load fal.js, and a fal-only one must never load segmind.js.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import config from '../../config.js';
import log from './logger.js';
import { ensureDir } from './util.js';

const V = config.video;
const FAL = config.fal;

/** Run an ffmpeg/ffprobe binary, resolving stdout on success. */
function runBin(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`spawn ${path.basename(bin)} failed: ${e.message}`)));
    child.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} exited ${c}: ${err.slice(-800)}`))));
  });
}

export async function probeDims(file) {
  const out = await runBin(V.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).catch(() => '');
  const [w, h] = out.trim().split('x').map((n) => parseInt(n, 10));
  return { width: w || 0, height: h || 0 };
}

/**
 * Pure: ffprobe reports `r_frame_rate` as an exact fraction ('24/1', '30000/1001'), so read it as
 * one. Rounded to the nearest integer — Segmind's `target_fps` is an int, and 30000/1001 is 30fps
 * footage. Anything unreadable is 0 ("unknown"), NEVER a guess: the caller decides the fallback.
 */
export function parseFrameRate(rate) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(String(rate ?? ''));
  if (!m) return 0;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return 0;
  const fps = Math.round(num / den);
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

/** The clip's frame rate as an integer, or 0 when it can't be read (see parseFrameRate). */
export async function probeFps(file) {
  const out = await runBin(V.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]).catch(() => '');
  return parseFrameRate(out.trim().split(/\r?\n/)[0]);
}

async function hasAudio(file) {
  const out = await runBin(V.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).catch(() => '');
  return out.trim().startsWith('audio');
}

/**
 * Pure: decide whether a source needs upscaling and the Topaz factor to lift its SHORT side to ~1080.
 * @returns {{ needsUpscale: boolean, upscaleFactor: number }}
 */
export function upscalePlan(width, height, { maxFactor = FAL.topazMaxFactor ?? 4, targetShort = 1080 } = {}) {
  const shortSide = Math.min(Number(width) || 0, Number(height) || 0);
  if (!shortSide || shortSide >= targetShort) return { needsUpscale: false, upscaleFactor: 1 };
  // smallest 0.25-step factor that reaches the target short side, capped at the Topaz max.
  const factor = Math.min(maxFactor, Math.ceil((targetShort / shortSide) / 0.25) * 0.25);
  return { needsUpscale: true, upscaleFactor: factor };
}

// ── provider dispatch ───────────────────────────────────────────────────────

const UPSCALE_PROVIDERS = ['auto', 'fal', 'segmind'];

/**
 * Pure: which provider runs this upscale.
 *   - an explicit 'fal'/'segmind' always wins (someone asked for it by name);
 *   - 'auto' follows the run's own render provider when that provider has a key, so the master is
 *     finished where it was made;
 *   - otherwise it falls back to whichever provider IS configured — that fallback is the whole point
 *     for a Segmind-only install, which has no fal key to reach for;
 *   - with no key at all it resolves to fal, so the failure is the long-familiar "FAL_KEY not set"
 *     rather than a new message about a provider the user has never heard of.
 * @param {{configured?:string, runProvider?:string|null, hasFalKey?:boolean, hasSegmindKey?:boolean}} p
 * @returns {'fal'|'segmind'}
 */
export function resolveUpscaleProvider({ configured = 'auto', runProvider = null, hasFalKey = false, hasSegmindKey = false } = {}) {
  const want = String(configured || 'auto').trim().toLowerCase();
  if (!UPSCALE_PROVIDERS.includes(want)) {
    throw new Error(`Unknown UPSCALE_PROVIDER "${configured}" — use one of: ${UPSCALE_PROVIDERS.join(', ')} ('auto' upscales wherever the run rendered).`);
  }
  if (want !== 'auto') return want;
  const configuredKey = { fal: Boolean(hasFalKey), segmind: Boolean(hasSegmindKey) };
  if (runProvider && configuredKey[runProvider]) return runProvider;
  if (configuredKey.fal) return 'fal';
  if (configuredKey.segmind) return 'segmind';
  return 'fal';
}

// "Has a key" must mean "this transport will actually accept the job", so each reader mirrors the
// rule its own client uses — fal.js's falHeaders reads the config snapshot, segmind.js's
// segmindHeaders lets a live process.env override it. Route on anything else and `auto` can pick a
// provider that then refuses the call.
const falKey = () => String(FAL.apiKey || '').trim();
const segmindKey = () => String(process.env.SEGMIND_API_KEY ?? config.segmind.apiKey ?? '').trim();

// Segmind's `target_resolution` enum → the short side it delivers, which is also the bar a source has
// to clear to make the upscale a no-op.
const TARGET_SHORT_SIDE = { '720p': 720, '1080p': 1080, '4k': 2160 };

function shortSideForTarget(res) {
  const px = TARGET_SHORT_SIDE[String(res)];
  if (!px) throw new Error(`Unknown upscale target resolution "${res}" (UPSCALE_TARGET_RESOLUTION) — Segmind's Topaz accepts ${Object.keys(TARGET_SHORT_SIDE).join(' | ')}.`);
  return px;
}

const FPS_MIN = 15;   // Segmind's documented target_fps window…
const FPS_MAX = 120;  // …clamped rather than sent out of range for a 422 we can predict.
const FPS_FALLBACK = 24; // both Seedance models render 24fps — the honest guess when the probe fails.

/** Pure: Segmind Topaz arguments. `target_fps` is PINNED to the source rate — see the file header. */
export function segmindTopazArgs(videoUrl, { targetResolution = config.upscale.targetResolution, sourceFps } = {}) {
  const resolution = String(targetResolution);
  shortSideForTarget(resolution); // validates, naming the bad value
  const rounded = Math.round(Number(sourceFps));
  const fps = Number.isFinite(rounded) && rounded > 0 ? rounded : FPS_FALLBACK;
  return {
    video: videoUrl,
    target_resolution: resolution,
    target_fps: Math.min(FPS_MAX, Math.max(FPS_MIN, fps)),
  };
}

/** Topaz sometimes returns a video with no audio track — put the source's back on when it does. */
async function withSourceAudio(inPath, up, outDir, srcHasAudio, label) {
  if (srcHasAudio && !(await hasAudio(up))) {
    const muxed = path.join(outDir, 'upscaled_with_audio.mp4');
    await runBin(V.ffmpeg, ['-y', '-i', up, '-i', inPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', muxed]);
    log.info('Re-muxed the source audio onto the upscaled video (Topaz dropped the track).');
    return muxed;
  }
  log.info(`${label} upscaled clip → ${up}`);
  return up;
}

/** The fal Topaz path — factor-based, unchanged. */
async function upscaleVideoFal({ inPath, outDir, factor, model }) {
  const maxFactor = FAL.topazMaxFactor ?? 4;

  let upscaleFactor;
  if (factor !== undefined && factor !== null && factor !== '') {
    upscaleFactor = Number(factor);
    if (!(upscaleFactor >= 1 && upscaleFactor <= maxFactor)) {
      throw new Error(`Topaz upscale: bad factor "${factor}" (use 1–${maxFactor})`);
    }
  } else {
    const { width, height } = await probeDims(inPath);
    const plan = upscalePlan(width, height);
    if (!plan.needsUpscale) {
      log.info(`Topaz upscale: ${path.basename(inPath)} is already ≥1080p — skipping.`);
      return inPath;
    }
    upscaleFactor = plan.upscaleFactor;
  }
  ensureDir(outDir);
  // Probed BEFORE the upload: the upscaled file can land on top of the source (same dir, same name
  // from the provider's url), and then "did the SOURCE have audio?" is no longer answerable.
  const srcHasAudio = await hasAudio(inPath);

  log.step(`fal Topaz upscale ${upscaleFactor}× [${model ?? FAL.topazModel}] : ${path.basename(inPath)}`);
  const { topazUpscale } = await import('./fal.js');
  // Stage the download AWAY from the source (same hazard as the Segmind branch): a fal result URL
  // carrying the input's basename would land on top of the source clip — after which the audio
  // restore below would read the silent upscale as both sides, and a PAID upscale loses its sound.
  const stage = fs.mkdtempSync(path.join(outDir, '.fal-upscale-'));
  try {
    const up = await topazUpscale(inPath, { destDir: stage, upscaleFactor, model });
    const result = await withSourceAudio(inPath, up, outDir, srcHasAudio, 'fal Topaz');
    if (result !== up) return result; // re-muxed into outDir — the staged download is scrap
    // Audio survived, so the staged file IS the result: promote it under a collision-proof name.
    const final = path.join(outDir, `upscaled_${path.basename(up)}`);
    fs.renameSync(up, final);
    return final;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * The Segmind Topaz path — resolution + a PINNED source frame rate instead of a factor. Exported so
 * it can be driven directly (and tested) without going through the dispatcher.
 * @param {{inPath:string, outDir:string, targetResolution?:string, slug?:string}} p
 */
export async function upscaleVideoSegmind({ inPath, outDir, targetResolution, slug } = {}) {
  if (!fs.existsSync(inPath)) throw new Error(`Topaz upscale: input not found: ${inPath}`);
  const target = targetResolution ?? config.upscale.targetResolution;
  const targetShort = shortSideForTarget(target); // before anything is uploaded or billed

  const { width, height } = await probeDims(inPath);
  if (!upscalePlan(width, height, { targetShort }).needsUpscale) {
    log.info(`Segmind Topaz upscale: ${path.basename(inPath)} is already ≥${target} — skipping.`);
    return inPath;
  }
  ensureDir(outDir);

  const sourceFps = await probeFps(inPath);
  if (!sourceFps) {
    log.warn(`Could not read ${path.basename(inPath)}'s frame rate — pinning Segmind Topaz to ${FPS_FALLBACK}fps (leaving it unset would let Segmind's 60fps default interpolate frames the take never had).`);
  }
  const srcHasAudio = await hasAudio(inPath);

  // Lazy, so a fal-only install never loads the Segmind client. `cache: false`: every job's clip has
  // the same basename, and the cloud-refs cache keys by basename — caching would upscale (and pay
  // for) job 1's take again for job 2.
  const { segmindAssetUrl, topazUpscaleSegmind } = await import('./segmind.js');
  const videoUrl = await segmindAssetUrl(inPath, undefined, { cache: false });
  const args = segmindTopazArgs(videoUrl, { targetResolution: target, sourceFps });

  log.step(`Segmind Topaz upscale → ${args.target_resolution} @ ${args.target_fps}fps : ${path.basename(inPath)}`);
  // Stage the download AWAY from the source: Segmind result URLs can carry the SAME basename as
  // the input, and landing that in outDir would overwrite the source clip — after which the audio
  // restore below would read the silent upscale as both sides, and a PAID upscale loses its sound.
  const stage = fs.mkdtempSync(path.join(outDir, '.segmind-upscale-'));
  try {
    const up = await topazUpscaleSegmind(args, { destDir: stage, slug });
    const result = await withSourceAudio(inPath, up, outDir, srcHasAudio, 'Segmind Topaz');
    if (result !== up) return result; // re-muxed into outDir — the staged download is scrap
    // Audio survived, so the staged file IS the result: promote it under a collision-proof name.
    const final = path.join(outDir, `upscaled_${path.basename(up)}`);
    fs.renameSync(up, final);
    return final;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Upscale one clip with Topaz and guarantee its audio survives. Returns the local path of the
 * upscaled mp4 (or the input path unchanged when it's already at/above the target and no explicit
 * factor was given).
 *
 *   - `factor` (fal only, optional): explicit Topaz multiplier (1..config.fal.topazMaxFactor). When
 *     omitted, the factor is auto-computed from the source's short side to reach ~1080p; a source
 *     already ≥1080p is a no-op (returns `inPath`).
 *   - `model` (fal only, optional): Topaz model name (defaults to config.fal.topazModel, 'Proteus').
 *   - `provider` (optional): pins the provider for this call (the `upscale` CLI's --provider);
 *     defaults to config.upscale.provider.
 *   - `runProvider` (optional): the provider the clip was RENDERED on, which 'auto' follows.
 * @param {{inPath:string, outDir:string, factor?:number|string, model?:string, provider?:string, runProvider?:string|null}} p
 */
export async function upscaleVideoTopaz({ inPath, outDir, factor, model, provider, runProvider } = {}) {
  if (!fs.existsSync(inPath)) throw new Error(`Topaz upscale: input not found: ${inPath}`);
  const target = resolveUpscaleProvider({
    configured: provider || config.upscale.provider,
    runProvider,
    hasFalKey: Boolean(falKey()),
    hasSegmindKey: Boolean(segmindKey()),
  });
  if (target !== 'segmind') return upscaleVideoFal({ inPath, outDir, factor, model });

  // fal-only inputs are refused rather than silently dropped: a factor changes the OUTPUT, so
  // ignoring it would deliver a size nobody asked for and bill for it.
  if (factor !== undefined && factor !== null && factor !== '') {
    throw new Error(`Topaz upscale: --factor is a fal parameter — Segmind's ${config.segmind.topazSlug} takes a target resolution instead (UPSCALE_TARGET_RESOLUTION=${Object.keys(TARGET_SHORT_SIDE).join('|')}), or run this upscale on fal with --provider fal.`);
  }
  if (model) log.warn(`Topaz model "${model}" is a fal setting — Segmind's ${config.segmind.topazSlug} has no model parameter; ignoring it.`);
  return upscaleVideoSegmind({ inPath, outDir });
}

export default {
  upscaleVideoTopaz, upscaleVideoSegmind, upscalePlan, segmindTopazArgs, resolveUpscaleProvider,
  probeDims, probeFps, parseFrameRate,
};
