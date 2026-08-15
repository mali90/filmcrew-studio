// The per-run resolution pick, asserted at the WIRE. A run created at 480p has to SUBMIT 480p —
// including when the spec it renders carries a seedance.resolution pin of its own, and including
// when that pin names a tier this model cannot render (a 1080p value that survived a 2.0 → 2.5
// switch, which used to fail the run outright).
//
// The pick arrives here exactly as web/server sends it into every child of that run: the model's own
// knob (SEEDANCE25_RESOLUTION) plus RENDER_RESOLUTION_PICK, the marker that separates a deliberate
// per-run choice from a .env default. Off the knob alone the two are indistinguishable, and a spec
// pin outranks .env defaults — which is how a picked tier lost to a pinned one.
//
// A CLI run makes no pick at all, and there a hand-authored pin must still govern. That half is
// asserted in the same process by clearing the live value, the way an unset variable would.
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
const fal = await startFalServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

neutralizeDotenv();
const voices = mkTmp('res-pick-voices');
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_SEEDANCE25_ENDPOINT: 'seedance25-submit',
  FAL_SEEDANCE25_PROBE_ENDPOINT: 'seedance25-probe',
  FAL_STORAGE_INITIATE_URL: `${fal.baseUrl}/storage/upload/initiate`,
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  RENDER_BACKEND: 'seedance-2.5@fal',
  SEEDANCE25_RESOLUTION: '480p',   // the knob run-service pins on the child…
  RENDER_RESOLUTION_PICK: '480p',  // …and the marker saying a human picked it for THIS run
  VOICES_DIR: voices.dir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('res-pick-out');
const cache = mkTmp('res-pick-cache');
config.paths.out = out.dir;
config.paths.cache = cache.dir;
const { renderSpec } = await import('../../src/lib/pipeline.js');

const lastSubmit = (from) => fal.requests.slice(from).find((q) => q.method === 'POST' && q.path === '/seedance25-submit');
/** The golden spec as ONE job, pinned to a resolution the way a hand-authored (or inherited) spec is. */
const pinnedSpec = (resolution) => {
  const spec = loadGoldenSpec();
  spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['subject'] }];
  spec.seedance = { resolution };
  return spec;
};

test.before(() => fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}'));
test.after(async () => { await fal.close(); out.cleanup(); cache.cleanup(); voices.cleanup(); });

test('the picked tier is submitted, not the spec pin', async () => {
  const { dir, cleanup } = mkTmp('res-pick-over-pin');
  try {
    const before = fal.requests.length;
    await renderSpec(pinnedSpec('720p'), { runDir: dir });
    assert.equal(JSON.parse(lastSubmit(before).body).resolution, '480p', 'the run was created at 480p — the 720p pin does not decide the render');
  } finally { cleanup(); }
});

test('an off-ladder stale pin is outranked, not obeyed and not fatal', async () => {
  const { dir, cleanup } = mkTmp('res-pick-stale');
  try {
    const before = fal.requests.length;
    // 1080p is on 2.0's ladder, never on 2.5's — a spec planned before a model switch carries it,
    // and honouring it threw "Unknown resolution" on a run whose tier the user had settled.
    await renderSpec(pinnedSpec('1080p'), { runDir: dir });
    assert.equal(JSON.parse(lastSubmit(before).body).resolution, '480p');
  } finally { cleanup(); }
});

test('with NO per-run pick (a CLI run) the hand-authored pin still governs', async () => {
  const { dir, cleanup } = mkTmp('res-pick-cli');
  const picked = config.render.resolutionPick;
  config.render.resolutionPick = ''; // what an unset RENDER_RESOLUTION_PICK reads as
  try {
    const before = fal.requests.length;
    // The knob still says 480p; the pin is the only thing that can lift it, and it must.
    await renderSpec(pinnedSpec('720p'), { runDir: dir });
    assert.equal(JSON.parse(lastSubmit(before).body).resolution, '720p');
  } finally { config.render.resolutionPick = picked; cleanup(); }
});
