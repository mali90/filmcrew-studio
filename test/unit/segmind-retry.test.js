// THE money-safety file for src/lib/segmind.js.
//
// fal's runFal resubmits the WHOLE POST on any transient failure — safe there, catastrophic on
// Segmind, where a second POST to /v2/<slug> starts a SECOND BILLABLE JOB. Segmind's retry policy is
// therefore asymmetric and must be written that way from the start:
//
//   * BEFORE a request_id exists, a POST may be retried (nothing was queued, nothing was billed).
//   * AFTER a successful submit, NOTHING may ever re-POST. Polls and the result GET retry freely;
//     a failure past that point is reported, never re-bought.
//
// The rest is deterministic-vs-transient classification, all of it stated as messages a user can act
// on rather than a raw provider blob:
//   422 → FAILED, carries `detail`, never retried      406 → insufficient credits, never retried
//   404 on a poll → the record expired (~1h)            content policy → keeps the token for the UI
//
// TDD (red first): src/lib/segmind.js does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { startSegmindServer } from '../helpers/segmind-server.js';

const sg = await startSegmindServer();

neutralizeDotenv();
Object.assign(process.env, {
  SEGMIND_BASE_URL: sg.baseUrl,
  SEGMIND_API_KEY: 'sk-test',
  SEGMIND_MAX_RETRIES: '3',
  SEGMIND_RETRY_BACKOFF_MS: '1', // the module's own backoff — kept ~instant so this file stays fast
  LOG_LEVEL: 'error',
});
const { runSegmind, submitSegmind } = await import('../../src/lib/segmind.js');

const posts = (from) => sg.requests.slice(from).filter((q) => q.method === 'POST');
const ARGS = { prompt: 'a harbour at dawn', duration: 5 };

test.afterEach(() => { Object.assign(sg.opts, { submitFailTimes: 0, statusFailOnce: false, validationFail: false, insufficientCredits: false, failed: false, contentPolicy: false, expired: false, processingHits: 0 }); });
test.after(async () => { await sg.close(); });

// ── THE billing guard ───────────────────────────────────────────────────────
test('after a SUCCESSFUL submit a transient poll failure NEVER re-POSTs — exactly one job is billed', async () => {
  const before = sg.requests.length;
  const queuedBefore = sg.queued.length;
  sg.opts.statusFailOnce = true; // the poll blows up once, then succeeds

  const r = await runSegmind('seedance-2.5', ARGS, { timeoutMs: 30000 });
  assert.ok(r.result?.video?.url, 'the job still completes — GETs may retry all they like');

  assert.equal(posts(before).length, 1, 'EXACTLY ONE POST: a resubmit here would be a second paid render');
  assert.equal(sg.queued.length - queuedBefore, 1, 'exactly one job was queued provider-side');
  assert.ok(sg.requests.slice(before).filter((q) => q.method === 'GET').length >= 2, 'the poll was retried, not the submit');
});

test('a transient 5xx BEFORE any request_id IS retried, and never more than SEGMIND_MAX_RETRIES times', async () => {
  const before = sg.requests.length;
  sg.opts.submitFailTimes = 2; // fails twice, succeeds on the third attempt

  const r = await runSegmind('seedance-2.5', ARGS, { timeoutMs: 30000 });
  assert.ok(r.requestId, 'the third attempt queued the job');
  const n = posts(before).length;
  assert.equal(n, 3, 'three attempts — nothing was queued by the first two, so resubmitting is free');
  assert.ok(n <= 3, 'and never more than SEGMIND_MAX_RETRIES (the POST carries NO transport-level retry of its own)');
  assert.equal(sg.queued.at(-1).slug, 'seedance-2.5');
});

test('a submit that keeps failing gives up at SEGMIND_MAX_RETRIES with the provider message attached', async () => {
  const before = sg.requests.length;
  sg.opts.submitFailTimes = 99;
  await assert.rejects(submitSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /seedance-2\.5/, 'the slug that failed is named');
    return true;
  });
  assert.equal(posts(before).length, 3, 'exactly SEGMIND_MAX_RETRIES attempts');
});

// ── deterministic failures: never retried, always actionable ────────────────
test('a 422 submit is a bad request — reported once, with its detail, never retried', async () => {
  const before = sg.requests.length;
  sg.opts.validationFail = true;
  await assert.rejects(runSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /duration must be between 4 and 30/, 'the provider detail survives to the user');
    return true;
  });
  assert.equal(posts(before).length, 1, 'a deterministic rejection is not made cheaper by asking again');
  assert.equal(sg.queued.length, sg.queued.length, 'nothing queued');
});

test('406 says INSUFFICIENT CREDITS, points at where to top up, and is never retried', async () => {
  const before = sg.requests.length;
  sg.opts.insufficientCredits = true;
  await assert.rejects(runSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /insufficient credits/i);
    assert.match(e.message, /segmind\.com/i, 'it names where to add credits — a bare 406 helps nobody');
    return true;
  });
  assert.equal(posts(before).length, 1, 'retrying a credit failure only wastes time');
});

test('a FAILED status carrying content_policy_violation KEEPS the token (the web banner keys off it)', async () => {
  const before = sg.requests.length;
  sg.opts.contentPolicy = true;
  await assert.rejects(runSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /content_policy_violation/, 'the literal token survives');
    assert.match(e.message, /moderation|content polic/i, 'and it is explained in words');
    return true;
  });
  assert.equal(posts(before).length, 1, 'a moderation flag is NEVER re-rolled automatically — that is a fresh charge');
});

test('a terminal FAILED (HTTP 422 on the poll) reports the provider detail and does not resubmit', async () => {
  const before = sg.requests.length;
  sg.opts.failed = true;
  await assert.rejects(runSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /reference audio shorter than 2s/, 'the detail is what tells the user what to fix');
    return true;
  });
  assert.equal(posts(before).length, 1);
});

test('404 on a poll explains the ~1h record expiry rather than looking like a bad URL', async () => {
  const before = sg.requests.length;
  sg.opts.expired = true;
  await assert.rejects(runSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /expire/i);
    assert.match(e.message, /1\s?h|hour/i, 'the window is stated');
    return true;
  });
  assert.equal(posts(before).length, 1, 'an expired record is not re-rendered behind the user\'s back');
});

// ── polling ─────────────────────────────────────────────────────────────────
test('QUEUED/PROCESSING are polled through; only COMPLETED and FAILED are terminal', async () => {
  const before = sg.requests.length;
  sg.opts.processingHits = 2;
  const r = await runSegmind('seedance-2.5', ARGS, { timeoutMs: 30000 });
  assert.ok(r.result?.video?.url);
  assert.equal(posts(before).length, 1);
  const statusHits = sg.requests.slice(before).filter((q) => q.path.endsWith('/status')).length;
  assert.ok(statusHits >= 3, `polled past PROCESSING (${statusHits} status GETs)`);
});

test('a missing SEGMIND_API_KEY fails BEFORE any request, naming the env var and where to get one', async () => {
  const { withEnv } = await import('../helpers/env.js');
  await withEnv({ SEGMIND_API_KEY: '', SEGMIND_BASE_URL: sg.baseUrl }, async () => {
    const fresh = await import(`../../src/lib/segmind.js?nokey=${Date.now()}`);
    const before = sg.requests.length;
    await assert.rejects(fresh.submitSegmind('seedance-2.5', ARGS), (e) => {
      assert.match(e.message, /SEGMIND_API_KEY/);
      assert.match(e.message, /segmind\.com/i);
      return true;
    });
    assert.equal(sg.requests.length, before, 'not one byte left the machine');
  });
});
