#!/usr/bin/env node
// Re-render ONE job of a spec as a new take — without touching the other jobs' clips.
//
//   node src/cli/render-job.js --spec runs/<id>/spec.json --job K2 --out runs/<id>/renders/t3
//   --seam-from <dir>   a PRIOR render dir: the previous job's last_frame.png seeds this job's
//                       opening frame (same cross-job chaining a full render does)
//   --take <n>          retake variation (Seedance: "Alternate take n" prompt nonce; Kling renders
//                       are naturally fresh takes — fal accepts no seed)
//   --feedback "…"      per-take director note (Seedance prompt front matter; for Kling, revise
//                       the spec instead: npm run revise)
//   --probe             render this job at the probe resolution (Seedance 480p; Kling ignores it)
//   --first-frame-from <path>  pin this job's OPENING frame. A still (.png/.jpg) is used as it is;
//                       a CLIP has its LAST frame grabbed ("start where that clip ended").
//   --last-frame-from <path>   pin this job's CLOSING frame. A still as it is; a CLIP has its
//                       FIRST frame grabbed ("end where that clip begins").
//   --no-first-frame / --no-last-frame  decide that end the OTHER way: the spec's authored
//                       first_frame/last_frame is dropped for this take, so the opening falls
//                       through to --seam-from (or to nothing) and the ending is a plain cut. This
//                       is how a caller that chose the boundaries itself — the web re-render dialog
//                       — says an excluded end really is free, instead of leaving it to whatever
//                       the spec happened to author.
//   --prompt-overrides <file>  a prompt-overrides.json sidecar — parsed and validated before any
//                       submit, then snapshotted into the take dir
//
// Opening-frame precedence: --first-frame-from  >  the spec's authored job.first_frame  >  the
// frame --seam-from derives from the prior take. (Closing frame: --last-frame-from > job.last_frame.)
//
// Prints JSON: { jobId, clip, staleDownstream } — staleDownstream lists jobs whose seams were
// chained from the OLD take (re-render them too for a continuous seam).
import path from 'node:path';
import fs from 'node:fs';
import config, { resolvePath } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { readJson, newRunId } from '../lib/util.js';
import { renderJob } from '../lib/pipeline.js';
import { readPromptOverrides } from '../lib/prompt-overrides.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

async function main() {
  const specArg = str('spec') ?? args._[0];
  const jobId = str('job');
  if (!specArg || !jobId) throw new Error('Pass --spec <spec.json> and --job <job_id> (e.g. --job K2).');
  const spec = await readJson(resolvePath(specArg));

  const take = str('take') === undefined ? 0 : Number(str('take'));
  if (!Number.isInteger(take) || take < 0) throw new Error(`--take must be a non-negative integer (got "${str('take')}").`);

  // Boundary and override flags are checked BEFORE anything is queued, and before a run dir is even
  // created: a typo must cost nothing, not a render and not a stray directory.
  // Pinning an end and freeing it are two different answers to the same question — say which,
  // rather than letting one silently outrank the other.
  for (const [end, from] of [['first', 'first-frame-from'], ['last', 'last-frame-from']]) {
    if (args[`no-${end}-frame`] && str(from)) throw new Error(`--no-${end}-frame contradicts --${from} — pass one.`);
  }
  for (const flag of ['first-frame-from', 'last-frame-from', 'prompt-overrides']) {
    const v = str(flag);
    if (v && !fs.existsSync(resolvePath(v))) throw new Error(`--${flag}: no such file — ${v}`);
  }
  const overrides = str('prompt-overrides');
  if (overrides) readPromptOverrides(resolvePath(overrides)); // shape errors, before any spend

  const runDir = str('out') ? resolvePath(str('out')) : path.join(resolvePath(config.paths.runs), newRunId(`job-${jobId.toLowerCase()}`));
  const r = await renderJob(spec, jobId, {
    runDir,
    backend: str('backend'),
    take,
    feedback: str('feedback'),
    seamFrom: str('seam-from'),
    firstFrameFrom: str('first-frame-from'),
    lastFrameFrom: str('last-frame-from'),
    clearFirstFrame: !!args['no-first-frame'],
    clearLastFrame: !!args['no-last-frame'],
    promptOverrides: overrides,
    lowRes: !!args.probe,
  });

  process.stdout.write(JSON.stringify({ runDir, ...r }, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
