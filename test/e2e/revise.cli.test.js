import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, jsonTail } from '../helpers/cli.js';
import { mkTmp } from '../helpers/tmp.js';
import { ROOT, loadGoldenSpec } from '../helpers/fixtures.js';

const FAKE = path.join(ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);
const LLM_ENV = { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake' };

test('revise CLI: revises a run dir\'s spec into revisions/r1 with the default owners route', async () => {
  const { dir, cleanup } = mkTmp('revise-cli');
  try {
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(loadGoldenSpec()));
    const { code, stdout } = await runCli('src/cli/revise.js',
      ['--from', dir, '--feedback', 'make the storm feel bigger'],
      { env: LLM_ENV });
    assert.equal(code, 0, stdout);
    const r = jsonTail(stdout);
    assert.equal(r.passed, true);
    assert.deepEqual(r.owners, [2], 'fake router default routes to content');
    assert.equal(r.runDir, path.join(dir, 'revisions', 'r1'), 'default out dir is the next revisions/rN');
    assert.ok(fs.existsSync(path.join(r.runDir, 'spec.json')));
    assert.ok(fs.existsSync(path.join(r.runDir, 'feedback.json')));
    // a second revision lands in r2, never overwriting r1
    const second = await runCli('src/cli/revise.js', ['--from', dir, '--feedback', 'even bigger'], { env: LLM_ENV });
    assert.equal(second.code, 0, second.stdout);
    assert.equal(jsonTail(second.stdout).runDir, path.join(dir, 'revisions', 'r2'));
  } finally { cleanup(); }
});

test('revise CLI: --owners pins the agents, --scope narrows to a job', async () => {
  const { dir, cleanup } = mkTmp('revise-cli-owners');
  try {
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(loadGoldenSpec()));
    const { code, stdout } = await runCli('src/cli/revise.js',
      ['--from', dir, '--feedback', 'slower pacing', '--owners', '1', '--scope', 'K1', '--out', path.join(dir, 'rev')],
      { env: LLM_ENV });
    assert.equal(code, 0, stdout);
    const r = jsonTail(stdout);
    assert.deepEqual(r.owners, [1]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'rev', 'feedback.json'), 'utf8'));
    assert.equal(meta.scope, 'K1');
  } finally { cleanup(); }
});

test('revise CLI: missing --feedback is a usage error', async () => {
  const { dir, cleanup } = mkTmp('revise-cli-usage');
  try {
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(loadGoldenSpec()));
    const { code, stderr } = await runCli('src/cli/revise.js', ['--from', dir], { env: LLM_ENV });
    assert.equal(code, 1);
    assert.match(stderr, /--feedback/);
  } finally { cleanup(); }
});
