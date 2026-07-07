// The stitch must MATCH the source frame rate, not force-convert to 30fps with motion-compensated
// interpolation. minterpolate fabricates ~6 frames/sec when lifting 24→30 and warps them wherever
// motion is hard to estimate — the artifacts a real 5mjo master showed while its clips were clean.
// With VIDEO_FPS unset (config.video.fps === null) the master takes the clips' own rate and
// fabricates nothing; a 24fps master (not 30) is the direct proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { hasFfmpeg, makeClip } from '../helpers/ffmpeg-clips.js';

neutralizeDotenv();
// No VIDEO_FPS / VIDEO_INTERPOLATE — exercise the production default (match source, no interp).
delete process.env.VIDEO_FPS;
delete process.env.VIDEO_INTERPOLATE;
delete process.env.VIDEO_WIDTH;
delete process.env.VIDEO_HEIGHT;
const FF = await hasFfmpeg();
const { assembleVideo, probeClip } = await import('../../src/lib/assemble.js');

test('uniform-fps clips: the master matches the source rate, fabricating no frames', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('assemble-fps-match');
  try {
    const c1 = path.join(dir, 'c1.mp4'); const c2 = path.join(dir, 'c2.mp4');
    await makeClip({ out: c1, seconds: 1, fps: 24 });
    await makeClip({ out: c2, seconds: 1, fps: 24 });
    const master = path.join(dir, 'master.mp4');
    await assembleVideo([c1, c2], master, { nativeAudio: true, aspect: '16:9' });
    const m = await probeClip(master);
    assert.equal(Math.round(m.fps), 24, 'master keeps 24fps — NOT force-converted to 30 via minterpolate');
    assert.ok(Math.abs(m.duration - 2) < 0.3, `duration preserved (~2s), got ${m.duration}`);
  } finally { cleanup(); }
});

test('mixed-fps clips with no override fall back to a plain 30fps resample (no interpolation crash)', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('assemble-fps-mixed');
  try {
    const a = path.join(dir, 'a.mp4'); const b = path.join(dir, 'b.mp4');
    await makeClip({ out: a, seconds: 1, fps: 24 });
    await makeClip({ out: b, seconds: 1, fps: 30 });
    const master = path.join(dir, 'master.mp4');
    await assembleVideo([a, b], master, { nativeAudio: true, aspect: '16:9' });
    const m = await probeClip(master);
    assert.equal(Math.round(m.fps), 30, 'mixed sources normalise to the 30fps fallback');
  } finally { cleanup(); }
});
