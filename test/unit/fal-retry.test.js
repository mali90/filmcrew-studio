// fal retry classification: a transient "timeout while fetching resource" 4xx (fal's worker failing
// to fetch a reference URL we just uploaded — a CDN/propagation race) must stay RETRYABLE, while a
// genuine bad-argument 422 (seed / negative_prompt / "must be one of") still fails fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { isValidationError, isTransientFalError, isContentPolicyError } = await import('../../src/lib/fal.js');

const err = (m) => new Error(m);

// The exact message shape observed in the field (fetchJson wraps the fal detail body).
const OBSERVED = err('HTTP 422 Unprocessable Entity on https://queue.fal.run/bytedance/seedance-2.0/requests/019f: [{"loc":["body"],"msg":"The parameter `content[1].image_url` specified in the request is not valid: timeout while fetching resource. Request id: 021","type":"invalid_request"}]');

test('the observed 422 fetch-timeout is a TRANSIENT error (retryable), not a hard validation failure', () => {
  assert.equal(isTransientFalError(OBSERVED), true);
  // It still matches VALIDATION on its surface ("invalid"/"not valid"/"unprocessable")…
  assert.equal(isValidationError(OBSERVED), true);
  // …but runFal's guard `isValidationError && !isTransientFalError` therefore RETRIES it.
  assert.equal(isValidationError(OBSERVED) && !isTransientFalError(OBSERVED), false);
});

test('other transient fetch/download phrasings are retryable too', () => {
  for (const m of [
    'HTTP 422 ...: failed to fetch the image_url',
    'HTTP 400 ...: could not download the resource',
    'HTTP 422 ...: unable to fetch reference',
    'HTTP 424 ...: timed out fetching resource',
  ]) assert.equal(isTransientFalError(err(m)), true, m);
});

test('genuine bad-argument 422s are NOT transient — they fail fast', () => {
  for (const m of [
    'HTTP 422 Unprocessable Entity on ...: {"detail":"`seed` is not a valid parameter"}',
    'HTTP 422 ...: negative_prompt is not supported on this endpoint',
    'HTTP 400 Bad Request on ...: aspect_ratio must be one of 16:9, 9:16',
    'HTTP 422 ...: prompt is required',
  ]) {
    assert.equal(isTransientFalError(err(m)), false, m);
    assert.equal(isValidationError(err(m)), true, m);           // → give up (no retry)
  }
});

test('a 5xx / network error is neither a validation nor a fetch-timeout error (retried by runFal anyway)', () => {
  const e = err('HTTP 503 Service Unavailable on ...: upstream');
  assert.equal(isValidationError(e), false);
  assert.equal(isTransientFalError(e), false);
});

// The output-moderation flag ("Output video has sensitive content" / content_policy_violation /
// partner_validation_failed). It must be recognized so runFal swaps in a clear message — and it must
// NOT be transient (a resubmit is a fresh paid generation; the user's constraint is "don't add cost").
const CONTENT_FLAG = err('HTTP 422 Unprocessable Entity on https://queue.fal.run/bytedance/seedance-2.0/requests/019f: {"detail":[{"loc":["body","generated_video"],"msg":"Output video has sensitive content.","type":"content_policy_violation","ctx":{"extra_info":{"reason":"partner_validation_failed"}}}]}');

test('a content-policy flag is recognized, and is NOT transient (never auto-retried)', () => {
  assert.equal(isContentPolicyError(CONTENT_FLAG), true);
  assert.equal(isTransientFalError(CONTENT_FLAG), false); // fail-fast, no extra generation billed
  for (const m of ['partner_validation_failed', 'content_policy_violation', 'Output video has sensitive content', 'content policy']) {
    assert.equal(isContentPolicyError(err(`HTTP 422 ...: ${m}`)), true, m);
  }
});

test('a fetch-timeout or bad-arg is NOT a content-policy error', () => {
  assert.equal(isContentPolicyError(OBSERVED), false);            // the transient fetch-timeout from above
  assert.equal(isContentPolicyError(err('HTTP 422 ...: seed is not a valid parameter')), false);
});
