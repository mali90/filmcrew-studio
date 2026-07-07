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
//   --out-name <name>   base name for the out/ master (default: the project title; repeats get -2, -3, …)
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { assembleRun } from '../lib/pipeline.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

async function main() {
  const from = str('from') ?? args._[0];
  if (!from) throw new Error('Pass --from <run-dir> (the folder with spec.json + render.json, e.g. runs/render-…). A --probe run prints this path when it finishes.');
  const r = await assembleRun(from, { upscale: !!args.upscale, outName: str('out-name') });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
