// Video upscale via fal Topaz (fal-ai/topaz/upscale/video). Enhances an EXISTING clip toward 1080p
// while PRESERVING the take — no diffusion regeneration, so the exact rendered take is kept (unlike
// re-rendering at a higher resolution, which diverges). Topaz can drop the audio track, so we re-mux
// the source audio back on when that happens. The fal submit/poll/download lives in fal.js.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import config from '../../config.js';
import log from './logger.js';
import { topazUpscale } from './fal.js';
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

/**
 * Upscale one clip with fal Topaz and guarantee its audio survives. Returns the local path of the
 * upscaled mp4 (or the input path unchanged when it's already ≥1080p and no explicit factor was given).
 *
 *   - `factor` (optional): explicit Topaz multiplier (1..config.fal.topazMaxFactor). When omitted, the
 *     factor is auto-computed from the source's short side to reach ~1080p; a source already ≥1080p is
 *     a no-op (returns `inPath`).
 *   - `model` (optional): Topaz model name (defaults to config.fal.topazModel, 'Proteus').
 * @param {{inPath:string, outDir:string, factor?:number|string, model?:string}} p
 */
export async function upscaleVideoTopaz({ inPath, outDir, factor, model }) {
  if (!fs.existsSync(inPath)) throw new Error(`Topaz upscale: input not found: ${inPath}`);
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

  log.step(`fal Topaz upscale ${upscaleFactor}× [${model ?? FAL.topazModel}] : ${path.basename(inPath)}`);
  const up = await topazUpscale(inPath, { destDir: outDir, upscaleFactor, model });

  // Topaz can strip the audio track — if the source had audio and the upscaled file doesn't, re-mux it.
  if ((await hasAudio(inPath)) && !(await hasAudio(up))) {
    const muxed = path.join(outDir, 'upscaled_with_audio.mp4');
    await runBin(V.ffmpeg, ['-y', '-i', up, '-i', inPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', muxed]);
    log.info('Re-muxed the source audio onto the upscaled video (Topaz dropped the track).');
    return muxed;
  }
  log.info(`fal Topaz upscaled clip → ${up}`);
  return up;
}

export default { upscaleVideoTopaz, upscalePlan, probeDims };
