import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../helpers/cli.js';

test('doctor exits 0 with a fully-configured fake env', async () => {
  const { code, stdout } = await runCli('src/cli/doctor.js', [], {
    env: { FAL_KEY: 'fake', LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: process.execPath },
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /FAL_KEY set/);
  assert.match(stdout, /ready\.|All checks passed/);
});

test('doctor --json: machine-readable checks with soft flags (the web app consumes this)', async () => {
  const { code, stdout } = await runCli('src/cli/doctor.js', ['--json'], {
    env: { FAL_KEY: 'fake', LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: process.execPath },
  });
  assert.equal(code, 0, stdout);
  const r = JSON.parse(stdout);
  assert.equal(r.hard, 0);
  assert.ok(Array.isArray(r.checks) && r.checks.length >= 5);
  for (const c of r.checks) {
    assert.equal(typeof c.ok, 'boolean');
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.soft, 'boolean');
  }
  const voices = r.checks.find((c) => c.label.startsWith('character voices'));
  assert.equal(voices?.soft, true, 'voice check is soft');
});

test('doctor --json exits 1 with hard>0 when FAL_KEY is missing', async () => {
  const { code, stdout } = await runCli('src/cli/doctor.js', ['--json'], {
    env: { FAL_KEY: '', LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: process.execPath },
  });
  assert.equal(code, 1);
  const r = JSON.parse(stdout);
  assert.ok(r.hard >= 1);
  assert.equal(r.checks.find((c) => c.label === 'FAL_KEY set')?.ok, false);
});

test('doctor exits 1 when FAL_KEY is missing', async () => {
  const { code, stdout } = await runCli('src/cli/doctor.js', [], {
    env: { FAL_KEY: '', LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: process.execPath },
  });
  assert.equal(code, 1);
  assert.match(stdout, /❌/);
  assert.match(stdout, /FAL_KEY set/);
});

test('doctor: cli transport with an uninstalled bin fails the llm check (the fixed hardcoded-green bug)', async () => {
  const { code, stdout } = await runCli('src/cli/doctor.js', ['--json'], {
    env: { FAL_KEY: 'fake', LLM_PROVIDER: 'openai', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: '/no/such/cli-xyz' },
  });
  assert.equal(code, 1, stdout);
  const r = JSON.parse(stdout);
  assert.equal(r.checks.find((c) => c.id === 'llm')?.ok, false, 'llm must be red when the CLI bin is not on PATH');
});

test('doctor: api transport checks the SELECTED provider key, not a cross-provider fallback', async () => {
  // Only a Claude key is set, but the provider is OpenAI → the llm check must fail (was a silent pass).
  const { stdout } = await runCli('src/cli/doctor.js', ['--json'], {
    env: { FAL_KEY: 'fake', LLM_PROVIDER: 'openai', LLM_TRANSPORT: 'api', ANTHROPIC_API_KEY: 'sk-ant-fake' },
  });
  const r = JSON.parse(stdout);
  assert.equal(r.checks.find((c) => c.id === 'llm')?.ok, false, 'a Claude key must NOT satisfy an OpenAI check');
});
