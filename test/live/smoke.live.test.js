// OPT-IN live smoke tests — run ONLY with `RUN_LIVE=1` (and real keys in your .env). Never in CI.
// Every check here is money-safe: validateFal sends an invalid request and reads only the HTTP status
// (no job queued); pingLlm spends ~1 token. They prove the mocks match the real contracts.
import test from 'node:test';
import assert from 'node:assert/strict';

const skip = process.env.RUN_LIVE ? false : 'set RUN_LIVE=1 (with real keys) to run live smoke tests';

// Use the REAL config here (do NOT neutralize dotenv) so it reads your actual .env credentials.
const config = (await import('../../config.js')).default;

test('fal: key validates (money-safe, no job queued)', { skip }, async () => {
  const { validateFal } = await import('../../src/lib/fal.js');
  const r = await validateFal(config.fal.apiKey);
  assert.equal(r.ok, true, `validateFal → ${JSON.stringify(r)}`);
});

test('llm: 1-token ping returns a reply', { skip }, async () => {
  const { pingLlm } = await import('../../src/lib/llm.js');
  const reply = await pingLlm({ provider: config.llm.provider, transport: config.llm.transport, model: config.llm.model, apiKey: config.llm.apiKey });
  assert.ok(String(reply).trim().length > 0, 'expected a non-empty reply');
});
