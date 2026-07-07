// A transient fal fetch race ("timeout while fetching resource", surfaced as HTTP 422 on the result
// poll) must be RESUBMITTED, not treated as a fatal validation error. This is the exact failure that
// killed a real render ("No rendered clips found — nothing to assemble"). Runs against the mock queue
// with a tiny backoff so the resubmit is fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { startFalServer } from '../helpers/fal-server.js';

const fal = await startFalServer({ opts: { fetchTimeoutOnce: true } });

neutralizeDotenv();
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit',
  FAL_MAX_RETRIES: '3', FAL_RETRY_BACKOFF_MS: '5',
});
await import('../../config.js');
const { generateSeedance } = await import('../../src/lib/fal.js');

test.after(async () => { await fal.close(); });

test('transient "timeout while fetching resource" 422 → resubmit and succeed', async () => {
  const out = mkTmp('fal-retry');
  try {
    const before = fal.requests.length;
    const paths = await generateSeedance(
      { prompt: 'p', image_urls: ['data:image/png;base64,AA=='], aspect_ratio: '9:16', resolution: '480p', duration: '5', generate_audio: false },
      { endpoint: 'seedance-submit', destDir: out.dir },
    );
    assert.ok(paths.length && paths[0], 'the render completed after the transient error cleared');
    const submits = fal.requests.slice(before).filter((q) => q.method === 'POST' && q.path === '/seedance-submit');
    assert.equal(submits.length, 2, 'the job was resubmitted exactly once (first result 422d, retry succeeded)');
  } finally { out.cleanup(); }
});
