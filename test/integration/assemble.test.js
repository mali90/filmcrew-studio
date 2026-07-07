import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { hasFfmpeg, makeClip } from '../helpers/ffmpeg-clips.js';

// Small, non-interpolated frames keep ffmpeg fast; set before importing assemble.js (snapshots config.video).
neutralizeDotenv();
Object.assign(process.env, { VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false' });
const FF = await hasFfmpeg();
const { assembleVideo, probeClip, clipsHaveNativeAudio, lastFrameOf, grabFrame } = await import('../../src/lib/assemble.js');

test('probe, native-audio stitch (seam fades), single clip, frame grabs', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('assemble');
  try {
    const c1 = path.join(dir, 'c1.mp4'); const c2 = path.join(dir, 'c2.mp4'); const c3 = path.join(dir, 'c3.mp4');
    await makeClip({ out: c1, seconds: 1, withAudio: true });
    await makeClip({ out: c2, seconds: 1, withAudio: true });
    await makeClip({ out: c3, seconds: 1, withAudio: false }); // silent

    const p1 = await probeClip(c1);
    assert.equal(p1.hasAudio, true);
    assert.ok(Math.abs(p1.duration - 1) < 0.3, `duration ~1s, got ${p1.duration}`);
    assert.equal((await probeClip(c3)).hasAudio, false);
    assert.equal(await clipsHaveNativeAudio([c3, c1]), true);
    assert.equal(await clipsHaveNativeAudio([c3]), false);

    // 3-clip native stitch (incl. a silent clip → anullsrc branch); output keeps audio, ~3s.
    const master = path.join(dir, 'master.mp4');
    await assembleVideo([c1, c2, c3], master, { nativeAudio: true });
    const pm = await probeClip(master);
    assert.equal(pm.hasAudio, true);
    assert.ok(pm.duration > 2.5, `master ~3s, got ${pm.duration}`);

    // single-clip stitch still works
    const single = path.join(dir, 'single.mp4');
    await assembleVideo([c1], single, { nativeAudio: true });
    assert.ok((await probeClip(single)).duration > 0.8);

    // frame extraction
    assert.ok(await lastFrameOf(c1, path.join(dir, 'last.png')));
    assert.ok(await grabFrame(c1, 0.5, path.join(dir, 'cover.png')));
  } finally { cleanup(); }
});

test('assembleVideo with no clips throws', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  await assert.rejects(assembleVideo([], '/tmp/x.mp4', {}), /No clips/);
});
