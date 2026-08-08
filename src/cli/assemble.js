#!/usr/bin/env node
// Finish/assemble an EXISTING render run into a final mp4 — without re-rendering (no render cost).
// Reads the run's spec.json + render.json and runs the assembly tail (stitch in job order →
// optional fal Topaz upscale → cover frame) on the clips already on disk.
// Handy to "promote" a --probe clip (the first job of a multi-job plan) into out/, or to
// re-finish any prior run.
//
//   node src/cli/assemble.js --from runs/render-2026…-abcdef
//   node src/cli/assemble.js --from runs/render-2026…-abcdef --upscale   # also Topaz-upscale the master
//   node src/cli/assemble.js runs/render-2026…-abcdef                    # --from may be positional
//   --out-name <name>     base name for the out/ master (default: the project title; repeats get -2, -3, …)
//   --continuity 1,0,1    which JOINTS are chained (one 1/0 per seam, so N-1 values for N clips):
//                         1 = the next clip was rendered from this one's last frame and can be
//                         stitched seamlessly, 0 = a scene cut. Overrides what the run recorded —
//                         use it when you know the lineage and the manifest does not.
//   --stitcher <mode>     force | off (default: whatever STITCH_SEAMLESS says, normally auto).
//                         `force` turns any fallback into an error instead of a hard-cut master.
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

/** "1,0,1" → [true,false,true]. Anything else is a hard error: a wrong flag here drops real frames. */
function parseContinuity(raw) {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((t) => t.trim()).filter(Boolean);
  if (!parts.length || parts.some((t) => t !== '0' && t !== '1')) {
    throw new Error(`--continuity takes one 1 or 0 per JOINT, comma-separated (e.g. --continuity 1,0,1) — got "${raw}"`);
  }
  return parts.map((t) => t === '1');
}

async function main() {
  const from = str('from') ?? args._[0];
  if (!from) throw new Error('Pass --from <run-dir> (the folder with spec.json + render.json, e.g. runs/render-…). A --probe run prints this path when it finishes.');
  const continuity = parseContinuity(str('continuity'));

  // --stitcher is a front door to STITCH_SEAMLESS; set it before pipeline.js pulls in config.js,
  // which snapshots the environment at import.
  const stitcher = str('stitcher');
  if (stitcher) {
    if (!['force', 'off', 'auto'].includes(stitcher)) throw new Error(`--stitcher takes force, off or auto — got "${stitcher}"`);
    process.env.STITCH_SEAMLESS = stitcher;
  }
  const { assembleRun } = await import('../lib/pipeline.js');

  const r = await assembleRun(from, { upscale: !!args.upscale, outName: str('out-name'), continuity });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
