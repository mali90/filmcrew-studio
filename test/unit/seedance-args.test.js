// BYTE-COMPAT GATE. This file must keep passing UNMODIFIED through the seedance-args /
// render-seedance extraction: it is the proof that the fal Seedance 2.0 payload did not move a
// single byte. It imports ONLY fal-seedance.js — the two pipeline cases that used to live here
// moved to test/unit/pipeline-backends.test.js so a backend-id change can never force an edit
// to the gate. The caps-driven behaviour of the NEW pure builder lives in seedance-args-caps.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { buildSeedanceArgs } = await import('../../src/lib/fal-seedance.js');

const BASE = { prompt: 'p', imageUrls: ['u1'], aspectRatio: '9:16', resolution: '1080p', generateAudio: true, totalDuration: 13 };

test('buildSeedanceArgs: shape matches the fal endpoint schema, no 422 landmines', () => {
  const args = buildSeedanceArgs(BASE);
  assert.deepEqual(args, { prompt: 'p', image_urls: ['u1'], aspect_ratio: '9:16', resolution: '1080p', duration: '13', generate_audio: true });
  // seed and negative_prompt are HTTP 422 on this endpoint — they must be impossible to emit
  assert.ok(!('seed' in args) && !('negative_prompt' in args));
});

test('buildSeedanceArgs: image_urls is OMITTED for a text-to-video job (no reference image)', () => {
  const ttv = buildSeedanceArgs({ ...BASE, imageUrls: [] });
  assert.ok(!('image_urls' in ttv), 'text-to-video sends no image_urls key');
  assert.equal(ttv.prompt, 'p'); // still a full, valid text-driven request
  assert.ok('image_urls' in buildSeedanceArgs(BASE), 'reference-to-video still carries image_urls');
});

test('buildSeedanceArgs: duration is a STRING clamped into the 4–15s model range', () => {
  assert.equal(buildSeedanceArgs({ ...BASE, totalDuration: 3 }).duration, '4');
  assert.equal(buildSeedanceArgs({ ...BASE, totalDuration: 20 }).duration, '15');
  assert.equal(buildSeedanceArgs({ ...BASE, totalDuration: 12.4 }).duration, '12');
});

test('buildSeedanceArgs: audio_urls only when voice refs exist; generate_audio coerced to boolean', () => {
  assert.ok(!('audio_urls' in buildSeedanceArgs(BASE)));
  assert.deepEqual(buildSeedanceArgs({ ...BASE, audioUrls: ['a1', 'a2'] }).audio_urls, ['a1', 'a2']);
  assert.equal(buildSeedanceArgs({ ...BASE, generateAudio: undefined }).generate_audio, false);
});
