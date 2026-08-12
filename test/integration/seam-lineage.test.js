// WS2-P1 (WS2-05) — forward seam lineage: prompts.json schema:2 + render.json seamIn/seamOut.
//
// Continuity has to be a RECORDED FACT, not an inference. Today `prompts.json` records that a seam
// frame was used but not WHICH CLIP it came from, so a cut that mixes take-2's K1 with take-1's K2
// looks exactly like an intact chain (the b1nx run). P2's continuity rule — "segment i continues
// from i−1 iff its recorded seam SOURCE clip is the clip currently at position i−1" — needs the
// source clip written down at render time.
//
// Shape (both sidecars, both renderers):
//   seam_in : { mode, frame, from: { take, job, clip } | null }
//   seam_out: { mode, frame, to:   { take, job, clip } | null }
//
// THE TRAP this file exists for: finishRender() REWRITES render.json wholesale at the end
// (`summary.jobs = results.map(...)`), and assembleRun() re-derives `results` by reading it back.
// Either one can silently forget the lineage — after which every stitched cut claims a hard cut.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';
import { hasFfmpeg, tinyMp4Bytes } from '../helpers/ffmpeg-clips.js';
import { startFalServer } from '../helpers/fal-server.js';
import { pending } from '../helpers/tdd.js';

const FF = await hasFfmpeg();
const videoBytes = FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4');
const fal = await startFalServer({ videoBytes });

neutralizeDotenv();
const voices = mkTmp('seam-voices');
fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}');
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit', FAL_KLING_TEXT_ENDPOINT: 'submit-text',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  FAL_SEEDANCE_TEXT_ENDPOINT: 'seedance-text',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  VOICES_DIR: voices.dir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('seam-out');
const cache = mkTmp('seam-cache');
config.paths.out = out.dir;
config.paths.cache = cache.dir;
const { renderSpec, renderJob, assembleRun } = await import('../../src/lib/pipeline.js');

test.after(async () => { await fal.close(); out.cleanup(); cache.cleanup(); voices.cleanup(); });

const twoJobSpec = (backend) => {
  const spec = loadGoldenSpec();
  spec.render_backend = backend;
  spec.kling.jobs = [
    { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
    { job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'] },
  ];
  return spec;
};
const sidecar = (dir, job) => JSON.parse(fs.readFileSync(path.join(dir, job, 'prompts.json'), 'utf8'));
const renderJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'render.json'), 'utf8'));
// The seam lineage below arrived at schema 2; `submitted_at` (when the provider accepted the
// job) took it to 3. Both renderers write the same number — one reader serves both.
const SIDECAR_SCHEMA = 3;

// Probe for readiness ONCE, on the cheapest possible render, so the whole file arms together.
let READY = false;
if (FF) {
  const probe = mkTmp('seam-probe');
  try {
    await renderSpec(twoJobSpec('seedance'), { runDir: probe.dir });
    READY = sidecar(probe.dir, 'K2').schema >= 2 && sidecar(probe.dir, 'K2').seam_in !== undefined;
  } catch { READY = false; } finally { probe.cleanup(); }
}
const PENDING = FF
  ? pending(READY, 'WS2-05: prompts.json schema:2 + seam_in/seam_out lineage')
  : { skip: 'ffmpeg not installed' };

test('a 2-job Seedance render records seam_in.from on K2 and seam_out.to on K1', PENDING, async () => {
  const { dir, cleanup } = mkTmp('t1');
  try {
    const r = await renderSpec(twoJobSpec('seedance'), { runDir: dir });
    assert.ok(r.master && fs.existsSync(r.master));
    const take = path.basename(dir);
    const k1Clip = r.jobs.find((j) => j.jobId === 'K1').clip;
    const k2Clip = r.jobs.find((j) => j.jobId === 'K2').clip;

    const s2 = sidecar(dir, 'K2');
    assert.equal(s2.schema, SIDECAR_SCHEMA, 'the sidecar declares its shape');
    assert.equal(s2.seam_in.mode, 'soft', 'fal Seedance always SOFT-pins — it has no frame anchors');
    assert.equal(path.basename(s2.seam_in.frame), 'last_frame.png');
    assert.deepEqual(s2.seam_in.from, { take, job: 'K1', clip: k1Clip },
      'the SOURCE CLIP is what P2 compares against the clip currently at position i−1');
    assert.equal(s2.seam_out.mode, 'none', 'nothing follows K2 — an absent seam is not a broken one');
    assert.equal(s2.seam_out.to, null);

    const s1 = sidecar(dir, 'K1');
    assert.equal(s1.schema, SIDECAR_SCHEMA);
    assert.equal(s1.seam_in.mode, 'none');
    assert.equal(s1.seam_in.from, null, 'the first job chains from nothing');
    // K1's sidecar is written BEFORE K2 exists — it must be re-stamped once the next clip is known.
    assert.equal(s1.seam_out.to.job, 'K2');
    assert.equal(s1.seam_out.to.take, take);
    assert.equal(s1.seam_out.to.clip, k2Clip);
  } finally { cleanup(); }
});

test('render.json carries seamIn/seamOut for every job, and SURVIVES finishRender + assembleRun', PENDING, async () => {
  const { dir, cleanup } = mkTmp('t1-finish');
  try {
    await renderSpec(twoJobSpec('seedance'), { runDir: dir });

    const first = renderJson(dir);
    assert.equal(first.jobs.length, 2);
    for (const j of first.jobs) {
      assert.ok(j.seamIn, `${j.jobId}: seamIn survived finishRender's wholesale render.json rewrite`);
      assert.ok(j.seamOut, `${j.jobId}: seamOut survived`);
    }
    assert.equal(first.jobs[1].seamIn.from.job, 'K1');
    assert.equal(first.jobs[0].seamOut.to.job, 'K2');

    // Re-finish from disk (`npm run assemble -- --from <dir>`): readRun→results→finishRender is a
    // SECOND chance to forget the lineage, because it rebuilds `results` from render.json by hand.
    await assembleRun(dir);
    const second = renderJson(dir);
    for (const j of second.jobs) {
      assert.ok(j.seamIn, `${j.jobId}: seamIn still present after a re-finish`);
      assert.ok(j.seamOut, `${j.jobId}: seamOut still present after a re-finish`);
    }
    assert.deepEqual(second.jobs.map((j) => j.seamIn.from), first.jobs.map((j) => j.seamIn.from),
      're-finishing must not rewrite history, only re-stitch it');
  } finally { cleanup(); }
});

test('the recorded seam mode is what was APPLIED, not what was wished for', PENDING, async () => {
  const { dir, cleanup } = mkTmp('t1-applied');
  try {
    // A text-to-video Kling job cannot seed a frame from anything (no element) → 'none', even though
    // a seam frame was produced and offered.
    const spec = twoJobSpec('kling');
    spec.kling.elements = [];
    spec.kling.jobs.forEach((j) => { j.elements = []; });
    await renderSpec(spec, { runDir: dir });
    const s2 = sidecar(dir, 'K2');
    assert.equal(s2.seam_in.mode, 'none', 'Kling text-to-video ignores the frame — record the truth, not the intent');
    assert.equal(s2.seam_in.from, null);
    // …and the other end of that joint must not claim it either: K1 handed its closing frame to
    // nobody, so naming K2 as its destination would be the same false continuation, mirrored.
    assert.equal(sidecar(dir, 'K1').seam_out.to, null, 'no destination for a frame the next job could not use');
  } finally { cleanup(); }
});

test('a seam frame that was offered and refused records no source clip', PENDING, async () => {
  const t1 = mkTmp('t1-refused');
  const t2 = mkTmp('t2-refused');
  try {
    // --seam-from finds the prior take's closing frame, so the lineage pointer EXISTS at the call
    // site — but a text-to-video Kling job has no element to seed a frame from and pins nothing.
    // Recording the source anyway is how a hard cut gets sold as a continuation.
    fs.mkdirSync(path.join(t1.dir, 'K1'), { recursive: true });
    fs.writeFileSync(path.join(t1.dir, 'K1', 'last_frame.png'), ONE_PX_PNG);
    const spec = twoJobSpec('kling');
    spec.kling.elements = [];
    spec.kling.jobs.forEach((j) => { j.elements = []; });

    await renderJob(spec, 'K2', { runDir: t2.dir, seamFrom: t1.dir });
    const s2 = sidecar(t2.dir, 'K2');
    assert.equal(s2.seam_in.mode, 'none');
    assert.equal(s2.seam_in.frame, null);
    assert.equal(s2.seam_in.from, null, 'an offered-and-refused frame is not a continuation');
    assert.equal(renderJson(t2.dir).jobs[0].seamIn.from, null, 'render.json tells the same story');
  } finally { t1.cleanup(); t2.cleanup(); }
});

test('the Kling sidecar is normalized to the Seedance superset (one reader for both)', PENDING, async () => {
  const k = mkTmp('t1-kling');
  const s = mkTmp('t1-seedance');
  try {
    await renderSpec(twoJobSpec('kling'), { runDir: k.dir });
    await renderSpec(twoJobSpec('seedance'), { runDir: s.dir });
    const kSide = sidecar(k.dir, 'K2');
    const sSide = sidecar(s.dir, 'K2');

    const shared = ['job_id', 'schema', 'backend', 'endpoint', 'aspect_ratio', 'duration_s',
      'generate_audio', 'seed', 'seed_unused', 'nonce', 'image_refs', 'seam_in', 'seam_out'];
    for (const key of shared) {
      assert.ok(key in kSide, `the Kling sidecar must carry "${key}" (schema:2 superset)`);
      assert.ok(key in sSide, `the Seedance sidecar must carry "${key}"`);
    }
    // `resolution` is recorded only where it is SENT: the Seedance payload carries one, Kling's
    // endpoint takes none — a sidecar claiming a tier for Kling would be the record lying.
    assert.ok('resolution' in sSide, 'Seedance records the tier it transmitted');
    assert.ok(!('resolution' in kSide), 'Kling records no tier — nothing was sent');
    assert.equal(kSide.schema, SIDECAR_SCHEMA);
    assert.equal(kSide.backend, 'kling-o3@fal');
    assert.equal(kSide.transport, 'fal', 'Kling keeps its own extra keys — existing readers must not break');
    // Every key Kling writes TODAY is still there.
    for (const key of ['elements', 'segments', 'start_frame']) assert.ok(key in kSide, `Kling still writes "${key}"`);
  } finally { k.cleanup(); s.cleanup(); }
});

test('renderJob --seam-from records the SOURCE take, and leaves other jobs\' seams untouched', PENDING, async () => {
  const t1 = mkTmp('t1-prior');
  const t2 = mkTmp('t2-rerender');
  try {
    // t1: a full 2-job render, so t1/K1/last_frame.png and a populated render.json exist.
    await renderSpec(twoJobSpec('seedance'), { runDir: t1.dir });
    const t1Json = renderJson(t1.dir);
    const t1K1Clip = t1Json.jobs.find((j) => j.jobId === 'K1').clip;

    // t2: re-render ONLY K2, chaining from t1.
    fs.mkdirSync(path.join(t2.dir, 'K1'), { recursive: true });
    fs.writeFileSync(path.join(t2.dir, 'K1', 'last_frame.png'), ONE_PX_PNG); // stale sibling, untouched below
    await renderJob(twoJobSpec('seedance'), 'K2', { runDir: t2.dir, seamFrom: t1.dir });

    const s2 = sidecar(t2.dir, 'K2');
    assert.equal(s2.seam_in.from.take, path.basename(t1.dir), 'the seam names the take it really came from');
    assert.equal(s2.seam_in.from.job, 'K1');
    assert.equal(s2.seam_in.from.clip, t1K1Clip, "…and t1's K1 CLIP — which is how P2 spots a cut that mixes takes");

    // renderJob merges into any render.json already in the dir; the jobs it did NOT render keep
    // whatever lineage they had (clobbering them is how a cascade loses its history).
    const merged = renderJson(t2.dir);
    const k2 = merged.jobs.find((j) => j.jobId === 'K2');
    assert.ok(k2.seamIn.from, 'the re-rendered job carries its new lineage');
  } finally { t1.cleanup(); t2.cleanup(); }
});

test('renderJob preserves the seam fields of jobs it did not touch (cascade bookkeeping)', PENDING, async () => {
  const t1 = mkTmp('t1-cascade');
  const t2 = mkTmp('t2-cascade');
  try {
    await renderSpec(twoJobSpec('seedance'), { runDir: t1.dir });
    // Seed t2's render.json with a prior K1 record carrying lineage, then re-render K2 into it.
    fs.mkdirSync(path.join(t2.dir, 'K1'), { recursive: true });
    fs.writeFileSync(path.join(t2.dir, 'K1', 'last_frame.png'), ONE_PX_PNG);
    const priorK1 = { jobId: 'K1', clip: path.join(t2.dir, 'K1', 'fake.mp4'), seamIn: { mode: 'none', frame: null, from: null }, seamOut: { mode: 'soft', frame: 'x.png', to: null } };
    fs.writeFileSync(path.join(t2.dir, 'render.json'), JSON.stringify({ project: 'Ocean Lighthouse', backend: 'seedance-2.0@fal', jobs: [priorK1] }));

    await renderJob(twoJobSpec('seedance'), 'K2', { runDir: t2.dir, seamFrom: t1.dir });
    const merged = renderJson(t2.dir);
    const k1 = merged.jobs.find((j) => j.jobId === 'K1');
    assert.deepEqual(k1.seamIn, priorK1.seamIn, "K1's recorded lineage was not clobbered by K2's re-render");
    assert.deepEqual(k1.seamOut, priorK1.seamOut);
  } finally { t1.cleanup(); t2.cleanup(); }
});
