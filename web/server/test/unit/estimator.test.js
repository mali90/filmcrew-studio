import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRender, estimateUpscale, jobSeconds, readSeedanceResolution } from '../../lib/estimator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const golden = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/ocean-lighthouse/spec.json'), 'utf8'));

const threeJobs = () => {
  const spec = golden();
  spec.kling.jobs = [
    { job_id: 'K1', shots: ['S1'], elements: ['subject'] },       // 5s
    { job_id: 'K2', shots: ['S2'], elements: ['subject'] },       // 4s
    { job_id: 'K3', shots: ['S3'], elements: ['subject'] },       // 4s
  ];
  delete spec.kling.resolution; // tests drive resolution explicitly (a spec pin overrides opts)
  return spec;
};

test('jobSeconds: sums shot durations like the validator does', () => {
  assert.equal(jobSeconds(golden(), 'K1'), 13); // 5 + 4 + 4
  assert.equal(jobSeconds(threeJobs(), 'K2'), 4);
});

test('full render: one row per job, positive USD, labeled as an estimate', () => {
  const e = estimateRender(threeJobs(), { backend: 'kling', mode: 'full' });
  assert.equal(e.perJob.length, 3);
  assert.deepEqual(e.perJob.map((j) => j.jobId), ['K1', 'K2', 'K3']);
  assert.deepEqual(e.perJob.map((j) => j.seconds), [5, 4, 4]);
  for (const j of e.perJob) assert.ok(j.usd > 0);
  assert.ok(Math.abs(e.totalUsd - e.perJob.reduce((a, j) => a + j.usd, 0)) < 1e-9);
  assert.equal(e.label, 'estimate');
});

test('probe: first job only, priced at the probe resolution (480p) — never a mini/fast tier', () => {
  const spec = threeJobs();
  const probe = estimateRender(spec, { backend: 'seedance', mode: 'probe', resolution: '1080p' });
  assert.equal(probe.perJob.length, 1);
  assert.equal(probe.perJob[0].jobId, 'K1');
  const full = estimateRender(spec, { backend: 'seedance', mode: 'full', resolution: '1080p' });
  assert.ok(probe.totalUsd < full.perJob[0].usd, 'probe prices at 480p while the full render is 1080p');
  // at the default 480p render resolution, probe and full share the SAME standard-tier rate —
  // the probe saving is "first job only", not a cheaper tier
  const probe480 = estimateRender(spec, { backend: 'seedance', mode: 'probe', resolution: '480p' });
  const full480 = estimateRender(spec, { backend: 'seedance', mode: 'full', resolution: '480p' });
  assert.equal(probe480.perJob[0].usd, full480.perJob[0].usd);
});

test('seedance pricing scales with resolution: 480p default is cheap, native 1080p costs MORE than kling', () => {
  const spec = threeJobs();
  const s480 = estimateRender(spec, { backend: 'seedance', mode: 'full', resolution: '480p' });
  const sDefault = estimateRender(spec, { backend: 'seedance', mode: 'full' }); // defaultResolution = 480p
  assert.equal(sDefault.totalUsd, s480.totalUsd);
  const s1080 = estimateRender(spec, { backend: 'seedance', mode: 'full', resolution: '1080p' });
  const kling = estimateRender(spec, { backend: 'kling', mode: 'full', resolution: '1080p' });
  assert.ok(s1080.totalUsd > kling.totalUsd, `seedance@1080p (${s1080.totalUsd}) must exceed kling (${kling.totalUsd})`);
  assert.ok(s480.totalUsd < s1080.totalUsd / 4, 'the 480p default is a fraction of native 1080p'); // kling standard ($0.112/s) now undercuts seedance@480p
  // an EXPLICIT spec.seedance.resolution pin beats the env-derived opt — but kling.resolution
  // NEVER does: the agents write the KLING default there, which once mispriced a 480p plan at 1080p
  const pinned = threeJobs();
  pinned.seedance = { resolution: '1080p' };
  assert.equal(
    estimateRender(pinned, { backend: 'seedance', mode: 'full', resolution: '480p' }).totalUsd,
    s1080.totalUsd,
  );
  const klingPolluted = threeJobs();
  klingPolluted.kling.resolution = '1080p';
  assert.equal(
    estimateRender(klingPolluted, { backend: 'seedance', mode: 'full', resolution: '480p' }).totalUsd,
    s480.totalUsd,
    'the kling block must not drive seedance pricing',
  );
  // kling's flat rate ignores the resolution knob entirely
  assert.equal(kling.totalUsd, estimateRender(spec, { backend: 'kling', mode: 'full' }).totalUsd);
  // fal prices kling by AUDIO, not resolution: audio-off is the cheaper flat rate
  const noAudio = structuredClone(spec);
  noAudio.kling.generate_audio = false;
  const off = estimateRender(noAudio, { backend: 'kling', mode: 'full' });
  assert.ok(off.totalUsd < kling.totalUsd, `audio-off (${off.totalUsd}) must be under audio-on (${kling.totalUsd})`);
  // unknown resolutions fail loudly instead of silently misquoting
  assert.throws(() => estimateRender(spec, { backend: 'seedance', resolution: '9000p' }), /no per-second rate/);
});

test('job mode: one job, cascade adds the stale downstream jobs', () => {
  const spec = threeJobs();
  const solo = estimateRender(spec, { backend: 'kling', mode: 'job', jobId: 'K2' });
  assert.deepEqual(solo.perJob.map((j) => j.jobId), ['K2']);
  const cascade = estimateRender(spec, { backend: 'kling', mode: 'job', jobId: 'K2', cascade: true });
  assert.deepEqual(cascade.perJob.map((j) => j.jobId), ['K2', 'K3']);
  assert.ok(cascade.totalUsd > solo.totalUsd);
});

test('estimateUpscale: priced per clip-second, zero rows for an empty list', () => {
  const e = estimateUpscale([{ jobId: 'K1', seconds: 5 }, { jobId: 'K2', seconds: 4 }]);
  assert.equal(e.perJob.length, 2);
  assert.ok(e.totalUsd > 0);
  assert.equal(estimateUpscale([]).totalUsd, 0);
});

test('unknown backend throws (never a silent $0 estimate)', () => {
  assert.throws(() => estimateRender(golden(), { backend: 'nope', mode: 'full' }), /backend/);
});

test('readSeedanceResolution: reads .env, tolerates quotes, defaults to 480p', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-res-'));
  try {
    assert.equal(readSeedanceResolution(dir), '480p'); // no .env at all
    fs.writeFileSync(path.join(dir, '.env'), 'FAL_KEY=x\nSEEDANCE_RESOLUTION=1080p\n');
    assert.equal(readSeedanceResolution(dir), '1080p');
    fs.writeFileSync(path.join(dir, '.env'), 'SEEDANCE_RESOLUTION="720p"\n');
    assert.equal(readSeedanceResolution(dir), '720p');
    fs.writeFileSync(path.join(dir, '.env'), '# SEEDANCE_RESOLUTION=4k\n');
    assert.equal(readSeedanceResolution(dir), '480p'); // commented line does not count
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
