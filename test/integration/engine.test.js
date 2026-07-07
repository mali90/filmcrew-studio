import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { ROOT } from '../helpers/fixtures.js';

// Inject a fake LLM via the CLI transport: LLM_CLI_BIN points at an executable that prints the golden
// spec. No real API is ever contacted (LLM api URLs are hardcoded and unreachable with no key).
neutralizeDotenv();
const FAKE = path.join(ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);
Object.assign(process.env, { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake' });
const { runEngine } = await import('../../src/lib/engine.js');

test('golden fake: drives agents 0..6 + QC to a passing spec', async () => {
  const { dir, cleanup } = mkTmp('engine');
  try {
    const { spec, passed } = await runEngine({ brief: 'a lighthouse keeper at dusk', runDir: dir, maxFix: 2, maxQc: 2 });
    assert.equal(passed, true);
    assert.equal(spec.spec_version, '1.0');
    assert.equal(spec.qc.status, 'pass');
    assert.ok(fs.existsSync(path.join(dir, 'spec-06.json')));
    assert.ok(fs.existsSync(path.join(dir, 'spec.json')));
  } finally { cleanup(); }
});

test('backend: a seedance run plans and validates cleanly with the fake LLM', async () => {
  const { dir, cleanup } = mkTmp('engine-seedance');
  try {
    const { passed, spec } = await runEngine({ brief: 'a lighthouse keeper at dusk', runDir: dir, backend: 'seedance', maxFix: 2, maxQc: 2 });
    assert.equal(passed, true); // the golden jobs (13s) satisfy Seedance's 4s/job floor
    // the spec must remember which backend it was planned FOR — otherwise a later render
    // silently falls back to the config default and renders a seedance plan on kling
    assert.equal(spec.render_backend, 'seedance');
  } finally { cleanup(); }
});

test('backend: an unknown backend is rejected BEFORE any agent runs (no LLM spend, no run files)', async () => {
  const { dir, cleanup } = mkTmp('engine-badbackend');
  try {
    await assert.rejects(
      () => runEngine({ brief: 'x', runDir: dir, backend: 'sedance' }),
      /Unknown render backend "sedance"/,
    );
    assert.ok(!fs.existsSync(path.join(dir, 'spec-00.json')), 'no agent output was produced');
  } finally { cleanup(); }
});

test('bad-then-good: an agent that first returns an invalid section is re-prompted and recovers', async () => {
  const { dir, cleanup } = mkTmp('engine-retry');
  process.env.FAKE_LLM_MODE = 'bad-then-good';
  process.env.FAKE_LLM_STATE = path.join(dir, 'state.json');
  try {
    const { passed } = await runEngine({ brief: 'x', runDir: dir, maxFix: 2, maxQc: 2 });
    assert.equal(passed, true);
  } finally { delete process.env.FAKE_LLM_MODE; delete process.env.FAKE_LLM_STATE; cleanup(); }
});

test('qc-fail-once: a QC failure routes to [shots], re-runs, then passes', async () => {
  const { dir, cleanup } = mkTmp('engine-qc');
  process.env.FAKE_LLM_MODE = 'qc-fail-once';
  process.env.FAKE_LLM_STATE = path.join(dir, 'state.json');
  // the redo re-run must be observable on stderr — monitors track it via the "revising agent" step
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { stderrLines.push(String(chunk)); return origWrite(chunk, ...rest); };
  try {
    const { passed } = await runEngine({ brief: 'x', runDir: dir, maxFix: 2, maxQc: 2 });
    assert.equal(passed, true);
    assert.ok(stderrLines.some((l) => /Engine — revising agent 1-/.test(l)),
      'QC redo re-runs must log a "revising agent" step sentinel');
  } finally {
    process.stderr.write = origWrite;
    delete process.env.FAKE_LLM_MODE; delete process.env.FAKE_LLM_STATE; cleanup();
  }
});
