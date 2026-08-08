// src/lib/queue-transport.js — the provider-neutral half of the fal client, extracted so a second
// queue-based provider can reuse it. This is a PURE MOVE: fal.js imports and re-exports every symbol,
// so no downstream import changes and test/unit/fal-retry.test.js + the fal integration tests keep
// passing UNMODIFIED (they are the real gate; this file pins the new module's own surface).
//
// The one thing that must never drift: contentPolicyError's message keeps the literal
// `content_policy_violation` token — the web banner keys off it.
//
// TDD (red first): src/lib/queue-transport.js does not exist; resultFileUrls / downloadResultFiles /
// contentPolicyError are module-private inside fal.js today.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();

const qt = await import('../../src/lib/queue-transport.js');
const fal = await import('../../src/lib/fal.js');

const err = (m) => new Error(m);

test('queue-transport exports the moved surface', () => {
  for (const name of ['resultFileUrls', 'downloadResultFiles', 'isValidationError', 'isTransientError', 'isContentPolicyError', 'contentPolicyError']) {
    assert.equal(typeof qt[name], 'function', `queue-transport exports ${name}`);
  }
});

test('fal.js RE-EXPORTS the same function objects — one implementation, no fork', () => {
  assert.equal(fal.isValidationError, qt.isValidationError);
  assert.equal(fal.isContentPolicyError, qt.isContentPolicyError);
  // fal.js keeps its historic name as an alias so existing imports/tests are untouched
  assert.equal(fal.isTransientFalError, qt.isTransientError);
  assert.equal(fal.default.isValidationError, qt.isValidationError);
  assert.equal(fal.default.isTransientFalError, qt.isTransientError);
  assert.equal(fal.default.isContentPolicyError, qt.isContentPolicyError);
});

test('the classifiers keep their exact behaviour after the move', () => {
  const FETCH_TIMEOUT = err('HTTP 422 Unprocessable Entity on https://queue.fal.run/x: `content[1].image_url` is not valid: timeout while fetching resource.');
  const BAD_ARG = err('HTTP 422 Unprocessable Entity on ...: {"detail":"`seed` is not a valid parameter"}');
  const FLAG = err('HTTP 422 ...: {"type":"content_policy_violation"}');
  const NET = err('HTTP 503 Service Unavailable on ...: upstream');

  assert.equal(qt.isValidationError(FETCH_TIMEOUT), true);
  assert.equal(qt.isTransientError(FETCH_TIMEOUT), true);   // retryable despite the 422
  assert.equal(qt.isValidationError(BAD_ARG), true);
  assert.equal(qt.isTransientError(BAD_ARG), false);        // fail fast
  assert.equal(qt.isContentPolicyError(FLAG), true);
  assert.equal(qt.isTransientError(FLAG), false);           // a resubmit is a fresh PAID generation
  assert.equal(qt.isValidationError(NET), false);
  assert.equal(qt.isTransientError(NET), false);
});

test('contentPolicyError keeps the content_policy_violation token (the web banner keys off it)', () => {
  const e = qt.contentPolicyError(err('Output video has sensitive content.'), 'bytedance/seedance-2.0/reference-to-video');
  assert.ok(e instanceof Error);
  assert.match(e.message, /content_policy_violation/);
  assert.match(e.message, /bytedance\/seedance-2\.0\/reference-to-video/, 'names the endpoint');
  assert.match(e.message, /Output video has sensitive content\./, 'keeps a slice of the original blob');
  assert.equal(qt.isContentPolicyError(e), true, 'the rethrown error still classifies as content-policy');
});

test('resultFileUrls pulls urls out of every shape a queue result uses', () => {
  assert.deepEqual(qt.resultFileUrls({ video: { url: 'a' } }), ['a']);
  assert.deepEqual(qt.resultFileUrls({ videos: [{ url: 'a' }, { url: 'b' }] }), ['a', 'b']);
  assert.deepEqual(qt.resultFileUrls({ url: 'c' }), ['c']);
  assert.deepEqual(qt.resultFileUrls({ video: { url: 'a' }, videos: [{ url: 'b' }], url: 'c' }), ['a', 'b', 'c']);
  assert.deepEqual(qt.resultFileUrls({}), []);
  assert.deepEqual(qt.resultFileUrls(null), []);
  assert.deepEqual(qt.resultFileUrls(undefined), []);
  assert.deepEqual(qt.resultFileUrls({ video: {} }), [], 'a url-less blob contributes nothing');
});

test('downloadResultFiles keeps its exact no-output error string', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-qt-'));
  try {
    await assert.rejects(
      () => qt.downloadResultFiles({ status: 'COMPLETED' }, dir, 'fal Kling'),
      /fal Kling job produced no video url: /,
    );
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing is written when there is nothing to download');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
