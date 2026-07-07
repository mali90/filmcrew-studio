#!/usr/bin/env node
// Fake LLM CLI for engine tests. Reads the prompt on stdin (like claude/codex/gemini), prints ONLY
// the JSON spec on stdout — the golden spec passes every agent gate + QC, so the engine converges.
// FAKE_LLM_MODE (via env): 'golden' (default) | 'bad-then-good' (agent 0 fails once, then recovers)
// | 'qc-fail-once' (QC fails once → routes to [shots] → then passes). Call counter in FAKE_LLM_STATE.
// FAKE_LLM_ROUTER (env): reply for '# REVISION ROUTER' prompts (default {"tags":["content"]}).
// FAKE_LLM_DUMP (env): a dir — every received prompt is written there as prompt-<n>.txt, so tests
// can assert what actually reached the model (e.g. that director feedback rode along).
// TWO-JOB (in the prompt, i.e. in the brief/idea): the golden plan's single K1 job is split into
// K1+K2 — per-run knob for probe tests, since probes only exist on multi-job plans.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// FAKE_LLM_SLEEP_MS (env): hold each completion open — probes use it to observe mid-work UI.
const sleepMs = Number(process.env.FAKE_LLM_SLEEP_MS || 0);
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/ocean-lighthouse/spec.json'), 'utf8'));
const mode = process.env.FAKE_LLM_MODE || 'golden';
const stateFile = process.env.FAKE_LLM_STATE;

let n = 0;
if (stateFile) { try { n = JSON.parse(fs.readFileSync(stateFile, 'utf8')).n || 0; } catch { /* first call */ } }

const spec = JSON.parse(JSON.stringify(golden));
if (mode === 'bad-then-good' && n === 0) spec.project.duration_target_s = 999; // fails validateSpec(upTo:0) once
if (mode === 'qc-fail-once' && n === 7) { // first QC call (agents 0..6 were clean → no retries)
  spec.qc = { status: 'fail', checks: [{ check: '[shots] the storyboard is weak', passed: false }], notes: '[shots] weak' };
}
const specOut = JSON.stringify(spec);
if (stateFile) { try { fs.writeFileSync(stateFile, JSON.stringify({ n: n + 1 })); } catch { /* best effort */ } }

// Consume stdin (so the parent's stdin.end() doesn't EPIPE), then print. The reply depends on the
// PROMPT: router prompts get a tags object, everything else gets the (mode-mutated) spec.
let buf = '';
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_LLM_DUMP) {
    try {
      fs.mkdirSync(process.env.FAKE_LLM_DUMP, { recursive: true });
      // pid makes the name unique per call even without FAKE_LLM_STATE (each call is a fresh process)
      fs.writeFileSync(path.join(process.env.FAKE_LLM_DUMP, `prompt-${String(n).padStart(3, '0')}-${process.pid}.txt`), buf);
    } catch { /* best effort */ }
  }
  let out = specOut;
  if (buf.includes('# REVISION ROUTER')) {
    out = process.env.FAKE_LLM_ROUTER || '{"tags":["content"]}';
  } else if (buf.includes('TWO-JOB')) {
    // the brief rides every agent prompt, so all 8 calls agree on the same two-job plan
    const s = JSON.parse(specOut);
    const [job] = s.kling.jobs;
    s.kling.jobs = [
      { ...job, job_id: 'K1', shots: job.shots.slice(0, -1) },
      { ...job, job_id: 'K2', shots: job.shots.slice(-1) },
    ];
    out = JSON.stringify(s);
  }
  process.stdout.write(out);
});
process.stdin.resume();
