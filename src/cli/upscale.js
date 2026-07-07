#!/usr/bin/env node
// Upscale an existing mp4 with fal Topaz (preserves the take; re-muxes audio if Topaz drops it).
//
//   node src/cli/upscale.js --in out/ocean-lighthouse.mp4 [--factor 2] [--model Proteus] [--out out]
//   (omit --factor to auto-pick the factor that lifts the short side to ~1080p; a ≥1080p input is a no-op)
import config, { resolvePath } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { upscaleVideoTopaz } from '../lib/upscale.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

async function main() {
  const inPath = str('in') ?? args._[0];
  if (!inPath) throw new Error('Pass --in <video.mp4>.');
  const clip = await upscaleVideoTopaz({
    inPath: resolvePath(inPath),
    outDir: resolvePath(str('out') ?? config.paths.out),
    factor: str('factor'),
    model: str('model'),
  });
  process.stdout.write(JSON.stringify({ upscaled: clip }, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
