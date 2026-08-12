// SEEDANCE_PROMPT_MAX_BYTES — the lever, still working.
//
// The whole-prompt clamp is off by default (no provider documents a prompt-length limit for
// Seedance), but the knob is what a user reaches for when a provider starts answering 422 on a very
// long prompt. A default that is removed and a knob that quietly stopped clamping look identical
// from the outside and are opposite in a paid render, so the SET path gets its own spec.
//
// It needs its own FILE because config.js snapshots process.env at import: one process can only
// ever see one value of the knob. The unset/default half lives in seedance-prompt.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';

neutralizeDotenv();
const MAX = 1200;
process.env.SEEDANCE_PROMPT_MAX_BYTES = String(MAX); // BEFORE the import below — config.js snapshots
const { buildSeedanceJobPrompt } = await import('../../src/lib/seedance.js');
const { buildConfig } = await import('../../config.js');

const REFS = [{ name: 'keeper', refs: ['@Image1', '@Image2'] }];
const utf8 = (s) => Buffer.byteLength(s, 'utf8');

/** The golden spec's K1 with ~7 KB of scene prose per shot — far past any cap worth testing. */
function hugeSpec() {
  const spec = loadGoldenSpec();
  for (const shot of spec.shots) {
    shot.kling.content_prompt = `${shot.kling.content_prompt} ${'The rain keeps coming in off the water. '.repeat(175)}`.trim();
  }
  return spec;
}

test('a SET cap still clamps the PLAN path — the agents\' own text may be re-cut', () => {
  const spec = hugeSpec();
  const { prompt } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });
  assert.ok(utf8(prompt) <= MAX, `the composed prompt fits the knob (got ${utf8(prompt)} B)`);
  assert.ok(prompt.endsWith('…'), 'and still marks where it cut');
  assert.match(prompt, /@Image1\/@Image2/, 'the identity front matter survives the clamp');
});

test('a SET cap still REFUSES an over-budget override — never truncates a user\'s paid words', () => {
  const spec = hugeSpec();
  const job = spec.kling.jobs[0];
  const override = { prompt: 'A held shot of the lamp. '.repeat(800).trim() }; // ~20 KB
  assert.throws(
    () => buildSeedanceJobPrompt(job, spec, { refGroups: REFS, override }),
    /K1: the saved prompt edit no longer fits — it is \d+ byte\(s\) over/,
  );
});

test('an explicit maxBytes: 0 opt UNCAPS one call, and an absent one leaves the knob alone', () => {
  const spec = hugeSpec();
  const job = spec.kling.jobs[0];
  // `Number(opts.maxBytes) ? …` swallowed an explicit 0 back into the ambient cap. 0 is the uncapped
  // sentinel now, so it has to travel; undefined/null still mean "the caller did not supply one",
  // which is what the renderer itself passes — it hands over `caps` and lets the settings merge
  // resolve the knob, exactly as the web preview does.
  const uncapped = buildSeedanceJobPrompt(job, spec, { refGroups: REFS, maxBytes: 0 });
  assert.ok(utf8(uncapped.prompt) > 20000, 'maxBytes: 0 means no clamp, not "fall back to the knob"');
  // Only `endsWith`: the speech rule quotes a literal `says: "…"` in every audio-on prompt.
  assert.ok(!uncapped.prompt.endsWith('…'));

  for (const absent of [undefined, null]) {
    const capped = buildSeedanceJobPrompt(job, spec, { refGroups: REFS, maxBytes: absent });
    assert.ok(utf8(capped.prompt) <= MAX, `maxBytes: ${absent} is "not supplied", so the knob still applies`);
  }
});

test('the RENDER path resolves the cap through the model block, like the preview does', () => {
  const spec = hugeSpec();
  const job = spec.kling.jobs[0];
  // What render-seedance.js passes: `caps`, and no clause/budget knobs of its own. Seedance 2.5
  // redeclares no prompt knob, so the shared one still applies — the point is that it is REACHED by
  // the same seedancePromptSettings merge the preview runs, so a model block cannot be honoured by
  // one half and ignored by the other (which is preview ≠ wire, in bytes somebody paid for).
  const viaCaps = buildSeedanceJobPrompt(job, spec, { refGroups: REFS, caps: { knobsKey: 'seedance25' } });
  assert.ok(utf8(viaCaps.prompt) <= MAX, `the shared knob still applies through a model block (got ${utf8(viaCaps.prompt)} B)`);
  assert.equal(viaCaps.prompt, buildSeedanceJobPrompt(job, spec, { refGroups: REFS }).prompt, 'and byte for byte the same prompt');
});

test('a knob that does not parse is REFUSED, never read as "no cap"', () => {
  const spec = hugeSpec();
  // The 422 story: a user meets a provider limit, reaches for the documented lever, and mistypes it.
  // Silence would answer their next 422 the same way — with no clamp at all.
  assert.throws(
    () => buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, maxBytes: '5,000' }),
    /SEEDANCE_PROMPT_MAX_BYTES is not a number of bytes/,
  );
});

// ── config.js's own mapping of the knob ─────────────────────────────────────────────────────────
// buildConfig takes its environment as an ARGUMENT, so these are exact — no shell, no .env, no
// import-time snapshot. web/server/lib/prompt-service.js mirrors this by hand; the two are pinned
// against each other in web/server/test/unit/prompt-defaults.test.js.

test('config.js: unset/empty = uncapped (0); an explicit value is the cap', () => {
  assert.equal(buildConfig({}).seedance.promptMaxBytes, 0, 'the shipped default no longer shortens anybody\'s prompt');
  assert.equal(buildConfig({ SEEDANCE_PROMPT_MAX_BYTES: '' }).seedance.promptMaxBytes, 0, 'an empty knob is not a cap of 0 bytes');
  assert.equal(buildConfig({ SEEDANCE_PROMPT_MAX_BYTES: '0' }).seedance.promptMaxBytes, 0, 'an explicit 0 is how a user says "uncapped"');
  assert.equal(buildConfig({ SEEDANCE_PROMPT_MAX_BYTES: '1200' }).seedance.promptMaxBytes, 1200);
  // A value that does not parse stays unreadable here rather than falling back to a default:
  // config.js is imported at module scope by every entry point, the doctor included, so throwing
  // here would kill the one command whose job is to report a broken setup. promptCapOf refuses it
  // instead — on the render path and in the preview at once (see the test above).
  assert.ok(Number.isNaN(buildConfig({ SEEDANCE_PROMPT_MAX_BYTES: '5,000' }).seedance.promptMaxBytes));
  // Kling's per-segment budget is fal's own o3 schema limit, not a house rule — it does not move.
  assert.equal(buildConfig({}).kling.segmentMaxBytes, 500);
});
