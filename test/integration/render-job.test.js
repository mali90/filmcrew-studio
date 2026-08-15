// renderJob: one job re-rendered in isolation against the mock fal queue — seam chaining in,
// take/feedback variation, stale-downstream reporting, and render.json bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';
import { startFalServer } from '../helpers/fal-server.js';

const fal = await startFalServer({ videoBytes: Buffer.from('FAKE-MP4') });

neutralizeDotenv();
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
});
const config = (await import('../../config.js')).default;
const cache = mkTmp('renderjob-cache');
config.paths.cache = cache.dir;
const { renderJob } = await import('../../src/lib/pipeline.js');

const threeJobSpec = () => {
  const spec = loadGoldenSpec();
  spec.kling.jobs = [
    { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
    { job_id: 'K2', shots: ['S2'], elements: ['subject'] },
    { job_id: 'K3', shots: ['S3'], elements: ['subject'] },
  ];
  return spec;
};
const lastSubmit = (from) => fal.requests.slice(from).find((q) => q.method === 'POST');

test.after(async () => { await fal.close(); cache.cleanup(); });

test('kling: middle job chains from the PREVIOUS job\'s seam frame and reports stale downstream', async () => {
  const take = mkTmp('rj-kling');
  const prev = mkTmp('rj-prev');
  try {
    fs.mkdirSync(path.join(prev.dir, 'K1'), { recursive: true });
    fs.writeFileSync(path.join(prev.dir, 'K1', 'last_frame.png'), ONE_PX_PNG);
    const before = fal.requests.length;
    const r = await renderJob(threeJobSpec(), 'K2', { runDir: take.dir, seamFrom: prev.dir });
    assert.equal(r.jobId, 'K2');
    assert.ok(fs.existsSync(r.clip), 'clip downloaded');
    assert.deepEqual(r.staleDownstream, ['K3'], 'K3 was chained from the OLD K2 take');
    const body = JSON.parse(lastSubmit(before).body);
    assert.ok(body.start_image_url?.startsWith('data:image/png'), 'seam frame rides as the start image');
    const rj = JSON.parse(fs.readFileSync(path.join(take.dir, 'render.json'), 'utf8'));
    assert.equal(rj.jobs[0].jobId, 'K2');
    // The take's own record of WHERE that frame came from — the source a mixed-take cut is caught by.
    assert.equal(rj.jobs[0].seamIn.mode, 'native', 'Kling anchors the frame through its Elements set');
    assert.equal(rj.jobs[0].seamIn.from.take, path.basename(prev.dir));
    assert.equal(rj.jobs[0].seamIn.from.job, 'K1');
    assert.ok(fs.existsSync(path.join(take.dir, 'spec.json')), 'take dir is self-contained (assemblable)');
  } finally { take.cleanup(); prev.cleanup(); }
});

test('kling: first job never chains; missing seam frame renders standalone with a warning', async () => {
  const take = mkTmp('rj-first');
  try {
    const before = fal.requests.length;
    const r = await renderJob(threeJobSpec(), 'K1', { runDir: take.dir, seamFrom: '/nowhere' });
    assert.deepEqual(r.staleDownstream, ['K2', 'K3']);
    const body = JSON.parse(lastSubmit(before).body);
    assert.ok(!('start_image_url' in body), 'K1 has no upstream seam');
  } finally { take.cleanup(); }
});

// The cascade advice and the seam lineage must tell one story. An applied closing pin renders this
// clip to ARRIVE on the next one's opening frame and records where it lands, which is the evidence
// seam-rule.js accepts from this side — so the joint is whole and the downstream jobs the CLI used
// to list are footage a cascade would replace for nothing.
test('kling: an APPLIED closing pin leaves nothing stale downstream', async () => {
  const take = mkTmp('rj-endpin');
  const cut = mkTmp('rj-endpin-cut');
  try {
    // The next segment as the cut holds it: a take dir the pin can be traced back to.
    const nextDir = path.join(cut.dir, 'renders', 't1', 'K3');
    fs.mkdirSync(nextDir, { recursive: true });
    fs.writeFileSync(path.join(nextDir, 'clip.mp4'), 'FAKE-MP4');
    const pin = path.join(nextDir, 'first_frame.png');
    fs.writeFileSync(pin, ONE_PX_PNG);

    const r = await renderJob(threeJobSpec(), 'K2', { runDir: take.dir, lastFrameFrom: pin });
    assert.ok(!['none', 'unsupported'].includes(r.seamOut.mode), 'the pin was really applied');
    assert.deepEqual(r.seamOut.to, { take: 't1', job: 'K3', clip: path.join(nextDir, 'clip.mp4') });
    assert.deepEqual(r.staleDownstream, [], 'K2 arrives on K3 — a cascade would re-render an intact joint');
  } finally { take.cleanup(); cut.cleanup(); }
});

test('kling: a closing pin that names nowhere keeps the downstream jobs stale', async () => {
  const take = mkTmp('rj-endpin-loose');
  const still = mkTmp('rj-endpin-still');
  try {
    // A hand-picked frame is a real pin, but it names no clip in this cut: neither side of that
    // joint gets recorded, so the lineage still reads a break and the cascade advice stands.
    const pin = path.join(still.dir, 'somewhere.png');
    fs.writeFileSync(pin, ONE_PX_PNG);
    const r = await renderJob(threeJobSpec(), 'K2', { runDir: take.dir, lastFrameFrom: pin });
    assert.equal(r.seamOut.to, null);
    assert.deepEqual(r.staleDownstream, ['K3']);
  } finally { take.cleanup(); still.cleanup(); }
});

test('seedance: --take and --feedback reach the prompt (Alternate take + Director note)', async () => {
  const take = mkTmp('rj-seedance');
  try {
    const spec = threeJobSpec();
    spec.render_backend = 'seedance';
    const before = fal.requests.length;
    const r = await renderJob(spec, 'K3', { runDir: take.dir, take: 2, feedback: 'less fog, warmer light' });
    assert.equal(r.backend, 'seedance-2.0@fal'); // resolveBackend canonicalizes the legacy alias
    assert.deepEqual(r.staleDownstream, []);
    const submit = lastSubmit(before);
    assert.equal(submit.path, '/seedance-submit');
    const body = JSON.parse(submit.body);
    assert.match(body.prompt, /Alternate take 2:/);
    assert.match(body.prompt, /Director note: less fog, warmer light/);
    for (const k of ['seed', 'negative_prompt']) assert.ok(!(k in body));
  } finally { take.cleanup(); }
});

test('unknown job id and invalid spec are rejected before any submission', async () => {
  const take = mkTmp('rj-guard');
  try {
    const before = fal.requests.length;
    await assert.rejects(() => renderJob(threeJobSpec(), 'K9', { runDir: take.dir }), /not found/);
    await assert.rejects(() => renderJob({ spec_version: '1.0' }, 'K1', { runDir: take.dir }), /failed validation/);
    assert.equal(fal.requests.length, before, 'nothing was submitted');
  } finally { take.cleanup(); }
});
