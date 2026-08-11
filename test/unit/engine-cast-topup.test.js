// The STARRED-cast contract, deterministic layer: topUpStarredElements. A starred character exists
// to pin identity, so a plan that sampled one reference per character (the LLM's "smallest set"
// habit) is topped up mechanically to the full set — within the exact budget validateJobs and the
// renderers enforce: per-model maxImages, tightened by a declared combined-refs cap, minus the
// opening/seam slot on chained jobs, capped by Kling's per-element ceiling, split evenly across the
// starred cast. Un-starred elements are never touched. Symptom this pins down: three casts starred,
// ONE image each sent to a Seedance render.
//
// Fixtures are SYNTHETIC (inventory arrays ride ctx.inventory) — no real profiles/references.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
const { topUpStarredElements, contextBlock } = await import('../../src/lib/engine.js');
const { inventoryText, characterRefs, refBelongsTo } = await import('../../src/lib/elements.js');
const { capsFor } = await import('../../src/lib/render-models.js');

// ── synthetic fixtures ──────────────────────────────────────────────────────
const ref = (id) => ({ id, type: 'reference', file: `elements/references/${id}.png`, abs: `/synthetic/${id}.png`, description: '' });
const refsFor = (cslug, n) => Array.from({ length: n }, (_, i) => ref(`${cslug}-${String(i + 1).padStart(2, '0')}`));
const el = (id, character, role = 'subject') => ({ id, role, image: `elements/references/${id}.png`, ...(character ? { character } : {}) });
const ctxFor = (backend, castNames, inventory) => ({ backend, caps: capsFor(backend), castNames, inventory });
const countFor = (spec, cslug) => spec.kling.elements.filter((e) => (e.character ? e.character.toLowerCase().replace(/\s+/g, '-') === cslug : refBelongsTo(e.id, cslug))).length;

// ── the symptom: starred char with 7 refs but ONE element → topped to budget ─
test('a starred character with 7 refs but 1 element entry is topped up to its full set', () => {
  const inv = refsFor('keeper', 7);
  const spec = { spec_version: '1.0', kling: { elements: [el('keeper-01', 'Keeper')], jobs: [{ job_id: 'S1J1', shots: ['S1'] }] } };
  topUpStarredElements(spec, ctxFor('seedance-2.0@fal', ['keeper'], inv));
  // single job, nothing chained → no seam slot; budget 9, share 9, 7 available → all 7 ride
  assert.equal(spec.kling.elements.length, 7);
  assert.deepEqual(spec.kling.elements.map((e) => e.id), refsFor('keeper', 7).map((r) => r.id));
  // the plan's own character spelling is kept — one group, not two
  assert.ok(spec.kling.elements.every((e) => e.character === 'Keeper'));
});

test('a starred character the plan attached NOTHING for still gets its references', () => {
  const inv = refsFor('keeper', 3);
  const spec = { spec_version: '1.0', kling: { jobs: [{ job_id: 'S1J1', shots: ['S1'] }] } }; // no elements array at all
  topUpStarredElements(spec, ctxFor('seedance-2.0@fal', ['keeper'], inv));
  assert.equal(spec.kling.elements.length, 3);
  assert.ok(spec.kling.elements.every((e) => e.character === 'keeper' && e.role === 'subject'));
});

// ── un-starred elements: never touched, never topped ────────────────────────
test('un-starred elements survive untouched and un-starred inventory is never attached', () => {
  const inv = [...refsFor('keeper', 3), ref('prop-cheese'), ref('prop-lamp')];
  const prop = el('prop-cheese', null, 'object');
  const spec = { spec_version: '1.0', kling: { elements: [el('keeper-01', 'Keeper'), prop], jobs: [{ job_id: 'S1J1', shots: ['S1'] }] } };
  topUpStarredElements(spec, ctxFor('seedance-2.0@fal', ['keeper'], inv));
  assert.equal(countFor(spec, 'keeper'), 3, 'starred char topped to its 3 refs');
  assert.deepEqual(spec.kling.elements.filter((e) => e.id.startsWith('prop-')), [prop], 'the un-starred pick is untouched; prop-lamp stays on disk');
});

// ── even split across starred casts ─────────────────────────────────────────
test('two starred casts split the full budget evenly (no seam reservation — pins yield to cast)', () => {
  const inv = [...refsFor('keeper', 7), ...refsFor('gull', 7)];
  const spec = {
    spec_version: '1.0',
    kling: {
      elements: [el('keeper-01', 'Keeper'), el('gull-01', 'Gull')],
      jobs: [
        { job_id: 'J1', shots: ['S1'], elements: ['keeper-01', 'gull-01'] },
        { job_id: 'J2', shots: ['S2'], elements: ['keeper-01', 'gull-01'] },
      ],
    },
  };
  topUpStarredElements(spec, ctxFor('seedance-2.0@fal', ['keeper', 'gull'], inv));
  // chained 2-job Seedance render → 9-image cap minus the seam slot = 8; floor(8/2) = 4 each
  assert.equal(countFor(spec, 'keeper'), 4);
  assert.equal(countFor(spec, 'gull'), 4);
  assert.equal(spec.kling.elements.length, 8, 'roster fits the tightest (chained) job budget');
  const caps = capsFor('seedance-2.0@fal');
  assert.ok(spec.kling.jobs[0].elements.length <= caps.maxImages, 'first job within maxImages');
  assert.ok(spec.kling.jobs[1].elements.length <= caps.maxImages - 1, 'chained job leaves the seam slot free');
});

test('an authored first_frame reserves nothing — cast fills the budget and the pin drops instead', () => {
  const inv = refsFor('keeper', 9);
  const spec = {
    spec_version: '1.0',
    kling: { elements: [el('keeper-01', 'Keeper')], jobs: [{ job_id: 'J1', shots: ['S1'], first_frame: 'elements/first-frame/open.png', elements: ['keeper-01'] }] },
  };
  topUpStarredElements(spec, ctxFor('seedance-2.0@fal', ['keeper'], inv));
  assert.equal(spec.kling.elements.length, 9, 'the full 9-image cap — the frame pin yields at render, not here');
  assert.equal(spec.kling.jobs[0].elements.length, 9);
});

// ── model caps: maxImages / maxCombinedRefs / Kling's per-element ceiling ───
test('fal Seedance 2.5: three starred casts top up fully and never break the 50 combined-refs cap', () => {
  const casts = ['ash', 'birch', 'cedar'];
  const inv = casts.flatMap((c) => refsFor(c, 20));
  const spec = {
    spec_version: '1.0',
    kling: {
      elements: casts.map((c) => el(`${c}-01`, c)),
      jobs: [{ job_id: 'J1', shots: ['S1'] }, { job_id: 'J2', shots: ['S2'] }], // inherit the roster
    },
  };
  topUpStarredElements(spec, ctxFor('seedance-2.5@fal', casts, inv));
  const caps = capsFor('seedance-2.5@fal');
  // chained → budget min(50, 50) - 1 = 49; floor(49/3) = 16 each
  for (const c of casts) assert.equal(countFor(spec, c), 16);
  assert.equal(spec.kling.elements.length, 48);
  assert.ok(spec.kling.elements.length <= Math.min(caps.maxImages, caps.maxCombinedRefs) - 1);
});

test('a tighter combined-refs cap wins over maxImages', () => {
  const casts = ['ash', 'birch', 'cedar'];
  const inv = casts.flatMap((c) => refsFor(c, 20));
  const caps = { ...capsFor('seedance-2.5@fal'), maxCombinedRefs: 10 }; // synthetic: combined budget bites first
  const spec = {
    spec_version: '1.0',
    kling: { elements: casts.map((c) => el(`${c}-01`, c)), jobs: [{ job_id: 'J1', shots: ['S1'] }, { job_id: 'J2', shots: ['S2'] }] },
  };
  topUpStarredElements(spec, { backend: 'seedance-2.5@fal', caps, castNames: casts, inventory: inv });
  // budget min(50, 10) - 1 seam = 9; floor(9/3) = 3 each
  for (const c of casts) assert.equal(countFor(spec, c), 3);
  assert.equal(spec.kling.elements.length, 9);
});

test('Kling: the per-element ceiling (frontal + 3 refs) caps the top-up, not the 7-image job cap', () => {
  const inv = refsFor('keeper', 7);
  const spec = { spec_version: '1.0', kling: { elements: [el('keeper-01', 'Keeper')], jobs: [{ job_id: 'K1', shots: ['S1'] }, { job_id: 'K2', shots: ['S2'] }] } };
  topUpStarredElements(spec, ctxFor('kling-o3@fal', ['keeper'], inv));
  // Kling renders 1 frontal + 3 reference images per element; a 5th view would upload dead weight.
  // Its native first-frame slot also means chaining reserves NO image slot.
  assert.equal(spec.kling.elements.length, 4);
});

// ── stability ───────────────────────────────────────────────────────────────
test('top-up is idempotent and leaves an already-full plan byte-identical', () => {
  const inv = refsFor('keeper', 3);
  const spec = { spec_version: '1.0', kling: { elements: refsFor('keeper', 3).map((r) => el(r.id, 'Keeper')), jobs: [{ job_id: 'J1', shots: ['S1'] }] } };
  const before = structuredClone(spec);
  topUpStarredElements(spec, ctxFor('seedance-2.0@fal', ['keeper'], inv));
  assert.deepEqual(spec, before, 'nothing to add — nothing changed');
});

// ── the context the Casting agent reasons from ──────────────────────────────
test('characterRefs / refBelongsTo follow the cast routes\' filename convention', () => {
  const inv = [...refsFor('keeper', 2), ref('keeper'), ref('keeperton-01'), ref('prop-cheese')];
  assert.deepEqual(characterRefs(inv, 'Keeper').map((r) => r.id), ['keeper-01', 'keeper-02', 'keeper']);
  assert.equal(refBelongsTo('keeperton-01', 'keeper'), false, 'prefix match is dash-bounded');
});

test('inventoryText groups a starred cast\'s references with a count; flat listing unchanged without a cast', () => {
  const inv = [...refsFor('keeper', 3), ref('prop-cheese')];
  const grouped = inventoryText(inv, { castNames: ['Keeper'] });
  assert.match(grouped, /Keeper — STARRED cast, 3 reference images:/);
  assert.match(grouped, /Other references \(attach by relevance only\):\n {2}- id: prop-cheese/);
  const flat = inventoryText(inv);
  assert.ok(!flat.includes('STARRED'), 'no cast → the historic flat listing');
  assert.match(flat, /id: keeper-01/);
});

test('contextBlock states the combined-refs cap and Kling\'s per-character ceiling on the Hard caps line', () => {
  const base = { brief: 'x', durationTargetS: 10, inventoryText: '(none)', voicesText: '(none)', profilesText: '', castNames: null, textToVideo: false };
  const s25 = contextBlock({ ...base, backend: 'seedance-2.5@fal', caps: capsFor('seedance-2.5@fal') });
  assert.ok(s25.includes('≤50 references/job combined across images+audio+video'));
  const kling = contextBlock({ ...base, backend: 'kling-o3@fal', caps: capsFor('kling-o3@fal') });
  assert.ok(kling.includes('≤4 images per character (1 frontal + 3 references)'));
  const s20 = contextBlock({ ...base, backend: 'seedance-2.0@fal', caps: capsFor('seedance-2.0@fal') });
  assert.ok(!s20.includes('combined across') && !s20.includes('per character'), 'models declaring neither cap keep the historic line');
});
