// readContinuity, per JOINT, from the seam lineage the renderers record (WS2-P2c).
//
// This is the payoff of the recorded lineage: before it, a run was chained all-or-nothing, so the
// only honest answer for a cut that mixed takes was "unknown" — and the whole master fell back to a
// hard cut, including the joints that really were continuations. Now each clip's own seam says which
// clip it opened on, and a mixed timeline stitches the intact joints and cuts the broken one.
//
// The rule is deliberately the SAME one web/server/lib/lineage.js applies for the UI's continuity
// badges: joint j is chained iff clip j+1 was pinned at all AND the clip that frame came off is the
// clip sitting at position j right now. The last test in this file re-runs the shared fixture shapes
// through BOTH implementations and requires the same verdicts, so the two cannot drift apart into a
// UI that promises "seamless" over a stitch that hard-cut (or the reverse).
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { planSeamstitch, readContinuity } = await import('../../src/lib/seamstitch.js');
const config = (await import('../../config.js')).default;

const CFG = { ...config.stitch, assumeContinuous: false };

// ── Fixture builder ────────────────────────────────────────────────────────────────────────────
// One description, two shapes: the render.json this module reads, and the run record lineage.js
// reads. Same runs, same paths — that is what makes the cross-check at the bottom meaningful.

const clipOf = (runId, take, job) => `/runs/${runId}/renders/${take}/${job}/clip.mp4`;
const frameOf = (runId, take, job) => `/runs/${runId}/renders/${take}/${job}/last_frame.png`;

/**
 * One segment of a cut: job `job` served by take `take`, opened on the closing frame of
 * `from` = [take, job] (or nothing, for a clip that started fresh). `mode` is the seam the renderer
 * actually applied — 'soft' (reference-guided pin) and 'native' (a real first/last-frame slot) both
 * share a frame; 'none' and 'unsupported' share nothing.
 */
const seg = (job, take, from = null, mode = from ? 'soft' : 'none') => ({ job, take, from, mode });

const seamInOf = (runId, s) => (s.from && s.mode !== 'none' && s.mode !== 'unsupported'
  ? { mode: s.mode, frame: frameOf(runId, s.from[0], s.from[1]), from: { take: s.from[0], job: s.from[1], clip: clipOf(runId, s.from[0], s.from[1]) } }
  : { mode: s.mode, frame: s.from ? frameOf(runId, s.from[0], s.from[1]) : null, from: s.from ? { take: s.from[0], job: s.from[1], clip: clipOf(runId, s.from[0], s.from[1]) } : null });

/** The render.json shape finishRender hands readContinuity: the cut, in clip order. */
const renderOf = (runId, segs, extra = {}) => ({
  project: runId,
  jobs: segs.map((s) => ({ jobId: s.job, job: s.job, clip: clipOf(runId, s.take, s.job), seamIn: seamInOf(runId, s), seamOut: null })),
  ...extra,
});

/** The run record web/server/lib/lineage.js reads: takes (oldest first) + the cut composed from them. */
function runRecordOf(runId, segs) {
  const takeIds = [...new Set(segs.map((s) => s.take))].sort();
  return {
    runId,
    takes: takeIds.map((take) => ({
      take,
      jobs: segs.filter((s) => s.take === take).map((s) => ({ jobId: s.job, clip: clipOf(runId, s.take, s.job), seamIn: seamInOf(runId, s), seamOut: null })),
    })),
    cut: segs.map((s) => ({ jobId: s.job, take: s.take })),
  };
}

// The two real runs from the plan's forensics, in the shapes web/server/test/fixtures/lineage/ holds:
//
// b1nx — K1 was re-rendered into take t2, but the cut still uses t1's K2, which opened on the OLD
//        K1's closing frame. Joint 1 is a genuine cut wearing a chain's clothes; joint 2 (t1's K3 on
//        t1's K2) never moved and is a real continuation.
const B1NX = [seg('K1', 't2'), seg('K2', 't1', ['t1', 'K1']), seg('K3', 't1', ['t1', 'K2'])];
// 5mjo — t4 re-rendered the whole chain in one pass; every seam names the clip that really precedes it.
const M5JO = [seg('K1', 't4'), seg('K2', 't4', ['t4', 'K1']), seg('K3', 't4', ['t4', 'K2'])];
// The mirror image of b1nx: the MIDDLE segment was re-rendered, chained onto the current K1, so the
// joint before it survives and the joint after it (t1's K3 still naming t1's K2) is the broken one.
const MIDDLE = [seg('K1', 't1'), seg('K2', 't2', ['t1', 'K1']), seg('K3', 't1', ['t1', 'K2'])];

/** Every element a real boolean, exactly one per joint — planSeamstitch rejects any other shape. */
function assertJointArray(got, expectedJoints) {
  assert.ok(Array.isArray(got), `expected an array of ${expectedJoints} flags, got ${JSON.stringify(got)}`);
  assert.equal(got.length, expectedJoints, 'one flag per joint, always');
  for (const [i, v] of got.entries()) assert.equal(typeof v, 'boolean', `joint ${i} is ${typeof v}, not a strict boolean`);
}

// ── The rule ───────────────────────────────────────────────────────────────────────────────────

test('a re-rendered FIRST segment breaks only its own joint (the b1nx shape)', () => {
  const got = readContinuity(renderOf('b1nx', B1NX), 3, CFG);
  assertJointArray(got, 2);
  assert.deepEqual(got, [false, true], 'K2 opened on a K1 clip the cut no longer contains; K3 → K2 never moved');
});

test('a re-rendered MIDDLE segment breaks the joint AFTER it, not the one before', () => {
  const got = readContinuity(renderOf('mid', MIDDLE), 3, CFG);
  assertJointArray(got, 2);
  assert.deepEqual(got, [true, false]);
});

test('an intact chain rendered in one pass is chained at every joint (the 5mjo shape)', () => {
  const got = readContinuity(renderOf('5mjo', M5JO), 3, CFG);
  assertJointArray(got, 2);
  assert.deepEqual(got, [true, true]);
});

test('modes that pinned nothing are cuts, even when the source clip still matches', () => {
  // 'none' — chaining was off, or a text-to-video Kling job with no reference path for a start frame.
  const none = [seg('K1', 't1'), seg('K2', 't1', ['t1', 'K1'], 'none')];
  assert.deepEqual(readContinuity(renderOf('x', none), 2, CFG), [false]);
  // 'unsupported' — we sent the anchor and the provider rejected it, so no frame was ever shared.
  const unsup = [seg('K1', 't1'), seg('K2', 't1', ['t1', 'K1'], 'unsupported')];
  assert.deepEqual(readContinuity(renderOf('x', unsup), 2, CFG), [false]);
  // 'native' (a real first-frame slot) shares a frame exactly like 'soft' does.
  const native = [seg('K1', 't1'), seg('K2', 't1', ['t1', 'K1'], 'native')];
  assert.deepEqual(readContinuity(renderOf('x', native), 2, CFG), [true]);
});

test('a pinned clip whose seam names no source clip is not a continuation', () => {
  // An explicit --first-frame-from still pin: a real frame was applied, but it has no take/job/clip
  // of its own, so nothing can be said about the joint before it.
  const render = renderOf('x', [seg('K1', 't1'), seg('K2', 't1')]);
  render.jobs[1].seamIn = { mode: 'soft', frame: '/tmp/hand-picked.png', from: null };
  assert.deepEqual(readContinuity(render, 2, CFG), [false]);
});

test('recorded lineage OUTRANKS the run-level chained flag, in both directions', () => {
  // A composed cut carries `chained:false` (composeCut clears it) while its clips carry real seams —
  // the intact joints must still stitch.
  assert.deepEqual(readContinuity(renderOf('5mjo', M5JO, { chained: false }), 3, CFG), [true, true]);
  // And a stale `chained:true` may not resurrect a joint the lineage says is broken.
  assert.deepEqual(readContinuity(renderOf('b1nx', B1NX, { chained: true }), 3, CFG), [false, true]);
});

test('a lineage-free run still reads its legacy chained flag exactly as before', () => {
  assert.deepEqual(readContinuity({ chained: true }, 3, CFG), [true, true]);
  assert.deepEqual(readContinuity({ chained: true, jobs: [{ jobId: 'K1', clip: 'a.mp4' }, { jobId: 'K2', clip: 'b.mp4' }] }, 2, CFG), [true],
    'jobs recorded before the sidecar existed carry no seamIn — the run-level flag is all there is');
  assert.equal(readContinuity({ chained: false }, 3, CFG), null, 'an unchained run is not stitchable');
});

test('an unknown run stays unknown — null is never "all cuts"', () => {
  assert.equal(readContinuity({}, 3, CFG), null);
  assert.equal(readContinuity(null, 3, CFG), null);
  assert.equal(readContinuity({ jobs: [] }, 3, CFG), null);
  assert.equal(readContinuity(undefined, 2, CFG), null);
  // One clip has no joints at all, whatever the lineage says.
  assert.equal(readContinuity(renderOf('5mjo', M5JO), 1, CFG), null);
  assert.equal(readContinuity(renderOf('5mjo', M5JO), 0, CFG), null);
});

test('a job list that does not match the clip list declines rather than misaligning', () => {
  // A partial render (one job failed) hands finishRender fewer clips than the cut describes. Reading
  // the seams anyway would attach joint 1's verdict to a different pair of clips.
  const render = renderOf('5mjo', M5JO);
  assert.equal(readContinuity(render, 2, CFG), null, 'three recorded jobs, two clips — we cannot say which joint is which');
  // A job that errored contributes no clip and therefore no joint: dropping it keeps the alignment.
  const withFailure = { chained: false, jobs: [...render.jobs, { jobId: 'K4', clip: null, error: 'content policy', seamIn: null }] };
  assert.deepEqual(readContinuity(withFailure, 3, CFG), [true, true]);
});

test('STITCH_ASSUME_CONTINUOUS still forces all-true over any lineage', () => {
  const cfg = { ...config.stitch, assumeContinuous: true };
  const got = readContinuity(renderOf('b1nx', B1NX), 3, cfg);
  assertJointArray(got, 2);
  assert.deepEqual(got, [true, true], 'the debug knob asserts a fact about the footage — it outranks the record');
  assert.equal(readContinuity(renderOf('b1nx', B1NX), 1, cfg), null, 'even forced, one clip has no joints');
  assert.equal(config.stitch.assumeContinuous, false, 'and it is OFF by default');
});

test('readContinuity is pure — it never mutates the render record it is handed', () => {
  const render = renderOf('b1nx', B1NX);
  const before = JSON.stringify(render);
  readContinuity(render, 3, CFG);
  assert.equal(JSON.stringify(render), before);
});

// ── What the stitcher is actually told ─────────────────────────────────────────────────────────

test('the mixed map reaches planSeamstitch as --joint-match 0,1, not all-1s', () => {
  const clip = { width: 160, height: 96, duration: 2, fps: 24 };
  const continuity = readContinuity(renderOf('b1nx', B1NX), 3, CFG);
  const { eligible, args } = planSeamstitch({
    probes: [clip, clip, clip], continuity, canvas: { w: 160, h: 96 }, targetFps: 24, cfg: CFG,
  });
  assert.equal(eligible, true, 'one broken joint must not disqualify the whole stitch');
  assert.equal(args[args.indexOf('--joint-match') + 1], '0,1');
  // …and the broken joint is given the CUT crossfade, not the chained one.
  assert.equal(args[args.indexOf('--joint-xfade') + 1], `${CFG.cutXfade},${CFG.xfade}`);
});

test('an all-broken cut declines: plain concat is exactly equivalent and cheaper', () => {
  const clip = { width: 160, height: 96, duration: 2, fps: 24 };
  const broken = [seg('K1', 't2'), seg('K2', 't1', ['t1', 'K1'])];
  const continuity = readContinuity(renderOf('b1nx', broken), 2, CFG);
  assert.deepEqual(continuity, [false]);
  const r = planSeamstitch({ probes: [clip, clip], continuity, canvas: { w: 160, h: 96 }, targetFps: 24, cfg: CFG });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /no chained joint/);
});

// ── The two implementations of one rule ────────────────────────────────────────────────────────

test('the stitcher and the UI agree on every joint of every fixture shape', async () => {
  let computeLineage;
  try { ({ computeLineage } = await import('../../web/server/lib/lineage.js')); }
  catch { return; } // the server package is not part of a source-only checkout — nothing to compare
  for (const [name, segs] of [['b1nx', B1NX], ['5mjo', M5JO], ['middle re-render', MIDDLE]]) {
    const fromStitcher = readContinuity(renderOf(name, segs), segs.length, CFG);
    const fromUi = computeLineage(runRecordOf(name, segs)).joints.map((j) => j.linked);
    assert.deepEqual(fromStitcher, fromUi, `${name}: the stitch and the badge must not disagree`);
  }
});
