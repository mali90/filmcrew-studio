import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, BLOCK_OWNER, KLING_CAPS } from '../../src/lib/spec-schema.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';

const errStr = (r) => r.errors.join('\n');

test('golden spec passes validation at every stage 0..7', () => {
  const spec = loadGoldenSpec();
  for (let u = 0; u <= 7; u++) {
    const r = validateSpec(spec, { upTo: u });
    assert.equal(r.ok, true, `upTo ${u} should pass but got: ${errStr(r)}`);
  }
});

test('exports: KLING_CAPS and BLOCK_OWNER', () => {
  assert.deepEqual(KLING_CAPS, { MAX_STORYBOARDS: 6, MAX_JOB_SECONDS: 15, MAX_SEG_CHARS: 512, MAX_REF_IMAGES: 7 });
  assert.equal(BLOCK_OWNER.jobs, 6);
  assert.equal(BLOCK_OWNER.qc, 7);
});

test('non-object / wrong spec_version', () => {
  assert.equal(validateSpec(null).ok, false);
  const s = loadGoldenSpec(); s.spec_version = '0.9';
  const r = validateSpec(s, { upTo: 0 });
  assert.equal(r.ok, false);
  assert.match(errStr(r), /spec_version/);
});

test('project: duration and aspect_ratio bounds', () => {
  let s = loadGoldenSpec(); s.project.duration_target_s = 999;
  assert.match(errStr(validateSpec(s, { upTo: 0 })), /duration_target_s/);
  s = loadGoldenSpec(); s.project.aspect_ratio = '4:3';
  assert.match(errStr(validateSpec(s, { upTo: 0 })), /aspect_ratio/);
});

test('camera enum: bad shot_size fails at upTo>=3', () => {
  const s = loadGoldenSpec(); s.shots[0].kling.shot_size = 'tele';
  assert.equal(validateSpec(s, { upTo: 2 }).ok, true); // not checked yet
  assert.match(errStr(validateSpec(s, { upTo: 3 })), /shot_size/);
});

test('content_prompt over 512 chars fails', () => {
  const s = loadGoldenSpec(); s.shots[0].kling.content_prompt = 'x'.repeat(513);
  assert.match(errStr(validateSpec(s, { upTo: 7 })), /exceeds 512/);
});

test('job storyboard cap: >6 shots per job', () => {
  const s = loadGoldenSpec();
  s.kling.jobs[0].shots = ['S1', 'S1', 'S1', 'S1', 'S1', 'S1', 'S1']; // 7 valid ids
  assert.match(errStr(validateSpec(s, { upTo: 7 })), /storyboard cap/);
});

test('job duration cap: total >15s per job', () => {
  const s = loadGoldenSpec();
  for (const sh of s.shots) { sh.duration_s = 6; delete sh.kling.duration; } // 3 * 6 = 18s
  assert.match(errStr(validateSpec(s, { upTo: 7 })), /15s\/job cap/);
});

test('job cross-refs: unknown shot id and unknown element id', () => {
  let s = loadGoldenSpec(); s.kling.jobs[0].shots = ['S1', 'NOPE'];
  assert.match(errStr(validateSpec(s, { upTo: 7 })), /not a shot_id/);
  s = loadGoldenSpec(); s.kling.jobs[0].elements = ['ghost'];
  assert.match(errStr(validateSpec(s, { upTo: 7 })), /not in kling\.elements/);
});

test('text-to-video: empty kling.elements (and unscoped jobs) passes; ghost element still fails', () => {
  // Casting attached no reference (image-less idea) → empty roster, jobs carry no element ids.
  const ttv = loadGoldenSpec();
  ttv.kling.elements = [];
  ttv.kling.jobs.forEach((j) => { j.elements = []; });
  for (let u = 0; u <= 7; u++) {
    assert.equal(validateSpec(ttv, { upTo: u }).ok, true, `empty-elements spec should pass upTo ${u}: ${errStr(validateSpec(ttv, { upTo: u }))}`);
  }
  // A job may not reference an element id that doesn't exist, even when the roster is empty.
  const bad = loadGoldenSpec(); bad.kling.elements = []; bad.kling.jobs[0].elements = ['subject'];
  assert.match(errStr(validateSpec(bad, { upTo: 7 })), /not in kling\.elements/);
});

test('last_frame requires first_frame', () => {
  const s = loadGoldenSpec(); s.kling.jobs[0].last_frame = 'elements/last-frame/x.png';
  assert.match(errStr(validateSpec(s, { upTo: 7 })), /last_frame requires first_frame/);
});

test('bad kling.model_name fails at upTo>=6', () => {
  const s = loadGoldenSpec(); s.kling.model_name = 'foo';
  assert.match(errStr(validateSpec(s, { upTo: 7 })), /model_name/);
});

test('incremental contract: missing jobs passes upTo<=3 but fails upTo>=6; missing qc only fails at 7', () => {
  const noJobs = loadGoldenSpec(); delete noJobs.kling.jobs;
  assert.equal(validateSpec(noJobs, { upTo: 3 }).ok, true);
  assert.match(errStr(validateSpec(noJobs, { upTo: 6 })), /kling\.jobs/);

  const noQc = loadGoldenSpec(); delete noQc.qc;
  assert.equal(validateSpec(noQc, { upTo: 6 }).ok, true);
  assert.match(errStr(validateSpec(noQc, { upTo: 7 })), /qc/);
});
