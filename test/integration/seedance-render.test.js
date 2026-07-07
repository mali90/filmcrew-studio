// renderSpec with the Seedance backend against the mock fal queue: endpoint/tier selection, flat
// args (no 422 landmines), chained seam frame as a prompt-pinned @Image ref, voice-ref lip-sync.
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
const videoBytes = FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4'); // real mp4 so assembly/chaining run

const fal = await startFalServer({ videoBytes });

// Set ALL env BEFORE importing config.js (which snapshots process.env at import), then mutate the
// non-env paths (out/cache) on the config singleton before importing pipeline.js.
neutralizeDotenv();
const voices = mkTmp('seedance-voices');
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  FAL_TOPAZ_ENDPOINT: 'topaz-submit',
  FAL_STORAGE_INITIATE_URL: `${fal.baseUrl}/storage/upload/initiate`,
  SEEDANCE_UPLOAD_MODE: 'data-uri', RENDER_BACKEND: 'seedance',
  VOICES_DIR: voices.dir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('seedance-out');
const cache = mkTmp('seedance-cache');
config.paths.out = out.dir;
config.paths.cache = cache.dir;
const { renderSpec } = await import('../../src/lib/pipeline.js');

const lastSubmit = (from) => fal.requests.slice(from).find((q) => q.method === 'POST');

test.after(async () => { await fal.close(); out.cleanup(); cache.cleanup(); voices.cleanup(); });

test('probe: mini endpoint, probe resolution, flat args, no seed/negative_prompt/elements', async () => {
  const { dir, cleanup } = mkTmp('sd-probe');
  try {
    const before = fal.requests.length;
    const r = await renderSpec(loadGoldenSpec(), { runDir: dir, probe: true });
    assert.equal(r.probe, true);
    assert.equal(r.backend, 'seedance');
    assert.ok(r.clip && fs.existsSync(r.clip));

    const submit = lastSubmit(before);
    assert.equal(submit.path, '/seedance-probe', 'probe honors FAL_SEEDANCE_PROBE_ENDPOINT (standard tier by default)');
    const body = JSON.parse(submit.body);
    assert.ok(body.prompt.includes('lighthouse beam'), 'shot prose reaches the prompt');
    assert.equal(body.image_urls.length, 1); // the golden spec's single element
    assert.equal(body.resolution, '480p');   // SEEDANCE_PROBE_RESOLUTION default
    assert.equal(body.aspect_ratio, '9:16');
    assert.equal(body.duration, '13');
    assert.equal(body.generate_audio, true);
    for (const k of ['seed', 'negative_prompt', 'elements', 'audio_urls']) assert.ok(!(k in body), `${k} must not be sent`);

    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'K1', 'prompts.json'), 'utf8'));
    assert.equal(sidecar.backend, 'seedance');
    assert.equal(sidecar.endpoint, 'seedance-probe');
    assert.equal(sidecar.seed_unused, 70000); // pipeline's per-job seed is recorded, never sent
  } finally { cleanup(); }
});

test('take: the regen nonce reaches the prompt as an Alternate take directive', async () => {
  const { dir, cleanup } = mkTmp('sd-take');
  try {
    const before = fal.requests.length;
    await renderSpec(loadGoldenSpec(), { runDir: dir, probe: true, take: 3 });
    const body = JSON.parse(lastSubmit(before).body);
    assert.match(body.prompt, /Alternate take 3: vary the staging, camera framing, and timing/);
  } finally { cleanup(); }
});

test('2-job render: seam frame becomes an extra @Image ref, prompt-pinned as the first frame', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('sd-chain');
  try {
    const spec = loadGoldenSpec();
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
      { job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'] },
    ];
    const before = fal.requests.length;
    const r = await renderSpec(spec, { runDir: dir });
    assert.ok(r.master && fs.existsSync(r.master), 'master mp4 exists');

    const submits = fal.requests.slice(before).filter((q) => q.method === 'POST' && q.path === '/seedance-submit');
    assert.equal(submits.length, 2, 'standard endpoint for a full render');
    const b1 = JSON.parse(submits[0].body);
    const b2 = JSON.parse(submits[1].body);
    assert.equal(b1.resolution, '480p'); // config default — the KLING block's resolution must NOT leak into Seedance (it once billed 480p plans at 1080p)
    assert.ok(!b1.prompt.includes('literal first frame'), 'job 1 has no frame to chain from');
    assert.equal(b2.image_urls.length, b1.image_urls.length + 1, 'seam frame takes one extra image slot');
    assert.match(b2.prompt, /Use @Image2 as the literal first frame of this clip/);
  } finally { cleanup(); }
});

test('reference mode (default): registered voice clip → audio_urls + @Audio1 voice-identity note', async () => {
  const { dir, cleanup } = mkTmp('sd-voice');
  try {
    const clip = path.join(voices.dir, 'keeper.mp3');
    fs.writeFileSync(clip, Buffer.from('FAKE-MP3')); // unprobe-able → sent as-is (warn path)
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), JSON.stringify({ keeper: { name: 'keeper', voice_id: 'v1', ref_clip: clip } }));
    const spec = loadGoldenSpec();
    spec.audio.voice.lines[0].speaker = 'keeper';
    const before = fal.requests.length;
    await renderSpec(spec, { runDir: dir, probe: true });
    const body = JSON.parse(lastSubmit(before).body);
    assert.equal(body.audio_urls?.length, 1, 'reference mode still attaches the voice clip');
    assert.ok(body.audio_urls[0].startsWith('data:'), 'ref travels per SEEDANCE_UPLOAD_MODE');
    assert.match(body.prompt, /@Audio1 is the sound of Keeper's voice/);
    assert.ok(!/lip-sync Keeper's mouth to it/.test(body.prompt), 'no reproduce-the-clip phrasing');
  } finally { cleanup(); }
});

test('native mode (SEEDANCE_VOICE_MODE=native): NO audio_urls; the written line is voiced natively', async () => {
  const { dir, cleanup } = mkTmp('sd-voice-native');
  const prev = config.seedance.voiceMode;
  config.seedance.voiceMode = 'native';
  try {
    const clip = path.join(voices.dir, 'keeper.mp3');
    fs.writeFileSync(clip, Buffer.from('FAKE-MP3'));
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), JSON.stringify({ keeper: { name: 'keeper', voice_id: 'v1', ref_clip: clip } }));
    const spec = loadGoldenSpec();
    spec.audio.voice.lines[0].speaker = 'keeper';
    const before = fal.requests.length;
    await renderSpec(spec, { runDir: dir, probe: true });
    const body = JSON.parse(lastSubmit(before).body);
    assert.ok(!('audio_urls' in body), 'native mode attaches no clip');
    assert.ok(!body.prompt.includes('@Audio'), 'no voice-ref note');
    assert.match(body.prompt, /says: "Forty years I kept this light\."/, 'the written line still drives native speech');
  } finally { config.seedance.voiceMode = prev; cleanup(); }
});

test('spec.render_backend beats the env default: "kling" in the spec routes to the Kling endpoint', async () => {
  const { dir, cleanup } = mkTmp('sd-specbackend');
  try {
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}');
    const spec = loadGoldenSpec();
    spec.render_backend = 'kling'; // env says seedance (RENDER_BACKEND above) — the spec must win
    const before = fal.requests.length;
    const r = await renderSpec(spec, { runDir: dir, probe: true });
    assert.equal(r.backend, 'kling');
    const submit = lastSubmit(before);
    assert.equal(submit.path, '/submit');
    const body = JSON.parse(submit.body);
    assert.ok(Array.isArray(body.elements), 'Kling payload shape (elements), not flat seedance args');
  } finally { cleanup(); }
});

test('more voiced speakers than Seedance\'s 3-audio-ref cap is a per-job error, not a bad request', async () => {
  const { dir, cleanup } = mkTmp('sd-4speakers');
  try {
    const reg = {};
    for (const sp of ['keeper', 'gull', 'crab', 'whale']) {
      const clip = path.join(voices.dir, `${sp}.mp3`);
      fs.writeFileSync(clip, Buffer.from('FAKE-MP3'));
      reg[sp] = { name: sp, voice_id: `v_${sp}`, ref_clip: clip };
    }
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), JSON.stringify(reg));
    const spec = loadGoldenSpec();
    spec.audio.voice.lines = [
      { shot_id: 'S1', text: 'One.', speaker: 'keeper' },
      { shot_id: 'S1', text: 'Two.', speaker: 'gull' },
      { shot_id: 'S2', text: 'Three.', speaker: 'crab' },
      { shot_id: 'S3', text: 'Four.', speaker: 'whale' },
    ];
    const before = fal.requests.length;
    const r = await renderSpec(spec, { runDir: dir, probe: true });
    assert.match(r.jobs[0].error, /4 voiced speakers exceeds Seedance's 3-audio-ref cap/);
    assert.equal(lastSubmit(before), undefined, 'nothing was submitted to fal');
  } finally { cleanup(); }
});

test('over-budget voice clip is re-cut to MP3 within the 15s audio budget', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('sd-recut');
  try {
    const { spawn } = await import('node:child_process');
    const longWav = path.join(voices.dir, 'keeper16.wav');
    await new Promise((resolve, reject) => {
      const c = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=16', '-ac', '1', longWav], { stdio: 'ignore' });
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), JSON.stringify({ keeper: { name: 'keeper', voice_id: 'v1', ref_clip: longWav } }));
    const spec = loadGoldenSpec();
    spec.audio.voice.lines[0].speaker = 'keeper';
    const before = fal.requests.length;
    await renderSpec(spec, { runDir: dir, probe: true });
    const body = JSON.parse(lastSubmit(before).body);
    assert.equal(body.audio_urls?.length, 1);
    const recut = path.join(dir, 'K1', 'keeper_ref.mp3');
    assert.ok(fs.existsSync(recut), 're-cut mp3 written into the job dir');
    const { probeClip } = await import('../../src/lib/assemble.js');
    const { duration } = await probeClip(recut);
    assert.ok(duration > 13 && duration <= 15.5, `re-cut to the 15s budget (got ${duration}s)`);
  } finally { cleanup(); }
});

test('--upscale lifts EACH sub-1080p clip via Topaz before assembly (one job per clip)', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('sd-upscale');
  try {
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}');
    const spec = loadGoldenSpec();
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
      { job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'] },
    ];
    const before = fal.requests.length;
    const r = await renderSpec(spec, { runDir: dir, upscale: true });
    assert.ok(r.master && fs.existsSync(r.master));
    const topaz = fal.requests.slice(before).filter((q) => q.method === 'POST' && q.path === '/topaz-submit');
    assert.equal(topaz.length, 2, 'per-CLIP upscale: one Topaz job per rendered clip, before the stitch');
    assert.ok(JSON.parse(topaz[0].body).video_url.includes('/dl/stored.bin'), 'clip uploaded to (mock) fal storage first');
  } finally { cleanup(); }
});

test('speaker without a registered clip still renders — native audio, no audio_urls', async () => {
  const { dir, cleanup } = mkTmp('sd-novoice');
  try {
    fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}');
    const spec = loadGoldenSpec();
    spec.audio.voice.lines[0].speaker = 'stranger';
    const before = fal.requests.length;
    const r = await renderSpec(spec, { runDir: dir, probe: true });
    assert.ok(r.clip && fs.existsSync(r.clip));
    const body = JSON.parse(lastSubmit(before).body);
    assert.ok(!('audio_urls' in body));
    assert.match(body.prompt, /Stranger says: "Forty years I kept this light\."/);
  } finally { cleanup(); }
});
