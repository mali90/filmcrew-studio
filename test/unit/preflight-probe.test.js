// The CLI presence probe behind the doctor's fixed llm check. runChecks() across env combos is
// covered end-to-end in test/e2e/doctor.cli.test.js (child-process isolation); here we unit-test the
// probe helper directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
const { probeCli, probeCliBin } = await import('../../src/lib/preflight.js');

test('probeCliBin: true for a real binary (node itself)', async () => {
  assert.equal(await probeCliBin(process.execPath), true);
});

test('probeCliBin: false for a binary that is not on PATH', async () => {
  assert.equal(await probeCliBin('no-such-cli-xyz-123'), false);
});

test('probeCli: reports installed + the first --version line', async () => {
  const { installed, version } = await probeCli(process.execPath);
  assert.equal(installed, true);
  assert.match(version, /^v?\d+\./); // `node --version` prints e.g. v20.11.0
});

test('probeCli: a missing bin resolves {installed:false} (no throw)', async () => {
  assert.deepEqual(await probeCli('no-such-cli-xyz-123'), { installed: false, version: null });
});
