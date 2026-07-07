import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
neutralizeDotenv();
const { upscaleVideoTopaz, upscalePlan } = await import('../../src/lib/upscale.js');
const { topazArgs } = await import('../../src/lib/fal.js');

test('topazArgs builds the fal Topaz payload; model is optional', () => {
  assert.deepEqual(topazArgs('https://x/v.mp4'), { video_url: 'https://x/v.mp4', upscale_factor: 2 });
  assert.deepEqual(topazArgs('u', { upscaleFactor: 3, model: 'Proteus' }), { video_url: 'u', upscale_factor: 3, model: 'Proteus' });
  assert.equal('model' in topazArgs('u', { upscaleFactor: 4 }), false);
});

test('upscalePlan: short-side → 0.25-step factor to ~1080p, capped, no-op when already ≥1080p', () => {
  assert.deepEqual(upscalePlan(1920, 1080), { needsUpscale: false, upscaleFactor: 1 }); // already ≥1080p short side
  assert.deepEqual(upscalePlan(720, 1280), { needsUpscale: true, upscaleFactor: 1.5 });  // 1080/720 = 1.5
  assert.deepEqual(upscalePlan(480, 854), { needsUpscale: true, upscaleFactor: 2.25 });  // 1080/480 = 2.25
  assert.deepEqual(upscalePlan(100, 100), { needsUpscale: true, upscaleFactor: 4 });      // capped at topazMaxFactor
  assert.deepEqual(upscalePlan(0, 0), { needsUpscale: false, upscaleFactor: 1 });         // undetectable dims → no-op
});

test('arg guards throw before any network call', async () => {
  const { dir, cleanup } = mkTmp('upscale');
  try {
    // missing input file
    await assert.rejects(upscaleVideoTopaz({ inPath: path.join(dir, 'nope.mp4'), outDir: dir }), /input not found/);
    // existing file, factor out of range (> topazMaxFactor) — rejected before uploading anything
    const clip = path.join(dir, 'clip.mp4'); fs.writeFileSync(clip, 'x');
    await assert.rejects(upscaleVideoTopaz({ inPath: clip, outDir: dir, factor: 9 }), /bad factor/);
    await assert.rejects(upscaleVideoTopaz({ inPath: clip, outDir: dir, factor: 0.5 }), /bad factor/);
  } finally { cleanup(); }
});
