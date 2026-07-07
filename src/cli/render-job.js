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
//
// Prints JSON: { jobId, clip, staleDownstream } — staleDownstream lists jobs whose seams were
// chained from the OLD take (re-render them too for a continuous seam).
import path from 'node:path';
import config, { resolvePath } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { readJson, newRunId } from '../lib/util.js';
import { renderJob } from '../lib/pipeline.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

async function main() {
  const specArg = str('spec') ?? args._[0];
  const jobId = str('job');
  if (!specArg || !jobId) throw new Error('Pass --spec <spec.json> and --job <job_id> (e.g. --job K2).');
  const spec = await readJson(resolvePath(specArg));

  const take = str('take') === undefined ? 0 : Number(str('take'));
  if (!Number.isInteger(take) || take < 0) throw new Error(`--take must be a non-negative integer (got "${str('take')}").`);

  const runDir = str('out') ? resolvePath(str('out')) : path.join(resolvePath(config.paths.runs), newRunId(`job-${jobId.toLowerCase()}`));
  const r = await renderJob(spec, jobId, {
    runDir,
    backend: str('backend'),
    take,
    feedback: str('feedback'),
    seamFrom: str('seam-from'),
    lowRes: !!args.probe,
  });

  process.stdout.write(JSON.stringify({ runDir, ...r }, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
