import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { sanitizePreset, computeEnvChanges } = await import('../../src/cli/init.js');
const { parseEnv } = await import('../../src/lib/env-file.js');

test('sanitizePreset clamps invalid fields to safe defaults', () => {
  assert.deepEqual(sanitizePreset({ aspectRatio: '4:3', resolution: '2k', wantsVoices: 1, upscale: 'yes' }),
    { aspectRatio: '9:16', resolution: '1080p', wantsVoices: true, upscale: true });
  assert.deepEqual(sanitizePreset({ aspectRatio: '16:9', resolution: '4k' }),
    { aspectRatio: '16:9', resolution: '4k', wantsVoices: false, upscale: false });
  assert.deepEqual(sanitizePreset(), { aspectRatio: '9:16', resolution: '1080p', wantsVoices: false, upscale: false });
});

test('computeEnvChanges masks secrets, shows new vs old, only reports real diffs', () => {
  const entries = parseEnv('LLM_PROVIDER=openai\nFAL_KEY=\n');
  const { changed, rows, overwritingReal } = computeEnvChanges(entries, { LLM_PROVIDER: 'claude', FAL_KEY: 'supersecretkey' });
  assert.deepEqual(changed.sort(), ['FAL_KEY', 'LLM_PROVIDER']);
  const falRow = rows.find((r) => r.key === 'FAL_KEY');
  assert.match(falRow.newShown, /^\*+…\(14\)$/); // masked, not the raw value
  assert.equal(falRow.newShown.includes('supersecretkey'), false);
  const provRow = rows.find((r) => r.key === 'LLM_PROVIDER');
  assert.deepEqual({ old: provRow.oldShown, new: provRow.newShown }, { old: 'openai', new: 'claude' });
  assert.equal(overwritingReal, true); // LLM_PROVIDER had a real value
});
