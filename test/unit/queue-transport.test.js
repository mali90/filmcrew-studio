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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
// logger.js snapshots LOG_LEVEL at import, and one case below asserts that a skipped optional
// download is REPORTED — pin the level so an ambient LOG_LEVEL=error cannot silently pass it.
process.env.LOG_LEVEL = 'info';

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

// A result carrying ONLY the optional closing still is still a job with no video — the courtesy
// artifact must never satisfy the "produced a video" check.
test('a last_frame with no video url is NOT a downloadable job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-qt-lf-'));
  try {
    await assert.rejects(
      () => qt.downloadResultFiles({ status: 'COMPLETED', last_frame: { url: 'http://127.0.0.1:1/last_frame.png' } }, dir, 'Segmind seedance'),
      /Segmind seedance job produced no video url: /,
    );
    assert.deepEqual(fs.readdirSync(dir), [], 'an unreachable optional url is not even attempted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The paid artifact is the CLIP. `return_last_frame` is a courtesy: the same frame is always
// reproducible with ffmpeg off the finished clip (pipeline.closingFrameFor), so an expired or 404
// still must degrade to that grab — never discard a render the user has already been billed for.
test('an undownloadable last_frame is skipped, not fatal — the clip still lands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-qt-opt-'));
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('last_frame.png')) { res.writeHead(404); return res.end('gone'); }
    res.writeHead(200, { 'content-type': 'video/mp4' });
    return res.end(Buffer.from('FAKE-MP4'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return write(chunk, ...rest); };
  try {
    const paths = await qt.downloadResultFiles(
      { video: { url: `${base}/dl/out.mp4` }, last_frame: { url: `${base}/dl/last_frame.png` } },
      dir, 'Segmind seedance',
    );
    assert.deepEqual(paths.map((p) => path.basename(p)), ['out.mp4'], 'the clip downloaded; the courtesy still did not');
    assert.equal(fs.existsSync(path.join(dir, 'last_frame.png')), false, 'no truncated/empty frame is left behind');
    assert.ok(stderr.join('').includes('last_frame.png'), 'the skip is reported, never silent');
  } finally {
    process.stderr.write = write;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A real CDN serves a video from whatever path it likes — `…/videos/9f3ac` with no suffix is
// ordinary — while the courtesy still always lands under last_frame.png. So the ROLE has to be
// readable without the filename: the renderers take the first output (fal-kling, render-seedance,
// topazUpscaleSegmind), and handing them the PNG would put a still where the paid clip belongs and
// only blow up later, in the stitch.
test('the paid video comes back FIRST and is identifiable by role, even with an extensionless url', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-qt-order-'));
  const server = http.createServer((req, res) => {
    const png = req.url.endsWith('.png');
    res.writeHead(200, { 'content-type': png ? 'image/png' : 'video/mp4' });
    return res.end(Buffer.from(png ? 'FAKE-PNG' : 'FAKE-MP4'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const paths = await qt.downloadResultFiles(
      { url: `${base}/videos/9f3ac`, last_frame: { url: `${base}/frames/8b2de.png` } },
      dir, 'Segmind seedance',
    );
    assert.deepEqual(paths.map((p) => path.basename(p)), ['9f3ac', 'last_frame.png'],
      'the courtesy still never precedes the artifact the job billed for');
    assert.equal(path.basename(qt.paidClipOf(paths)), '9f3ac', 'and the role reader agrees with the order');
    assert.equal(fs.readFileSync(qt.paidClipOf(paths), 'utf8'), 'FAKE-MP4', 'the bytes are the video, not the still');
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('paidClipOf reads the role, never the suffix', () => {
  assert.equal(qt.paidClipOf(['/j/K1/last_frame.png', '/j/K1/9f3ac']), '/j/K1/9f3ac');
  assert.equal(qt.paidClipOf(['/j/K1/out.mp4', '/j/K1/last_frame.png']), '/j/K1/out.mp4');
  assert.equal(qt.paidClipOf(['/j/K1/out.mp4']), '/j/K1/out.mp4');
  assert.equal(qt.paidClipOf([]), null, 'nothing downloaded is nothing to claim');
  assert.equal(qt.paidClipOf(undefined), null);
});

// The mirror image: a VIDEO that will not download is still fatal. Nothing about the optional path
// may soften the required one.
test('an undownloadable VIDEO is still fatal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-qt-req-'));
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end('gone'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(
      () => qt.downloadResultFiles({ video: { url: `${base}/dl/out.mp4` } }, dir, 'fal Kling'),
      /fal Kling output download failed .*HTTP 404/,
    );
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
