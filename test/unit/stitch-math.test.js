import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { segmentLengths, computeOffsets } = await import('../../src/lib/stitch-math.js');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test('spec §7.5 worked example: 3x120 frames @24fps, xfade 0.25', () => {
  const { lengths, offsets, expectedDuration } = computeOffsets([120, 120, 120], 24, 0.25);
  near(lengths[0], 5.0);
  near(lengths[1], 119 / 24);
  near(lengths[2], 119 / 24);
  near(offsets[0], 4.75);
  near(offsets[1], 9.4583333, 1e-6);
  near(offsets[1], 227 / 24);
  near(expectedDuration, 14.4166667, 1e-6);
});

test('30fps, and every offset lands on the frame grid', () => {
  const { offsets, expectedDuration } = computeOffsets([90, 90, 90], 30, 0.5);
  near(offsets[0], 2.5);
  near(offsets[1], 2.5 + 89 / 30 - 0.5);
  for (const o of offsets) near(o * 30, Math.round(o * 30), 1e-9);
  near(expectedDuration, 3.0 + (2 * 89) / 30 - 1.0);
});

test('2 segments: one joint', () => {
  const { lengths, offsets, expectedDuration } = computeOffsets([90, 90], 30, 0.5);
  assert.equal(offsets.length, 1);
  near(offsets[0], 2.5);
  near(expectedDuration, lengths[0] + lengths[1] - 0.5);
});

test('5 segments: four joints, each offset a running total less the fades so far', () => {
  const { lengths, offsets, expectedDuration } = computeOffsets([48, 48, 48, 48, 48], 24, 0.25);
  assert.equal(lengths.length, 5);
  assert.equal(offsets.length, 4);
  near(offsets[0], 1.75);
  near(offsets[1], 3.4583333, 1e-6);
  near(offsets[2], 5.1666667, 1e-6);
  near(offsets[3], 6.875);
  near(expectedDuration, 2.0 + (4 * 47) / 24 - 1.0);
});

test('a scene cut keeps its first frame: L_j = nframes*fd, not (nframes-1)*fd', () => {
  const chained = segmentLengths([48, 48, 48], 24);                       // default: all continuations
  const mixed = segmentLengths([48, 48, 48], 24, [false, true, false]);   // joint 2 is a cut
  near(chained[2], 47 / 24);
  near(mixed[2], 48 / 24);
  near(mixed[2] - chained[2], 1 / 24);

  // The kept frame lands in the duration, and joint 1's offset (before the cut) is untouched.
  const all = computeOffsets([48, 48, 48], 24, [0.25, 0.25]);
  const cut = computeOffsets([48, 48, 48], 24, [0.25, 0.25], [false, true, false]);
  assert.deepEqual(cut.offsets, all.offsets);
  near(cut.expectedDuration - all.expectedDuration, 1 / 24);
  near(cut.expectedDuration, 5.4583333, 1e-6);
});

test('per-joint xfades: a short fade at one joint only shortens that joint', () => {
  const even = computeOffsets([48, 48, 48], 24, 0.25);
  const mixed = computeOffsets([48, 48, 48], 24, [0.25, 1 / 24]);
  near(mixed.offsets[0], even.offsets[0]);                       // joint 1 unchanged
  near(mixed.offsets[1], even.offsets[1] + 0.25 - 1 / 24, 1e-9); // joint 2 starts later
  near(mixed.expectedDuration, even.expectedDuration + 0.25 - 1 / 24);
  near(mixed.expectedDuration, 5.625);
});

test('a single xfade value is the same as repeating it per joint', () => {
  const scalar = computeOffsets([60, 72, 48, 96], 24, 0.4);
  const list = computeOffsets([60, 72, 48, 96], 24, [0.4, 0.4, 0.4]);
  assert.deepEqual(list.offsets, scalar.offsets);
  assert.equal(list.expectedDuration, scalar.expectedDuration);
});

test('frame-grid snapping rounds half to EVEN, like graph.py (Python round(), not Math.round)', () => {
  // 2.0 - 0.3125 = 1.6875s = 40.5 frames @24. Python's round() gives 40; Math.round would give 41.
  const { offsets } = computeOffsets([48, 48], 24, 0.3125);
  near(offsets[0], 40 / 24);
  assert.notEqual(offsets[0], 41 / 24);
});

test('mismatched list lengths are rejected, not silently padded', () => {
  assert.throws(() => computeOffsets([48, 48, 48], 24, [0.25]), /need 2 xfade value/);
  assert.throws(() => segmentLengths([48, 48], 24, [false]), /dropFirst needs 2 entries/);
  assert.throws(() => segmentLengths([], 24), /non-empty/);
  assert.throws(() => segmentLengths([48], 0), /fps must be > 0/);
});
