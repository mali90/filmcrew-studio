// seedance-2.5@fal — the smallest possible provider delta: the SAME fal transport, a different
// registry entry. Nothing in fal.js, render-seedance.js or seedance-args.js may branch on the model;
// everything asserted below is a consequence of the caps bundle alone.
//
// What makes 2.5 different from 2.0 on fal (plan "Research facts", verified against the live
// endpoint 2026-08-08) — and therefore what this file pins on the recorded request body:
//   * refs are cited `[Image1]` (BRACKET), not `@Image1`
//   * shots are numbered `Shot 1: …`, not joined with `Cut to:` connectors
//   * `duration` is still a STRING, but the window is 4–30s (2.0 tops out at 15)
//   * `seed` IS accepted (fal's 2.0 endpoint 422s on it)
//   * resolution is 480p|720p ONLY, default 720p (2.0 defaults 480p and goes to 4k)
//   * there are NO first/last-frame parameters on this endpoint, so a chained seam frame is demoted
//     to the LAST image ref and prompt-pinned — byte-for-byte the same seam strategy as 2.0
//   * all six numeric aspect ratios render
//
// TDD (red first): RENDER_MODELS['seedance-2.5'].providers.fal, config.fal.seedance25Endpoint and
// the `seedance25` knobs block do not exist yet, so `RENDER_BACKEND=seedance-2.5@fal` throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
import { hasFfmpeg, tinyMp4Bytes } from '../helpers/ffmpeg-clips.js';
import { startFalServer } from '../helpers/fal-server.js';

const FF = await hasFfmpeg();
const videoBytes = FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4');

const fal = await startFalServer({ videoBytes });

neutralizeDotenv();
const voices = mkTmp('sd25-voices');
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_SEEDANCE25_ENDPOINT: 'seedance25-submit',
  FAL_SEEDANCE25_PROBE_ENDPOINT: 'seedance25-probe',
  FAL_STORAGE_INITIATE_URL: `${fal.baseUrl}/storage/upload/initiate`,
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  RENDER_BACKEND: 'seedance-2.5@fal',
  VOICES_DIR: voices.dir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('sd25-out');
const cache = mkTmp('sd25-cache');
config.paths.out = out.dir;
config.paths.cache = cache.dir;
const { renderSpec } = await import('../../src/lib/pipeline.js');

const lastSubmit = (from) => fal.requests.slice(from).find((q) => q.method === 'POST');

test.before(() => fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}'));
test.after(async () => { await fal.close(); out.cleanup(); cache.cleanup(); voices.cleanup(); });

test('config: the 2.5 endpoints and knobs are their own, defaulting to the live endpoint id', () => {
  assert.equal(config.fal.seedance25Endpoint, 'seedance25-submit');       // FAL_SEEDANCE25_ENDPOINT
  assert.equal(config.fal.seedance25ProbeEndpoint, 'seedance25-probe');   // FAL_SEEDANCE25_PROBE_ENDPOINT
  assert.equal(config.seedance25.resolution, '720p');                     // SEEDANCE25_RESOLUTION default
  assert.equal(config.seedance25.probeResolution, '480p');                // SEEDANCE25_PROBE_RESOLUTION default
  // the 2.0 endpoints are untouched — two models, two settings, one transport
  assert.equal(config.fal.seedanceEndpoint, 'bytedance/seedance-2.0/reference-to-video');
});

test('full render: bracket refs, numbered shots, STRING duration, seed sent, 720p by default', async () => {
  const { dir, cleanup } = mkTmp('sd25-full');
  try {
    const before = fal.requests.length;
    const r = await renderSpec(loadGoldenSpec(), { runDir: dir, probe: true });
    assert.equal(r.backend, 'seedance-2.5@fal');
    assert.ok(r.clip && fs.existsSync(r.clip));

    const submit = lastSubmit(before);
    assert.equal(submit.path, '/seedance25-probe', 'a probe rides FAL_SEEDANCE25_PROBE_ENDPOINT');
    const body = JSON.parse(submit.body);

    // ── the three prompt-shape facts that make 2.5 a different model ──
    assert.match(body.prompt, /\[Image1\]/, 'refs are cited in BRACKET style');
    assert.ok(!body.prompt.includes('@Image'), 'never the 2.0 compact style');
    assert.match(body.prompt, /Shot 1: /);
    assert.match(body.prompt, /\nShot 2: /);
    assert.ok(!body.prompt.includes('Cut to:'), 'numbered shots carry no connector words');

    // ── the payload facts ──
    assert.equal(typeof body.duration, 'string', 'fal 2.5 still takes a STRING duration');
    assert.equal(body.duration, '13');
    assert.ok('seed' in body, 'unlike fal 2.0, the 2.5 endpoint accepts a seed');
    assert.equal(body.seed, 70000, "the pipeline's per-job seed is actually sent");
    assert.equal(body.resolution, '480p', 'a probe renders at SEEDANCE25_PROBE_RESOLUTION');
    assert.equal(body.aspect_ratio, '9:16');
    assert.deepEqual(Object.keys(body).filter((k) => /image_urls|audio_urls|video_urls/.test(k)), ['image_urls']);
    for (const k of ['first_frame_url', 'last_frame_url', 'start_image_url', 'end_image_url', 'elements', 'negative_prompt']) {
      assert.ok(!(k in body), `${k} must never reach the 2.5 reference endpoint`);
    }

    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'K1', 'prompts.json'), 'utf8'));
    assert.equal(sidecar.backend, 'seedance-2.5@fal');
    assert.equal(sidecar.endpoint, 'seedance25-probe');
    // The sidecar records the seed HONESTLY: on a model that accepts one it is `seed` (what was
    // sent, so a take can be reproduced); `seed_unused` stays the fal-2.0-only record of a seed the
    // endpoint would 422 on. A model that accepts a seed must never report it as "unused".
    assert.equal(sidecar.seed, 70000);
    assert.equal(sidecar.seed_unused, null);
  } finally { cleanup(); }
});

test('the standard endpoint and the 720p default drive a full (non-probe) render', async () => {
  const { dir, cleanup } = mkTmp('sd25-standard');
  try {
    const spec = loadGoldenSpec();
    spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['subject'] }];
    const before = fal.requests.length;
    await renderSpec(spec, { runDir: dir });
    const submit = lastSubmit(before);
    assert.equal(submit.path, '/seedance25-submit');
    assert.equal(JSON.parse(submit.body).resolution, '720p', 'SEEDANCE25_RESOLUTION default — NOT seedance 2.0\'s 480p');
  } finally { cleanup(); }
});

test('a 21:9 run renders — all six numeric ratios are on 2.5\'s list', async () => {
  const { dir, cleanup } = mkTmp('sd25-wide');
  try {
    const spec = loadGoldenSpec();
    spec.project.aspect_ratio = '21:9';
    spec.kling.aspect_ratio = '21:9';
    spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['subject'] }];
    const before = fal.requests.length;
    const r = await renderSpec(spec, { runDir: dir, probe: true });
    assert.ok(r.clip && fs.existsSync(r.clip));
    assert.equal(JSON.parse(lastSubmit(before).body).aspect_ratio, '21:9');
  } finally { cleanup(); }
});

test('a 30s job is legal here (2.0 would reject it) and ships as the string "30"', async () => {
  const { dir, cleanup } = mkTmp('sd25-30s');
  try {
    const spec = loadGoldenSpec();
    spec.shots = [spec.shots[0]];
    spec.shots[0].duration_s = 30;
    spec.audio.voice.lines = spec.audio.voice.lines.filter((l) => l.shot_id === spec.shots[0].shot_id);
    spec.kling.jobs = [{ job_id: 'K1', shots: [spec.shots[0].shot_id], elements: ['subject'] }];
    const before = fal.requests.length;
    await renderSpec(spec, { runDir: dir, probe: true });
    assert.equal(JSON.parse(lastSubmit(before).body).duration, '30');
  } finally { cleanup(); }
});

test('2-job render: the seam frame is the LAST image ref, prompt-pinned as [ImageN]', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('sd25-chain');
  try {
    const spec = loadGoldenSpec();
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
      { job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'] },
    ];
    const before = fal.requests.length;
    const r = await renderSpec(spec, { runDir: dir });
    assert.ok(r.master && fs.existsSync(r.master));

    const submits = fal.requests.slice(before).filter((q) => q.method === 'POST' && q.path === '/seedance25-submit');
    assert.equal(submits.length, 2);
    const b1 = JSON.parse(submits[0].body);
    const b2 = JSON.parse(submits[1].body);
    assert.ok(!b1.prompt.includes('literal first frame'), 'job 1 has nothing to chain from');
    assert.equal(b2.image_urls.length, b1.image_urls.length + 1, 'the seam frame takes one extra image slot');
    assert.match(b2.prompt, /Use \[Image2\] as the literal first frame of this clip/);
    assert.ok(!('first_frame_url' in b2), 'this endpoint has no native anchor — demotion is the ONLY path');
  } finally { cleanup(); }
});

test('a text-to-video job falls back to the reference endpoint (2.5 declares no text tier)', async () => {
  const { dir, cleanup } = mkTmp('sd25-ttv');
  try {
    const spec = loadGoldenSpec();
    spec.kling.elements = [];
    spec.kling.jobs.forEach((j) => { j.elements = []; });
    const before = fal.requests.length;
    const r = await renderSpec(spec, { runDir: dir, probe: true });
    assert.ok(r.clip && fs.existsSync(r.clip));
    const submit = lastSubmit(before);
    assert.equal(submit.path, '/seedance25-probe', 'no textEndpointKey ⇒ the model\'s own endpoint');
    const body = JSON.parse(submit.body);
    assert.ok(!('image_urls' in body));
    assert.ok(!body.prompt.includes('[Image'), 'no dangling bracket refs');
  } finally { cleanup(); }
});
