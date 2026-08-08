// Provider-aware pricing, and the UNKNOWN-PRICE path.
//
// Two facts drive this file, and they pull in opposite directions:
//   1. fal publishes Seedance 2.5's rate, so it goes straight in ($0.0214/1k tokens, tokens =
//      h×w×(dur_in+dur_out)×24/1024 → $0.2205/s at 480p, $0.4730/s at 720p, 16:9-derived like every
//      other row here).
//   2. Segmind publishes NOTHING for seedance-2.0, seedance-2.5 or topaz-video-upscale. So those
//      rows exist with `perSecondUsd: null` and a `_todo`, and the estimator answers "I don't know"
//      — explicitly, structurally, and without throwing.
//
// The rules the unknown-price path must obey, in order of how much they'd cost to get wrong:
//   * NEVER guess a sibling's rate. seedance-2.5@segmind is not priced at seedance-2.5@fal's rate;
//     an invented number on a paid button is worse than no number.
//   * NEVER throw. An estimate 500 would take the whole run page down for a backend that renders fine.
//   * totalUsd is null and a machine-readable `unknownPrice` hint says where to fill it in.
//
// TDD (red first): prices.json has no 2.5/segmind rows, and estimateRender throws on an unpriced key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRender, estimateUpscale, jobSeconds } from '../../lib/estimator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PRICES = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/server/lib/prices.json'), 'utf8'));
const golden = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/ocean-lighthouse/spec.json'), 'utf8'));

const threeJobs = () => {
  const spec = golden();
  spec.kling.jobs = [
    { job_id: 'K1', shots: ['S1'], elements: ['subject'] }, // 5s
    { job_id: 'K2', shots: ['S2'], elements: ['subject'] }, // 4s
    { job_id: 'K3', shots: ['S3'], elements: ['subject'] }, // 4s
  ];
  delete spec.kling.resolution;
  return spec;
};

const UNPRICED = ['seedance-2.0@segmind', 'seedance-2.5@segmind'];

// ── the row fal actually publishes ──────────────────────────────────────────
test('prices.json carries fal Seedance 2.5 at its real, sourced per-second rates', () => {
  const row = PRICES['seedance-2.5@fal'];
  assert.ok(row, 'seedance-2.5@fal is a REAL rate row, not an $alias hop');
  assert.ok(!row.$alias, '2.5 is a different model with different rates — aliasing 2.0 would undercharge by 60%');
  assert.deepEqual(row.perSecondUsd, { '480p': 0.2205, '720p': 0.473 });
  assert.equal(row.defaultResolution, '720p');
  assert.match(row._source, /0\.0214/, 'the derivation is written down so the next person can re-check it');
  assert.match(row._source, /16:9/, 'the 16:9-derived convention is documented, like every other row');
});

test('seedance-2.5@fal prices per second, per resolution, exactly like the other Seedance rows', () => {
  const spec = threeJobs();
  const at720 = estimateRender(spec, { backend: 'seedance-2.5@fal', mode: 'full', resolution: '720p' });
  assert.deepEqual(at720.perJob.map((j) => j.seconds), [5, 4, 4]);
  assert.equal(at720.perJob[0].usd, Math.round(5 * 0.473 * 100) / 100);
  assert.equal(at720.currency, 'USD');
  assert.equal(at720.label, 'estimate');

  const at480 = estimateRender(spec, { backend: 'seedance-2.5@fal', mode: 'full', resolution: '480p' });
  assert.ok(at480.totalUsd < at720.totalUsd, '480p is the cheap path here too');

  // …and it is genuinely dearer than 2.0, which is exactly why it may not share a row
  const twenty = estimateRender(spec, { backend: 'seedance-2.0@fal', mode: 'full', resolution: '720p' });
  assert.ok(at720.totalUsd > twenty.totalUsd, `2.5@720p (${at720.totalUsd}) must exceed 2.0@720p (${twenty.totalUsd})`);
});

// ── the rows nobody publishes ───────────────────────────────────────────────
test('the three Segmind rows exist, are explicitly null, and carry a PRICE CHECK REQUIRED todo', () => {
  for (const key of [...UNPRICED, 'topaz@segmind']) {
    const row = PRICES[key];
    assert.ok(row, `${key} has a row — a missing row is indistinguishable from a typo'd backend id`);
    assert.equal(row.perSecondUsd, null, `${key} is UNKNOWN, not zero and not a sibling's rate`);
    assert.match(row._todo, /PRICE CHECK REQUIRED/, key);
    assert.match(row._todo, /segmind\.com/, `${key}'s todo says where to look it up`);
  }
});

test('an unpriced backend returns totalUsd:null with an actionable hint — and never throws', () => {
  for (const backend of UNPRICED) {
    for (const mode of ['full', 'probe']) {
      const e = estimateRender(threeJobs(), { backend, mode, resolution: '720p' });
      assert.equal(e.totalUsd, null, `${backend} (${mode})`);
      assert.ok(e.unknownPrice, 'the caller can tell "unknown" from "free"');
      assert.match(e.unknownPrice.hint, /segmind/i);
      assert.equal(e.currency, 'USD');
      assert.equal(e.label, 'estimate');
      // the per-job breakdown still carries the SECONDS — the run page can show what will render
      assert.ok(e.perJob.length > 0);
      for (const j of e.perJob) {
        assert.ok(Number.isFinite(j.seconds) && j.seconds > 0, 'durations are known even when rates are not');
        assert.equal(j.usd, null, 'no invented per-job figure either');
      }
    }
  }
});

test('an unpriced backend NEVER borrows a sibling\'s rate', () => {
  const spec = threeJobs();
  const falPriced = estimateRender(spec, { backend: 'seedance-2.5@fal', mode: 'full', resolution: '720p' });
  const segmind = estimateRender(spec, { backend: 'seedance-2.5@segmind', mode: 'full', resolution: '720p' });
  assert.ok(falPriced.totalUsd > 0);
  assert.equal(segmind.totalUsd, null, 'the same MODEL on another provider is a different bill');
  const twenty = estimateRender(spec, { backend: 'seedance-2.0@segmind', mode: 'full', resolution: '480p' });
  assert.equal(twenty.totalUsd, null, "…and it does not fall back to fal 2.0's row either");
});

test('estimateUpscale is provider-aware: fal Topaz prices, Segmind Topaz reports unknown', () => {
  const clips = [{ jobId: 'K1', seconds: 5 }, { jobId: 'K2', seconds: 4 }];
  const onFal = estimateUpscale(clips, { provider: 'fal' });
  assert.ok(onFal.totalUsd > 0);
  assert.ok(!onFal.unknownPrice);
  assert.deepEqual(estimateUpscale(clips), onFal, 'fal stays the default — today\'s callers are unchanged');

  const onSegmind = estimateUpscale(clips, { provider: 'segmind' });
  assert.equal(onSegmind.totalUsd, null);
  assert.ok(onSegmind.unknownPrice);
  assert.match(onSegmind.unknownPrice.hint, /segmind/i);
  assert.deepEqual(onSegmind.perJob.map((j) => j.seconds), [5, 4]);
  assert.deepEqual(onSegmind.perJob.map((j) => j.usd), [null, null]);
  assert.equal(estimateUpscale([], { provider: 'segmind' }).totalUsd, null, 'no clips, still no rate');
});

// ── the coupling that keeps this honest ─────────────────────────────────────
test('EVERY registry backend id estimates: a real number or an explicit unknown — never a throw', async () => {
  const { BACKEND_IDS, ALL_BACKENDS } = await import('../../../../src/lib/render-models.js');
  assert.ok(BACKEND_IDS.length >= 5);
  for (const id of [...BACKEND_IDS, ...ALL_BACKENDS]) {
    const e = estimateRender(threeJobs(), { backend: id, mode: 'full', resolution: '480p' });
    if (e.totalUsd === null) {
      assert.ok(e.unknownPrice?.hint, `${id}: an unknown price must say so, with a hint`);
    } else {
      assert.ok(Number.isFinite(e.totalUsd) && e.totalUsd > 0, `${id} priced to a real number, got ${e.totalUsd}`);
      assert.ok(!e.unknownPrice, `${id} cannot be both priced and unknown`);
    }
  }
});

test('a genuinely unknown backend id still fails LOUDLY (unknown price ≠ unknown backend)', () => {
  // "the rate isn't on file" is a warning; "that backend does not exist" is a bug worth surfacing.
  for (const bad of ['kling-o3@segmind', 'runway', 'seedance-3.0@fal']) {
    assert.throws(() => estimateRender(threeJobs(), { backend: bad, mode: 'full' }), /backend/, bad);
  }
});

test('jobSeconds is untouched — the seconds half of an estimate never depended on a rate', () => {
  assert.equal(jobSeconds(threeJobs(), 'K1'), 5);
  assert.equal(jobSeconds(golden(), 'K1'), 13);
});
