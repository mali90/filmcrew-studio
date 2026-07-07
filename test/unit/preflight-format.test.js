import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { formatChecks, hardFailures, SOFT } = await import('../../src/lib/preflight.js');

const CHECKS = [
  { ok: true, label: 'ffmpeg present (ffmpeg)', hint: '' },
  { ok: false, label: 'FAL_KEY set (transport=fal)', hint: 'get a key' },
  { ok: false, label: 'character voices registered (0)', hint: 'mint one' }, // SOFT
];

test('hardFailures excludes SOFT-prefixed labels', () => {
  const hard = hardFailures(CHECKS);
  assert.equal(hard.length, 1);
  assert.equal(hard[0].label, 'FAL_KEY set (transport=fal)');
  assert.ok(SOFT.includes('character voices'));
});

test('formatChecks renders ✅/❌ lines + a summary line', () => {
  const out = formatChecks(CHECKS);
  assert.match(out, /✅ {2}ffmpeg present/);
  assert.match(out, /❌ {2}FAL_KEY set.*→ get a key/);
  assert.match(out, /2 issue\(s\) — fix the ❌ above before rendering\./);
});

test('all-pass summary line', () => {
  assert.match(formatChecks([{ ok: true, label: 'x', hint: '' }]), /All checks passed — ready\./);
});
