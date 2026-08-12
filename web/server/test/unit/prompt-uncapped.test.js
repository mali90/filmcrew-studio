// The prompt EDITOR with no cap to edit against.
//
// The whole-prompt clamp for Seedance was a house rule, not a provider limit, and it is now off by
// default. That removes a denominator the save path used to subtract from, and a denominator that
// silently reads as 0 is worse than the cap ever was: `maxBytes − pinBytes` goes negative, every
// edit meters as instantly over, and the editor refuses to save words the renderer would happily
// send. So "no cap" travels as `null` — the shape the wire contract already uses for a past take's
// unrecorded budget (web/shared/api-types.ts) — and the save path only refuses when a limit exists.
//
// This file drives prompt-service.js directly (the routes are a thin wrapper over exactly these
// calls, and are pinned for the CAPPED case by test/integration/prompt-edit.test.js, whose run root
// sets the knob to 4321). Nothing here composes prompt text of its own: the numbers come from the
// same composer the renderer uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { neutralizeDotenv } = await import(path.join(HOST_ROOT, 'test/helpers/env.js'));
neutralizeDotenv(); // prompt-service must never reach config.js, but the host imports below can
const { goldenSpec } = await import(path.join(HOST_ROOT, 'test/helpers/golden-spec.js'));
const { buildPromptView, buildPromptViews, savePromptOverride } = await import('../../lib/prompt-service.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-prompt-uncapped-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const bareRoot = path.join(tmpRoot, 'bare');       // no .env ⇒ the shipped default: uncapped
const cappedRoot = path.join(tmpRoot, 'capped');   // the knob, set the way a user would set it
const voicesDir = path.join(tmpRoot, 'voices');    // empty: no minted speaker, so no @AudioN refs
for (const d of [bareRoot, cappedRoot, voicesDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cappedRoot, '.env'), 'SEEDANCE_PROMPT_MAX_BYTES=1200\n');

const SEEDANCE = 'seedance-2.0@fal';
const spec = goldenSpec();
const utf8 = (s) => Buffer.byteLength(s, 'utf8');

/** A fresh run directory per case: savePromptOverride writes a sidecar into it. */
let n = 0;
function mkRun() {
  const dir = path.join(tmpRoot, `run-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const argsFor = (envRoot, runDir, backend = SEEDANCE) =>
  ({ root: HOST_ROOT, envRoot, childEnv: {}, runDir, spec, backend, voicesDir });

/** ~20 KB of one user's own words — the long multi-shot prompt the cap used to shorten. */
const LONG_EDIT = 'A held shot of the lamp, the beam turning slowly over the water. '.repeat(320).trim();

// ── The view: no denominator, but every other number is still real ──────────────────────────────

test('with no cap the Seedance view carries maxBytes: null and a measured pinBytes', async () => {
  const view = (await buildPromptViews(argsFor(bareRoot, mkRun()))).prompts[0];
  assert.equal(view.error ?? null, null, 'the job must preview, not error');
  assert.equal(view.maxBytes, null, '"no limit" is null — 0 would meter every edit as instantly over');
  assert.equal(view.segmentMaxBytes, null, 'Seedance renders one document per job, so there is no per-segment cap either');
  assert.equal(typeof view.pinBytes, 'number', 'what the SYSTEM owns is still measured');
  assert.ok(view.pinBytes > 0, 'front matter, guards and pins cost real bytes even with no budget to spend them from');
  assert.ok(view.bytes > 0);
  assert.ok(!JSON.stringify(view).includes('Infinity'), 'Infinity must never reach the wire — it serializes as null and reads as a number');
  assert.ok(!Number.isNaN(view.maxBytes), 'and never NaN');
});

test('Kling is untouched: 500 B per segment is fal\'s own o3 limit, not a house rule', async () => {
  const view = (await buildPromptViews(argsFor(bareRoot, mkRun(), 'kling'))).prompts[0];
  assert.equal(view.segmentMaxBytes, 500);
  for (const seg of view.segments) {
    assert.equal(seg.maxBytes, 500, 'every segment is still metered against the cap the model enforces');
    assert.ok(seg.pinBytes > 0 && seg.pinBytes < 500);
    assert.ok(seg.bytes <= 500, 'and the composed segment still fits it');
  }
});

test('an un-composable job reports no budget as null too — 0 never has to mean two things', async () => {
  const broken = goldenSpec();
  broken.kling.jobs = [{ job_id: 'K1', shots: ['NOPE'], elements: ['subject'] }];
  const view = (await buildPromptViews({ ...argsFor(bareRoot, mkRun()), spec: broken })).prompts[0];
  assert.match(view.error ?? '', /not found in spec\.shots/, 'the render would fail on this message, so the sheet shows it');
  assert.equal(view.maxBytes, null, 'an errored job has no budget on record — null, the same way every other absence travels');
  assert.equal(view.segmentMaxBytes, null);
});

// ── The save path: it may only refuse what a limit exists to refuse ─────────────────────────────

test('a ~20 KB prompt override is STORED, verbatim, and reads back byte for byte', async () => {
  const runDir = mkRun();
  const args = argsFor(bareRoot, runDir);
  const jobId = (await buildPromptViews(args)).prompts[0].jobId;

  const saved = await savePromptOverride({ ...args, jobId, prompt: LONG_EDIT });
  assert.equal(saved.source, 'override');
  assert.ok(saved.prompt.includes(LONG_EDIT), 'the words are what a render would send');

  // Re-read through the ordinary path — what a reload gets is what the save returned.
  const reread = await buildPromptView({ ...args, jobId });
  assert.equal(reread.source, 'override');
  assert.ok(reread.prompt.includes(LONG_EDIT));
  assert.ok(utf8(reread.prompt) > 20000, `the whole edit survived (got ${utf8(reread.prompt)} B)`);
  // `endsWith`, never `includes` — the speech rule quotes a literal `says: "…"` in every audio-on
  // prompt, so an `includes` would report a truncation that never happened.
  assert.ok(!reread.prompt.endsWith('…'), 'nothing was cut, so nothing marks a cut');

  // …and the sidecar holds the WORDS, at their full length, with no system pin frozen in.
  const sidecar = JSON.parse(fs.readFileSync(path.join(runDir, 'prompt-overrides.json'), 'utf8'));
  assert.equal(sidecar.jobs[jobId].prompt, LONG_EDIT, 'stored byte for byte');
});

test('an empty prompt is still refused — uncapped is not unvalidated', async () => {
  const args = argsFor(bareRoot, mkRun());
  const jobId = (await buildPromptViews(args)).prompts[0].jobId;
  await assert.rejects(
    () => savePromptOverride({ ...args, jobId, prompt: '   \n ' }),
    (e) => e.statusCode === 400 && /empty prompt would send nothing/.test(e.message),
  );
});

test('sending "segments" to a one-document model is still the wrong shape', async () => {
  const args = argsFor(bareRoot, mkRun());
  const jobId = (await buildPromptViews(args)).prompts[0].jobId;
  await assert.rejects(
    () => savePromptOverride({ ...args, jobId, segments: ['a', 'b', 'c'] }),
    (e) => e.statusCode === 400 && /renders as ONE prompt on this model/.test(e.message),
  );
});

// ── The knob still clamps, and still refuses ────────────────────────────────────────────────────

test('a run that SETS the knob gets the number back, and an over-budget edit is refused WITH it', async () => {
  const runDir = mkRun();
  const args = argsFor(cappedRoot, runDir);
  const view = (await buildPromptViews(args)).prompts[0];
  assert.equal(view.maxBytes, 1200, "the run's own SEEDANCE_PROMPT_MAX_BYTES reached the preview");
  assert.ok(view.pinBytes > 0 && view.pinBytes < view.maxBytes, 'the meter has a usable denominator again');

  await assert.rejects(
    () => savePromptOverride({ ...args, jobId: view.jobId, prompt: LONG_EDIT }),
    (e) => e.statusCode === 400 && /the edit is \d+ bytes; the room left for your words is \d+ bytes \(over by \d+\)/.test(e.message),
    'the refusal still carries the numbers the meter shows',
  );
  assert.ok(!fs.existsSync(path.join(runDir, 'prompt-overrides.json')), 'and nothing was stored');
});

test('an edit that FITS a set cap still saves', async () => {
  const args = argsFor(cappedRoot, mkRun());
  const view = (await buildPromptViews(args)).prompts[0];
  const body = 'one held shot of the lamp';
  assert.ok(utf8(body) < view.maxBytes - view.pinBytes);
  const saved = await savePromptOverride({ ...args, jobId: view.jobId, prompt: body });
  assert.equal(saved.source, 'override');
  assert.ok(saved.prompt.endsWith(body));
});
