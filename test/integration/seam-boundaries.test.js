// WS2-P1 (WS2-06) — the seam decision applied at the Seedance renderer boundary.
//
// chooseSeamMode() decides; THIS file proves the wire payload obeys it, per provider:
//
//   fal      · boundary frames are SOFT pins: extra image refs + prompt sentences, cast refs KEPT.
//              `first_frame_url`/`last_frame_url` must NEVER appear — the endpoint has no such
//              inputs, and a UI that says "seamless" off the back of them would be lying.
//   segmind  · native `first_frame_url`/`last_frame_url` ONLY on a cast-less segment (they are
//              mutually exclusive with `reference_images` there). With a cast present, the cast
//              wins and both frames become soft pins — which is a behaviour CHANGE: today an
//              authored `last_frame` on a Segmind job with refs throws.
//
// Plus `return_last_frame`: where the caps declare it and the job feeds a next job, ask for the
// provider's own closing still and PRESERVE it as <job>/last_frame.png (that file is what every
// downstream seam reads). Absent or undownloadable → ffmpeg grab, recorded honestly as
// seam_out.frameSource.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';
import { hasFfmpeg, tinyMp4Bytes } from '../helpers/ffmpeg-clips.js';
import { startFalServer } from '../helpers/fal-server.js';
import { startSegmindServer } from '../helpers/segmind-server.js';
import { pending } from '../helpers/tdd.js';

const FF = await hasFfmpeg();
const videoBytes = FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4');
const fal = await startFalServer({ videoBytes });
const sg = await startSegmindServer({ videoBytes });

neutralizeDotenv();
const voices = mkTmp('sb-voices');
fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}');
const refs = mkTmp('sb-refs');
const frames = mkTmp('sb-frames');
// Non-proprietary throwaway reference images (never elements/references/, never profiles/).
const refPath = (i) => path.join(refs.dir, `ref-${i}.png`);
for (let i = 1; i <= 10; i++) fs.writeFileSync(refPath(i), ONE_PX_PNG);
const FIRST_PNG = path.join(frames.dir, 'authored-first.png');
const LAST_PNG = path.join(frames.dir, 'authored-last.png');
fs.writeFileSync(FIRST_PNG, ONE_PX_PNG);
fs.writeFileSync(LAST_PNG, ONE_PX_PNG);

Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  FAL_SEEDANCE_TEXT_ENDPOINT: 'seedance-text',
  SEGMIND_BASE_URL: sg.baseUrl, SEGMIND_API_KEY: 'sk-test', SEGMIND_UPLOAD_MODE: 'data-uri',
  SEGMIND_MAX_RETRIES: '1', SEGMIND_RETRY_BACKOFF_MS: '1',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  VOICES_DIR: voices.dir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
  LOG_LEVEL: 'error',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('sb-out');
const cache = mkTmp('sb-cache');
config.paths.out = out.dir;
config.paths.cache = cache.dir;
const { renderSpec } = await import('../../src/lib/pipeline.js');

test.after(async () => {
  await fal.close(); await sg.close();
  out.cleanup(); cache.cleanup(); voices.cleanup(); refs.cleanup(); frames.cleanup();
});

/** A one-job spec on `backend` with `castCount` reference images and the given authored frames. */
function specWith({ backend, castCount = 1, firstFrame = null, lastFrame = null }) {
  const spec = loadGoldenSpec();
  spec.render_backend = backend;
  spec.kling.elements = Array.from({ length: castCount }, (_, i) => ({
    id: `e${i + 1}`, role: 'subject', character: 'keeper', image: refPath(i + 1),
  }));
  const job = { job_id: 'K1', shots: ['S1'], elements: spec.kling.elements.map((e) => e.id) };
  if (firstFrame) job.first_frame = firstFrame;
  if (lastFrame) job.last_frame = lastFrame;
  spec.kling.jobs = [job];
  return spec;
}

const bodyOf = (reqs, from) => JSON.parse(reqs.slice(from).find((q) => q.method === 'POST').body);
const sidecar = (dir, job = 'K1') => JSON.parse(fs.readFileSync(path.join(dir, job, 'prompts.json'), 'utf8'));

// Arm the whole file on one cheap render: fal + both authored frames must produce two soft pins.
let READY = false;
{
  const probe = mkTmp('sb-probe');
  try {
    const before = fal.requests.length;
    await renderSpec(specWith({ backend: 'seedance-2.0@fal', castCount: 1, firstFrame: FIRST_PNG, lastFrame: LAST_PNG }), { runDir: probe.dir, probe: false });
    const b = bodyOf(fal.requests, before);
    READY = (b.image_urls?.length === 3) && /literal last frame/.test(b.prompt ?? '');
  } catch { READY = false; } finally { probe.cleanup(); }
}
const PENDING = pending(READY, 'WS2-06: soft-pin/native boundary application in render-seedance.js');
const PENDING_FF = FF ? PENDING : { skip: 'ffmpeg not installed' };

test('fal + cast refs + both seams: NO frame args, two extra image refs, both prompt pins', PENDING, async () => {
  const { dir, cleanup } = mkTmp('sb-fal-soft');
  try {
    const before = fal.requests.length;
    await renderSpec(specWith({ backend: 'seedance-2.0@fal', castCount: 2, firstFrame: FIRST_PNG, lastFrame: LAST_PNG }), { runDir: dir });
    const b = bodyOf(fal.requests, before);

    assert.ok(!('first_frame_url' in b), "fal's reference endpoint has no first-frame anchor");
    assert.ok(!('last_frame_url' in b), "fal's reference endpoint has no last-frame anchor");
    assert.equal(b.image_urls.length, 4, '2 cast refs + 2 boundary frames, all as image refs');
    assert.match(b.prompt, /Use @Image3 as the literal first frame of this clip and continue its motion seamlessly forward\./);
    assert.match(b.prompt, /@Image4/);
    assert.match(b.prompt, /literal last frame/);

    const s = sidecar(dir);
    assert.equal(s.seam_in.mode, 'soft');
    assert.equal(s.seam_out.mode, 'soft');
    assert.equal(s.image_refs.filter((r) => r.id === 'first_frame' || r.id === 'last_frame' || r.id === 'seam').length, 2,
      'the sidecar legend names both boundary refs');
  } finally { cleanup(); }
});

test('segmind + ZERO cast refs: native first_frame_url + last_frame_url, no reference_images', PENDING, async () => {
  const { dir, cleanup } = mkTmp('sb-sg-native');
  try {
    const before = sg.requests.length;
    await renderSpec(specWith({ backend: 'seedance-2.0@segmind', castCount: 0, firstFrame: FIRST_PNG, lastFrame: LAST_PNG }), { runDir: dir });
    const b = bodyOf(sg.requests, before);

    assert.ok(b.first_frame_url, 'a cast-less segment takes the native opening slot');
    assert.ok(b.last_frame_url, '…and the native closing slot');
    assert.ok(!('reference_images' in b), 'native mode is mutually exclusive with reference_images on Segmind');
    assert.ok(!/literal first frame/.test(b.prompt), 'a native pin needs no prompt sentence — and must not claim one');

    const s = sidecar(dir);
    assert.equal(s.seam_in.mode, 'native');
    assert.equal(s.seam_out.mode, 'native');
  } finally { cleanup(); }
});

test('segmind WITH cast refs: the cast wins, both frames fall back to soft pins (no throw)', PENDING, async () => {
  const { dir, cleanup } = mkTmp('sb-sg-soft');
  try {
    const before = sg.requests.length;
    // Today this combination THROWS ("…pins a closing frame only in native first/last mode…").
    // P1 replaces the throw with an honest soft pin: the character's identity outranks a frame hint.
    const r = await renderSpec(specWith({ backend: 'seedance-2.0@segmind', castCount: 2, firstFrame: FIRST_PNG, lastFrame: LAST_PNG }), { runDir: dir });
    assert.ok(r.jobs.every((j) => !j.error), `no job may fail: ${JSON.stringify(r.jobs.map((j) => j.error))}`);
    const b = bodyOf(sg.requests, before);
    assert.ok(!('first_frame_url' in b));
    assert.ok(!('last_frame_url' in b));
    assert.equal(b.reference_images.length, 4, 'cast refs kept, both frames appended');
    assert.match(b.prompt, /Use @Image 3 as the literal first frame/, 'Segmind cites refs SPACED');
    assert.match(b.prompt, /literal last frame/);

    const s = sidecar(dir);
    assert.equal(s.seam_in.mode, 'soft');
    assert.equal(s.seam_out.mode, 'soft');
  } finally { cleanup(); }
});

test('at the image cap the END pin is dropped first — asserted on the wire, not just in the plan', PENDING, async () => {
  const { dir, cleanup } = mkTmp('sb-cap');
  try {
    const before = fal.requests.length;
    // fal Seedance 2.0 takes 9 images. 8 cast + 2 boundary frames = 10 → exactly one must go.
    await renderSpec(specWith({ backend: 'seedance-2.0@fal', castCount: 8, firstFrame: FIRST_PNG, lastFrame: LAST_PNG }), { runDir: dir });
    const b = bodyOf(fal.requests, before);
    assert.equal(b.image_urls.length, 9, 'the model cap is respected');
    assert.match(b.prompt, /Use @Image9 as the literal first frame/, 'the START pin survived, in the last slot');
    assert.ok(!/literal last frame/.test(b.prompt), 'the END pin was dropped — and took its prompt claim with it');

    const s = sidecar(dir);
    assert.equal(s.seam_in.mode, 'soft');
    assert.equal(s.seam_out.mode, 'none', 'a dropped pin is recorded as no seam, never as a pin that was applied');
  } finally { cleanup(); }
});

test('over the cap, BOTH pins go before a single cast reference does', PENDING, async () => {
  const { dir, cleanup } = mkTmp('sb-cap2');
  try {
    const before = fal.requests.length;
    await renderSpec(specWith({ backend: 'seedance-2.0@fal', castCount: 9, firstFrame: FIRST_PNG, lastFrame: LAST_PNG }), { runDir: dir });
    const b = bodyOf(fal.requests, before);
    assert.equal(b.image_urls.length, 9);
    assert.ok(!/literal first frame/.test(b.prompt));
    assert.ok(!/literal last frame/.test(b.prompt));
  } finally { cleanup(); }
});

test('return_last_frame: requested where caps allow, provider frame preserved as <job>/last_frame.png', PENDING_FF, async () => {
  const { dir, cleanup } = mkTmp('sb-rlf');
  try {
    const spec = specWith({ backend: 'seedance-2.0@segmind', castCount: 1 });
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['e1'] },
      { job_id: 'K2', shots: ['S2'], elements: ['e1'] },
    ];
    const before = sg.requests.length;
    await renderSpec(spec, { runDir: dir });
    const submits = sg.requests.slice(before).filter((q) => q.method === 'POST' && q.path.startsWith('/v2/'));
    const b1 = JSON.parse(submits[0].body);
    const b2 = JSON.parse(submits[1].body);
    assert.equal(b1.return_last_frame, true, 'K1 feeds K2 — ask the provider for its own closing still');
    assert.ok(!('return_last_frame' in b2), 'K2 feeds nothing; do not tag a paid job with a flag nobody reads');

    const seam = path.join(dir, 'K1', 'last_frame.png');
    assert.ok(fs.existsSync(seam), 'the provider frame lands where every downstream seam reads');
    assert.equal(fs.readFileSync(seam).toString(), 'PROVIDER-PNG', "the PROVIDER's pixels, not an ffmpeg re-encode");
    assert.equal(sidecar(dir, 'K1').seam_out.frameSource, 'provider');
  } finally { cleanup(); }
});

test('return_last_frame absent from the response → ffmpeg grab, recorded as frameSource "ffmpeg"', PENDING_FF, async () => {
  const { dir, cleanup } = mkTmp('sb-rlf-fallback');
  sg.opts.omitLastFrame = true;
  try {
    const spec = specWith({ backend: 'seedance-2.0@segmind', castCount: 1 });
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['e1'] },
      { job_id: 'K2', shots: ['S2'], elements: ['e1'] },
    ];
    await renderSpec(spec, { runDir: dir });
    const seam = path.join(dir, 'K1', 'last_frame.png');
    assert.ok(fs.existsSync(seam), 'the seam file still appears — the chain must not break');
    assert.notEqual(fs.readFileSync(seam).toString(), 'PROVIDER-PNG');
    assert.equal(sidecar(dir, 'K1').seam_out.frameSource, 'ffmpeg', 'record which frame we actually used');
  } finally { sg.opts.omitLastFrame = false; cleanup(); }
});

test('fal never requests return_last_frame (its caps do not declare it)', PENDING, async () => {
  const { dir, cleanup } = mkTmp('sb-rlf-fal');
  try {
    const spec = specWith({ backend: 'seedance-2.0@fal', castCount: 1 });
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['e1'] },
      { job_id: 'K2', shots: ['S2'], elements: ['e1'] },
    ];
    const before = fal.requests.length;
    await renderSpec(spec, { runDir: dir });
    for (const q of fal.requests.slice(before).filter((x) => x.method === 'POST')) {
      assert.ok(!('return_last_frame' in JSON.parse(q.body)), 'an undeclared capability is never sent');
    }
  } finally { cleanup(); }
});

test('the stale "return_last_frame is deliberately NOT requested" comment is gone from the renderer', PENDING, () => {
  const src = fs.readFileSync(path.join(config.root, 'src/lib/render-seedance.js'), 'utf8');
  assert.ok(!/deliberately NOT requested/.test(src),
    'the comment describes the OLD behaviour — a reader who trusts it will look for a bug that is not there');
});
