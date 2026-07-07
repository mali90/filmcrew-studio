import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
neutralizeDotenv();
const { validateSpec, SEEDANCE_CAPS, KLING_CAPS, RENDER_BACKENDS } = await import('../../src/lib/spec-schema.js');

test('golden spec is valid for both backends', () => {
  assert.equal(validateSpec(loadGoldenSpec(), { backend: 'kling' }).ok, true);
  assert.equal(validateSpec(loadGoldenSpec(), { backend: 'seedance' }).ok, true);
});

test('a 3s job passes kling but fails Seedance\'s 4s/job floor', () => {
  const spec = loadGoldenSpec();
  spec.shots = [spec.shots[0]];
  spec.shots[0].duration_s = 3;
  spec.audio.voice.lines = spec.audio.voice.lines.filter((l) => l.shot_id === 'S1');
  spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['subject'] }];
  assert.equal(validateSpec(spec, { backend: 'kling' }).ok, true);
  const v = validateSpec(spec, { backend: 'seedance' });
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /under Seedance's 4s\/job minimum/);
});

test('optional spec.render_backend: valid values pass, unknown fails', () => {
  const spec = loadGoldenSpec();
  spec.render_backend = 'seedance';
  assert.equal(validateSpec(spec).ok, true);
  spec.render_backend = 'runway';
  const v = validateSpec(spec);
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /render_backend "runway" is not one of: kling, seedance/);
});

test('caps exports: backends list + Seedance caps alongside the untouched Kling caps', () => {
  assert.deepEqual(RENDER_BACKENDS, ['kling', 'seedance']);
  assert.deepEqual(SEEDANCE_CAPS, { MIN_JOB_SECONDS: 4, MAX_JOB_SECONDS: 15, MAX_IMAGE_REFS: 9, MAX_AUDIO_REFS: 3 });
  assert.deepEqual(KLING_CAPS, { MAX_STORYBOARDS: 6, MAX_JOB_SECONDS: 15, MAX_SEG_CHARS: 512, MAX_REF_IMAGES: 7 });
});
