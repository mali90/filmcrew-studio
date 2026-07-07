// The live "list models" fetchers. fetchJson is injected so no real network is hit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
const { listProviderModels, hasLiveModelApi } = await import('../../src/lib/provider-models.js');

test('hasLiveModelApi: true for the HTTP providers, false for copilot', () => {
  assert.equal(hasLiveModelApi('claude'), true);
  assert.equal(hasLiveModelApi('openai'), true);
  assert.equal(hasLiveModelApi('gemini'), true);
  assert.equal(hasLiveModelApi('copilot'), false);
});

test('claude: maps id + display_name from /v1/models', async () => {
  const fetchJson = async () => ({ data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' }], has_more: false });
  const { models } = await listProviderModels({ provider: 'claude', apiKey: 'k', fetchJson });
  assert.deepEqual(models, [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }]);
});

test('gemini: keeps only generateContent models and strips the models/ prefix', async () => {
  const fetchJson = async () => ({
    models: [
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
    ],
  });
  const { models } = await listProviderModels({ provider: 'gemini', apiKey: 'k', fetchJson });
  assert.deepEqual(models, [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }]);
});

test('openai: flags chat-likely ids recommended, keeps the noisy rest', async () => {
  const fetchJson = async () => ({ data: [{ id: 'gpt-5.1' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-realtime' }] });
  const { models } = await listProviderModels({ provider: 'openai', apiKey: 'k', fetchJson });
  const rec = Object.fromEntries(models.map((m) => [m.id, m.recommended]));
  assert.equal(rec['gpt-5.1'], true);
  assert.equal(rec['text-embedding-3-small'], false);
  assert.equal(rec['gpt-4o-realtime'], false); // excluded by the non-chat regex even though it starts with gpt
});

test('rejects without a key, and for a provider with no HTTP API', async () => {
  await assert.rejects(listProviderModels({ provider: 'claude', apiKey: '', fetchJson: async () => ({}) }));
  await assert.rejects(listProviderModels({ provider: 'copilot', apiKey: 'k', fetchJson: async () => ({}) }));
});
