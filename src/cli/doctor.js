#!/usr/bin/env node
// Preflight: check everything the pipeline needs before you spend on a render.
//   node src/cli/doctor.js           # human-readable report
//   node src/cli/doctor.js --json    # machine-readable (the web app's health/doctor endpoints)
// The check logic lives in src/lib/preflight.js (shared with the init wizard); this is a thin
// CLI wrapper that prints the report and sets the exit code.
import { runChecks, formatChecks, hardFailures, SOFT } from '../lib/preflight.js';

async function main() {
  const checks = await runChecks();
  const hard = hardFailures(checks);
  if (process.argv.includes('--json')) {
    const rows = checks.map((c) => ({ ...c, soft: SOFT.some((s) => c.label.startsWith(s)) }));
    process.stdout.write(JSON.stringify({ checks: rows, hard: hard.length, platform: process.platform }, null, 2) + '\n');
  } else {
    process.stdout.write(formatChecks(checks));
  }
  process.exit(hard.length ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`${e.stack || e.message}\n`); process.exit(1); });
