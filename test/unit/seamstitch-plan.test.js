import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv, withEnv } from '../helpers/env.js';
neutralizeDotenv();
const { planSeamstitch, readContinuity } = await import('../../src/lib/seamstitch.js');
const config = (await import('../../config.js')).default;

const CFG = config.stitch;
const clip = (w = 160, h = 96, duration = 2, fps = 24) => ({ width: w, height: h, duration, fps });
const CANVAS = { w: 160, h: 96 };
/** Flags come out as a flat argv; read a flag's value by name. */
const flag = (args, name) => args[args.indexOf(name) + 1];

test('a chained pair is eligible and carries the full flag set', () => {
  const { eligible, reason, args } = planSeamstitch({
    probes: [clip(), clip()], continuity: [true], canvas: CANVAS, targetFps: 24, cfg: CFG,
  });
  assert.equal(eligible, true);
  assert.equal(reason, null);
  assert.equal(flag(args, '--target-res'), '160x96');
  assert.equal(flag(args, '--fps'), '24');
  assert.equal(flag(args, '--joint-match'), '1');
  assert.equal(flag(args, '--fit'), CFG.fit);
  assert.equal(flag(args, '--method'), CFG.method);
  assert.equal(flag(args, '--ramp'), String(CFG.ramp));
  assert.equal(flag(args, '--crf'), String(CFG.crf));
  assert.equal(flag(args, '--preset'), CFG.preset);
  assert.ok(args.includes('--json'), 'the wrapper always asks for the machine-readable report');
  assert.ok(args.includes('--verify'), `verify=${CFG.verify} should add --verify`);
});

test('verify=off drops --verify; deflicker/desqueeze only appear when set', () => {
  const off = planSeamstitch({ probes: [clip(), clip()], continuity: [true], canvas: CANVAS, targetFps: 24, cfg: { ...CFG, verify: 'off' } });
  assert.ok(!off.args.includes('--verify'));
  assert.ok(!off.args.includes('--deflicker'));
  assert.ok(!off.args.includes('--desqueeze'), 'desqueeze=off is the default and stays implicit');

  const on = planSeamstitch({ probes: [clip(), clip()], continuity: [true], canvas: CANVAS, targetFps: 24, cfg: { ...CFG, deflicker: true, desqueeze: 'auto' } });
  assert.ok(on.args.includes('--deflicker'));
  assert.equal(flag(on.args, '--desqueeze'), 'auto');
});

test('a mixed timeline maps to per-joint match + per-joint xfade (cut joints use cutXfade)', () => {
  const { eligible, args } = planSeamstitch({
    probes: [clip(), clip(), clip(), clip()],
    continuity: [true, false, true],
    canvas: CANVAS,
    targetFps: 24,
    cfg: { ...CFG, xfade: 0.25, cutXfade: 0 },
  });
  assert.equal(eligible, true);
  assert.equal(flag(args, '--joint-match'), '1,0,1');
  assert.equal(flag(args, '--joint-xfade'), '0.25,0,0.25');
  // The 0 stays a 0 here on purpose: the one-frame promotion is graph.py's job, which is the only
  // place that knows the frame duration.
});

test('never upscales: the caller canvas reaches --target-res even when clips are bigger', () => {
  // A 480p clip next to a 720p one — assemble.js caps the canvas at the SOFTEST clip's short side,
  // and the stitcher must be told that same canvas, not the larger clip's size.
  const { eligible, args } = planSeamstitch({
    probes: [clip(854, 480, 3), clip(1280, 720, 3)],
    continuity: [true],
    canvas: { w: 854, h: 480 },
    targetFps: 24,
    cfg: CFG,
  });
  assert.equal(eligible, true);
  assert.equal(flag(args, '--target-res'), '854x480');
});

test('ineligible: fewer than 2 clips', () => {
  const r = planSeamstitch({ probes: [clip()], continuity: [], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(r.eligible, false);
  assert.equal(r.args, null);
  assert.match(r.reason, /fewer than 2 clips/);
});

test('ineligible: continuity undefined is "unknown", not "all cuts"', () => {
  for (const continuity of [undefined, null]) {
    const r = planSeamstitch({ probes: [clip(), clip()], continuity, canvas: CANVAS, targetFps: 24, cfg: CFG });
    assert.equal(r.eligible, false);
    assert.match(r.reason, /no continuity map/);
  }
});

test('ineligible: continuity length must be one flag per joint', () => {
  const r = planSeamstitch({ probes: [clip(), clip(), clip()], continuity: [true], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /expected 2 \(one per joint\)/);
});

test('ineligible: no chained joint at all — a plain concat is equivalent', () => {
  const r = planSeamstitch({ probes: [clip(), clip(), clip()], continuity: [false, false], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /no chained joint/);
});

test('ineligible: a clip shorter than its own crossfades plus a frame', () => {
  // Middle clip fades on BOTH sides: 0.25 + 0.25 + 1/24 = 0.5417s needed.
  const ok = planSeamstitch({ probes: [clip(160, 96, 2), clip(160, 96, 0.6), clip(160, 96, 2)], continuity: [true, true], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(ok.eligible, true);

  const r = planSeamstitch({ probes: [clip(160, 96, 2), clip(160, 96, 0.5), clip(160, 96, 2)], continuity: [true, true], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /clip 2 is 0.50s, shorter than its crossfades need/);
});

test('length budget counts a cut joint as one frame, not zero (graph.py promotes 0 → fd)', () => {
  // 4 clips, joints: chained, cut, cut. Clip 3 sits between two cut joints; with cutXfade=0 the
  // tool still spends one frame per joint, so its budget is fd+fd+fd ≈ 0.125s at 24fps.
  const probes = (midDur) => [clip(), clip(), clip(160, 96, midDur), clip()];
  const short = planSeamstitch({ probes: probes(0.1), continuity: [true, false, false], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(short.eligible, false);
  assert.match(short.reason, /clip 3/);
  const ok = planSeamstitch({ probes: probes(0.15), continuity: [true, false, false], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(ok.eligible, true);
});

test('ineligible: framing more than 8% off the canvas (ADDENDUM_AR §4 abort)', () => {
  // 176x96 against a 160x96 canvas is 9.1% off — refitting that crops real content.
  const r = planSeamstitch({ probes: [clip(), clip(176, 96)], continuity: [true], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /clip 2 is framed 9\.1% off/);

  // A real bucket mismatch (1.5%) is fine — that is what --fit cover exists for.
  const ok = planSeamstitch({ probes: [clip(), clip(176, 104)], continuity: [true], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.equal(ok.eligible, true);
});

test('framing is judged by DISPLAY aspect, so non-square pixels are not mistaken for a reframe', () => {
  // 128x96 stored, but SAR 4:3 → it DISPLAYS as 170.7x96, i.e. the 16:9-ish shape of the canvas.
  // Storage dimensions alone would read as 33% off and decline a perfectly stitchable clip.
  const anamorphic = { width: 128, height: 96, duration: 2, fps: 24, sar: 4 / 3, dar: (128 * (4 / 3)) / 96 };
  const canvas = { w: 170, h: 96 };
  const ok = planSeamstitch({ probes: [clip(170, 96), anamorphic], continuity: [true], canvas, targetFps: 24, cfg: CFG });
  assert.equal(ok.eligible, true, ok.reason);

  // The same storage size with SQUARE pixels really is a different shape, and is refused.
  const square = { width: 128, height: 96, duration: 2, fps: 24, sar: 1, dar: 128 / 96 };
  const no = planSeamstitch({ probes: [clip(170, 96), square], continuity: [true], canvas, targetFps: 24, cfg: CFG });
  assert.equal(no.eligible, false);
  assert.match(no.reason, /clip 2 is framed 32\.8% off/);
});

// The LEGACY path only — a run whose jobs carry no seam records. Per-joint derivation from the
// recorded lineage lives in seamstitch-continuity.test.js.
test('readContinuity: only a run that RECORDED chaining gets a continuity map', () => {
  const cfg = { ...CFG, assumeContinuous: false };
  assert.deepEqual(readContinuity({ chained: true }, 3, cfg), [true, true]);
  assert.equal(readContinuity({ chained: false }, 3, cfg), null, 'an unchained run is not stitchable');
  assert.equal(readContinuity({}, 3, cfg), null, 'a manifest that never recorded it means UNKNOWN');
  assert.equal(readContinuity(null, 3, cfg), null);
  assert.equal(readContinuity({ chained: true }, 1, cfg), null, 'one clip has no joints');
  assert.equal(readContinuity({ chained: true }, 0, cfg), null);
});

test('readContinuity: STITCH_ASSUME_CONTINUOUS forces all-true (test/debug knob)', () => {
  const cfg = { ...CFG, assumeContinuous: true };
  assert.deepEqual(readContinuity({}, 3, cfg), [true, true]);
  assert.deepEqual(readContinuity({ chained: false }, 2, cfg), [true]);
  assert.equal(readContinuity({}, 1, cfg), null, 'even forced, one clip has no joints');
  assert.equal(CFG.assumeContinuous, false, 'and it is OFF by default');
});

test('ineligible: unusable probes (no dimensions, no duration, no fps)', () => {
  const noDims = planSeamstitch({ probes: [clip(), { width: 0, height: 0, duration: 2 }], continuity: [true], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.match(noDims.reason, /clip 2 has unknown dimensions/);

  const noDur = planSeamstitch({ probes: [clip(), clip(160, 96, 0)], continuity: [true], canvas: CANVAS, targetFps: 24, cfg: CFG });
  assert.match(noDur.reason, /clip 2 has unknown duration/);

  const noFps = planSeamstitch({ probes: [clip(), clip()], continuity: [true], canvas: CANVAS, targetFps: 0, cfg: CFG });
  assert.match(noFps.reason, /no target frame rate/);

  const noCanvas = planSeamstitch({ probes: [clip(), clip()], continuity: [true], canvas: null, targetFps: 24, cfg: CFG });
  assert.match(noCanvas.reason, /no stitch canvas/);
});

test('ineligible: STITCH_SEAMLESS=off short-circuits everything', async () => {
  await withEnv({ STITCH_SEAMLESS: 'off' }, async () => {
    const cfg = (await import('../../config.js?stitch-off')).default.stitch;
    assert.equal(cfg.seamless, 'off');
    const r = planSeamstitch({ probes: [clip(), clip()], continuity: [true], canvas: CANVAS, targetFps: 24, cfg });
    assert.equal(r.eligible, false);
    assert.equal(r.args, null);
    assert.match(r.reason, /STITCH_SEAMLESS=off/);
  });
});

test('config defaults: the stitch block reads its env with sane fallbacks', async () => {
  assert.equal(CFG.seamless, 'auto');
  assert.equal(CFG.python, 'python3');
  assert.equal(CFG.method, 'hybrid');
  assert.equal(CFG.xfade, 0.25);
  assert.equal(CFG.cutXfade, 0);
  assert.equal(CFG.ramp, 2.0);
  assert.equal(CFG.fit, 'cover');
  assert.equal(CFG.verify, 'warn');
  assert.equal(CFG.crf, 19);
  assert.equal(CFG.preset, 'medium');
  assert.equal(CFG.timeoutMs, 20 * 60 * 1000);

  await withEnv({ STITCH_XFADE: '0.5', STITCH_CUT_XFADE: '0.04', STITCH_METHOD: 'mkl' }, async () => {
    const cfg = (await import('../../config.js?stitch-env')).default.stitch;
    assert.equal(cfg.xfade, 0.5);
    assert.equal(cfg.cutXfade, 0.04);
    assert.equal(cfg.method, 'mkl');
    const { args } = planSeamstitch({ probes: [clip(), clip(), clip()], continuity: [true, false], canvas: CANVAS, targetFps: 24, cfg });
    assert.equal(flag(args, '--joint-xfade'), '0.5,0.04');
    assert.equal(flag(args, '--method'), 'mkl');
  });
});
