// The point of the render-seedance extraction, asserted directly: renderSeedanceJob is driven by
// (caps, adapter) and contains no model or provider branch. Everything else in the suite reaches it
// through the fal binding, so the generalization itself — different key names, a different duration
// type, a native first-frame slot, a different ref citation style, a seed that is actually sent, a
// transport that is not fal — rests on the fal path alone. This file drives it with a STUB adapter
// and a caps bundle shaped like the model that lands next phase.
//
// It is a unit test on purpose: the stub adapter is the only transport, so nothing here touches a
// network, a queue or fal.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';

neutralizeDotenv();
const voices = mkTmp('rs-adapter-voices'); // empty ⇒ getVoiceRefClip() is null ⇒ no ffmpeg needed
Object.assign(process.env, {
  VOICES_DIR: voices.dir,
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  FAL_SEEDANCE_ENDPOINT: 'ref2vid', FAL_SEEDANCE_TEXT_ENDPOINT: 'txt2vid', FAL_SEEDANCE_PROBE_ENDPOINT: 'probe2vid',
});
const { renderSeedanceJob } = await import('../../src/lib/render-seedance.js');

const assets = mkTmp('rs-adapter-assets');
const PNG_A = path.join(assets.dir, 'a.png');
const PNG_B = path.join(assets.dir, 'b.png');
const SEAM = path.join(assets.dir, 'seam.png');
for (const p of [PNG_A, PNG_B, SEAM]) fs.writeFileSync(p, ONE_PX_PNG);

test.after(() => { voices.cleanup(); assets.cleanup(); });

// A caps bundle for the model that has no provider entry yet. Every field differs from fal
// Seedance 2.0's, so a renderer that still hardcoded 2.0's behaviour cannot pass.
const CAPS_25 = {
  id: 'seedance-2.5@fal', model: 'seedance-2.5', provider: 'fal', family: 'seedance',
  label: 'Seedance 2.5', providerLabel: 'fal',
  endpointKey: 'seedanceEndpoint', probeEndpointKey: 'seedanceProbeEndpoint', textEndpointKey: 'seedanceTextEndpoint',
  maxImages: 30, maxAudioRefs: 10, audioBudgetS: 20,
  minSeconds: 4, maxSeconds: 30, durationType: 'int',
  resolutions: ['480p', '720p'], defaultResolution: '480p',
  aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  nativeFirstFrame: true, nativeLastFrame: false, firstFrameExcludesRefs: true,
  supportsSeed: true,
  refStyle: 'spaced', shotSyntax: 'numbered',
  argMap: {
    images: 'reference_images', audios: 'reference_audios', videos: 'reference_videos',
    firstFrame: 'first_frame_url', lastFrame: null,
  },
};

/** A transport that is emphatically not fal: it records its calls and writes a byte to disk. */
function stubAdapter() {
  const calls = { assetUrl: [], generate: [] };
  return {
    calls,
    assetUrl: async (abs, mode, opts) => { calls.assetUrl.push({ abs, mode, opts }); return `stub://${path.basename(abs)}`; },
    generate: async (args, ctx) => {
      calls.generate.push({ args, ctx });
      const out = path.join(ctx.destDir, 'out.mp4');
      fs.writeFileSync(out, 'MP4');
      return [out];
    },
  };
}

/** The golden spec with its element images repointed at throwaway PNGs. */
function specWith({ elements = [{ id: 'subject', role: 'subject', image: PNG_A }] } = {}) {
  const spec = loadGoldenSpec();
  spec.kling.elements = elements;
  spec.kling.jobs = [{ job_id: 'K1', shots: ['S1', 'S2', 'S3'], elements: elements.map((e) => e.id) }];
  return spec;
}

const run = async ({ spec = specWith(), ...params } = {}, caps = CAPS_25) => {
  const { dir, cleanup } = mkTmp('rs-adapter-run');
  const adapter = stubAdapter();
  try {
    const res = await renderSeedanceJob(
      { job: spec.kling.jobs[0], spec, runDir: dir, seed: 4242, ...params },
      { caps, adapter },
    );
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'K1', 'prompts.json'), 'utf8'));
    return { res, adapter, sidecar, dir, cleanup };
  } catch (e) {
    cleanup();
    throw Object.assign(e, { adapter });
  }
};

test('the adapter is the ONLY transport: assetUrl feeds the args, generate produces the clip', async () => {
  const { res, adapter, cleanup } = await run();
  try {
    // one upload per element image — through the stub, so no fal client was involved
    assert.deepEqual(adapter.calls.assetUrl.map((c) => c.abs), [PNG_A]);
    assert.equal(adapter.calls.assetUrl[0].mode, 'data-uri', 'the configured upload mode is passed through');
    assert.equal(adapter.calls.generate.length, 1, 'exactly one generate call per job');

    const { args, ctx } = adapter.calls.generate[0];
    assert.deepEqual(args.reference_images, ['stub://a.png'], 'the urls the ADAPTER returned are what ship');
    assert.equal(ctx.endpoint, 'ref2vid', 'endpointKey resolved against the provider config block');
    assert.equal(ctx.destDir, path.dirname(res.clip));
    assert.ok(Number.isFinite(ctx.timeoutMs));

    assert.equal(res.jobId, 'K1');
    assert.equal(res.segments, 3);
    assert.ok(fs.existsSync(res.clip) && res.clip.endsWith('.mp4'));
  } finally { cleanup(); }
});

test('every payload key comes from caps.argMap — no fal Seedance 2.0 key name survives', async () => {
  const { adapter, cleanup } = await run();
  try {
    const { args } = adapter.calls.generate[0];
    assert.ok('reference_images' in args);
    for (const k of ['image_urls', 'audio_urls', 'video_urls', 'start_image_url']) {
      assert.ok(!(k in args), `${k} is a fal-2.0 key name and must not appear`);
    }
  } finally { cleanup(); }
});

test('caps.durationType and caps.supportsSeed change the wire payload, with no code change', async () => {
  const { adapter, sidecar, cleanup } = await run();
  try {
    const { args } = adapter.calls.generate[0];
    assert.equal(typeof args.duration, 'number', 'durationType "int" ships a Number where fal 2.0 ships a String');
    assert.equal(args.seed, 4242, 'a model that accepts a seed actually receives it');
    assert.equal(sidecar.seed_unused, null, 'so nothing is recorded as "unused"');
    assert.equal(sidecar.backend, 'seedance-2.5@fal', 'the sidecar names the MODEL that rendered it');
    assert.equal(sidecar.endpoint, 'ref2vid');
  } finally { cleanup(); }
});

test('caps.refStyle drives the prompt citations (@Image 1, not @Image1)', async () => {
  const { adapter, sidecar, cleanup } = await run();
  try {
    assert.match(adapter.calls.generate[0].args.prompt, /@Image 1\b/);
    assert.ok(!/@Image1\b/.test(adapter.calls.generate[0].args.prompt), 'the compact style belongs to 2.0');
    assert.deepEqual(sidecar.image_refs.map((r) => r.ref), ['@Image 1']);
  } finally { cleanup(); }
});

test('a native first-frame slot is used when no refs compete for it', async () => {
  const spec = specWith({ elements: [] });
  const { adapter, cleanup } = await run({ spec, startFrame: SEAM });
  try {
    const { args } = adapter.calls.generate[0];
    assert.equal(args.first_frame_url, 'stub://seam.png', 'the seam rides the native slot');
    assert.ok(!('reference_images' in args), 'and is NOT demoted to a ref');
  } finally { cleanup(); }
});

test('firstFrameExcludesRefs demotes the seam to the LAST ref once refs exist', async () => {
  const spec = specWith({ elements: [{ id: 'subject', role: 'subject', image: PNG_A }, { id: 'prop', role: 'prop', image: PNG_B }] });
  const { adapter, sidecar, cleanup } = await run({ spec, startFrame: SEAM });
  try {
    const { args } = adapter.calls.generate[0];
    assert.deepEqual(args.reference_images, ['stub://a.png', 'stub://b.png', 'stub://seam.png']);
    assert.ok(!('first_frame_url' in args), 'the two inputs are mutually exclusive on this model');
    assert.equal(sidecar.image_refs.at(-1).ref, '@Image 3', 'the prompt pin points at the demoted frame');
    assert.equal(sidecar.image_refs.at(-1).id, 'seam');
    // the seam frame is fetched fresh — its basename repeats across runs, so it must skip the cache
    assert.equal(adapter.calls.assetUrl.at(-1).opts?.cache, false);
  } finally { cleanup(); }
});

test('a job with no refs routes to caps.textEndpointKey; --probe routes to probeEndpointKey', async () => {
  const ttv = await run({ spec: specWith({ elements: [] }) });
  try { assert.equal(ttv.adapter.calls.generate[0].ctx.endpoint, 'txt2vid'); } finally { ttv.cleanup(); }

  const probe = await run({ lowRes: true });
  try { assert.equal(probe.adapter.calls.generate[0].ctx.endpoint, 'probe2vid'); } finally { probe.cleanup(); }
});

test('a provider with no config block fails loudly, and NOTHING is generated', async () => {
  const orphan = { ...CAPS_25, id: 'seedance-2.5@segmind', provider: 'segmind', providerLabel: 'Segmind' };
  await assert.rejects(() => run({}, orphan), (e) => {
    assert.match(e.message, /seedance-2\.5@segmind/);
    assert.match(e.message, /seedanceEndpoint/, 'the message names the missing config KEY');
    assert.match(e.message, /segmind/);
    assert.equal(e.adapter.calls.generate.length, 0, 'no paid generation was attempted');
    return true;
  });
});

/** Mint `names` into the tmp voice registry with (empty) ref clips on disk. */
function mintVoices(names) {
  const map = {};
  for (const n of names) {
    const clip = path.join(assets.dir, `${n}.mp3`);
    fs.writeFileSync(clip, 'ID3');
    map[n] = { name: n, voice_id: `v-${n}`, ref_clip: clip, minted_at: null };
  }
  fs.writeFileSync(path.join(voices.dir, 'voices.json'), JSON.stringify(map, null, 2));
  return () => fs.rmSync(path.join(voices.dir, 'voices.json'), { force: true });
}

/** A spec whose job carries one VO line per named speaker. */
function specWithSpeakers(names) {
  const spec = specWith();
  spec.audio.voice.lines = names.map((n, i) => ({ shot_id: ['S1', 'S2', 'S3'][i % 3], speaker: n, text: `line ${i}` }));
  return spec;
}

test('the voice-ref cap is caps.maxAudioRefs, and the error names THIS model', async () => {
  const unmint = mintVoices(['ana', 'bo', 'cy']);
  try {
    // three minted speakers against a model that takes two — the throw must quote the model's own
    // number, not fal Seedance 2.0's 3, and must happen before anything is generated.
    await assert.rejects(() => run({ spec: specWithSpeakers(['ana', 'bo', 'cy']) }, { ...CAPS_25, maxAudioRefs: 2 }), (e) => {
      assert.match(e.message, /3 voiced speakers exceeds Seedance 2\.5 on fal's 2-audio-ref cap/);
      assert.equal(e.adapter.calls.generate.length, 0, 'no paid generation was attempted');
      return true;
    });

    // …and at the cap the clips ship under the model's OWN key name
    const { adapter, sidecar, cleanup } = await run({ spec: specWithSpeakers(['ana', 'bo']) });
    try {
      assert.deepEqual(adapter.calls.generate[0].args.reference_audios, ['stub://ana.mp3', 'stub://bo.mp3']);
      assert.ok(!('audio_urls' in adapter.calls.generate[0].args), 'the fal-2.0 key name must not appear');
      assert.deepEqual(sidecar.audio_refs.map((r) => r.ref), ['@Audio 1', '@Audio 2'], 'caps.refStyle applies to audio too');
    } finally { cleanup(); }
  } finally { unmint(); }
});

test('the combined-ref budget rejects BEFORE any upload — per-kind caps admit what the shared budget refuses', async () => {
  // 3 image refs, each within maxImages (30) — but a 2-ref combined budget must abort the job
  // while every reference is still on disk, not after a full round of storage uploads.
  const spec = specWith({ elements: [
    { id: 'a', role: 'subject', image: PNG_A },
    { id: 'b', role: 'subject', image: PNG_B },
    { id: 'c', role: 'subject', image: SEAM },
  ] });
  await assert.rejects(
    run({ spec }, { ...CAPS_25, maxCombinedRefs: 2 }),
    (e) => {
      assert.match(e.message, /at most 2 references in total/);
      assert.equal(e.adapter.calls.assetUrl.length, 0, 'no reference left the machine');
      return true;
    },
  );
});
