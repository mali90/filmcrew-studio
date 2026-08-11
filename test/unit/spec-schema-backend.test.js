// Backend-aware spec validation, now driven by the render-models registry instead of hardcoded
// constants. Three INTENTIONAL updates in this file (ST2 of the provider/model registry work):
//   1. RENDER_BACKENDS is ALL_BACKENDS — the two canonical compound ids PLUS the two legacy aliases,
//      which stay valid forever so old spec.json files need no migration.
//   2. the render_backend rejection message lists that same widened set.
//   3. Seedance's floor message names the MODEL ("Seedance 2.0"), because the number now comes from
//      capsFor(backend) rather than a module constant.
// The KLING_CAPS / SEEDANCE_CAPS deepEquals below are deliberately UNCHANGED: if the registry
// derivation is right they reproduce the old constants exactly, and if it is wrong they say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
neutralizeDotenv();
const { validateSpec, SEEDANCE_CAPS, KLING_CAPS, RENDER_BACKENDS, ASPECTS } = await import('../../src/lib/spec-schema.js');

test('golden spec is valid for every backend id (legacy alias and canonical compound alike)', async () => {
  const { ALL_BACKENDS } = await import('../../src/lib/render-models.js');
  for (const be of ALL_BACKENDS) {
    assert.equal(validateSpec(loadGoldenSpec(), { backend: be }).ok, true, be);
  }
});

// Seedance 2.5 doubles the per-job window (4–30s on BOTH providers). The schema is where that
// becomes real for a plan: a 30s job is a legal 2.5 job and an illegal 2.0 one, and the difference
// must come from capsFor(backend) rather than a module constant.
test('the per-job window is caps-driven: 30s validates on 2.5 and fails on every 15s model', () => {
  const spec = loadGoldenSpec();
  const [s1] = spec.shots;
  spec.shots = [s1];
  s1.duration_s = 30;
  spec.audio.voice.lines = spec.audio.voice.lines.filter((l) => l.shot_id === s1.shot_id);
  spec.kling.jobs = [{ job_id: 'K1', shots: [s1.shot_id], elements: ['subject'] }];

  for (const be of ['seedance-2.5@fal', 'seedance-2.5@segmind']) {
    assert.equal(validateSpec(spec, { backend: be }).ok, true, `${be} renders a 30s job`);
  }
  for (const be of ['seedance-2.0@fal', 'seedance-2.0@segmind', 'kling-o3@fal']) {
    const v = validateSpec(spec, { backend: be });
    assert.equal(v.ok, false, be);
    assert.match(v.errors.join('\n'), /total 30s exceeds the 15s\/job cap/, be);
  }
  // …and 2.5's own ceiling still bites one second later
  s1.duration_s = 31;
  const over = validateSpec(spec, { backend: 'seedance-2.5@fal' });
  assert.equal(over.ok, false);
  assert.match(over.errors.join('\n'), /total 31s exceeds the 30s\/job cap/);
});

test('a 3s job passes kling but fails Seedance\'s 4s/job floor (caps-driven, model named)', () => {
  const spec = loadGoldenSpec();
  spec.shots = [spec.shots[0]];
  spec.shots[0].duration_s = 3;
  spec.audio.voice.lines = spec.audio.voice.lines.filter((l) => l.shot_id === 'S1');
  spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['subject'] }];
  assert.equal(validateSpec(spec, { backend: 'kling' }).ok, true);
  const v = validateSpec(spec, { backend: 'seedance' });
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /under Seedance 2\.0's 4s\/job minimum/);
  // the compound id resolves to the same caps, so it fails identically
  assert.deepEqual(validateSpec(spec, { backend: 'seedance-2.0@fal' }).errors, v.errors);
});

test('optional spec.render_backend: every valid id passes, unknown fails with the full list', async () => {
  const { ALL_BACKENDS } = await import('../../src/lib/render-models.js');
  const spec = loadGoldenSpec();
  for (const be of ALL_BACKENDS) {
    spec.render_backend = be;
    assert.equal(validateSpec(spec).ok, true, be);
  }
  spec.render_backend = 'runway';
  const v = validateSpec(spec);
  assert.equal(v.ok, false);
  const errs = v.errors.join('\n');
  assert.match(errs, /render_backend "runway" is not one of: /);
  for (const be of ALL_BACKENDS) assert.ok(errs.includes(be), `the message lists ${be}`);
});

test('caps exports: the registry-derived backends list + caps objects unchanged in shape', () => {
  assert.deepEqual(RENDER_BACKENDS, [
    'kling-o3@fal',
    'seedance-2.0@fal', 'seedance-2.0@segmind',
    'seedance-2.5@fal', 'seedance-2.5@segmind',
    'kling', 'seedance',
  ]);
  // ↓↓↓ these two must NOT need touching — they prove the registry reproduces the old constants ↓↓↓
  assert.deepEqual(SEEDANCE_CAPS, { MIN_JOB_SECONDS: 4, MAX_JOB_SECONDS: 15, MAX_IMAGE_REFS: 9, MAX_AUDIO_REFS: 3 });
  assert.deepEqual(KLING_CAPS, { MAX_STORYBOARDS: 6, MAX_JOB_SECONDS: 15, MAX_SEG_CHARS: 512, MAX_REF_IMAGES: 7 });
});

// ── caps-driven validateJobs ────────────────────────────────────────────────

/** A one-job spec with `n` 1-second shots (total = n seconds — inside every model's window at n≥4). */
function nShotSpec(n) {
  const spec = loadGoldenSpec();
  const template = spec.shots[0];
  spec.shots = Array.from({ length: n }, (_, i) => ({
    ...structuredClone(template),
    shot_id: `S${i + 1}`,
    duration_s: 1,
  }));
  spec.audio.voice.lines = []; // the removed shot ids must not dangle
  spec.kling.jobs = [{ job_id: 'K1', shots: spec.shots.map((s) => s.shot_id), elements: ['subject'] }];
  return spec;
}

test('maxSegments / maxSegmentChars FALL BACK to the shared 6/512 when a model declares neither', () => {
  // seedance-2.0's registry entry carries no maxSegments and no maxSegmentChars — the check must
  // still run against the shared defaults rather than silently disappearing.
  const spec = nShotSpec(7);
  spec.shots[0].kling.content_prompt = 'x'.repeat(600);
  const v = validateSpec(spec, { backend: 'seedance' });
  assert.equal(v.ok, false);
  const errs = v.errors.join('\n');
  assert.match(errs, /kling\.jobs\[0\]: 7 shots exceeds the 6-storyboard cap/);
  assert.match(errs, /kling\.jobs\[0\]: shot S1 content_prompt exceeds 512 chars/);
  // and kling — which DOES declare both caps — reports the same two job-level failures
  const k = validateSpec(spec, { backend: 'kling' });
  assert.equal(k.ok, false);
  assert.match(k.errors.join('\n'), /kling\.jobs\[0\]: 7 shots exceeds the 6-storyboard cap/);
  assert.match(k.errors.join('\n'), /kling\.jobs\[0\]: shot S1 content_prompt exceeds 512 chars/);
});

test('maxImages is per MODEL now: Seedance takes 9 refs where Kling still stops at 7', () => {
  // Today both backends shared the Kling 7-image "safe intersection". Caps-driven means a Seedance
  // job may legitimately carry its endpoint's 9. Nothing in the suite depended on 8 refs failing
  // on Seedance — this test is the record of that deliberate widening.
  const spec = nShotSpec(5);
  spec.kling.elements = Array.from({ length: 10 }, (_, i) => ({
    id: `e${i + 1}`, role: 'subject', image: 'elements/references/wren-01.png',
  }));
  const withRefs = (n) => {
    const s = structuredClone(spec);
    s.kling.jobs[0].elements = s.kling.elements.slice(0, n).map((e) => e.id);
    return s;
  };

  assert.equal(validateSpec(withRefs(7), { backend: 'kling' }).ok, true);
  const kling8 = validateSpec(withRefs(8), { backend: 'kling' });
  assert.equal(kling8.ok, false);
  assert.match(kling8.errors.join('\n'), /8 elements exceeds the 7-reference cap/);

  assert.equal(validateSpec(withRefs(8), { backend: 'seedance' }).ok, true, 'Seedance 2.0 accepts 8 image refs');
  assert.equal(validateSpec(withRefs(9), { backend: 'seedance' }).ok, true);
  const sd10 = validateSpec(withRefs(10), { backend: 'seedance' });
  assert.equal(sd10.ok, false);
  assert.match(sd10.errors.join('\n'), /10 elements exceeds the 9-reference cap/);
});

test('maxSeconds stays caps-driven: an 18s job fails on both of today\'s models', () => {
  const spec = nShotSpec(6);                                 // 6 shots — inside the storyboard cap
  spec.shots.forEach((s) => { s.duration_s = 3; });          // 6 × 3 = 18s
  for (const be of ['kling', 'seedance']) {
    const v = validateSpec(spec, { backend: be });
    assert.equal(v.ok, false, be);
    assert.match(v.errors.join('\n'), /total 18s exceeds the 15s\/job cap/, be);
  }
});

test('an unknown backend passed to validateSpec throws from the registry (never a silent pass)', () => {
  assert.throws(() => validateSpec(loadGoldenSpec(), { backend: 'runway' }), /runway/);
});

// ── ASPECTS is the SUPERSET; per-run legality is caps-driven elsewhere ──────
// The schema must accept any ratio some model can render, because a spec.json planned for
// seedance-2.5 is a valid spec.json. Which ratios a PARTICULAR run may use is enforced where the
// backend is known: engine buildCtx (CLI) and POST /api/runs (web). Splitting it this way is what
// lets a 4:3 spec survive round-tripping through a validator that does not know the backend.
test('ASPECTS is the numeric superset — no adaptive/auto, and the schema accepts all six', () => {
  assert.deepEqual(ASPECTS, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);
  assert.ok(!ASPECTS.includes('adaptive') && !ASPECTS.includes('auto'));

  const spec = loadGoldenSpec();
  for (const a of ASPECTS) {
    spec.project.aspect_ratio = a;
    spec.kling.aspect_ratio = a;
    assert.equal(validateSpec(spec).ok, true, `${a} is structurally valid`);
  }
  spec.project.aspect_ratio = '5:4';
  spec.kling.aspect_ratio = '5:4';
  const v = validateSpec(spec);
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /aspect_ratio "5:4"/);
});

// The opening-frame slot (WS2-P1): a boundary frame that has to travel as a reference is a SOFT
// pin, and SEAM_PRIORITY drops the closing pin, then the opening one, before it drops a single
// identity reference. So the CAST gets the whole image budget — reserving a slot up front would
// reject a legal max-cast job to protect a hint the renderer is willing to lose.
test('the cast gets the whole image budget — a droppable seam pin never reserves a slot', () => {
  const max = SEEDANCE_CAPS.MAX_IMAGE_REFS;
  const spec = loadGoldenSpec();
  const [s1, s2] = spec.shots;
  assert.ok(s2, 'the fixture needs at least two shots');
  spec.shots = [s1, s2];
  s1.duration_s = 5;
  s2.duration_s = 5;
  spec.audio.voice.lines = spec.audio.voice.lines.filter((l) => [s1.shot_id, s2.shot_id].includes(l.shot_id));
  const tpl = spec.kling.elements[0];
  const ids = Array.from({ length: max }, (_, i) => `ref-${i}`);
  spec.kling.elements = ids.map((id) => ({ ...tpl, id }));
  spec.kling.jobs = [
    { job_id: 'K1', shots: [s1.shot_id], elements: ids.slice() },
    { job_id: 'K2', shots: [s2.shot_id], elements: ids.slice() },
  ];

  // A full cast on EVERY job is legal, seam chaining and all: at render time the seam pin is what
  // gives way, not a paid identity reference.
  assert.equal(validateSpec(spec, { backend: 'seedance' }).ok, true, 'max cast + a chained seam is legal');
  spec.kling.jobs[0].first_frame = 'first-frame/open.png';
  spec.kling.jobs[0].last_frame = 'last-frame/close.png';
  assert.equal(validateSpec(spec, { backend: 'seedance-2.0@fal' }).ok, true, 'authored boundary frames reserve nothing either');

  // One reference OVER the model's cap is still a spec error — that one is not droppable.
  spec.kling.elements = Array.from({ length: max + 1 }, (_, i) => ({ ...tpl, id: `ref-${i}` }));
  spec.kling.jobs = spec.kling.jobs.map((j) => ({ ...j, elements: spec.kling.elements.map((e) => e.id) }));
  const over = validateSpec(spec, { backend: 'seedance' });
  assert.equal(over.ok, false);
  assert.match(over.errors.join('\n'), new RegExp(`kling\\.jobs\\[0\\]: ${max + 1} elements exceeds the ${max}-reference cap`));

  // An OMITTED job.elements inherits the whole roster at render time (characterGroups), so a
  // 10-entry roster with empty per-job lists is ten uploads per job — the budget must see them.
  spec.kling.jobs = [
    { job_id: 'K1', shots: [s1.shot_id] },
    { job_id: 'K2', shots: [s2.shot_id] },
  ];
  const vr = validateSpec(spec, { backend: 'seedance' });
  assert.equal(vr.ok, false);
  assert.match(vr.errors.join('\n'), new RegExp(`kling\\.jobs\\[1\\]: ${max + 1} roster refs .*exceeds the ${max}-reference cap`));
});

// Backend-less caps precedence (codex round 4): a persisted spec is judged by ITS OWN backend, and
// a spec naming none gets the widest registered window — never silently Kling's 7-reference cap.
test('backend-less validation infers caps from spec.render_backend, else the superset', () => {
  const max = SEEDANCE_CAPS.MAX_IMAGE_REFS;
  const spec = loadGoldenSpec();
  const [s1, s2] = spec.shots;
  spec.shots = [s1, s2];
  s1.duration_s = 5;
  s2.duration_s = 5;
  spec.audio.voice.lines = spec.audio.voice.lines.filter((l) => [s1.shot_id, s2.shot_id].includes(l.shot_id));
  const tpl = spec.kling.elements[0];
  const ids = Array.from({ length: max - 1 }, (_, i) => `ref-${i}`);
  spec.kling.elements = ids.map((id) => ({ ...tpl, id }));
  spec.kling.jobs = [
    { job_id: 'K1', shots: [s1.shot_id], elements: ids.slice() },
    { job_id: 'K2', shots: [s2.shot_id], elements: ids.slice() },
  ];
  // 8 refs: over Kling's 7, within Seedance's chained budget of 8.
  spec.render_backend = 'seedance-2.0@fal';
  assert.equal(validateSpec(spec).ok, true, 'the persisted backend judges, not the old kling default');
  delete spec.render_backend;
  assert.equal(validateSpec(spec).ok, true, 'no backend anywhere — the widest registered window judges');
  spec.render_backend = 'kling';
  assert.equal(validateSpec(spec).ok, false, 'a persisted kling spec still gets kling\'s 7');

  // The persisted backend enforces its ASPECT list too — a stored Kling spec carrying 21:9 is
  // broken however it is read; only a spec with no backend at all gets the superset reading.
  const aspectSpec = loadGoldenSpec();
  aspectSpec.project.aspect_ratio = '21:9';
  aspectSpec.kling.aspect_ratio = '21:9';
  assert.equal(validateSpec(aspectSpec).ok, true, 'no backend anywhere — superset');
  aspectSpec.render_backend = 'kling';
  const va = validateSpec(aspectSpec);
  assert.equal(va.ok, false, 'a persisted kling spec cannot carry 21:9');
  assert.match(va.errors.join('\n'), /not renderable on Kling 3\.0 Omni/);
});

// The other half of that split, stated as an assertion rather than a comment: with NO backend the
// schema takes '21:9' from any spec (the superset), but the moment a caller NAMES the backend —
// and every render/engine path passes the resolved one — the model's own ratio list is enforced.
// Without this, a hand-authored 4:3 spec rendered with `--backend kling-o3@fal` would sail through
// to a paid render the model cannot produce; the engine buildCtx and POST /api/runs gates only
// cover THEIR entry points, not a spec.json handed straight to the render CLI.
test("'21:9' clears the backend-less schema but FAILS validation once kling is named", async () => {
  const { aspectsFor } = await import('../../src/lib/render-models.js');
  const spec = loadGoldenSpec();
  spec.project.aspect_ratio = '21:9';
  spec.kling.aspect_ratio = '21:9';
  assert.equal(validateSpec(spec).ok, true, 'no backend named — the schema stays the superset');
  const v = validateSpec(spec, { backend: 'kling' });
  assert.equal(v.ok, false, 'backend named — its ratio list bites');
  assert.match(v.errors.join('\n'), /not renderable on Kling 3\.0 Omni/);
  assert.ok(ASPECTS.includes('21:9'));
  assert.ok(!aspectsFor('kling').includes('21:9'), 'kling-o3 renders 16:9/9:16/1:1 only');
  assert.ok(!aspectsFor('seedance-2.0@fal').includes('21:9'), 'seedance 2.0 ON FAL the same three');
  // …but the SAME model on Segmind does offer it, so the ratio list is a (model, provider) fact
  for (const be of ['seedance-2.0@segmind', 'seedance-2.5@fal', 'seedance-2.5@segmind']) {
    assert.ok(aspectsFor(be).includes('21:9'), be);
    const wide = loadGoldenSpec();
    wide.project.aspect_ratio = '21:9';
    wide.kling.aspect_ratio = '21:9';
    assert.equal(validateSpec(wide, { backend: be }).ok, true, `${be} accepts a 21:9 spec`);
  }
  const narrow = loadGoldenSpec();
  narrow.project.aspect_ratio = '21:9';
  narrow.kling.aspect_ratio = '21:9';
  assert.equal(validateSpec(narrow, { backend: 'seedance-2.0@fal' }).ok, false, 'the same spec fails on fal 2.0');
});

// kling.resolution got the same registry treatment as the ratios above, with one asymmetry that is
// the point: the field only DRIVES a kling-family render (klingPromptSettings reads it first), while
// the Seedance renderers IGNORE it and read their own knob — and old Seedance specs legitimately
// carry the KLING default ('1080p') the agents used to copy in. So kling is judged against its own
// ladder, and Seedance-family / backend-less specs get the registry-wide union as a shape check —
// never the old hardcoded '4k|1080p|720p', which rejected a planner writing 480p for a 2.5 plan.
test('kling.resolution: the kling ladder where it drives the render, the registry union elsewhere', () => {
  const at = (res, backend) => {
    const spec = loadGoldenSpec();
    spec.kling.resolution = res;
    return validateSpec(spec, backend === undefined ? {} : { backend });
  };
  // kling's own ladder — 480p is not on it
  assert.equal(at('720p', 'kling-o3@fal').ok, true);
  assert.equal(at('4k', 'kling').ok, true);
  const v = at('480p', 'kling-o3@fal');
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /kling\.resolution "480p" not in 720p\|1080p\|4k/);
  // Seedance: new plans write 480p (the caps-driven engine enum), old 2.5 plans carry 1080p — both
  // must keep validating, because neither value reaches the render
  assert.equal(at('480p', 'seedance-2.5@fal').ok, true);
  assert.equal(at('1080p', 'seedance-2.5@segmind').ok, true, 'a pre-registry 2.5 spec still validates');
  assert.equal(at('480p', 'seedance').ok, true);
  // no backend named: the union still rejects garbage
  assert.equal(at('480p', undefined).ok, true);
  assert.equal(at('900p', undefined).ok, false);
});
