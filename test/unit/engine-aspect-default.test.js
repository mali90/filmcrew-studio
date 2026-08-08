// The aspect gate judges the EFFECTIVE ratio (codex P2, engine.js): when the CLI omits --aspect the
// plan inherits config.kling.aspectRatio (KLING_ASPECT), and an unsupported default must be rejected
// BEFORE any agent runs — a full planning pass on a spec the renderer refuses is real LLM spend for
// nothing. This file pins KLING_ASPECT=4:3 (legal on no currently-renderable model) at import time,
// which is why it lives alone: config snapshots env once per process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-aspect-default-'));
const PROFILES_DIR = path.join(tmpRoot, 'profiles');
const REFS_DIR = path.join(tmpRoot, 'refs');
const ENV_DIR = path.join(tmpRoot, 'environments');
const VOICES_DIR = path.join(tmpRoot, 'voices');
for (const d of [PROFILES_DIR, REFS_DIR, ENV_DIR, VOICES_DIR]) fs.mkdirSync(d, { recursive: true });

// An "LLM" that records the fact it was invoked — reaching it at all is the bug.
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
  PROFILES_DIR,
  ELEMENTS_REFERENCES_DIR: REFS_DIR,
  ENVIRONMENTS_DIR: ENV_DIR,
  VOICES_DIR,
  LLM_PROVIDER: 'claude',
  LLM_TRANSPORT: 'cli',
  LLM_CLI_BIN: FAKE_LLM,
  LLM_MODEL: 'fake',
  KLING_ASPECT: '4:3', // schema-legal (the widened superset) but renderable on no current model
});

const { buildCtx } = await import('../../src/lib/engine.js');

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('an unsupported KLING_ASPECT default is rejected pre-spend, and says where it came from', async () => {
  for (const backend of ['kling', 'seedance', 'seedance-2.0@fal']) {
    await assert.rejects(
      () => buildCtx({ brief: 'x', backend }),
      (e) => {
        assert.match(e.message, /Unknown aspect ratio "4:3"/);
        assert.match(e.message, /KLING_ASPECT config default/);
        return true;
      },
      backend,
    );
  }
  assert.ok(!fs.existsSync(MARKER), 'no agent ever ran');
});

test('an explicit --aspect wins over the bad default, and its own error names no default', async () => {
  const ctx = await buildCtx({ brief: 'x', backend: 'kling', aspectRatio: '16:9' });
  assert.equal(ctx.aspectRatio, '16:9');
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'kling', aspectRatio: '21:9' }),
    (e) => {
      assert.match(e.message, /Unknown aspect ratio "21:9"/);
      assert.ok(!/config default/.test(e.message), 'an explicit flag is not blamed on config');
      return true;
    },
  );
  assert.ok(!fs.existsSync(MARKER), 'no agent ever ran');
});
