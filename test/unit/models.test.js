// The shared model catalog + the config.js default-resolution fix (blank LLM_MODEL must resolve to the
// SELECTED provider's default, not always Claude's).
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv, withEnv } from '../helpers/env.js';

neutralizeDotenv();
const { modelDefault, curatedFor } = await import('../../src/lib/models.js');

test('modelDefault resolves per provider; unknown → Claude default', () => {
  assert.equal(modelDefault('claude'), 'claude-opus-4-8');
  assert.equal(modelDefault('openai'), 'gpt-5.5');
  assert.equal(modelDefault('gemini'), 'gemini-2.5-pro');
  assert.equal(modelDefault('copilot'), ''); // Copilot rides its CLI's own default
  assert.equal(modelDefault('bogus'), 'claude-opus-4-8');
});

test('curatedFor returns default + options (empty shell for an unknown provider)', () => {
  const c = curatedFor('openai');
  assert.equal(c.default, 'gpt-5.5');
  assert.ok(c.options.some((o) => o.id === 'gpt-5.4-mini'));
  assert.deepEqual(curatedFor('bogus'), { default: '', options: [] });
});

test('config.llm.model resolves the provider default when LLM_MODEL is blank', async () => {
  await withEnv({ LLM_PROVIDER: 'openai', LLM_MODEL: '' }, async () => {
    const cfg = (await import('../../config.js?models-openai-default')).default;
    assert.equal(cfg.llm.model, 'gpt-5.5');
  });
});

test('config.llm.model honors an explicit LLM_MODEL over the default', async () => {
  await withEnv({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-5.4-mini' }, async () => {
    const cfg = (await import('../../config.js?models-openai-explicit')).default;
    assert.equal(cfg.llm.model, 'gpt-5.4-mini');
  });
});
