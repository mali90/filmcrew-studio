// The STARRED-cast contract, deterministic layer: topUpStarredElements. A starred character exists
// to pin identity, so a plan that sampled one reference per character (the LLM's "smallest set"
// habit) is topped up mechanically to the full set — within the exact budget validateJobs and the
// renderers enforce: per-model maxImages, tightened by a declared combined-refs cap MINUS the voice
// references that share it, capped by Kling's per-element ceiling, split evenly across the starred
// cast. Seam pins reserve nothing (they are dropped before a cast ref) and voice clips reserve
// everything they will spend (nothing drops them — the renderer throws instead).
// Un-starred elements are never touched. Symptom this pins down: three casts starred, ONE image
// each sent to a Seedance render.
//
// Fixtures are SYNTHETIC (inventory arrays ride ctx.inventory) — no real profiles/references.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
const { topUpStarredElements, contextBlock } = await import('../../src/lib/engine.js');
const { inventoryText, characterRefs, refBelongsTo } = await import('../../src/lib/elements.js');
const { capsFor } = await import('../../src/lib/render-models.js');
const { nameOf } = await import('../../src/lib/seedance-args.js');

// ── synthetic fixtures ──────────────────────────────────────────────────────
const ref = (id) => ({ id, type: 'reference', file: `elements/references/${id}.png`, abs: `/synthetic/${id}.png`, description: '' });
const refsFor = (cslug, n) => Array.from({ length: n }, (_, i) => ref(`${cslug}-${String(i + 1).padStart(2, '0')}`));
const el = (id, character, role = 'subject') => ({ id, role, image: `elements/references/${id}.png`, ...(character ? { character } : {}) });
const ctxFor = (backend, castNames, inventory, voiceClipFor = () => null) =>
  ({ backend, caps: capsFor(backend), castNames, inventory, voiceClipFor });
/** One VO line, the shape jobSpeakers reads — a speaker only costs an @AudioN ref if it has a clip. */
const line = (shotId, speaker) => ({ shot_id: shotId, speaker, text: 'a line of dialogue' });
const voiced = (...names) => (sp) => (names.includes(sp) ? `/synthetic/${sp}.mp3` : null);
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

test('un-starred props do not eat the split — the cast divides what is LEFT of the budget', () => {
  const inv = [...refsFor('keeper', 9), ...refsFor('gull', 9), ref('prop-cheese'), ref('prop-lamp'), ref('prop-net')];
  const props = ['prop-cheese', 'prop-lamp', 'prop-net'].map((id) => el(id, null, 'object'));
  const spec = {
    spec_version: '1.0',
    kling: { elements: [...props, el('keeper-01', 'Keeper'), el('gull-01', 'Gull')], jobs: [{ job_id: 'J1', shots: ['S1'] }] },
  };
  topUpStarredElements(spec, ctxFor('seedance-2.0@fal', ['keeper', 'gull'], inv));
  // Three of the nine image slots are already spent on props, so six are the cast's: three each.
  // Splitting the WHOLE nine promised four apiece, and the second star hit the ceiling at two —
  // the same plan allocated differently for no reason but the order the cast was listed in.
  assert.equal(countFor(spec, 'keeper'), 3);
  assert.equal(countFor(spec, 'gull'), 3);
  assert.equal(spec.kling.elements.length, 9, 'and the budget is still spent to the last slot');
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
  // 2-job Seedance render, nothing voiced → the whole 9-image cap; floor(9/2) = 4 each
  assert.equal(countFor(spec, 'keeper'), 4);
  assert.equal(countFor(spec, 'gull'), 4);
  assert.equal(spec.kling.elements.length, 8, 'an even split of the 9-image budget leaves one slot unspendable');
  const caps = capsFor('seedance-2.0@fal');
  for (const job of spec.kling.jobs) assert.ok(job.elements.length <= caps.maxImages, `${job.job_id} within maxImages`);
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
  // nothing voiced → budget min(50, 50) = 50; floor(50/3) = 16 each
  for (const c of casts) assert.equal(countFor(spec, c), 16);
  assert.equal(spec.kling.elements.length, 48);
  assert.ok(spec.kling.elements.length <= Math.min(caps.maxImages, caps.maxCombinedRefs));
});

// ── the combined budget is shared with VOICE refs, and nothing ever drops those ──
test('fal Seedance 2.5: a voiced line reserves its @Audio slot out of the 50 combined refs', () => {
  // The reviewer's scenario: one starred character with more references than the model has slots,
  // and a single voiced line. Topping up to all 50 image slots makes render-seedance count 51
  // combined refs and THROW before it uploads anything — an engine-produced plan that cannot render.
  const inv = refsFor('keeper', 60);
  const spec = {
    spec_version: '1.0',
    kling: { elements: [el('keeper-01', 'Keeper')], jobs: [{ job_id: 'J1', shots: ['S1'] }] },
    audio: { voice: { lines: [line('S1', 'Keeper')] } },
  };
  topUpStarredElements(spec, ctxFor('seedance-2.5@fal', ['keeper'], inv, voiced('Keeper')));
  const caps = capsFor('seedance-2.5@fal');
  assert.equal(spec.kling.elements.length, 49, 'the voice clip keeps its slot — 49 images + 1 audio = 50');
  // The renderer's own pre-upload arithmetic, run here: images (capped) + audio refs ≤ combined cap.
  const plannedImages = Math.min(spec.kling.elements.length, caps.maxImages);
  assert.ok(plannedImages + 1 <= caps.maxCombinedRefs,
    `${plannedImages} images + 1 voice ref exceeds ${nameOf(caps)}'s ${caps.maxCombinedRefs}-reference combined budget`);
});

test('two voiced speakers reserve two slots; an unregistered speaker reserves none', () => {
  const inv = refsFor('keeper', 60);
  const specFor = (clipFor, lines) => {
    const spec = {
      spec_version: '1.0',
      kling: { elements: [el('keeper-01', 'Keeper')], jobs: [{ job_id: 'J1', shots: ['S1'] }] },
      audio: { voice: { lines } },
    };
    topUpStarredElements(spec, ctxFor('seedance-2.5@fal', ['keeper'], inv, clipFor));
    return spec.kling.elements.length;
  };
  assert.equal(specFor(voiced('Keeper', 'Gull'), [line('S1', 'Keeper'), line('S1', 'Gull')]), 48);
  // A speaker the model voices NATIVELY (no minted clip) sends no @AudioN ref, so it costs nothing.
  assert.equal(specFor(voiced('Keeper'), [line('S1', 'Keeper'), line('S1', 'Gull')]), 49);
  assert.equal(specFor(() => null, [line('S1', 'Keeper'), line('S1', 'Gull')]), 50, 'nothing voiced — the whole budget is the cast\'s');
  // A line belonging to a shot this job does not render is not this job's audio (jobSpeakers).
  assert.equal(specFor(voiced('Keeper'), [line('S9', 'Keeper')]), 50);
});

test('the reservation follows the TIGHTEST job that inherits the roster', () => {
  const inv = refsFor('keeper', 60);
  const spec = {
    spec_version: '1.0',
    kling: {
      elements: [el('keeper-01', 'Keeper')],
      jobs: [{ job_id: 'J1', shots: ['S1'] }, { job_id: 'J2', shots: ['S2'] }], // both inherit
    },
    audio: { voice: { lines: [line('S2', 'Keeper'), line('S2', 'Gull')] } }, // only J2 speaks
  };
  topUpStarredElements(spec, ctxFor('seedance-2.5@fal', ['keeper'], inv, voiced('Keeper', 'Gull')));
  assert.equal(spec.kling.elements.length, 48, 'the roster rides in J2 too — it has to fit J2');
});

test('a model with per-kind budgets is untouched: a voice clip never takes an image slot', () => {
  // Seedance 2.0 declares maxImages/maxAudioRefs and NO combined cap, so the two budgets are
  // independent and reserving an image slot for audio would just starve the cast for nothing.
  const inv = refsFor('keeper', 20);
  const spec = {
    spec_version: '1.0',
    kling: { elements: [el('keeper-01', 'Keeper')], jobs: [{ job_id: 'J1', shots: ['S1'] }] },
    audio: { voice: { lines: [line('S1', 'Keeper')] } },
  };
  topUpStarredElements(spec, ctxFor('seedance-2.0@fal', ['keeper'], inv, voiced('Keeper')));
  assert.equal(spec.kling.elements.length, capsFor('seedance-2.0@fal').maxImages);
});

test('a job naming its own subset is topped up within ITS budget, voice refs included', () => {
  const inv = [...refsFor('keeper', 60), ...refsFor('gull', 60)];
  const spec = {
    spec_version: '1.0',
    kling: {
      elements: [el('keeper-01', 'Keeper'), el('gull-01', 'Gull')],
      jobs: [
        { job_id: 'J1', shots: ['S1'], elements: ['keeper-01', 'gull-01'] }, // silent
        { job_id: 'J2', shots: ['S2'], elements: ['keeper-01', 'gull-01'] }, // two voiced speakers
      ],
    },
    audio: { voice: { lines: [line('S2', 'Keeper'), line('S2', 'Gull')] } },
  };
  topUpStarredElements(spec, ctxFor('seedance-2.5@fal', ['keeper', 'gull'], inv, voiced('Keeper', 'Gull')));
  // No job inherits the roster, so the pool follows the widest job (J1, silent → 50); each job is
  // then filled to its own combined budget.
  assert.ok(spec.kling.jobs[0].elements.length <= 50);
  assert.ok(spec.kling.jobs[1].elements.length <= 48, `J2 sends ${spec.kling.jobs[1].elements.length} images + 2 voice refs`);
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
  // budget min(50, 10) = 10, nothing voiced; floor(10/3) = 3 each
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
