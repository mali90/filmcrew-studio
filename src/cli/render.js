#!/usr/bin/env node
// Render an existing Production Spec (engine output or hand-authored) → a final mp4.
//
//   node src/cli/render.js --spec examples/ocean-lighthouse/spec.json
//   node src/cli/render.js --spec runs/x/spec.json --probe          # multi-job specs only: first job, no stitch
//   node src/cli/render.js --spec runs/x/spec.json --upscale        # also fal Topaz-upscale sub-1080p clips
//   node src/cli/render.js --spec runs/x/spec.json --backend seedance [--take 2]
//     --backend kling|seedance  overrides spec.render_backend / RENDER_BACKEND
//     --take <n>                Seedance regen knob: same spec, "Alternate take n" (it accepts no seed)
import path from 'node:path';
import config, { resolvePath } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { readJson, newRunId } from '../lib/util.js';
import { renderSpec } from '../lib/pipeline.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

async function main() {
  const specArg = str('spec') ?? args._[0];
  if (!specArg) throw new Error('Pass --spec <spec.json> (e.g. examples/ocean-lighthouse/spec.json).');
  const spec = await readJson(resolvePath(specArg));
  if (args.probe && (spec?.kling?.jobs?.length ?? 0) < 2) {
    throw new Error('--probe needs a multi-job spec: this plan renders as a single job, so a probe would be the full render anyway. Run again without --probe.');
  }

  const runDir = str('out') ? resolvePath(str('out')) : path.join(resolvePath(config.paths.runs), newRunId('render'));
  const take = str('take') === undefined ? undefined : Number(str('take'));
  if (take !== undefined && (!Number.isInteger(take) || take < 0)) {
    throw new Error(`--take must be a non-negative integer (got "${str('take')}") — it names the retake variation.`);
  }
  const r = await renderSpec(spec, { runDir, probe: !!args.probe, upscale: !!args.upscale, backend: str('backend'), take, outName: str('out-name') });

  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
