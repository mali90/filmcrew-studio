// seedance-2.5@segmind and seedance-2.0@segmind through renderSpec, against the mock Segmind queue.
//
// The whole point of this file is that NOTHING new was written to make these two backends render:
// the generalized renderer + the pure arg builder are the same modules fal uses, and the difference
// is entirely (a) a registry entry and (b) a provider adapter. So every assertion below is really an
// assertion about the caps bundle reaching the wire intact:
//
//   * the queue is addressed by SLUG (`POST /v2/seedance-2.5`), resolved from config.segmind by the
//     registry's `slugKey` — the same endpointFor() that resolves fal's `endpointKey`
//   * refs are cited `@Image 1` (SPACED), shots numbered on 2.5 / `Cut to:`-joined on 2.0
//   * `duration` is an INTEGER here (fal takes a string) and `seed` + `return_last_frame` are sent
//   * the argument KEY NAMES are Segmind's (`reference_images`, not `image_urls`)
//   * the seam frame takes the NATIVE `first_frame_url` slot only when the job has no cast refs —
//     the two inputs are mutually exclusive on Segmind (firstFrameExcludesRefs), so a job WITH refs
//     demotes it to the last `reference_images` entry and pins it in the prompt instead
//   * the sidecar records the provider receipt: request_id + the terminal cost/credits metrics
//
// TDD (red first): the two segmind registry entries, src/lib/segmind-seedance.js and the
// SEEDANCE_ADAPTERS.segmind binding do not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
import { hasFfmpeg, tinyMp4Bytes } from '../helpers/ffmpeg-clips.js';
import { startSegmindServer } from '../helpers/segmind-server.js';

const FF = await hasFfmpeg();
const sg = await startSegmindServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

neutralizeDotenv();
const voices = mkTmp('sgsd-voices');
Object.assign(process.env, {
  SEGMIND_BASE_URL: sg.baseUrl, SEGMIND_API_KEY: 'sk-test',
  SEGMIND_UPLOAD_MODE: 'data-uri',            // a Segmind-ONLY install: no fal key is set below
  SEGMIND_MAX_RETRIES: '1', SEGMIND_RETRY_BACKOFF_MS: '1',
  FAL_KEY: '', FAL_API_KEY: '',
  RENDER_BACKEND: 'seedance-2.5@segmind',
  VOICES_DIR: voices.dir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
  LOG_LEVEL: 'error',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('sgsd-out');
const cache = mkTmp('sgsd-cache');
config.paths.out = out.dir;
config.paths.cache = cache.dir;
const { renderSpec } = await import('../../src/lib/pipeline.js');

const submitsSince = (from) => sg.requests.slice(from).filter((q) => q.method === 'POST');

test.before(() => fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}'));
test.after(async () => { await sg.close(); out.cleanup(); cache.cleanup(); voices.cleanup(); });

test('seedance-2.5@segmind: slug route, spaced refs, numbered shots, INT duration, seed + return_last_frame', async () => {
  const { dir, cleanup } = mkTmp('sg-25');
  try {
    const before = sg.requests.length;
    const r = await renderSpec(loadGoldenSpec(), { runDir: dir, probe: true });
    assert.equal(r.backend, 'seedance-2.5@segmind');
    assert.ok(r.clip && fs.existsSync(r.clip));

    const submit = submitsSince(before)[0];
    assert.equal(submit.path, '/v2/seedance-2.5', 'the slug comes from config.segmind.seedance25Slug via caps.slugKey');
    const body = JSON.parse(submit.body);

    assert.match(body.prompt, /@Image 1/, 'Segmind cites refs in SPACED style');
    assert.ok(!body.prompt.includes('@Image1'), 'never fal 2.0\'s compact style');
    assert.ok(!body.prompt.includes('[Image1]'), 'never fal 2.5\'s bracket style');
    assert.match(body.prompt, /Shot 1: /);
    assert.ok(!body.prompt.includes('Cut to:'), '2.5 numbers its shots on BOTH providers');

    assert.equal(typeof body.duration, 'number', 'Segmind takes an INTEGER duration');
    assert.equal(body.duration, 13);
    assert.equal(body.seed, 70000);
    assert.equal(body.return_last_frame, true, 'asked for, so the next job can chain from it');
    assert.equal(body.resolution, '720p');
    assert.equal(body.aspect_ratio, '9:16');

    assert.equal(body.reference_images.length, 1, 'Segmind\'s own key name — the golden spec\'s single element');
    assert.ok(body.reference_images[0].startsWith('data:'), 'refs travel per SEGMIND_UPLOAD_MODE');
    for (const k of ['image_urls', 'audio_urls', 'video_urls']) assert.ok(!(k in body), `${k} is a fal key name`);
  } finally { cleanup(); }
});

test('the sidecar records the provider receipt: backend id, request_id and the cost metrics', async () => {
  const { dir, cleanup } = mkTmp('sg-receipt');
  try {
    sg.opts.cost = 0.51;
    sg.opts.remainingCredits = 777;
    await renderSpec(loadGoldenSpec(), { runDir: dir, probe: true });
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'K1', 'prompts.json'), 'utf8'));
    assert.equal(sidecar.backend, 'seedance-2.5@segmind');
    assert.equal(sidecar.endpoint, 'seedance-2.5', 'the slug is what was called');
    assert.equal(sidecar.request_id, sg.queued.at(-1).id, 'the receipt: which Segmind job produced this clip');
    assert.equal(sidecar.cost_usd, 0.51);
    assert.equal(sidecar.remaining_credits, 777);
    assert.equal(sidecar.seed, 70000);
  } finally { cleanup(); }
});

test('seam frame — NATIVE first_frame_url with no cast refs, DEMOTED to a trailing ref with them', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  // (a) castless: the native anchor is free, so use it — it is a stronger conditioning signal.
  const bare = mkTmp('sg-seam-native');
  try {
    const spec = loadGoldenSpec();
    spec.kling.elements = [];
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: [] },
      { job_id: 'K2', shots: ['S2', 'S3'], elements: [] },
    ];
    const before = sg.requests.length;
    await renderSpec(spec, { runDir: bare.dir });
    const [b1, b2] = submitsSince(before).map((q) => JSON.parse(q.body));
    assert.ok(!('first_frame_url' in b1), 'job 1 has nothing to chain from');
    assert.ok(b2.first_frame_url, 'job 2 rides the NATIVE first-frame slot');
    assert.ok(!('reference_images' in b2), 'the native slot is mutually exclusive with reference images');
    assert.ok(!b2.prompt.includes('literal first frame'), 'a native anchor needs no prompt pin');
  } finally { bare.cleanup(); }

  // (b) with cast refs: identity wins, so the frame is demoted to the LAST ref and pinned in prose.
  const cast = mkTmp('sg-seam-demoted');
  try {
    const spec = loadGoldenSpec();
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
      { job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'] },
    ];
    const before = sg.requests.length;
    await renderSpec(spec, { runDir: cast.dir });
    const [b1, b2] = submitsSince(before).map((q) => JSON.parse(q.body));
    assert.ok(!('first_frame_url' in b2), 'never both — Segmind rejects the combination');
    assert.equal(b2.reference_images.length, b1.reference_images.length + 1, 'the seam frame took one extra slot');
    assert.match(b2.prompt, /Use @Image 2 as the literal first frame of this clip/);
  } finally { cast.cleanup(); }
});

test('seedance-2.0@segmind: its own slug, "Cut to:" connectors, 1080p, and its 15s ceiling', async () => {
  const { dir, cleanup } = mkTmp('sg-20');
  try {
    const spec = loadGoldenSpec();
    spec.render_backend = 'seedance-2.0@segmind';
    spec.seedance = { resolution: '1080p' }; // 2.0 on Segmind goes to 1080p/4k; 2.5 stops at 720p
    const before = sg.requests.length;
    const r = await renderSpec(spec, { runDir: dir, probe: true });
    assert.equal(r.backend, 'seedance-2.0@segmind');

    const submit = submitsSince(before)[0];
    assert.equal(submit.path, '/v2/seedance-2.0');
    const body = JSON.parse(submit.body);
    assert.match(body.prompt, /@Image 1/, 'spaced refs are a PROVIDER trait, shared by both Segmind models');
    assert.match(body.prompt, /\nCut to: /, '2.0 keeps connector joins on Segmind too');
    assert.ok(!/Shot \d: /.test(body.prompt), 'numbering is a 2.5 trait');
    assert.equal(typeof body.duration, 'number');
    assert.equal(body.resolution, '1080p');
    assert.equal(body.seed, 70000, 'Segmind accepts a seed on 2.0 — unlike fal, where it 422s');
    assert.ok('reference_images' in body);
  } finally { cleanup(); }
});

test('a 20s job is rejected for seedance-2.0@segmind before anything is submitted', async () => {
  const { dir, cleanup } = mkTmp('sg-20-toolong');
  try {
    const { capsFor } = await import('../../src/lib/render-models.js');
    const { nameOf } = await import('../../src/lib/seedance-args.js');
    const caps = capsFor('seedance-2.0@segmind');
    assert.equal(caps.maxSeconds, 15);
    // every renderer-level message about this model names the exact pair that rejected the job
    assert.equal(nameOf(caps), 'Seedance 2.0 on Segmind');

    const spec = loadGoldenSpec();
    spec.render_backend = 'seedance-2.0@segmind';
    spec.shots = [spec.shots[0]];
    spec.shots[0].duration_s = 20;
    spec.audio.voice.lines = spec.audio.voice.lines.filter((l) => l.shot_id === spec.shots[0].shot_id);
    spec.kling.jobs = [{ job_id: 'K1', shots: [spec.shots[0].shot_id], elements: ['subject'] }];

    const before = sg.requests.length;
    await assert.rejects(renderSpec(spec, { runDir: dir, probe: true }), (e) => {
      assert.match(e.message, /Seedance 2\.0/);
      assert.match(e.message, /15s/);
      return true;
    });
    assert.equal(submitsSince(before).length, 0, 'nothing was queued — the cap bites before the spend');
  } finally { cleanup(); }
});

test('a 30s job renders on 2.5@segmind — the two models genuinely differ in window', async () => {
  const { dir, cleanup } = mkTmp('sg-25-30s');
  try {
    const spec = loadGoldenSpec();
    spec.shots = [spec.shots[0]];
    spec.shots[0].duration_s = 30;
    spec.audio.voice.lines = spec.audio.voice.lines.filter((l) => l.shot_id === spec.shots[0].shot_id);
    spec.kling.jobs = [{ job_id: 'K1', shots: [spec.shots[0].shot_id], elements: ['subject'] }];
    const before = sg.requests.length;
    await renderSpec(spec, { runDir: dir, probe: true });
    assert.equal(JSON.parse(submitsSince(before)[0].body).duration, 30);
  } finally { cleanup(); }
});

test('a 21:9 run renders on Segmind (six ratios) and the aspect reaches the payload', async () => {
  const { dir, cleanup } = mkTmp('sg-wide');
  try {
    const spec = loadGoldenSpec();
    spec.project.aspect_ratio = '21:9';
    spec.kling.aspect_ratio = '21:9';
    spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['subject'] }];
    const before = sg.requests.length;
    await renderSpec(spec, { runDir: dir, probe: true });
    assert.equal(JSON.parse(submitsSince(before)[0].body).aspect_ratio, '21:9');
  } finally { cleanup(); }
});

test('a voice clip under 2s is DROPPED with a warning, not sent to be 422d', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('sg-shortvoice');
  try {
    const { spawn } = await import('node:child_process');
    const shortMp3 = path.join(voices.dir, 'keeper-short.mp3');
    await new Promise((resolve, reject) => {
      const c = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-ac', '1', shortMp3], { stdio: 'ignore' });
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), JSON.stringify({ keeper: { name: 'keeper', voice_id: 'v1', ref_clip: shortMp3 } }));
    const spec = loadGoldenSpec();
    spec.audio.voice.lines[0].speaker = 'keeper';

    const before = sg.requests.length;
    const r = await renderSpec(spec, { runDir: dir, probe: true });
    assert.ok(r.clip, 'the render still happens — a missing voice ref is a downgrade, not a failure');
    const body = JSON.parse(submitsSince(before)[0].body);
    assert.ok(!('reference_audios' in body), 'the too-short clip never reached the provider');
    assert.ok(!body.prompt.includes('@Audio'), 'and no prompt note cites a ref that was not sent');
  } finally {
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}');
    cleanup();
  }
});
