// Doctor checks for the Segmind provider. Two new checks, and both exist because of ways a Segmind
// setup can look fine and then fail with the money already committed:
//
//   segmind-key    — SEGMIND_API_KEY. HARD when the default backend actually renders on Segmind,
//                    SOFT otherwise (a fal user should not be nagged about a provider they never
//                    chose — but a Segmind user must not discover it after planning has been paid for).
//   render-assets  — how a local reference reaches the provider. `SEGMIND_UPLOAD_MODE=fal-storage`
//                    quietly needs a FAL_KEY: without one, EVERY Segmind render dies at the first
//                    upload. `data-uri` is the keyless path and must report as a VALID setup, not as
//                    "you're missing a fal key".
//
// Checks are asserted through runChecks() by their stable `id`, never their prose.
//
// TDD (red first): preflight.js has no segmind-key / render-assets checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from '../helpers/env.js';

/** Fresh preflight + config for one env (both snapshot process.env at import). */
async function checksFor(env) {
  return withEnv({
    LOG_LEVEL: 'error',
    LLM_TRANSPORT: 'api', LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'x',
    ...env,
  }, async () => {
    const stamp = `${Date.now()}-${Math.random()}`;
    await import(`../../config.js?pf=${stamp}`);
    const { runChecks, hardFailures } = await import(`../../src/lib/preflight.js?pf=${stamp}`);
    const checks = await runChecks();
    return { checks, hard: hardFailures(checks), by: (id) => checks.find((c) => c.id === id) };
  });
}

const SEGMIND_RUN = { RENDER_BACKEND: 'seedance-2.5@segmind', SEGMIND_UPLOAD_MODE: 'data-uri' };

test('segmind-key: present and PASSING when a Segmind backend has its key', async () => {
  const { by, hard } = await checksFor({ ...SEGMIND_RUN, SEGMIND_API_KEY: 'sk-live' });
  const c = by('segmind-key');
  assert.ok(c, 'the check exists');
  assert.equal(c.ok, true);
  assert.ok(!hard.some((h) => h.id === 'segmind-key'));
});

test('segmind-key: HARD when the default backend renders on Segmind and the key is missing', async () => {
  const { by, hard } = await checksFor({ ...SEGMIND_RUN, SEGMIND_API_KEY: '' });
  const c = by('segmind-key');
  assert.equal(c.ok, false);
  assert.match(c.hint, /SEGMIND_API_KEY/);
  assert.match(c.hint, /segmind\.com/i, 'the hint says where to get one');
  assert.ok(hard.some((h) => h.id === 'segmind-key'), 'a render on this backend cannot start without it');
});

test('segmind-key: SOFT for a fal user — never a blocker for a provider they did not choose', async () => {
  const { by, hard } = await checksFor({ RENDER_BACKEND: 'kling', SEGMIND_API_KEY: '', FAL_KEY: 'fake' });
  const c = by('segmind-key');
  assert.equal(c.ok, false, 'still reported, so switching provider is a known step');
  assert.ok(!hard.some((h) => h.id === 'segmind-key'), 'but it does not block a Kling render');
});

test('fal-key mirrors it: a Segmind-only install is not blocked on FAL_KEY', async () => {
  const { hard } = await checksFor({ ...SEGMIND_RUN, SEGMIND_API_KEY: 'sk-live', FAL_KEY: '' });
  assert.ok(!hard.some((h) => h.id === 'fal-key'),
    'the whole point of Segmind support: no fal account required to finish a film');
});

test('render-assets: fal-storage uploads WITHOUT a FAL_KEY is the silent killer — reported hard', async () => {
  const { by, hard } = await checksFor({
    RENDER_BACKEND: 'seedance-2.5@segmind', SEGMIND_API_KEY: 'sk-live',
    SEGMIND_UPLOAD_MODE: 'fal-storage', FAL_KEY: '',
  });
  const c = by('render-assets');
  assert.ok(c, 'the check exists');
  assert.equal(c.ok, false);
  assert.match(c.hint, /SEGMIND_UPLOAD_MODE=data-uri|FAL_KEY/, 'the hint offers BOTH ways out');
  assert.ok(hard.some((h) => h.id === 'render-assets'), 'every render would die at the first upload');
});

test('render-assets: data-uri on Segmind is a VALID keyless setup, not a missing-fal-key warning', async () => {
  const { by, hard } = await checksFor({ ...SEGMIND_RUN, SEGMIND_API_KEY: 'sk-live', FAL_KEY: '' });
  const c = by('render-assets');
  assert.equal(c.ok, true);
  assert.ok(!hard.some((h) => h.id === 'render-assets'));
});

test('render-assets: fal-storage WITH a fal key is fine (the hybrid setup people actually run)', async () => {
  const { by } = await checksFor({
    RENDER_BACKEND: 'seedance-2.5@segmind', SEGMIND_API_KEY: 'sk-live',
    SEGMIND_UPLOAD_MODE: 'fal-storage', FAL_KEY: 'fake',
  });
  assert.equal(by('render-assets').ok, true);
});

test('the backend check accepts every new compound id and still rejects nonsense', async () => {
  for (const be of ['seedance-2.5@fal', 'seedance-2.5@segmind', 'seedance-2.0@segmind']) {
    const { by } = await checksFor({ RENDER_BACKEND: be, SEGMIND_API_KEY: 'sk-live', FAL_KEY: 'fake' });
    assert.equal(by('backend').ok, true, be);
  }
  const { by } = await checksFor({ RENDER_BACKEND: 'kling-o3@segmind', FAL_KEY: 'fake' });
  assert.equal(by('backend').ok, false, 'Kling is fal-only — the doctor says so before a plan is paid for');
});
