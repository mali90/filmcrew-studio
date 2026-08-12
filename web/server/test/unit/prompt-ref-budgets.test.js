// The prompt PREVIEW and the wire have to agree about REFUSAL, not just about bytes.
//
// The preview exists to be "exactly what we send". Byte parity (prompt-defaults.test.js,
// prompt-read.test.js) proves that for jobs the renderer will accept — this file proves the other
// half: a job the renderer will REFUSE must not preview as a ready prompt. Both refusals below are
// hard errors raised before the first paid round trip (src/lib/render-seedance.js), so a preview
// that quietly sliced the audio list, or let planSeamRefs drop cast refs to fit, would show a
// green-looking prompt for a job that can never be rendered — and would cite @Image/@Audio labels
// no render will ever send.
//
// The two checks are the SAME functions the renderer calls (src/lib/seedance-args.js), so the
// wording cannot drift between the two surfaces; the literal texts below are what the user reads on
// both, and are asserted against the renderer's own tests in
// test/unit/render-seedance-adapter.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { neutralizeDotenv } = await import(path.join(HOST_ROOT, 'test/helpers/env.js'));
neutralizeDotenv();
const { goldenSpec } = await import(path.join(HOST_ROOT, 'test/helpers/golden-spec.js'));
const { capsFor } = await import(path.join(HOST_ROOT, 'src/lib/render-models.js'));
const { buildPromptViews } = await import('../../lib/prompt-service.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-prompt-budgets-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const runDir = path.join(tmpRoot, 'run');       // no prompt-overrides.json: the plan path
const envRoot = path.join(tmpRoot, 'env');      // no .env: prompt-service's own defaults
const voicesDir = path.join(tmpRoot, 'voices'); // the clips a minted speaker sends as @AudioN
for (const d of [runDir, envRoot, voicesDir]) fs.mkdirSync(d, { recursive: true });

/** Mint N speakers the way the registry does — a clip on disk is what makes a speaker cost a ref. */
const SPEAKERS = ['ana', 'bo', 'cy', 'dee', 'eli', 'fen', 'gus', 'hal', 'ines', 'jo', 'kit', 'lou'];
const registry = {};
for (const n of SPEAKERS) {
  const clip = path.join(voicesDir, `${n}.mp3`);
  fs.writeFileSync(clip, 'ID3'); // unprobeable on purpose: an unfittable clip is KEPT, exactly as sent
  registry[n] = { name: n, voice_id: `v-${n}`, ref_clip: clip, minted_at: null };
}
fs.writeFileSync(path.join(voicesDir, 'voices.json'), JSON.stringify(registry, null, 2));

/** One job carrying `castRefs` reference images and one VO line per named speaker. */
function specWith(castRefs, speakers) {
  const spec = goldenSpec();
  const ids = Array.from({ length: castRefs }, (_, i) => `c${i + 1}`);
  spec.kling.elements = ids.map((id) => ({ id, role: 'subject', image: `elements/references/${id}.png` }));
  spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ids }];
  spec.audio.voice.lines = speakers.map((n, i) => ({ shot_id: 'S1', speaker: n, text: `line ${i}` }));
  return spec;
}

const preview = async (spec, backend) => (await buildPromptViews({
  root: HOST_ROOT, envRoot, childEnv: {}, runDir, spec, backend, voicesDir,
})).prompts[0];

// ── the audio cap: more voiced speakers than the model has @Audio slots ─────────────────────────

test('a job with more voiced speakers than the model accepts previews as the renderer\'s own refusal', async () => {
  // fal Seedance 2.0 takes three audio refs. Four minted speakers is a job the renderer throws on
  // before it fits a single clip — the preview used to slice to three and look perfectly sendable.
  const view = await preview(specWith(2, ['ana', 'bo', 'cy', 'dee']), 'seedance-2.0@fal');
  assert.equal(view.error, "job K1: 4 voiced speakers exceeds Seedance 2.0 on fal's 3-audio-ref cap — split the dialogue across jobs.");
  assert.equal(view.prompt, '', 'an errored job carries no prompt to copy or edit');
  assert.deepEqual(view.refs, [], 'and no reference labels the render would never send');
});

test('at the cap the same job previews normally — the refusal is the cap, not the presence of voices', async () => {
  const caps = capsFor('seedance-2.0@fal');
  const view = await preview(specWith(2, SPEAKERS.slice(0, caps.maxAudioRefs)), 'seedance-2.0@fal');
  assert.equal(view.error ?? null, null);
  assert.equal(view.refs.filter((r) => r.role === 'voice').length, caps.maxAudioRefs);
});

// ── the combined budget: legal image and audio counts whose SUM overruns ────────────────────────

test('individually legal counts that overrun the combined budget preview as the renderer\'s refusal', async () => {
  // The reviewer's case: 49 cast images (under the 50-image cap) and two voice refs (under the
  // 10-audio cap) — 51 against a 50-reference combined budget. planSeamRefs used to quietly drop
  // cast refs to fit, so the preview succeeded and cited labels for images that would never ship.
  const view = await preview(specWith(49, ['ana', 'bo']), 'seedance-2.5@fal');
  assert.equal(view.error, 'Seedance 2.5 on fal accepts at most 50 references in total (images + audio + video) — 51 supplied.');
});

test('exactly at the combined budget the preview composes, and cites every reference it will send', async () => {
  const view = await preview(specWith(48, ['ana', 'bo']), 'seedance-2.5@fal');
  assert.equal(view.error ?? null, null);
  assert.equal(view.refs.filter((r) => r.role === 'voice').length, 2);
  assert.equal(view.refs.filter((r) => r.role !== 'voice').length, 48, 'no cast reference was dropped to make room');
  assert.equal(view.refs.length, capsFor('seedance-2.5@fal').maxCombinedRefs);
});

test('a model with per-kind budgets only is judged by those — no phantom combined cap', async () => {
  // Seedance 2.0 declares no maxCombinedRefs: 9 images + 3 voice refs is 12 references and legal.
  const view = await preview(specWith(9, ['ana', 'bo', 'cy']), 'seedance-2.0@fal');
  assert.equal(view.error ?? null, null);
  assert.equal(view.refs.length, 12);
});

test('a speaker with no minted clip costs no reference — it is voiced natively', async () => {
  // Four speakers, one of them unregistered: three @Audio refs, which is the 2.0 cap exactly.
  const view = await preview(specWith(2, ['ana', 'bo', 'cy', 'nobody']), 'seedance-2.0@fal');
  assert.equal(view.error ?? null, null);
  assert.equal(view.refs.filter((r) => r.role === 'voice').length, 3);
});
