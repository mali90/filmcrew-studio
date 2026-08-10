// Provider-aware pricing, and the UNKNOWN-PRICE path.
//
// Two facts drive this file, and they pull in opposite directions:
//   1. The price is a property of the (model, provider) PAIR, not the model. fal and Segmind both
//      publish per-second rates for both Seedance models, and Segmind's are roughly HALF fal's —
//      so every pair carries its own row and the two must never be collapsed into one.
//   2. A provider may publish nothing at all. That is a KNOWN state, not an error, and the
//      estimator answers "I don't know" — explicitly, structurally, and without throwing.
//
// The rules the unknown-price path must obey, in order of how much they'd cost to get wrong:
//   * NEVER guess a sibling's rate. An invented number on a paid button is worse than no number.
//   * NEVER throw. An estimate 500 would take the whole run page down for a backend that renders fine.
//   * totalUsd is null and a machine-readable `unknownPrice` hint says where to fill it in.
//
// Every SHIPPED vendor row is priced today, so rule 2 is exercised against the SYNTHETIC
// 'examplevendor' rows in prices.json rather than against whichever real vendor happens to be
// behind on publishing. That coupling used to run the other way — the Segmind rows were the only
// proof this path worked — and pricing them broke seven test files at once. The fixtures exist so
// that never happens again; see the `_fixtures` note in prices.json.
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

// The synthetic vendor. NOT a registry backend and never will be — it exists only to keep the
// unpriced path honest without holding a real vendor's rates hostage to it.
const UNPRICED_BACKEND = 'seedance-2.0@examplevendor';
const UNPRICED_PROVIDER = 'examplevendor';

const total = (spec, backend, resolution, mode = 'full') =>
  estimateRender(spec, { backend, mode, resolution }).totalUsd;

// The estimator rounds each JOB to cents and then sums, so an expectation built from the raw total
// (13s × rate) drifts a cent off. Mirror the real arithmetic instead of hard-coding the drift.
const round2 = (n) => Math.round(n * 100) / 100;
const billed = (rate, seconds = [5, 4, 4]) => round2(seconds.reduce((a, s) => a + round2(s * rate), 0));

// ── the rows the vendors actually publish ───────────────────────────────────
test('prices.json carries fal Seedance 2.5 at its real, sourced per-second rates', () => {
  const row = PRICES['seedance-2.5@fal'];
  assert.ok(row, 'seedance-2.5@fal is a REAL rate row, not an $alias hop');
  assert.ok(!row.$alias, '2.5 is a different model with different rates — aliasing 2.0 would undercharge by 60%');
  assert.deepEqual(row.perSecondUsd, { '480p': 0.2205, '720p': 0.473 });
  assert.equal(row.defaultResolution, '720p');
  assert.match(row._source, /0\.0214/, 'the derivation is written down so the next person can re-check it');
  assert.match(row._source, /16:9/, 'the 16:9-derived convention is documented, like every other row');
});

test('prices.json carries the Segmind rows at their real, sourced, DATED rates', () => {
  const twenty = PRICES['seedance-2.0@segmind'];
  assert.deepEqual(twenty.perSecondUsd, { '480p': 0.0703, '720p': 0.1512, '1080p': 0.34, '4k': 1.3721 });
  assert.equal(twenty.defaultResolution, '480p', 'Segmind 2.0 renders the cheap tier by default, like fal 2.0');
  assert.equal(twenty.probeResolution, '480p');

  const twentyFive = PRICES['seedance-2.5@segmind'];
  assert.deepEqual(twentyFive.perSecondUsd, { '480p': 0.1065, '720p': 0.2389 });
  assert.equal(twentyFive.defaultResolution, '720p', '2.5 renders 720p by default on both providers');
  assert.equal(twentyFive.probeResolution, '480p');
  // Segmind publishes no high tiers for 2.5. Inventing them (by mirroring 2.0's) would quote a rate
  // for a render this provider will not do.
  assert.ok(!('1080p' in twentyFive.perSecondUsd), 'Segmind publishes NO 1080p tier for 2.5');
  assert.ok(!('4k' in twentyFive.perSecondUsd), 'Segmind publishes NO 4k tier for 2.5');

  assert.equal(PRICES['topaz@segmind'].perSecondUsd, 0.125, 'flat — Segmind publishes one Topaz rate');

  for (const key of ['seedance-2.0@segmind', 'seedance-2.5@segmind', 'topaz@segmind']) {
    assert.match(PRICES[key]._source, /segmind\.com/, `${key} cites the page it came from`);
    assert.match(PRICES[key]._source, /2026-08-10/, `${key} says WHEN it was checked — a rate with no date rots silently`);
    assert.ok(!PRICES[key].$alias, `${key} is independent; aliasing would let one edit reprice the others`);
  }
});

test('the Segmind rows are HALF fal\'s, independently — not a shared row, not a typo', () => {
  const spec = threeJobs();
  // Same model, same resolution, two providers, two different bills. If these ever come out equal,
  // something has aliased one row to the other.
  const ratio20 = total(spec, 'seedance-2.0@segmind', '720p') / total(spec, 'seedance-2.0@fal', '720p');
  const ratio25 = total(spec, 'seedance-2.5@segmind', '720p') / total(spec, 'seedance-2.5@fal', '720p');
  for (const [label, r] of [['2.0', ratio20], ['2.5', ratio25]]) {
    assert.ok(r > 0.4 && r < 0.6, `Segmind ${label} should be ~half fal's, got ${r.toFixed(3)}×`);
  }
  // …and editing one provider's row must not move the other's: they share no storage.
  assert.notEqual(PRICES['seedance-2.0@segmind'].perSecondUsd, PRICES.seedance.perSecondUsd);
});

test('Segmind Seedance prices per second, per resolution, at every tier it publishes', () => {
  const spec = threeJobs();               // 5s + 4s + 4s = 13s
  const at480 = estimateRender(spec, { backend: 'seedance-2.0@segmind', mode: 'full', resolution: '480p' });
  assert.deepEqual(at480.perJob.map((j) => j.seconds), [5, 4, 4]);
  assert.equal(at480.perJob[0].usd, round2(5 * 0.0703));
  assert.equal(at480.totalUsd, 0.91);     // 13s at $0.0703 — the whole point of filling the row in
  assert.equal(at480.currency, 'USD');
  assert.equal(at480.label, 'estimate');
  assert.ok(!at480.unknownPrice, 'a priced row must not also report an unknown price');

  // every published tier, cheapest to dearest, in order
  const tiers = ['480p', '720p', '1080p', '4k'].map((r) => total(spec, 'seedance-2.0@segmind', r));
  for (let i = 1; i < tiers.length; i += 1) assert.ok(tiers[i] > tiers[i - 1], `tier ${i} must cost more`);
  assert.equal(tiers[1], billed(0.1512));
  assert.equal(tiers[3], billed(1.3721));

  const twentyFive720 = total(spec, 'seedance-2.5@segmind', '720p');
  assert.equal(twentyFive720, billed(0.2389));
  assert.ok(twentyFive720 > total(spec, 'seedance-2.5@segmind', '480p'), '480p is the cheap path here too');
  // 2.5 is dearer than 2.0 on Segmind exactly as it is on fal — that is why they are separate rows
  assert.ok(twentyFive720 > total(spec, 'seedance-2.0@segmind', '720p'));
});

test('a resolution Segmind does not sell for 2.5 fails loudly rather than quoting an invented tier', () => {
  // Same contract as seedance-2.5@fal, which also stops at 720p: a spec pinning 1080p (say, one that
  // survived a 2.0 → 2.5 switch) must not be silently priced at the default tier.
  assert.throws(
    () => estimateRender(threeJobs(), { backend: 'seedance-2.5@segmind', mode: 'full', resolution: '1080p' }),
    /no per-second rate/,
  );
});

test('probes ride the configured probe tier on Segmind too', () => {
  const spec = threeJobs();
  const probe = estimateRender(spec, { backend: 'seedance-2.5@segmind', mode: 'probe' });
  assert.equal(probe.perJob.length, 1, 'a probe renders the first job only');
  assert.equal(probe.totalUsd, round2(5 * 0.1065), 'at 480p, the probeResolution');
  assert.ok(probe.totalUsd < total(spec, 'seedance-2.5@segmind', '720p'), 'and it is the cheap look');
});

test('seedance-2.5@fal prices per second, per resolution, exactly like the other Seedance rows', () => {
  const spec = threeJobs();
  const at720 = estimateRender(spec, { backend: 'seedance-2.5@fal', mode: 'full', resolution: '720p' });
  assert.deepEqual(at720.perJob.map((j) => j.seconds), [5, 4, 4]);
  assert.equal(at720.perJob[0].usd, round2(5 * 0.473));
  assert.equal(at720.currency, 'USD');
  assert.equal(at720.label, 'estimate');

  const at480 = estimateRender(spec, { backend: 'seedance-2.5@fal', mode: 'full', resolution: '480p' });
  assert.ok(at480.totalUsd < at720.totalUsd, '480p is the cheap path here too');

  // …and it is genuinely dearer than 2.0, which is exactly why it may not share a row
  const twenty = estimateRender(spec, { backend: 'seedance-2.0@fal', mode: 'full', resolution: '720p' });
  assert.ok(at720.totalUsd > twenty.totalUsd, `2.5@720p (${at720.totalUsd}) must exceed 2.0@720p (${twenty.totalUsd})`);
});

test('the Topaz upscale is priced on BOTH providers, each at its own rate', () => {
  const clips = [{ jobId: 'K1', seconds: 5 }, { jobId: 'K2', seconds: 4 }];   // 9s of INPUT video
  const onFal = estimateUpscale(clips, { provider: 'fal' });
  assert.equal(onFal.totalUsd, billed(0.12, [5, 4]));
  assert.ok(!onFal.unknownPrice);
  assert.deepEqual(estimateUpscale(clips), onFal, 'fal stays the default — today\'s callers are unchanged');

  const onSegmind = estimateUpscale(clips, { provider: 'segmind' });
  assert.equal(onSegmind.totalUsd, billed(0.125, [5, 4]), 'flat $0.125 per INPUT second');
  assert.ok(!onSegmind.unknownPrice, 'Segmind Topaz has a published rate — it is no longer a known unknown');
  assert.deepEqual(onSegmind.perJob.map((j) => j.seconds), [5, 4]);
  assert.ok(onSegmind.totalUsd > onFal.totalUsd, 'Segmind Topaz is the dearer of the two, slightly');
  assert.equal(estimateUpscale([], { provider: 'segmind' }).totalUsd, 0, 'nothing to upscale, nothing to pay');
});

// ── the path for a vendor that publishes nothing ────────────────────────────
test('an unpriced backend returns totalUsd:null with an actionable hint — and never throws', () => {
  for (const mode of ['full', 'probe']) {
    const e = estimateRender(threeJobs(), { backend: UNPRICED_BACKEND, mode, resolution: '720p' });
    assert.equal(e.totalUsd, null, mode);
    assert.ok(e.unknownPrice, 'the caller can tell "unknown" from "free"');
    assert.match(e.unknownPrice.hint, /costs money/i, 'unknown is not free, and the hint says so');
    assert.equal(e.unknownPrice.provider, UNPRICED_PROVIDER);
    assert.equal(e.currency, 'USD');
    assert.equal(e.label, 'estimate');
    // the per-job breakdown still carries the SECONDS — the run page can show what will render
    assert.ok(e.perJob.length > 0);
    for (const j of e.perJob) {
      assert.ok(Number.isFinite(j.seconds) && j.seconds > 0, 'durations are known even when rates are not');
      assert.equal(j.usd, null, 'no invented per-job figure either');
    }
  }
});

test('an unpriced backend NEVER borrows a sibling\'s rate', () => {
  const spec = threeJobs();
  // The fixture is 'seedance-2.0@examplevendor' — the same MODEL that IS priced on two real
  // providers. Falling through to either of those rows is the exact bug this guards.
  assert.ok(total(spec, 'seedance-2.0@fal', '480p') > 0);
  assert.ok(total(spec, 'seedance-2.0@segmind', '480p') > 0);
  assert.equal(total(spec, UNPRICED_BACKEND, '480p'), null, 'the same model on another provider is a different bill');
});

test('estimateUpscale reports unknown for a provider with no published Topaz rate', () => {
  const onNobody = estimateUpscale([{ jobId: 'K1', seconds: 5 }], { provider: UNPRICED_PROVIDER });
  assert.equal(onNobody.totalUsd, null);
  assert.match(onNobody.unknownPrice.hint, /examplevendor/i);
  // the row carries a _todo, so the hint tells the reader where to go looking
  assert.match(onNobody.unknownPrice.hint, /pricing/, 'the hint says where to look the rate up');
  assert.match(onNobody.unknownPrice.hint, /prices\.json/, '…and where to put it once found');
  assert.deepEqual(onNobody.perJob.map((j) => j.usd), [null]);
});

// ── the guards that keep this from rotting ──────────────────────────────────
test('no shipped rate row is still waiting on a PRICE CHECK', () => {
  // A model added to the registry but never priced would ship quoting "Price not set" to real users.
  // The fixtures are unpriced ON PURPOSE, forever, and say so with `_fixture` — so a bare `_todo`
  // means somebody added a backend and left the rate for later. Fail here, not in production.
  for (const [key, row] of Object.entries(PRICES)) {
    if (!row || typeof row !== 'object' || !('perSecondUsd' in row)) continue;
    if (row._fixture) continue;
    assert.ok(!row._todo, `${key} still carries a _todo — look the rate up, or mark the row _fixture`);
    assert.notEqual(row.perSecondUsd, null, `${key} ships unpriced; users would see "Price not set"`);
  }
});

test('the synthetic rows stay synthetic — no registry backend may point at examplevendor', async () => {
  const { BACKEND_IDS, ALL_BACKENDS } = await import('../../../../src/lib/render-models.js');
  for (const id of [...BACKEND_IDS, ...ALL_BACKENDS]) {
    assert.ok(!String(id).includes(UNPRICED_PROVIDER), `${id} is a REAL backend on a fake vendor`);
  }
  // and the fixtures really are the unpriced ones, so the tests above test what they claim to
  assert.equal(PRICES[UNPRICED_BACKEND].perSecondUsd, null);
  assert.ok(PRICES[UNPRICED_BACKEND]._fixture, 'marked as deliberate, not as an oversight');
});

// ── the coupling that keeps this honest ─────────────────────────────────────
test('EVERY registry backend id estimates to a real, positive number', async () => {
  const { BACKEND_IDS, ALL_BACKENDS } = await import('../../../../src/lib/render-models.js');
  assert.ok(BACKEND_IDS.length >= 5);
  for (const id of [...BACKEND_IDS, ...ALL_BACKENDS]) {
    const e = estimateRender(threeJobs(), { backend: id, mode: 'full', resolution: '480p' });
    assert.ok(Number.isFinite(e.totalUsd) && e.totalUsd > 0, `${id} priced to a real number, got ${e.totalUsd}`);
    assert.ok(!e.unknownPrice, `${id} cannot be both priced and unknown`);
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
