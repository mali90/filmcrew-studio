import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRender, estimateUpscale, jobSeconds, readEnvVar, readProbeResolution, readRenderResolution, readSeedanceResolution, readUpscaleProvider, readUpscaleTargetShortSide } from '../../lib/estimator.js';
import { voiceKnobs } from '../../lib/voice-refs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// config.js is the CHILD's reading of the same .env, and it runs `import 'dotenv/config'` — point
// dotenv at nothing BEFORE it is ever loaded, so a developer's real .env cannot leak in here.
const { neutralizeDotenv } = await import(path.join(ROOT, 'test/helpers/env.js'));
neutralizeDotenv();
const { buildConfig } = await import(path.join(ROOT, 'config.js'));
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

// The per-run pick is the tier the user chose for THIS run, and it is what renders (the child ranks
// it above a spec pin too — src/lib/prompt-settings.js seedanceResolution, which this module runs
// rather than re-states). A price quoted for the pinned tier would bill a render nobody asked for.
test('a per-run pick outranks a spec.seedance.resolution pin; without one the pin still beats .env', () => {
  const pinned = threeJobs();
  pinned.seedance = { resolution: '720p' };
  // priced() rounds each job before summing — mirror that, not seconds × rate
  const round2 = (n) => Math.round(n * 100) / 100;
  const at = (r) => round2(['K1', 'K2', 'K3'].reduce((a, id) => a + round2(jobSeconds(pinned, id) * r), 0));

  // picked 480p, pinned 720p, .env 720p → the pick, on 2.5's own rates ($0.2205/s vs $0.473/s)
  assert.equal(
    estimateRender(pinned, { backend: 'seedance-2.5@fal', mode: 'full', pick: '480p', resolution: '720p' }).totalUsd,
    at(0.2205),
  );
  // same run, no pick (a CLI spec): the hand-authored pin is still worth authoring
  assert.equal(
    estimateRender(pinned, { backend: 'seedance-2.5@fal', mode: 'full', resolution: '480p' }).totalUsd,
    at(0.473),
  );
  // a STALE pin naming a tier this model cannot render must not take the estimate down either
  const stale = threeJobs();
  stale.seedance = { resolution: '1080p' }; // survived a 2.0 → 2.5 switch; 2.5 renders 480p/720p
  assert.equal(
    estimateRender(stale, { backend: 'seedance-2.5@fal', mode: 'full', pick: '480p', resolution: '720p' }).totalUsd,
    at(0.2205),
  );
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
  // NB: 'seedance-2.5@segmind' USED to belong here. It is now a real, priced row — see
  // estimator-providers.test.js for the difference between "no rate on file" and "no such backend".
  assert.throws(() => estimateRender(threeJobs(), { backend: 'kling-o3@segmind', mode: 'full' }), /backend/);
  assert.throws(() => estimateRender(threeJobs(), { backend: 'seedance-3.0@fal', mode: 'full' }), /backend/);
});

// The registry is the thing that grows: a model/provider added there with no matching price row
// would 500 the estimate endpoint for every run on it. This is the coupling stated as an assertion,
// so the failure lands on whoever adds the model rather than on a user opening a run page.
test('EVERY renderable backend id in the registry has a PRICED row', async () => {
  const { BACKEND_IDS, ALL_BACKENDS } = await import('../../../../src/lib/render-models.js');
  assert.ok(BACKEND_IDS.length > 0);
  for (const id of [...BACKEND_IDS, ...ALL_BACKENDS]) {
    const e = estimateRender(threeJobs(), { backend: id, mode: 'full', resolution: '480p' });
    // Every shipped pair is priced today. A provider that published nothing would answer null + a
    // hint rather than throw (estimator-providers.test.js pins that path against a synthetic row) —
    // but shipping a REAL backend in that state is the bug this catches.
    assert.ok(Number.isFinite(e.totalUsd) && e.totalUsd > 0, `${id} priced to a real number, got ${e.totalUsd}`);
    assert.ok(!e.unknownPrice, `${id} ships unpriced — users would see "Price not set"`);
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

test('readRenderResolution: kling has no ladder — null, never a Seedance env read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-resk-'));
  try {
    // Kling's endpoint takes no resolution parameter: the registry declares an empty ladder, and
    // the estimator answers null even when legacy KLING_RESOLUTION values sit in .env or the child
    // env — kling is priced flat, and a knob nothing sends must never masquerade as a tier.
    assert.equal(readRenderResolution(dir, 'kling-o3@fal'), null, 'no ladder: null, not a config default');
    fs.writeFileSync(path.join(dir, '.env'), 'KLING_RESOLUTION=720p\nSEEDANCE_RESOLUTION=4k\n');
    assert.equal(readRenderResolution(dir, 'kling'), null, 'legacy id, legacy .env value: still null');
    assert.equal(readRenderResolution(dir, 'kling-o3@fal', { KLING_RESOLUTION: '4k' }), null);
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

// The ApproveBar's pick arrives as an EXPLICIT provider, and it must beat whatever the env would
// have derived — otherwise the gate/label judge the configured vendor while the pinned child runs
// the picked one, and the button promises a target the upscale will not deliver.
test('readUpscaleTargetShortSide: an explicit provider beats the env derivation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-upt-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'UPSCALE_PROVIDER=fal\nUPSCALE_TARGET_RESOLUTION=4k\nFAL_KEY=x\nSEGMIND_API_KEY=y\n');
    assert.equal(readUpscaleTargetShortSide(dir, 'kling-o3@fal'), 1080, 'env says fal — fal lifts toward ~1080p');
    assert.equal(readUpscaleTargetShortSide(dir, 'kling-o3@fal', undefined, 'segmind'), 2160, 'the pick reads SEGMIND\'s target over the env provider');
    assert.equal(readUpscaleTargetShortSide(dir, 'kling-o3@fal', undefined, 'fal'), 1080, 'an explicit fal pick stays ~1080p whatever the target knob says');

    fs.writeFileSync(path.join(dir, '.env'), 'UPSCALE_PROVIDER=segmind\nUPSCALE_TARGET_RESOLUTION=720p\nSEGMIND_API_KEY=y\n');
    assert.equal(readUpscaleTargetShortSide(dir, 'kling-o3@fal'), 720, 'env segmind honors the 720p target');
    assert.equal(readUpscaleTargetShortSide(dir, 'kling-o3@fal', undefined, 'fal'), 1080, 'picking fal beats UPSCALE_PROVIDER=segmind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── ONE reading of the .env: dotenv's ────────────────────────────────────────
// readEnvVar answers for EVERY .env-derived knob this server quotes or budgets — the resolution
// tiers, the upscale provider and its target, key presence, and run-service's voice-reference
// demand. The render child reads that same file through dotenv (`import 'dotenv/config'` in
// config.js), whose grammar differs from a hand-rolled "first KEY= line" reader in three ways: the
// LAST assignment wins, a trailing `# comment` is not part of the value, and `export KEY=…` is
// still an assignment. Reading it the other way is not a cosmetic disagreement — it made the server
// promise a soft boundary pin against a voice demand the renderer did not have, and quote a tier it
// would not render. So dotenv itself is the oracle, on a file using all three quirks at once.
test('readEnvVar reads a .env exactly as the render child does — dotenv itself is the oracle', async () => {
  const { parse } = await import('dotenv');
  const quirkyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-dotenv-q-'));
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-dotenv-p-'));
  try {
    const quirky = [
      '# what someone had configured first',
      'SEEDANCE_GENERATE_AUDIO=false',
      'SEEDANCE_RESOLUTION=480p',
      'UPSCALE_TARGET_RESOLUTION=1080p',
      'export SEEDANCE_VOICE_MODE=reference',
      'export UPSCALE_PROVIDER=segmind',
      'SEGMIND_API_KEY=y',
      'SEEDANCE_PROBE_RESOLUTION=480p # probes stay cheap',
      'LLM_MODEL=claude sonnet 4 # a value runs to the comment, not to the first space',
      '',
      '# …and what they changed their mind to, further down the same file',
      'SEEDANCE_GENERATE_AUDIO=true',
      'SEEDANCE_RESOLUTION=1080p',
      'UPSCALE_TARGET_RESOLUTION=4k',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(quirkyDir, '.env'), quirky);

    // What the CHILD gets, from dotenv's own parser — never a second reading of ours.
    const child = parse(quirky);
    assert.deepEqual(child, {
      SEEDANCE_GENERATE_AUDIO: 'true',
      SEEDANCE_RESOLUTION: '1080p',
      UPSCALE_TARGET_RESOLUTION: '4k',
      SEEDANCE_VOICE_MODE: 'reference',
      UPSCALE_PROVIDER: 'segmind',
      SEGMIND_API_KEY: 'y',
      SEEDANCE_PROBE_RESOLUTION: '480p',
      LLM_MODEL: 'claude sonnet 4',
    }, 'dotenv itself reads it this way');
    for (const [key, value] of Object.entries(child)) {
      assert.equal(readEnvVar(quirkyDir, key), value, `${key}: the server reads what the child loads`);
    }

    // The same values written plainly: every derived knob must answer identically, so no quirk of
    // the file can move a price, a tier or a budget.
    fs.writeFileSync(path.join(plainDir, '.env'), Object.entries(child).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    const knobs = (dir) => ({
      render: readRenderResolution(dir, 'seedance-2.0@fal'),
      probe: readProbeResolution(dir, 'seedance-2.0@fal'),
      provider: readUpscaleProvider(dir, 'seedance-2.5@segmind'),
      target: readUpscaleTargetShortSide(dir, 'kling-o3@fal'),
      voices: voiceKnobs((k) => readEnvVar(dir, k)),
    });
    assert.deepEqual(knobs(quirkyDir), knobs(plainDir), 'the quirks change the bytes, never the answers');
    assert.deepEqual(knobs(quirkyDir), {
      render: '1080p',   // the LAST assignment is the tier that renders and bills
      probe: '480p',     // a trailing comment is not part of the value
      provider: 'segmind',
      target: 2160,      // …nor of the target the approve bar promises
      voices: { audioOn: true, voiceMode: 'reference' }, // `export` is an assignment
    });

    // …and the child's own reading of those same knobs agrees, by config.js's rules rather than a
    // restatement of them: this is the pairing that decides a Seedance 2.5 job's voice-reference
    // demand, and with it whether a promised boundary pin survives the combined-reference cap.
    const childCfg = buildConfig(child);
    assert.equal(voiceKnobs((k) => readEnvVar(quirkyDir, k)).audioOn, childCfg.seedance.generateAudio);
    assert.equal(voiceKnobs((k) => readEnvVar(quirkyDir, k)).voiceMode, childCfg.seedance.voiceMode);
    assert.equal(readRenderResolution(quirkyDir, 'seedance-2.0@fal'), childCfg.seedance.resolution);
    assert.equal(readProbeResolution(quirkyDir, 'seedance-2.0@fal'), childCfg.seedance.probeResolution);
    assert.equal(readEnvVar(quirkyDir, 'UPSCALE_TARGET_RESOLUTION'), childCfg.upscale.targetResolution);
    assert.equal(readEnvVar(quirkyDir, 'UPSCALE_PROVIDER'), childCfg.upscale.provider);
  } finally {
    for (const d of [quirkyDir, plainDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// The two are one system: a Segmind-rendered run must show SEGMIND's Topaz figure on approve, not
// fal's. The rates are close ($0.125 vs $0.12 per input second), which is exactly why a mix-up here
// would survive a casual glance — so this asserts the provider routing, not just "some number".
test('a Segmind run prices its upscale at Segmind\'s rate, a fal run at fal\'s', () => {
  const clips = [{ jobId: 'K1', seconds: 5 }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-upv2-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'FAL_KEY=x\nSEGMIND_API_KEY=y\n');
    const seg = estimateUpscale(clips, { provider: readUpscaleProvider(dir, 'seedance-2.5@segmind') });
    const fal = estimateUpscale(clips, { provider: readUpscaleProvider(dir, 'kling-o3@fal') });
    assert.equal(seg.totalUsd, 0.63);   // 5s × $0.125
    assert.equal(fal.totalUsd, 0.6);    // 5s × $0.12
    assert.ok(!seg.unknownPrice && !fal.unknownPrice, 'both providers publish a Topaz rate now');
    assert.notEqual(seg.totalUsd, fal.totalUsd, 'a Segmind run must never quote fal money');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
