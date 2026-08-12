// voiceRefsRide — WHEN a job's registered voice clips actually ride as @AudioN refs.
//
// The rule has always had two halves: the user's intent (audio on, a voiceMode that keeps the clip)
// and the endpoint's own requirement that audio refs travel alongside something the model is
// conditioned on. The second half only ever counted CAST references and an OPENING frame — so a
// cast-less segment pinned at its END (the shape a frame-conditioned re-render of the last segment
// produces) sent its ending image and then dropped every registered voice, and the dialogue came
// back in model-native voices with nothing on screen saying why.
//
// Both ends are images to the model — a native last-frame anchor where one exists, a trailing image
// reference where it does not — so both make the job reference-to-video. The gate lives in
// seedance-args.js beside the budget checks, because the renderer and the prompt preview
// (web/server/lib/prompt-service.js, asserted in web/server/test/unit/prompt-ref-budgets.test.js)
// have to answer it identically or the preview stops being what the wire carries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';

neutralizeDotenv();
// A bundled clip on disk IS a registered voice (voices.js stages one for any clip it finds), so the
// speaker below costs an @Audio ref without a minted voices.json.
const voices = mkTmp('voice-gate-voices');
fs.writeFileSync(path.join(voices.dir, 'keeper.mp3'), 'ID3'); // unprobeable on purpose: kept as-is
Object.assign(process.env, {
  VOICES_DIR: voices.dir,
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  FAL_SEEDANCE_ENDPOINT: 'ref2vid', FAL_SEEDANCE_TEXT_ENDPOINT: 'txt2vid', FAL_SEEDANCE_PROBE_ENDPOINT: 'probe2vid',
});
const { voiceRefsRide } = await import('../../src/lib/seedance-args.js');
const { capsFor } = await import('../../src/lib/render-models.js');
const { renderSeedanceJob } = await import('../../src/lib/render-seedance.js');

const assets = mkTmp('voice-gate-assets');
const CAST_PNG = path.join(assets.dir, 'cast.png');
const END_PNG = path.join(assets.dir, 'end.png');
for (const p of [CAST_PNG, END_PNG]) fs.writeFileSync(p, ONE_PX_PNG);

test.after(() => { voices.cleanup(); assets.cleanup(); });

// ── the rule itself ─────────────────────────────────────────────────────────────────────────────

test('an ENDING frame makes a cast-less job reference-to-video, so its voices ride', () => {
  const on = { audioOn: true, voiceMode: 'reference' };
  assert.equal(voiceRefsRide({ castRefCount: 0, hasSeamOut: true, ...on }), true);
  assert.equal(voiceRefsRide({ castRefCount: 0, hasSeamIn: true, ...on }), true);
  assert.equal(voiceRefsRide({ castRefCount: 2, ...on }), true);
  assert.equal(voiceRefsRide({ castRefCount: 0, hasSeamIn: true, hasSeamOut: true, ...on }), true);
});

test('with nothing to condition on it is a text-to-video job — the model voices the line itself', () => {
  assert.equal(voiceRefsRide({ castRefCount: 0, audioOn: true, voiceMode: 'reference' }), false);
});

test('the two deliberate ways to ask for native voices still win over any frame', () => {
  assert.equal(voiceRefsRide({ castRefCount: 2, hasSeamOut: true, audioOn: false, voiceMode: 'reference' }), false);
  assert.equal(voiceRefsRide({ castRefCount: 2, hasSeamOut: true, audioOn: true, voiceMode: 'native' }), false);
  assert.equal(voiceRefsRide(), false, 'and no opinion at all attaches nothing');
});

// ── and what the renderer really sends ──────────────────────────────────────────────────────────

/** A transport that records its calls and writes a byte to disk (no fal, no network, no queue). */
function stubAdapter() {
  const calls = { assetUrl: [], generate: [] };
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

/** The golden spec with one voiced speaker and `elements` under the caller's control. */
function specWith(elements) {
  const spec = loadGoldenSpec();
  spec.kling.elements = elements;
  spec.kling.jobs = [{ job_id: 'K1', shots: ['S1', 'S2', 'S3'], elements: elements.map((e) => e.id) }];
  spec.audio.voice.lines = [{ shot_id: 'S1', speaker: 'keeper', text: 'Forty years I kept this light.' }];
  return spec;
}

const render = async (spec, caps, params) => {
  const { dir, cleanup } = mkTmp('voice-gate-run');
  const adapter = stubAdapter();
  try {
    await renderSeedanceJob({ job: spec.kling.jobs[0], spec, runDir: dir, seed: 7, ...params }, { caps, adapter });
    return { args: adapter.calls.generate[0].args, sidecar: JSON.parse(fs.readFileSync(path.join(dir, 'K1', 'prompts.json'), 'utf8')) };
  } finally { cleanup(); }
};

test('fal Seedance: a cast-less segment pinned only at its END still ships its voice clip', async () => {
  const caps = capsFor('seedance-2.0@fal'); // no native closing slot — the end frame rides as an image ref
  const { args, sidecar } = await render(specWith([]), caps, { endFrame: END_PNG });
  assert.deepEqual(args.image_urls, ['stub://end.png'], 'the ending image is what makes this reference-to-video');
  assert.deepEqual(args.audio_urls, ['stub://keeper.mp3'], 'and the registered voice rides with it');
  assert.deepEqual(sidecar.audio_refs.map((r) => r.speaker), ['keeper']);
  assert.match(args.prompt, /@Audio1/, 'the prompt cites the clip it is sending');
});

test('a NATIVE closing anchor counts too, even with no image reference at all', async () => {
  // The sharp case: the ending image travels in the model's own last-frame slot, so `image_urls`
  // stays empty. A gate that counted image refs rather than conditioning would drop the voice here.
  const caps = { ...capsFor('seedance-2.0@fal'), nativeLastFrame: true, argMap: { ...capsFor('seedance-2.0@fal').argMap, lastFrame: 'last_frame_url' } };
  const { args } = await render(specWith([]), caps, { endFrame: END_PNG });
  assert.equal(args.last_frame_url, 'stub://end.png');
  assert.equal(args.image_urls, undefined, 'nothing rides as an image reference');
  assert.deepEqual(args.audio_urls, ['stub://keeper.mp3']);
});

test('a job with neither cast nor boundary frames sends no clip — the model voices it', async () => {
  const caps = capsFor('seedance-2.0@fal');
  const { args, sidecar } = await render(specWith([]), caps, {});
  assert.equal(args.audio_urls, undefined, 'text-to-video attaches no audio reference');
  assert.deepEqual(sidecar.audio_refs, []);
});

test('the cast path is untouched — a segment with elements still ships its voices', async () => {
  const caps = capsFor('seedance-2.0@fal');
  const { args } = await render(specWith([{ id: 'subject', role: 'subject', image: CAST_PNG }]), caps, {});
  assert.deepEqual(args.image_urls, ['stub://cast.png']);
  assert.deepEqual(args.audio_urls, ['stub://keeper.mp3']);
});
