#!/usr/bin/env node
// Revise an EXISTING Production Spec from director feedback — the feedback is routed back through
// the 8-agent engine (explicit --owners > a block-name --scope > an LLM router), the owning agents
// re-run with the feedback in their prompt, and the QC gate re-checks the result. LLM cost only —
// nothing is rendered.
//
//   node src/cli/revise.js --from runs/<id> --feedback "the keeper looks too young" [--out <dir>]
//   node src/cli/revise.js --from runs/<id> --feedback "…" --scope K2      # only job K2's shots
//   node src/cli/revise.js --from runs/<id> --feedback "…" --owners 2,3    # pin the agents yourself
//
// --from may also point directly at a spec.json. Artifacts in --out (default: <from>/revisions/r<N>):
// feedback.json, spec-rNN.json per re-run agent, spec-r07-qcN.json per QC cycle, final spec.json.
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { readJson } from '../lib/util.js';
import { reviseSpec } from '../lib/engine.js';

const args = parseArgs();
const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : undefined);

/** Next free revisions/r<N> under a run dir. */
function nextRevisionDir(fromDir) {
  for (let n = 1; ; n++) {
    const p = path.join(fromDir, 'revisions', `r${n}`);
    if (!fs.existsSync(p)) return p;
  }
}

async function main() {
  const from = str('from') ?? args._[0];
  if (!from) throw new Error('Pass --from <run-dir or spec.json> (the plan to revise).');
  const fromPath = resolvePath(from);
  const specPath = fromPath.endsWith('.json') ? fromPath : path.join(fromPath, 'spec.json');
  const spec = await readJson(specPath);

  const feedback = str('feedback');
  if (!feedback) throw new Error('Pass --feedback "what should change" (free text; it re-runs the planning agents).');
  const owners = str('owners')?.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));

  const runDir = str('out') ? resolvePath(str('out')) : nextRevisionDir(path.dirname(specPath));
  const r = await reviseSpec({
    spec, runDir, feedback,
    scope: str('scope'),
    owners: owners?.length ? owners : undefined,
    backend: str('backend'),
    aspectRatio: str('aspect'),
  });

  log.info(`\nRevision ${r.passed ? '✓ QC pass' : '✗ QC not passed'} — agents re-run: [${r.owners.join(', ')}]`);
  process.stdout.write(JSON.stringify({ runDir, passed: r.passed, owners: r.owners, spec: r.spec }, null, 2) + '\n');
}

main().catch((e) => { log.error(e); process.exit(1); });
