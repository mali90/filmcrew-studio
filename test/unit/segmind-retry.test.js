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

test.afterEach(() => { Object.assign(sg.opts, { submitFailTimes: 0, rateLimitTimes: 0, statusFailOnce: false, validationFail: false, insufficientCredits: false, failed: false, contentPolicy: false, expired: false, processingHits: 0, submitHang: false, authFail: false, unknownSlug: false }); });
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

// ── the ambiguous middle: a POST that may or may not have landed ─────────────
// The 5xx cases below are safe to retry because SEGMIND ANSWERED — the response itself proves what
// happened. When `fetch` throws instead, nothing proves anything: the connection can die just as
// easily after Segmind accepted the job as before it arrived. Those failures are the ones that could
// turn one render into two charges, so they stop.
test('a submit that times out with the job already accepted is NOT re-POSTed — one charge, reported', async () => {
  const before = sg.requests.length;
  const queuedBefore = sg.queued.length;
  sg.opts.submitHang = true; // Segmind accepts (and bills) the job, then never answers

  await assert.rejects(submitSegmind('seedance-2.5', ARGS, { requestTimeoutMs: 250 }), (e) => {
    assert.match(e.message, /cannot tell whether the job was queued/i, 'it says exactly what it does not know');
    assert.match(e.message, /segmind\.com/i, 'and where to go look before running it again');
    return true;
  });

  assert.equal(posts(before).length, 1, 'EXACTLY ONE POST: this one may already be queued, so a retry buys a second render');
  assert.equal(sg.queued.length - queuedBefore, 1, 'provider-side exactly one job exists — which is the whole point');
});

// Both transport branches against a stubbed fetch, so the failure is the exact one being classified.
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), method: opts?.method }); return impl(url, opts); };
  try { await fn(calls); } finally { globalThis.fetch = real; }
};
/** How undici reports a socket-level failure: a bare `TypeError: fetch failed` with the real code buried in `cause`. */
const causedBy = (code, message) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

test('a connection REFUSED before the body left the machine is still retried — nothing could have been queued', async () => {
  await withFetch(() => { throw causedBy('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1'); }, async (calls) => {
    await assert.rejects(submitSegmind('seedance-2.5', ARGS), /never reached Segmind/i);
    assert.equal(calls.length, 3, 'all SEGMIND_MAX_RETRIES attempts — caution about ambiguity is not a blanket ban on retrying');
  });
});

test('a socket RESET, which may have died AFTER Segmind accepted the POST, stops at one attempt', async () => {
  await withFetch(() => { throw causedBy('ECONNRESET', 'other side closed'); }, async (calls) => {
    await assert.rejects(submitSegmind('seedance-2.5', ARGS), (e) => {
      assert.match(e.message, /cannot tell whether the job was queued/i);
      return true;
    });
    assert.equal(calls.length, 1, 'ONE POST: an ambiguous failure is reported, never re-bought');
  });
});

test('a 429 rejection IS retried (nothing was queued), never more than SEGMIND_MAX_RETRIES times', async () => {
  const before = sg.requests.length;
  sg.opts.rateLimitTimes = 2; // rejected twice, accepted on the third attempt

  const r = await runSegmind('seedance-2.5', ARGS, { timeoutMs: 30000 });
  assert.ok(r.requestId, 'the third attempt queued the job');
  assert.equal(posts(before).length, 3, 'three attempts — a rate-limit is a REJECTION, so resubmitting is free');
  assert.equal(sg.queued.at(-1).slug, 'seedance-2.5');
});

test('a 5xx ANSWER to the submit is ambiguous — exactly one POST, and the message points at the console', async () => {
  // A 500 answered mid-submit may mean "queued and billed, then the server fell over": treating it
  // as transient (the original design) is how one render becomes two bills. Same rule as a dead
  // socket after the body was sent.
  const before = sg.requests.length;
  sg.opts.submitFailTimes = 99;
  await assert.rejects(submitSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /seedance-2\.5/, 'the slug that failed is named');
    assert.match(e.message, /MAY already have been queued and billed/);
    assert.match(e.message, /Console → Requests/);
    return true;
  });
  assert.equal(posts(before).length, 1, 'EXACTLY ONE POST — nothing re-buys on an ambiguous answer');
});

// ── deterministic failures: never retried, always actionable ────────────────
test('a 422 submit is a bad request — reported once, with its detail, never retried', async () => {
  const before = sg.requests.length;
  const queuedBefore = sg.queued.length;
  sg.opts.validationFail = true;
  await assert.rejects(runSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /duration must be between 4 and 30/, 'the provider detail survives to the user');
    return true;
  });
  assert.equal(posts(before).length, 1, 'a deterministic rejection is not made cheaper by asking again');
  assert.equal(sg.queued.length, queuedBefore, 'a rejected submit queued nothing, so nothing was billed');
});

test('a REJECTED key (401/403) stops at one attempt and names the var to fix', async () => {
  // Every authenticated route answers 401 here, which is what a stale or mistyped key looks like.
  // Burning SEGMIND_MAX_RETRIES on it wastes the user's time; worse, a retry loop on an auth error
  // is how a transport ends up hammering a provider it has already been told to go away by.
  const before = sg.requests.length;
  const queuedBefore = sg.queued.length;
  sg.opts.authFail = true;
  await assert.rejects(runSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /SEGMIND_API_KEY/, 'the env var to fix is named');
    assert.match(e.message, /segmind\.com/i, 'and where to check the key');
    assert.match(e.message, /401|403/, 'with the status that says "your key", not "our fault"');
    return true;
  });
  assert.equal(posts(before).length, 1, 'asking the same rejected key again cannot help');
  assert.equal(sg.queued.length, queuedBefore, 'nothing was queued behind a rejected key');
});

test('a 404 on SUBMIT reads as a bad slug/base url and names the slug settings — never retried', async () => {
  // A 404 here is configuration, not weather: a wrong SEGMIND_*_SLUG or a SEGMIND_BASE_URL pointing
  // somewhere else. It must not be confused with the 404 a POLL gets, which means "record expired".
  const before = sg.requests.length;
  sg.opts.unknownSlug = true;
  await assert.rejects(runSegmind('seedance-2.5', ARGS), (e) => {
    assert.match(e.message, /404/);
    assert.match(e.message, /slug/i);
    assert.match(e.message, /SEGMIND_SEEDANCE25_SLUG|SEGMIND_TOPAZ_SLUG/, 'the settings that produce it are named');
    assert.ok(!/expire/i.test(e.message), 'a submit 404 is NOT the ~1h record expiry — that is the poll case');
    return true;
  });
  assert.equal(posts(before).length, 1, 'a model that does not exist will not exist on the second ask either');
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
