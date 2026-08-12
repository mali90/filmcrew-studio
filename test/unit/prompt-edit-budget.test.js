// The editor's byte meter, measured against the render that will really spend the money.
//
// The prompt sheet promises "this is exactly what we send, word for word", and it keeps that
// promise by refusing an over-budget edit outright rather than clamping it — a user who cannot see
// what was cut cannot fix it. That refusal is only honest if the budget it quotes covers EVERY
// render the saved words can reach, because `applyOverride` re-composes the system front matter
// over them and clamps the result to the model's cap.
//
// A full render from the plan pins at most the chained OPENING frame. A re-render pins more: WS2-P5
// resolves `boundaries: 'auto'` over the recorded cut, so a nonterminal segment whose successor
// joins onto it also gets a CLOSING pin — one more sentence in the front matter, paid for out of
// the same cap. Metering the plan's pins alone accepted an edit that the paid re-render then
// truncated, silently, from the end.
//
// So this file drives both halves for real: the preview/save path (web/server/lib/prompt-service.js)
// and the renderer (src/lib/render-seedance.js, through a stub transport — no fal, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pinPromptEnv } from '../helpers/golden-spec.js';
import { mkTmp } from '../helpers/tmp.js';
import { ROOT, loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';

pinPromptEnv(); // config.js snapshots process.env at import time — pin before importing the renderer
const voices = mkTmp('prompt-budget-voices'); // empty ⇒ nothing is voiced ⇒ no ffmpeg, no @AudioN
Object.assign(process.env, {
  VOICES_DIR: voices.dir,
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  FAL_SEEDANCE_ENDPOINT: 'ref2vid', FAL_SEEDANCE_TEXT_ENDPOINT: 'txt2vid', FAL_SEEDANCE_PROBE_ENDPOINT: 'probe2vid',
});
const { capsFor } = await import('../../src/lib/render-models.js');
const { renderSeedanceJob } = await import('../../src/lib/render-seedance.js');
const { buildPromptViews, savePromptOverride } = await import('../../web/server/lib/prompt-service.js');

const BACKEND = 'seedance-2.0@fal'; // no native frame slots: both pins ride as reference + sentence
const assets = mkTmp('prompt-budget-assets');
const CAST_PNG = path.join(assets.dir, 'cast.png');
const SEAM_PNG = path.join(assets.dir, 'seam.png');
for (const p of [CAST_PNG, SEAM_PNG]) fs.writeFileSync(p, ONE_PX_PNG);
test.after(() => { voices.cleanup(); assets.cleanup(); });

/** The golden spec cut into `jobIds.length` jobs, one shot each, all carrying the same cast ref. */
function specWith(jobIds) {
  const spec = loadGoldenSpec();
  spec.kling.elements = [{ id: 'subject', role: 'subject', image: CAST_PNG }];
  spec.kling.jobs = jobIds.map((id, i) => ({ job_id: id, shots: [`S${i + 1}`], elements: ['subject'] }));
  return spec;
}

/** A transport that records its calls and writes a byte to disk (no fal, no network, no queue). */
function stubAdapter() {
  const calls = { generate: [] };
  return {
    calls,
    assetUrl: async (abs) => `stub://${path.basename(abs)}`,
    generate: async (args, ctx) => {
      calls.generate.push({ args, ctx });
      const out = path.join(ctx.destDir, 'out.mp4');
      fs.writeFileSync(out, 'MP4');
      return [out];
    },
  };
}

/** Save an edit that spends the editor's WHOLE offered budget, ending on a marker we can look for. */
async function fillTheMeter(runDir, spec, jobId) {
  const envRoot = mkTmp('prompt-budget-env'); // no .env ⇒ prompt-service's own defaults, config.js's
  try {
    const args = { root: ROOT, envRoot: envRoot.dir, childEnv: {}, runDir, spec, backend: BACKEND, voicesDir: voices.dir };
    const view = (await buildPromptViews(args)).prompts.find((p) => p.jobId === jobId);
    assert.equal(view.error ?? null, null, `${jobId} must preview`);
    const marker = ' the last words I typed.';
    const room = view.maxBytes - view.pinBytes;
    const body = 'x'.repeat(room - Buffer.byteLength(marker, 'utf8')) + marker;
    // The save endpoint is the same meter: if it refuses this, the editor was offering room the
    // server would not take, which is the same bug seen from the other side.
    await savePromptOverride({ ...args, jobId, prompt: body });
    return { marker, body, view };
  } finally { envRoot.cleanup(); }
}

/** Render one job the way `rerender-job` does, with the boundary frames it resolved. */
async function render(spec, jobId, boundaries) {
  const run = mkTmp('prompt-budget-run');
  const adapter = stubAdapter();
  const job = spec.kling.jobs.find((j) => j.job_id === jobId);
  return { run, adapter, job, render: () => renderSeedanceJob(
    { job, spec, runDir: run.dir, seed: 7, ...boundaries },
    { caps: capsFor(BACKEND), adapter },
  ) };
}

test('an edit that fills the meter survives the re-render that pins the CLOSING frame', async () => {
  // The reviewer's case: K1 is nonterminal and K2's join is on record, so `boundaries: 'auto'`
  // ends K1 on K2's opening frame — a pin the plan's own render never applies.
  const spec = specWith(['K1', 'K2']);
  const { run, adapter, render: go } = await render(spec, 'K1', { endFrame: SEAM_PNG });
  try {
    const { marker } = await fillTheMeter(run.dir, spec, 'K1');
    await go();
    const { prompt } = adapter.calls.generate[0].args;
    assert.match(prompt, /literal last frame/, 'the re-render really did add a closing pin');
    assert.ok(prompt.includes(marker), 'the tail of the saved edit reached the wire, unclamped');
    assert.ok(!prompt.endsWith('…'), 'nothing was truncated for the user behind their back');
  } finally { run.cleanup(); }
});

test('…and the re-render that pins BOTH ends of a middle segment', async () => {
  const spec = specWith(['K1', 'K2', 'K3']);
  const { run, adapter, render: go } = await render(spec, 'K2', { startFrame: SEAM_PNG, endFrame: SEAM_PNG });
  try {
    const { marker } = await fillTheMeter(run.dir, spec, 'K2');
    await go();
    const { prompt } = adapter.calls.generate[0].args;
    assert.match(prompt, /literal first frame/);
    assert.match(prompt, /literal last frame/);
    assert.ok(prompt.includes(marker), 'the tail of the saved edit reached the wire, unclamped');
  } finally { run.cleanup(); }
});

test('room is held back only for a pin some render could really apply', async () => {
  // A one-job plan has no neighbour at either end, so no re-render can pin anything: reserving for
  // a closing frame there would be a cap cut paid by every user for a render that cannot happen.
  const runDir = mkTmp('prompt-budget-plan');
  const envRoot = mkTmp('prompt-budget-plan-env');
  const pinsOf = async (spec) => {
    const views = (await buildPromptViews({
      root: ROOT, envRoot: envRoot.dir, childEnv: {}, runDir: runDir.dir, spec, backend: BACKEND, voicesDir: voices.dir,
    })).prompts;
    return views.find((p) => p.jobId === 'K1');
  };
  try {
    const solo = await pinsOf(specWith(['K1']));
    const chained = await pinsOf(specWith(['K1', 'K2']));
    assert.ok(solo.pinBytes > 0 && solo.pinBytes < solo.maxBytes, 'the meter still has a usable denominator');
    assert.ok(solo.pinBytes < chained.pinBytes, 'a segment nothing can join to holds back nothing for a join');
  } finally { runDir.cleanup(); envRoot.cleanup(); }
});
