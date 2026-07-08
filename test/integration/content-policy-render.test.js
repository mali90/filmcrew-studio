// A content-policy flag on the generated video: runFal swaps the raw fal blob for a clear message
// and does NOT auto-retry (a resubmit is a fresh paid generation), and finishRender names the failed
// job + reason instead of the bare "No rendered clips found — nothing to assemble".
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
import { startFalServer } from '../helpers/fal-server.js';

const fal = await startFalServer({ opts: { contentPolicy: true } });

neutralizeDotenv();
const voices = mkTmp('cp-voices');
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', SEEDANCE_UPLOAD_MODE: 'data-uri', RENDER_BACKEND: 'seedance',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_TEXT_ENDPOINT: 'seedance-text',
  FAL_MAX_RETRIES: '3', FAL_RETRY_BACKOFF_MS: '5', VOICES_DIR: voices.dir,
});
const config = (await import('../../config.js')).default;
const cache = mkTmp('cp-cache');
config.paths.cache = cache.dir;
const { renderSpec } = await import('../../src/lib/pipeline.js');

test.after(async () => { await fal.close(); voices.cleanup(); cache.cleanup(); });

test('content-policy flag → fail-fast, one attempt, clear message naming the job + reason', async () => {
  const { dir, cleanup } = mkTmp('cp-render');
  try {
    const before = fal.requests.length;
    await assert.rejects(
      renderSpec(loadGoldenSpec(), { runDir: dir, probe: false }),
      (e) => /every job failed/i.test(e.message)      // finishRender names the job(s)…
        && /K1/.test(e.message)
        // …and the reason is the NEW normalized contentPolicyError message, not the raw fal body
        // ("Output video has sensitive content") — this wording only exists in the new handling.
        && /content moderation/i.test(e.message)
        && /revise the plan to rephrase/i.test(e.message)
        && /content_policy_violation/i.test(e.message),
    );
    // No auto-retry: the job was submitted exactly once (a content flag must not burn extra credits).
    const submits = fal.requests.slice(before).filter((q) => q.method === 'POST' && q.path === '/seedance-submit');
    assert.equal(submits.length, 1, 'a content-policy flag is never resubmitted');
  } finally { cleanup(); }
});
