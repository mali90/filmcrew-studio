#!/usr/bin/env node
// MAIN entry. Run the 8-agent engine on a brief → a render-ready spec, then optionally render it.
//
//   node src/cli/engine.js --brief "A cat reviews expensive cheese, deadpan" [--out runs/cheese]
//   node src/cli/engine.js --brief-file examples/ocean-lighthouse/brief.txt --render [--probe] [--upscale]
//   node src/cli/engine.js --brief "…" --render --backend seedance   # plan + render on Seedance 2.0
//   echo "a brief…" | node src/cli/engine.js --render
import fsp from 'node:fs/promises';
import path from 'node:path';
import config, { resolvePath } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs, readStdin } from '../lib/args.js';
import { newRunId } from '../lib/util.js';
import { runEngine } from '../lib/engine.js';
import { renderSpec } from '../lib/pipeline.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

async function main() {
  let brief = str('brief') ?? '';
  if (!brief && str('brief-file')) brief = (await fsp.readFile(resolvePath(str('brief-file')), 'utf8')).trim();
  if (!brief) brief = (await readStdin()).trim();
  if (!brief) throw new Error('No brief. Use --brief "<text>", --brief-file <path>, or pipe it on stdin.');

  const runDir = str('out') ? resolvePath(str('out')) : path.join(resolvePath(config.paths.runs), newRunId('engine'));
  const durationTargetS = args.duration && args.duration !== true ? Number(args.duration) : undefined;
  const aspectRatio = str('aspect');
  const cast = str('cast')?.split(',').map((s) => s.trim()).filter(Boolean); // star these profiles (comma-separated names)
  const environment = str('environment'); // a SINGLE world/mood/style bible (not comma-split — exactly one environment per idea)

  log.step(`Content Engine — run dir ${path.relative(config.root, runDir)}`);
  log.info(`Brief: ${brief.slice(0, 200)}${brief.length > 200 ? '…' : ''}`);

  const backend = str('backend');
  const { spec, passed } = await runEngine({ brief, runDir, durationTargetS, backend, aspectRatio, cast, environment });
  if (backend) {
    // Stamp the explicit choice into the persisted spec so re-renders/assembles of this run
    // pick the same backend without the flag.
    spec.render_backend = backend;
    await fsp.writeFile(path.join(runDir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
  }
  log.info(`\nEngine ${passed ? '✓ QC pass' : '✗ QC not passed'} — spec: ${path.relative(config.root, path.join(runDir, 'spec.json'))}`);

  let master = null;
  if (args.render) {
    if (!passed) log.warn('Spec did not pass QC; rendering anyway (--render).');
    // --probe only pays off on multi-job plans (it renders just the first job). The plan's job
    // count isn't known when the flag is typed, so a single-job plan downgrades with a warning
    // instead of stranding the run after planning.
    let probe = !!args.probe;
    if (probe && (spec?.kling?.jobs?.length ?? 0) < 2) {
      log.warn('--probe ignored: the plan renders as a single job, so a probe would be the full render anyway. Rendering it fully.');
      probe = false;
    }
    const r = await renderSpec(spec, { runDir: path.join(runDir, 'render'), probe, upscale: !!args.upscale, backend });
    master = r.master ?? r.clip ?? null;
  } else {
    log.info('Spec only (pass --render to generate the video).');
  }

  process.stdout.write(JSON.stringify({ runDir, passed, spec: path.join(runDir, 'spec.json'), master }, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
