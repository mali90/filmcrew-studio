// WS2-P1 (WS2-06) — Kling's `end_image_url`, and the one-shot fallback that makes it safe to send.
//
// src/lib/fal-kling.js has always passed an authored `job.last_frame` through as `end_image_url`,
// but nothing has ever exercised it against the live endpoint: the input is documented on the
// model's API tab and unverified in practice. Shipping the closing-frame UX on an unverified input
// is only acceptable with a fallback, so:
//
//   · one submit is rejected with a VALIDATION-class error that NAMES `end_image_url`
//        → re-submit ONCE, identical payload minus `end_image_url`, and record
//          seam_out.mode = 'unsupported' (the UI then says "may jump", never "seamless")
//   · any other rejection
//        → exactly ONE submit, the error propagates unchanged
//
// The counting matters: fal bills per accepted submit. A blanket retry would double the bill on
// every unrelated 422, and a retry loop would multiply it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';
import { startFalServer } from '../helpers/fal-server.js';
import { pending } from '../helpers/tdd.js';

const fal = await startFalServer({ videoBytes: Buffer.from('FAKE-MP4') });

neutralizeDotenv();
const voices = mkTmp('kef-voices');
fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}');
const refs = mkTmp('kef-refs');
const REF_PNG = path.join(refs.dir, 'ref.png');
const END_PNG = path.join(refs.dir, 'end.png');
fs.writeFileSync(REF_PNG, ONE_PX_PNG);
fs.writeFileSync(END_PNG, ONE_PX_PNG);

Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit', FAL_KLING_TEXT_ENDPOINT: 'submit-text',
  RENDER_BACKEND: 'kling-o3@fal',
  VOICES_DIR: voices.dir,
  LOG_LEVEL: 'error',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('kef-out');
const cache = mkTmp('kef-cache');
config.paths.out = out.dir;
config.paths.cache = cache.dir;
const { renderJob } = await import('../../src/lib/pipeline.js');

test.after(async () => { await fal.close(); out.cleanup(); cache.cleanup(); voices.cleanup(); refs.cleanup(); });

function endFrameSpec() {
  const spec = loadGoldenSpec();
  spec.render_backend = 'kling-o3@fal';
  spec.kling.elements = [{ id: 'subject', role: 'subject', character: 'keeper', image: REF_PNG }];
  spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['subject'], last_frame: END_PNG }];
  return spec;
}
const submitsSince = (from) => fal.requests.slice(from).filter((q) => q.method === 'POST' && q.path === '/submit');
const sidecar = (dir, job = 'K1') => JSON.parse(fs.readFileSync(path.join(dir, job, 'prompts.json'), 'utf8'));

// Arm on the happy path: an authored last_frame must reach the wire as end_image_url and be recorded
// as a native seam_out.
let READY = false;
{
  const probe = mkTmp('kef-probe');
  try {
    const before = fal.requests.length;
    await renderJob(endFrameSpec(), 'K1', { runDir: probe.dir });
    const body = JSON.parse(submitsSince(before)[0].body);
    READY = Boolean(body.end_image_url) && sidecar(probe.dir).seam_out !== undefined;
  } catch { READY = false; } finally { probe.cleanup(); }
}
const PENDING = pending(READY, 'WS2-06: end_image_url one-shot fallback in fal-kling.js');

test('happy path: an authored last_frame is sent as end_image_url and recorded as a native seam', PENDING, async () => {
  const { dir, cleanup } = mkTmp('kef-ok');
  try {
    const before = fal.requests.length;
    await renderJob(endFrameSpec(), 'K1', { runDir: dir });
    const submits = submitsSince(before);
    assert.equal(submits.length, 1, 'one accepted submit, one paid render');
    const body = JSON.parse(submits[0].body);
    assert.ok(body.end_image_url?.startsWith('data:image/png'), 'the closing frame travels per FAL_UPLOAD_MODE');
    assert.equal(sidecar(dir).seam_out.mode, 'native');
  } finally { cleanup(); }
});

test('a validation error NAMING end_image_url → EXACTLY two submits, the second without it', PENDING, async () => {
  const { dir, cleanup } = mkTmp('kef-fallback');
  fal.opts.validationFailNaming = { field: 'end_image_url', times: 1 };
  try {
    const before = fal.requests.length;
    const r = await renderJob(endFrameSpec(), 'K1', { runDir: dir });

    const submits = submitsSince(before);
    assert.equal(submits.length, 2, 'ONE fallback retry — never a loop, never a blanket retry');
    const first = JSON.parse(submits[0].body);
    const second = JSON.parse(submits[1].body);
    assert.ok('end_image_url' in first, 'the first attempt tried the documented input');
    assert.ok(!('end_image_url' in second), 'the retry drops exactly the input that was rejected');
    // Everything else must be byte-identical — a "retry" that also changed the prompt would bill for
    // a different render than the one the user approved.
    assert.deepEqual({ ...second }, (() => { const c = { ...first }; delete c.end_image_url; return c; })(),
      'the retry payload differs from the first ONLY by the removed field');

    assert.ok(r.clip && fs.existsSync(r.clip), 'the job still delivers a clip');
    assert.equal(sidecar(dir).seam_out.mode, 'unsupported',
      "the sidecar records that the model refused the pin — the UI must not promise a seam it did not get");
  } finally { delete fal.opts.validationFailNaming; cleanup(); }
});

test('a validation error naming something else → EXACTLY one submit, error propagates', PENDING, async () => {
  const { dir, cleanup } = mkTmp('kef-other');
  fal.opts.validationFailNaming = { field: 'duration', times: 1, msg: 'The parameter `duration` specified in the request is not valid: must be between 1 and 15.' };
  try {
    const before = fal.requests.length;
    await assert.rejects(() => renderJob(endFrameSpec(), 'K1', { runDir: dir }), /duration/);
    assert.equal(submitsSince(before).length, 1, 'an unrelated rejection is NOT retried — that would be a second bill');
  } finally { delete fal.opts.validationFailNaming; cleanup(); }
});

test('the fallback fires at most once: a second end_image_url rejection is fatal', PENDING, async () => {
  const { dir, cleanup } = mkTmp('kef-twice');
  fal.opts.validationFailNaming = { field: 'end_image_url', times: 2 };
  try {
    const before = fal.requests.length;
    await assert.rejects(() => renderJob(endFrameSpec(), 'K1', { runDir: dir }), /end_image_url/);
    assert.equal(submitsSince(before).length, 2, 'two attempts total, then stop');
  } finally { delete fal.opts.validationFailNaming; cleanup(); }
});

test('a job with NO closing frame never sends end_image_url and never retries', PENDING, async () => {
  const { dir, cleanup } = mkTmp('kef-none');
  try {
    const spec = endFrameSpec();
    delete spec.kling.jobs[0].last_frame;
    const before = fal.requests.length;
    await renderJob(spec, 'K1', { runDir: dir });
    const submits = submitsSince(before);
    assert.equal(submits.length, 1);
    assert.ok(!('end_image_url' in JSON.parse(submits[0].body)));
    assert.equal(sidecar(dir).seam_out.mode, 'none');
  } finally { cleanup(); }
});
