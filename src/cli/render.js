#!/usr/bin/env node
// Render an existing Production Spec (engine output or hand-authored) → a final mp4.
//
//   node src/cli/render.js --spec examples/ocean-lighthouse/spec.json
//   node src/cli/render.js --spec runs/x/spec.json --probe          # multi-job specs only: first job, no stitch
//   node src/cli/render.js --spec runs/x/spec.json --upscale        # also fal Topaz-upscale sub-1080p clips
//   node src/cli/render.js --spec runs/x/spec.json --backend seedance [--take 2]
//     --backend <model>@<provider>  overrides spec.render_backend / RENDER_BACKEND
//                               (kling-o3@fal | seedance-2.0@fal; legacy kling|seedance still accepted)
//     --take <n>                Seedance regen knob: same spec, "Alternate take n" (it accepts no seed)
//     --first-frame-from <path> pin the FIRST job's opening frame. A still (.png/.jpg) is used as
//                               it is; a CLIP has its LAST frame grabbed ("start where that clip ended").
//     --last-frame-from <path>  pin the LAST job's closing frame. A still as it is; a CLIP has its
//                               FIRST frame grabbed ("end where that clip begins").
//     --prompt-overrides <file> a prompt-overrides.json sidecar — parsed and validated before any
//                               submit, then snapshotted into the run dir
import path from 'node:path';
import fs from 'node:fs';
import config, { resolvePath } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { readJson, newRunId } from '../lib/util.js';
import { renderSpec } from '../lib/pipeline.js';
import { readPromptOverrides } from '../lib/prompt-overrides.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

async function main() {
  const specArg = str('spec') ?? args._[0];
  if (!specArg) throw new Error('Pass --spec <spec.json> (e.g. examples/ocean-lighthouse/spec.json).');
  const spec = await readJson(resolvePath(specArg));
  if (args.probe && (spec?.kling?.jobs?.length ?? 0) < 2) {
    throw new Error('--probe needs a multi-job spec: this plan renders as a single job, so a probe would be the full render anyway. Run again without --probe.');
  }

  // Boundary and override flags are checked BEFORE anything is queued, and before a run dir is even
  // created: a typo must cost nothing, not a render and not a stray directory.
  const overrides = str('prompt-overrides');
  if (overrides) readPromptOverrides(resolvePath(overrides));
  for (const flag of ['first-frame-from', 'last-frame-from']) {
    const v = str(flag);
    if (v && !fs.existsSync(resolvePath(v))) throw new Error(`--${flag}: no such file — ${v}`);
  }

  const runDir = str('out') ? resolvePath(str('out')) : path.join(resolvePath(config.paths.runs), newRunId('render'));
  const take = str('take') === undefined ? undefined : Number(str('take'));
  if (take !== undefined && (!Number.isInteger(take) || take < 0)) {
    throw new Error(`--take must be a non-negative integer (got "${str('take')}") — it names the retake variation.`);
  }
  const r = await renderSpec(spec, { runDir, probe: !!args.probe, upscale: !!args.upscale, backend: str('backend'), take, outName: str('out-name'),
    firstFrameFrom: str('first-frame-from'), lastFrameFrom: str('last-frame-from'), promptOverrides: overrides });

  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
