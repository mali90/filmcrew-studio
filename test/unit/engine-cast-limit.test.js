// Per-model cast caps, layer 1 of 3 (engine). Every model has a hard ceiling on how many characters
// can be starred — kling-o3 1, seedance-2.0 2, seedance-2.5 4 — because each cast member burns
// reference-image slots. The check belongs in buildCtx, alongside the backend/aspect gate, so an
// over-starred run is rejected BEFORE the first agent prompt: an 8-agent plan that can never render
// is real LLM spend for nothing.
//
// The zero-spend claim is proved, not asserted: LLM_CLI_BIN points at a script that touches a marker
// file. If any agent ever ran, the marker exists.
//
// TDD (red first): buildCtx has no cast-cap check at all today.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-cast-cap-'));
const PROFILES_DIR = path.join(tmpRoot, 'profiles');
const REFS_DIR = path.join(tmpRoot, 'refs');
const ENV_DIR = path.join(tmpRoot, 'environments');
const VOICES_DIR = path.join(tmpRoot, 'voices');
for (const d of [PROFILES_DIR, REFS_DIR, ENV_DIR, VOICES_DIR]) fs.mkdirSync(d, { recursive: true });

const CAST = ['keeper', 'gull', 'crab', 'whale', 'squid'];
for (const c of CAST) fs.writeFileSync(path.join(PROFILES_DIR, `${c}.md`), `# ${c}\n\nA character.\n`);

// A "LLM" that records the fact it was invoked and fails — reaching it at all is the bug.
const MARKER = path.join(tmpRoot, 'llm-was-called');
const FAKE_LLM = path.join(tmpRoot, 'never-call-me.mjs');
fs.writeFileSync(FAKE_LLM, [
  '#!/usr/bin/env node',
  "import fs from 'node:fs';",
  `fs.appendFileSync(${JSON.stringify(MARKER)}, 'called\\n');`,
  'process.exit(1);',
].join('\n'));
fs.chmodSync(FAKE_LLM, 0o755);

Object.assign(process.env, {
  PROFILES_DIR, ELEMENTS_REFERENCES_DIR: REFS_DIR, ENVIRONMENTS_DIR: ENV_DIR, VOICES_DIR,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE_LLM, LLM_MODEL: 'fake',
});

const { buildCtx, runEngine } = await import('../../src/lib/engine.js');
const { castLimitFor } = await import('../../src/lib/render-models.js');

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('the caps this layer enforces are the registry\'s, not a second copy', () => {
  assert.equal(castLimitFor('kling'), 1);
  assert.equal(castLimitFor('seedance'), 2);
  assert.equal(castLimitFor('seedance-2.5'), 4);
});

test('buildCtx accepts a cast AT the model\'s limit', async () => {
  const kling = await buildCtx({ brief: 'x', backend: 'kling', cast: ['keeper'] });
  assert.deepEqual(kling.castNames, ['keeper']);
  const seedance = await buildCtx({ brief: 'x', backend: 'seedance', cast: ['keeper', 'gull'] });
  assert.deepEqual(seedance.castNames, ['keeper', 'gull']);
});

test('buildCtx rejects a cast OVER the limit, naming the model, the limit and the starred names', async () => {
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'kling', cast: ['keeper', 'gull'] }),
    (e) => {
      assert.match(e.message, /Kling 3\.0 Omni/, 'names the MODEL, not the backend id');
      assert.match(e.message, /\b1\b/, 'names the limit');
      assert.match(e.message, /keeper/);
      assert.match(e.message, /gull/);
      return true;
    },
  );
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'seedance', cast: ['keeper', 'gull', 'crab'] }),
    (e) => {
      assert.match(e.message, /Seedance 2\.0/);
      assert.match(e.message, /\b2\b/);
      return true;
    },
  );
  // the compound id behaves identically
  await assert.rejects(() => buildCtx({ brief: 'x', backend: 'kling-o3@fal', cast: ['keeper', 'gull'] }), /Kling 3\.0 Omni/);
});

test('the rejection costs ZERO LLM calls and writes no run files', async () => {
  const runDir = path.join(tmpRoot, 'run-over-cap');
  await assert.rejects(() => runEngine({ brief: 'a keeper and a gull', runDir, backend: 'kling', cast: ['keeper', 'gull'] }));
  assert.equal(fs.existsSync(MARKER), false, 'no agent prompt was ever sent — the cap fires before any spend');
  assert.equal(fs.existsSync(runDir), false, 'no half-written run dir left behind');
});

test('the cap fires BEFORE profile resolution — an over-cap list of unknown names still says "too many"', async () => {
  // ordering matters: reporting "unknown character" first would hide the real problem from the UI.
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'kling', cast: ['nobody-1', 'nobody-2'] }),
    /Kling 3\.0 Omni/,
  );
  assert.equal(fs.existsSync(MARKER), false);
});
