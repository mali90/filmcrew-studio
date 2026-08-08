// src/lib/seedance-args.js — ONE pure argument builder for every Seedance model on every provider.
// Everything that differs between (model, provider) pairs is data on the caps object: the argument
// KEY NAMES (argMap), the duration type and window, which arguments are outright banned, whether a
// seed is accepted, and which resolutions/aspects exist. No branch in here may name a model or a
// provider.
//
// The byte-compat proof lives next door: test/unit/seedance-args.test.js must keep passing
// unmodified through this extraction. The first test below is the same proof stated from the new
// signature's side — feed it capsFor('seedance-2.0@fal') and today's fal payload comes back.
//
// TDD (red first): src/lib/seedance-args.js does not exist; buildSeedanceArgs currently takes one
// argument and reads config.seedance directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { buildSeedanceArgs } = await import('../../src/lib/seedance-args.js');
const { capsFor } = await import('../../src/lib/render-models.js');

const FAL20 = capsFor('seedance-2.0@fal');

const BASE = {
  prompt: 'p', imageUrls: ['u1'], audioUrls: [], videoUrls: [],
  aspectRatio: '9:16', resolution: '1080p', generateAudio: true, totalDuration: 13,
};

// A seedance-2.5-shaped caps object. 2.5 has no provider entry this phase, so it is written out
// here explicitly — which is exactly the point: the builder is driven by the DATA, and this proves
// it before the real registry entry lands.
const CAPS_25 = {
  id: 'seedance-2.5@x', model: 'seedance-2.5', provider: 'x', family: 'seedance',
  label: 'Seedance 2.5', providerLabel: 'X',
  minSeconds: 4, maxSeconds: 30, durationType: 'int',
  maxImages: 30, maxAudioRefs: 10,
  resolutions: ['480p', '720p'], defaultResolution: '480p',
  aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  nativeFirstFrame: true, nativeLastFrame: false, firstFrameExcludesRefs: true,
  supportsSeed: true, supportsReturnLastFrame: true,
  refStyle: 'spaced', shotSyntax: 'numbered',
  argMap: {
    images: 'reference_images', audios: 'reference_audios', videos: 'reference_videos',
    firstFrame: 'first_frame_url', lastFrame: null,
  },
};

// ── 1. The byte-compat proof, from the new signature ────────────────────────
test('fal Seedance 2.0 caps reproduce TODAY\'s payload, byte for byte', () => {
  assert.deepEqual(buildSeedanceArgs(BASE, FAL20), {
    prompt: 'p', image_urls: ['u1'], aspect_ratio: '9:16', resolution: '1080p', duration: '13', generate_audio: true,
  });
  const withAudio = buildSeedanceArgs({ ...BASE, audioUrls: ['a1', 'a2'] }, FAL20);
  assert.deepEqual(withAudio.audio_urls, ['a1', 'a2']);
  assert.equal(buildSeedanceArgs({ ...BASE, generateAudio: undefined }, FAL20).generate_audio, false);
});

// ── 2. Key names come from caps.argMap ──────────────────────────────────────
test('argMap decides every key name — the builder never hardcodes image_urls', () => {
  const args = buildSeedanceArgs({ ...BASE, imageUrls: ['i1'], audioUrls: ['a1'], videoUrls: ['v1'], resolution: '720p' }, CAPS_25);
  assert.deepEqual(args.reference_images, ['i1']);
  assert.deepEqual(args.reference_audios, ['a1']);
  assert.deepEqual(args.reference_videos, ['v1']);
  assert.ok(!('image_urls' in args) && !('audio_urls' in args) && !('video_urls' in args));
});

test('a null argMap slot means the model has no such input — it can never be emitted', () => {
  // fal 2.0: videos/firstFrame/lastFrame are all null in its argMap
  const args = buildSeedanceArgs({ ...BASE, videoUrls: [], audioUrls: [] }, FAL20);
  for (const k of ['video_urls', 'videos', 'first_frame_url', 'last_frame_url', 'end_image_url', 'start_image_url']) {
    assert.ok(!(k in args), `${k} must not be sent to fal Seedance 2.0`);
  }
  // …and ASKING for one is loud, not a silent drop: a caller that hands this model a video ref or
  // a closing frame has a bug, and swallowing it would ship a payload nobody intended.
  assert.throws(() => buildSeedanceArgs({ ...BASE, videoUrls: ['v1'] }, FAL20), /video/i);
  assert.throws(() => buildSeedanceArgs({ ...BASE, lastFrameUrl: 'lf' }, FAL20), /last-frame/i);
  // a non-null slot on another model emits it — same builder, different data
  assert.deepEqual(buildSeedanceArgs({ ...BASE, videoUrls: ['v1'], resolution: '720p' }, CAPS_25).reference_videos, ['v1']);
});

test('empty ref arrays are OMITTED, never sent as []', () => {
  const ttv = buildSeedanceArgs({ ...BASE, imageUrls: [], audioUrls: [], videoUrls: [] }, FAL20);
  assert.ok(!('image_urls' in ttv), 'a text-to-video job sends no image_urls key');
  assert.ok(!('audio_urls' in ttv));
  assert.equal(ttv.prompt, 'p');
  const empty25 = buildSeedanceArgs({ ...BASE, imageUrls: [], resolution: '720p' }, CAPS_25);
  assert.ok(!('reference_images' in empty25));
});

// ── 3. Duration: clamp, then type ───────────────────────────────────────────
test('duration is clamped into the model\'s window, then cast per caps.durationType', () => {
  // fal 2.0 — 4..15, STRING
  assert.equal(buildSeedanceArgs({ ...BASE, totalDuration: 3 }, FAL20).duration, '4');
  assert.equal(buildSeedanceArgs({ ...BASE, totalDuration: 20 }, FAL20).duration, '15');
  assert.equal(buildSeedanceArgs({ ...BASE, totalDuration: 12.4 }, FAL20).duration, '12');
  assert.equal(typeof buildSeedanceArgs(BASE, FAL20).duration, 'string');

  // 2.5-shaped — 4..30, INT
  const d = (n) => buildSeedanceArgs({ ...BASE, totalDuration: n, resolution: '720p' }, CAPS_25).duration;
  assert.equal(d(2), 4);
  assert.equal(d(40), 30);
  assert.equal(d(27.4), 27);
  assert.equal(typeof d(10), 'number', 'durationType "int" emits a Number, not a String');
});

// ── 4. Seed + bannedArgs ────────────────────────────────────────────────────
test('seed is emitted ONLY when caps.supportsSeed', () => {
  assert.ok(!('seed' in buildSeedanceArgs({ ...BASE, seed: 70000 }, FAL20)), 'fal 2.0 HTTP 422s on seed');
  assert.equal(buildSeedanceArgs({ ...BASE, seed: 70000, resolution: '720p' }, CAPS_25).seed, 70000);
  // no seed in the intent ⇒ no key, even where it is supported
  assert.ok(!('seed' in buildSeedanceArgs({ ...BASE, resolution: '720p' }, CAPS_25)));
});

test('bannedArgs are deleted LAST — a banned key can never survive another rule that set it', () => {
  // deliberately contradictory caps: seed is "supported" AND banned. The ban must win.
  const contradictory = { ...CAPS_25, bannedArgs: ['seed', 'return_last_frame', 'negative_prompt'] };
  const args = buildSeedanceArgs({ ...BASE, seed: 1, returnLastFrame: true, resolution: '720p' }, contradictory);
  assert.ok(!('seed' in args));
  assert.ok(!('return_last_frame' in args));
  assert.ok(!('negative_prompt' in args));
  // and fal 2.0's own ban list still holds
  const fal = buildSeedanceArgs({ ...BASE, seed: 1 }, FAL20);
  assert.ok(!('seed' in fal) && !('negative_prompt' in fal));
});

test('return_last_frame rides caps.supportsReturnLastFrame', () => {
  assert.equal(buildSeedanceArgs({ ...BASE, returnLastFrame: true, resolution: '720p' }, CAPS_25).return_last_frame, true);
  assert.ok(!('return_last_frame' in buildSeedanceArgs({ ...BASE, returnLastFrame: true }, FAL20)));
});

// ── 5. First-frame handling ─────────────────────────────────────────────────
test('firstFrameExcludesRefs: with refs present the first frame is DEMOTED to a trailing image ref', () => {
  const args = buildSeedanceArgs({ ...BASE, imageUrls: ['i1', 'i2'], firstFrameUrl: 'seam.png', resolution: '720p' }, CAPS_25);
  assert.deepEqual(args.reference_images, ['i1', 'i2', 'seam.png'], 'the seam frame lands LAST, after the cast refs');
  assert.ok(!('first_frame_url' in args), 'the two inputs are mutually exclusive on this model');
});

test('firstFrameExcludesRefs: with NO refs the native first-frame slot is used instead', () => {
  const args = buildSeedanceArgs({ ...BASE, imageUrls: [], firstFrameUrl: 'seam.png', resolution: '720p' }, CAPS_25);
  assert.equal(args.first_frame_url, 'seam.png');
  assert.ok(!('reference_images' in args));
});

test('a model with no native first frame at all always demotes (today\'s fal 2.0 seam behaviour)', () => {
  const args = buildSeedanceArgs({ ...BASE, imageUrls: ['i1'], firstFrameUrl: 'seam.png' }, FAL20);
  assert.deepEqual(args.image_urls, ['i1', 'seam.png']);
  assert.ok(!('first_frame_url' in args));
  // even with zero refs — fal 2.0's reference endpoint has no frame anchor
  const solo = buildSeedanceArgs({ ...BASE, imageUrls: [], firstFrameUrl: 'seam.png' }, FAL20);
  assert.deepEqual(solo.image_urls, ['seam.png']);
  assert.ok(!('first_frame_url' in solo));
});

// ── 6. Loud validation ──────────────────────────────────────────────────────
test('an aspect outside caps.aspects throws, naming the model\'s valid ratios', () => {
  assert.throws(() => buildSeedanceArgs({ ...BASE, aspectRatio: '21:9' }, FAL20), (e) => {
    assert.match(e.message, /21:9/);
    for (const a of FAL20.aspects) assert.ok(e.message.includes(a), a);
    return true;
  });
  assert.equal(buildSeedanceArgs({ ...BASE, aspectRatio: '21:9', resolution: '720p' }, CAPS_25).aspect_ratio, '21:9');
  assert.throws(() => buildSeedanceArgs({ ...BASE, aspectRatio: '5:4', resolution: '720p' }, CAPS_25), /5:4/);
});

test('a resolution outside caps.resolutions throws, naming the model\'s valid resolutions', () => {
  assert.throws(() => buildSeedanceArgs({ ...BASE, resolution: '9000p' }, FAL20), (e) => {
    assert.match(e.message, /9000p/);
    for (const r of FAL20.resolutions) assert.ok(e.message.includes(r), r);
    return true;
  });
  assert.throws(() => buildSeedanceArgs({ ...BASE, resolution: '1080p' }, CAPS_25), /1080p/, 'Segmind 2.5 tops out at 720p');
  for (const r of FAL20.resolutions) assert.equal(buildSeedanceArgs({ ...BASE, resolution: r }, FAL20).resolution, r);
});

test('more image refs than the model accepts is a loud throw, not a silent 422 round trip', () => {
  const tooMany = Array.from({ length: FAL20.maxImages + 1 }, (_, i) => `u${i}`);
  assert.throws(() => buildSeedanceArgs({ ...BASE, imageUrls: tooMany }, FAL20), /9/);
  // the demoted first frame counts toward the same budget
  const atCap = Array.from({ length: FAL20.maxImages }, (_, i) => `u${i}`);
  assert.throws(() => buildSeedanceArgs({ ...BASE, imageUrls: atCap, firstFrameUrl: 'seam.png' }, FAL20), /9/);
  assert.equal(buildSeedanceArgs({ ...BASE, imageUrls: atCap }, FAL20).image_urls.length, 9);
});

test('the builder is pure — it mutates neither the intent nor the caps', () => {
  const intent = { ...BASE, imageUrls: ['i1'], firstFrameUrl: 'seam.png' };
  const capsSnapshot = JSON.stringify(FAL20);
  buildSeedanceArgs(intent, FAL20);
  assert.deepEqual(intent.imageUrls, ['i1'], 'the caller\'s array is never appended to in place');
  assert.equal(JSON.stringify(FAL20), capsSnapshot);
});
