// The stitched master must come out at the SOURCE clips' resolution, not inflated to
// VIDEO_SHORT_SIDE: Kling standard delivers ~496p clips and the default scale is 1080, so a
// naive stitch produced a fake-1080p master — which then disabled the approve-time Topaz
// upscale as "already 1080p". Mixed sizes follow the SOFTEST clip (the master is only as
// sharp as that), so post-Topaz re-assembly still reaches a true 1080p.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { hasFfmpeg, makeClip } from '../helpers/ffmpeg-clips.js';

neutralizeDotenv();
delete process.env.VIDEO_WIDTH;      // no explicit canvas — the aspect + cap must decide
delete process.env.VIDEO_HEIGHT;
delete process.env.VIDEO_SHORT_SIDE; // the REAL default (1080) — the bug only shows there
Object.assign(process.env, { VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false' });
const FF = await hasFfmpeg();
const { assembleVideo, probeClip } = await import('../../src/lib/assemble.js');

test('stitch keeps the source resolution — 128px clips never inflate to a 1080p master', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('assemble-native');
  try {
    const c1 = path.join(dir, 'c1.mp4'); const c2 = path.join(dir, 'c2.mp4');
    await makeClip({ out: c1 }); await makeClip({ out: c2 });
    const master = path.join(dir, 'master.mp4');
    await assembleVideo([c1, c2], master, { nativeAudio: true, aspect: '16:9' });
    const m = await probeClip(master);
    assert.deepEqual({ w: m.width, h: m.height }, { w: 228, h: 128 }, 'canvas capped at the clips\' short side');
  } finally { cleanup(); }
});

test('mixed clip sizes stitch at the SOFTEST clip, so upscale stays honest', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('assemble-mixed');
  try {
    const small = path.join(dir, 'small.mp4'); const big = path.join(dir, 'big.mp4');
    await makeClip({ out: small, size: '128x128' });
    await makeClip({ out: big, size: '256x144' });
    const master = path.join(dir, 'master.mp4');
    await assembleVideo([small, big], master, { nativeAudio: true, aspect: '16:9' });
    const m = await probeClip(master);
    assert.equal(Math.min(m.width, m.height), 128, 'short side follows the softest source clip');
  } finally { cleanup(); }
});
