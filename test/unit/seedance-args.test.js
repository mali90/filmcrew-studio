import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { buildSeedanceArgs } = await import('../../src/lib/fal-seedance.js');
const { resolveBackend, RENDERERS } = await import('../../src/lib/pipeline.js');

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

test('resolveBackend precedence: explicit flag > spec.render_backend > config default', () => {
  assert.equal(resolveBackend({}, 'seedance'), 'seedance');
  assert.equal(resolveBackend({ render_backend: 'kling' }, 'seedance'), 'seedance');
  assert.equal(resolveBackend({ render_backend: 'seedance' }), 'seedance');
  assert.equal(resolveBackend({}), 'kling'); // config default (env neutralized)
  assert.throws(() => resolveBackend({}, 'nope'), /Unknown render backend "nope"/);
});

test('RENDERERS table carries both backends with render fns and labels', () => {
  assert.deepEqual(Object.keys(RENDERERS).sort(), ['kling', 'seedance']);
  for (const r of Object.values(RENDERERS)) {
    assert.equal(typeof r.render, 'function');
    assert.equal(typeof r.label, 'string');
  }
});
