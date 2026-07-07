import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { validateFal } = await import('../../src/lib/fal.js');

// Empty key short-circuits BEFORE any network call — proves the money-safe guard.
test('validateFal("") returns missing without a network call', async () => {
  assert.deepEqual(await validateFal(''), { ok: false, reason: 'missing' });
  assert.deepEqual(await validateFal(undefined), { ok: false, reason: 'missing' });
});
