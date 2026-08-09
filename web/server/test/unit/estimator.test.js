import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRender, estimateUpscale, jobSeconds, readProbeResolution, readRenderResolution, readSeedanceResolution, readUpscaleProvider } from '../../lib/estimator.js';

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

// ── Compound backend ids ────────────────────────────────────────────────────
// The CLI now writes the CANONICAL compound id into render.json, and run-scan falls back to it for
// run.backend — so a plain PRICES[backend] lookup would throw on the estimate endpoint for every
// CLI-created run. prices.json carries `{"$alias": "<legacy key>"}` hops for the compound ids and
// the table lookup follows one hop.
//
// TDD (red first): the $alias rows and the hop do not exist yet.
test('$alias: a compound backend id prices exactly like its legacy key', () => {
  const spec = threeJobs();
  for (const [compound, legacy] of [['kling-o3@fal', 'kling'], ['seedance-2.0@fal', 'seedance']]) {
    for (const mode of ['full', 'probe']) {
      assert.deepEqual(
        estimateRender(spec, { backend: compound, mode, resolution: '480p' }),
        estimateRender(spec, { backend: legacy, mode, resolution: '480p' }),
        `${compound} (${mode})`,
      );
    }
  }
});

test('$alias hop preserves the kling audio-off rate (a literal backend check would miss it)', () => {
  const noAudio = threeJobs();
  noAudio.kling.generate_audio = false;
  assert.equal(
    estimateRender(noAudio, { backend: 'kling-o3@fal', mode: 'full' }).totalUsd,
    estimateRender(noAudio, { backend: 'kling', mode: 'full' }).totalUsd,
  );
  assert.ok(
    estimateRender(noAudio, { backend: 'kling-o3@fal', mode: 'full' }).totalUsd
    < estimateRender(threeJobs(), { backend: 'kling-o3@fal', mode: 'full' }).totalUsd,
    'the cheaper audio-off rate still applies through the alias',
  );
});

test('$alias resolves ONE hop and still fails loudly on a genuinely unknown compound id', () => {
  // NB: 'seedance-2.5@segmind' USED to belong here. It is now a real (unpriced) row — see
  // estimator-providers.test.js for the difference between "no rate on file" and "no such backend".
  assert.throws(() => estimateRender(threeJobs(), { backend: 'kling-o3@segmind', mode: 'full' }), /backend/);
  assert.throws(() => estimateRender(threeJobs(), { backend: 'seedance-3.0@fal', mode: 'full' }), /backend/);
});

// The registry is the thing that grows: a model/provider added there with no matching price row
// would 500 the estimate endpoint for every run on it. This is the coupling stated as an assertion,
// so the failure lands on whoever adds the model rather than on a user opening a run page.
test('EVERY renderable backend id in the registry has a ROW — priced or explicitly unknown', async () => {
  const { BACKEND_IDS, ALL_BACKENDS } = await import('../../../../src/lib/render-models.js');
  assert.ok(BACKEND_IDS.length > 0);
  for (const id of [...BACKEND_IDS, ...ALL_BACKENDS]) {
    const e = estimateRender(threeJobs(), { backend: id, mode: 'full', resolution: '480p' });
    // A provider whose prices are unpublished (Segmind) answers null + a hint rather than throwing;
    // anything with a rate must still price to a real, positive number.
    if (e.totalUsd === null) assert.ok(e.unknownPrice?.hint, `${id}: unknown price must carry a hint`);
    else assert.ok(Number.isFinite(e.totalUsd) && e.totalUsd > 0, `${id} priced to a real number, got ${e.totalUsd}`);
  }
});

test('a $alias row never points at another $alias row (only one hop is followed)', () => {
  const prices = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/server/lib/prices.json'), 'utf8'));
  for (const [key, row] of Object.entries(prices)) {
    if (!row?.$alias) continue;
    const target = prices[row.$alias];
    assert.ok(target, `${key} aliases "${row.$alias}", which does not exist`);
    assert.ok(!target.$alias, `${key} → ${row.$alias} is a second hop; tableFor follows only one`);
    assert.ok(target.perSecondUsd != null, `${key} must land on a real rate row`);
  }
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

// ── The resolution knob is per MODEL ──────────────────────────────────────────
// Seedance 2.5 has its own env knob and its own default (720p; 480p is only its probe tier), so
// reading SEEDANCE_RESOLUTION for a 2.5 run would quietly price a 720p render at the 480p rate —
// off by more than 2×. readSeedanceResolution stays as the pre-2.5 spelling of the same question.
test('readRenderResolution: 2.5 reads its own knob and its own default; everything else is unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-res25-'));
  try {
    assert.equal(readRenderResolution(dir, 'seedance-2.5@fal'), '720p');   // no .env: 2.5 default
    assert.equal(readRenderResolution(dir, 'seedance-2.0@fal'), '480p');   // …not the 2.0 default
    assert.equal(readRenderResolution(dir, null), '480p');                 // nor the legacy answer

    fs.writeFileSync(path.join(dir, '.env'), 'SEEDANCE_RESOLUTION=1080p\nSEEDANCE25_RESOLUTION=480p\n');
    assert.equal(readRenderResolution(dir, 'seedance-2.5@segmind'), '480p', '2.5 follows SEEDANCE25_RESOLUTION on either provider');
    assert.equal(readRenderResolution(dir, 'seedance-2.0@fal'), '1080p', 'and never crosses the two knobs');
    assert.equal(readSeedanceResolution(dir), '1080p', 'the old export still answers the old question');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readRenderResolution/readProbeResolution: an injected childEnv var beats .env — dotenv never overwrites it in the render child', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-res-child-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'SEEDANCE_RESOLUTION=720p\nSEEDANCE_PROBE_RESOLUTION=720p\n');
    const childEnv = { SEEDANCE_RESOLUTION: '480p', SEEDANCE_PROBE_RESOLUTION: '480p' };
    assert.equal(readRenderResolution(dir, 'seedance-2.0@fal', childEnv), '480p', 'the child renders the injected tier — the estimate must quote it');
    assert.equal(readProbeResolution(dir, 'seedance-2.0@fal', childEnv), '480p');
    // an explicitly EMPTY injected var also blocks the .env value (dotenv leaves it empty), so the
    // model default applies — exactly what config.js resolves to inside the child
    assert.equal(readRenderResolution(dir, 'seedance-2.0@fal', { SEEDANCE_RESOLUTION: '' }), '480p');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Which vendor the approve-time upscale will bill ───────────────────────────
// Mirrors src/lib/upscale.js resolveUpscaleProvider, which this server may not import (config.js).
// Getting it wrong shows a fal figure on a Segmind bill — exactly the invented number this work
// exists to avoid.
test('readUpscaleProvider: explicit wins, auto upscales where the run rendered, else where a key is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-upv-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'UPSCALE_PROVIDER=segmind\nFAL_KEY=x\n');
    assert.equal(readUpscaleProvider(dir, 'kling-o3@fal'), 'segmind', 'an explicit pin beats everything');

    fs.writeFileSync(path.join(dir, '.env'), 'FAL_KEY=x\nSEGMIND_API_KEY=y\n'); // auto (unset)
    assert.equal(readUpscaleProvider(dir, 'seedance-2.5@segmind'), 'segmind', 'no master round-trips to a second vendor');
    assert.equal(readUpscaleProvider(dir, 'seedance-2.0@fal'), 'fal');
    assert.equal(readUpscaleProvider(dir, 'kling'), 'fal', 'legacy ids resolve through the registry');

    fs.writeFileSync(path.join(dir, '.env'), 'SEGMIND_API_KEY=y\n'); // Segmind-only install
    assert.equal(readUpscaleProvider(dir, 'kling-o3@fal'), 'segmind', 'falls back to the key that exists');

    fs.writeFileSync(path.join(dir, '.env'), '# nothing configured\n');
    assert.equal(readUpscaleProvider(dir, 'seedance-2.5@segmind'), 'fal', 'keyless fails with the familiar FAL_KEY message');
    assert.equal(readUpscaleProvider(dir, 'seedance-2.5@segmind', { SEGMIND_API_KEY: 'y' }), 'segmind', 'the child env counts too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The two are one system: a Segmind-rendered run must not show a fal Topaz figure on approve.
test('a Segmind run prices its upscale as unknown, a fal run keeps its number', () => {
  const clips = [{ jobId: 'K1', seconds: 5 }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-upv2-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'FAL_KEY=x\nSEGMIND_API_KEY=y\n');
    const seg = estimateUpscale(clips, { provider: readUpscaleProvider(dir, 'seedance-2.5@segmind') });
    assert.equal(seg.totalUsd, null);
    assert.match(seg.unknownPrice.hint, /segmind/i);
    assert.ok(estimateUpscale(clips, { provider: readUpscaleProvider(dir, 'kling-o3@fal') }).totalUsd > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
