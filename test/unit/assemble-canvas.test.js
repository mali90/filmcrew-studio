// The stitch canvas must take the RUN'S aspect shape — a fixed portrait canvas used to
// center-crop every 16:9 and 1:1 master into 9:16.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
delete process.env.VIDEO_WIDTH;   // canvas shape must derive from aspect, not explicit overrides
delete process.env.VIDEO_HEIGHT;
process.env.VIDEO_SHORT_SIDE = '128';
const { canvasFor } = await import('../../src/lib/assemble.js');

test('canvas follows the aspect at VIDEO_SHORT_SIDE scale (even dimensions for yuv420p)', () => {
  assert.deepEqual(canvasFor('16:9'), { w: 228, h: 128 }); // landscape: height is the short side
  assert.deepEqual(canvasFor('9:16'), { w: 128, h: 228 });
  assert.deepEqual(canvasFor('1:1'), { w: 128, h: 128 });
  assert.deepEqual(canvasFor(null), { w: 128, h: 228 });   // unknown → legacy portrait
  for (const a of ['16:9', '9:16', '1:1']) {
    const { w, h } = canvasFor(a);
    assert.equal(w % 2, 0); assert.equal(h % 2, 0);
  }
});

test('the canvas never upscales past the source clips (srcShortSide cap)', () => {
  // a softer source caps the scale — a ~496p Kling render must NOT stitch into a 1080p master
  // (the inflated size read as "already 1080p" and disabled the real approve-time upscale)
  assert.deepEqual(canvasFor('16:9', 96), { w: 170, h: 96 });
  assert.deepEqual(canvasFor('9:16', 96), { w: 96, h: 170 });
  // a sharper source never RAISES the scale past VIDEO_SHORT_SIDE
  assert.deepEqual(canvasFor('16:9', 4096), { w: 228, h: 128 });
  // unknown source dims → the configured scale, unchanged
  assert.deepEqual(canvasFor('16:9', null), { w: 228, h: 128 });
});

// ── Per-model aspect ratios: seedance-2.5 offers 4:3, 3:4 and 21:9 as well ──
// The stitch canvas must shape itself for those too — a 21:9 render center-cropped into 16:9 loses
// the frame edges the plan was written for.
test('the new per-model ratios get their own canvas, still even and still capped', () => {
  assert.deepEqual(canvasFor('4:3'), { w: 170, h: 128 });   // landscape: height is the short side
  assert.deepEqual(canvasFor('3:4'), { w: 128, h: 170 });   // portrait: width is the short side
  assert.deepEqual(canvasFor('21:9'), { w: 298, h: 128 });  // ultrawide
  for (const a of ['4:3', '3:4', '21:9']) {
    const { w, h } = canvasFor(a);
    assert.equal(w % 2, 0, `${a} width is even (yuv420p)`);
    assert.equal(h % 2, 0, `${a} height is even (yuv420p)`);
  }
});

test('the never-upscale cap holds for the new ratios too', () => {
  assert.deepEqual(canvasFor('4:3', 96), { w: 128, h: 96 });
  assert.deepEqual(canvasFor('3:4', 96), { w: 96, h: 128 });
  assert.deepEqual(canvasFor('21:9', 96), { w: 224, h: 96 });
  // a sharper source never RAISES the scale past VIDEO_SHORT_SIDE
  assert.deepEqual(canvasFor('21:9', 4096), { w: 298, h: 128 });
});

test('adaptive/auto are deliberately NOT canvas shapes — they fall back to legacy portrait', () => {
  // the stitch pipeline needs a deterministic ratio; the registry never offers these two.
  assert.deepEqual(canvasFor('adaptive'), { w: 128, h: 228 });
  assert.deepEqual(canvasFor('auto'), { w: 128, h: 228 });
});
