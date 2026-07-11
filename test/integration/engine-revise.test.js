// reviseSpec routes director feedback back through the owning agents (fake LLM), re-runs QC, and
// leaves an auditable artifact trail (feedback.json, spec-rNN.json, spec-r07-qcN.json, spec.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { ROOT, loadGoldenSpec } from '../helpers/fixtures.js';

neutralizeDotenv();
const FAKE = path.join(ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);
// Isolated environments dir (config.js snapshots it at import) — holds the file a revision re-derives
// from the persisted spec.environment; absent-environment revisions are unaffected (loadEnvironment
// returns '' when no environment is selected).
const ENV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-revise-env-'));
fs.writeFileSync(path.join(ENV_DIR, 'harbor-town.md'), '# Harbor Town\n\nGrey docks, foghorns, wet cobbles.\n');
Object.assign(process.env, { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake', ENVIRONMENTS_DIR: ENV_DIR });
const { reviseSpec } = await import('../../src/lib/engine.js');

test.after(() => fs.rmSync(ENV_DIR, { recursive: true, force: true }));

test('re-injection: a revision re-derives the environment from the persisted spec and re-stamps it', async () => {
  const { dir, cleanup } = mkTmp('revise-environment');
  try {
    const seed = loadGoldenSpec();
    seed.environment = 'harbor-town'; // engine-stamped top-level key (parity with spec.cast)
    const { spec, passed } = await reviseSpec({ spec: seed, runDir: dir, feedback: 'more fog on the water', owners: [2] });
    assert.equal(passed, true);
    assert.equal(spec.environment, 'harbor-town', 'the revised spec still carries the environment slug');
  } finally { cleanup(); }
});

test('explicit owners: re-runs exactly those agents + QC, with the feedback in their prompts', async () => {
  const { dir, cleanup } = mkTmp('revise-owners');
  const dump = mkTmp('revise-dump');
  process.env.FAKE_LLM_DUMP = dump.dir;
  try {
    const { spec, passed, owners } = await reviseSpec({
      spec: loadGoldenSpec(), runDir: dir,
      feedback: 'the keeper should look much older', owners: [2, 3],
    });
    assert.equal(passed, true);
    assert.deepEqual(owners, [2, 3]);
    assert.equal(spec.spec_version, '1.0');
    for (const f of ['feedback.json', 'spec-r02.json', 'spec-r03.json', 'spec-r07-qc1.json', 'spec.json']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${f} written`);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8'));
    assert.equal(meta.feedback, 'the keeper should look much older');
    assert.deepEqual(meta.owners, [2, 3]);
    // the feedback actually reached the agents' prompts (dumped by the fake LLM)
    const prompts = fs.readdirSync(dump.dir).map((f) => fs.readFileSync(path.join(dump.dir, f), 'utf8'));
    assert.equal(prompts.length, 3, 'two owners + one QC call — no router call with explicit owners');
    for (const p of prompts) {
      assert.match(p, /DIRECTOR FEEDBACK \(revision\)/);
      assert.match(p, /the keeper should look much older/);
    }
  } finally { delete process.env.FAKE_LLM_DUMP; dump.cleanup(); cleanup(); }
});

test('router path: free-text feedback is routed by the LLM router ({"tags":…} → owners)', async () => {
  const { dir, cleanup } = mkTmp('revise-router');
  process.env.FAKE_LLM_ROUTER = '{"tags":["audio","camera"]}';
  try {
    const { owners, passed } = await reviseSpec({
      spec: loadGoldenSpec(), runDir: dir, feedback: 'the waves should sound louder and the camera should be lower',
    });
    assert.deepEqual(owners, [3, 5]);
    assert.equal(passed, true);
    assert.ok(fs.existsSync(path.join(dir, 'spec-r03.json')));
    assert.ok(fs.existsSync(path.join(dir, 'spec-r05.json')));
  } finally { delete process.env.FAKE_LLM_ROUTER; cleanup(); }
});

test('job scope: narrows the note to that job\'s shots; router still picks the agents', async () => {
  const { dir, cleanup } = mkTmp('revise-scope');
  const dump = mkTmp('revise-scope-dump');
  process.env.FAKE_LLM_DUMP = dump.dir;
  try {
    const { owners } = await reviseSpec({
      spec: loadGoldenSpec(), runDir: dir, feedback: 'less fog in these shots', scope: 'K1',
    });
    assert.deepEqual(owners, [2], 'default router reply routes to content');
    const prompts = fs.readdirSync(dump.dir).map((f) => fs.readFileSync(path.join(dump.dir, f), 'utf8'));
    const agentPrompts = prompts.filter((p) => p.includes('DIRECTOR FEEDBACK'));
    assert.ok(agentPrompts.length >= 1);
    for (const p of agentPrompts) assert.match(p, /concerns ONLY job K1 \(shots S1, S2, S3\)/);
  } finally { delete process.env.FAKE_LLM_DUMP; dump.cleanup(); cleanup(); }
});

test('guards: empty feedback and invalid starting spec are rejected before any LLM call', async () => {
  const { dir, cleanup } = mkTmp('revise-guards');
  try {
    await assert.rejects(() => reviseSpec({ spec: loadGoldenSpec(), runDir: dir, feedback: '  ' }), /non-empty feedback/);
    await assert.rejects(() => reviseSpec({ spec: { spec_version: '2.0' }, runDir: dir, feedback: 'x' }), /valid spec/);
    await assert.rejects(() => reviseSpec({ spec: loadGoldenSpec(), runDir: dir, feedback: 'x', owners: [9] }), /agent indices 0–6/);
    // a typo'd scope must not silently widen into a whole-spec revision
    await assert.rejects(() => reviseSpec({ spec: loadGoldenSpec(), runDir: dir, feedback: 'x', scope: 'K9' }), /Unknown revision scope "K9"/);
    await assert.rejects(() => reviseSpec({ spec: loadGoldenSpec(), runDir: dir, feedback: 'x', scope: 'contnet' }), /Unknown revision scope/);
  } finally { cleanup(); }
});
