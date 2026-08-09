// assembleVideo's two stitch paths, end to end with real ffmpeg.
//
// The FIRST test is the contract that matters most: with continuity declared but the stitcher
// unreachable, assembly must still produce a valid master. The seamless path is an enhancement — it
// may never be the reason a render has nothing to deliver.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { hasFfmpeg } from '../helpers/ffmpeg-clips.js';
import { makeChainedClips, hasSeamstitch } from '../helpers/seam-fixtures.js';

// 160x90 is exactly 16:9, so canvasFor('16:9') lands on the clips' own size and nothing is refitted.
neutralizeDotenv();
Object.assign(process.env, { VIDEO_FPS: '', VIDEO_INTERPOLATE: 'false', LOG_LEVEL: 'error' });

const FPS = 24;
const FRAMES = 48;
const SIZE = '160x90';
const XFADE = 0.25;

const FF = await hasFfmpeg();
const SS = await hasSeamstitch();
const NEED_FF = FF ? false : 'ffmpeg not installed';
const NEED_BOTH = FF && SS ? false : 'requires ffmpeg + python3 with numpy/pillow';

const { canvasFor, probeClip } = await import('../../src/lib/assemble.js');
const { computeOffsets } = await import('../../src/lib/stitch-math.js');
const config = (await import('../../config.js')).default;

// One fixture for the file; each test assembles from it into its own master.
const tmp = FF ? mkTmp('assemble-seamless') : null;
const fixture = FF ? await makeChainedClips({ dir: tmp.dir, fps: FPS, size: SIZE, frames: FRAMES }) : null;
test.after(() => tmp?.cleanup());

const clips = () => fixture.segments.slice(0, 2);
const CHILD = fileURLToPath(new URL('../helpers/assemble-child.mjs', import.meta.url));

/**
 * A b1nx-shaped render.json over the three fixture clips: segment 1 was re-rendered into a new take,
 * so segment 2 still points at a K1 clip this cut no longer contains (broken), while segment 3 opens
 * on segment 2's own closing frame (intact). readContinuity turns that into [false, true] — the map
 * the mixed-timeline test below drives the real stitcher with.
 */
const mixedRender = (segs) => ({
  chained: false,
  jobs: [
    { jobId: 'K1', clip: segs[0], seamIn: { mode: 'none', frame: null, from: null } },
    { jobId: 'K2', clip: segs[1], seamIn: { mode: 'soft', frame: '/gone/t1/K1/last_frame.png', from: { take: 't1', job: 'K1', clip: '/gone/t1/K1/clip.mp4' } } },
    { jobId: 'K3', clip: segs[2], seamIn: { mode: 'soft', frame: '/gone/t1/K2/last_frame.png', from: { take: 't1', job: 'K2', clip: segs[1] } } },
  ],
});

/** assembleVideo in a child process, so the STITCH_ and PYTHON_BIN vars in `env` really reach config.js. */
function assembleWithEnv(env, clipPaths, out, opts) {
  const r = spawnSync(process.execPath, [CHILD, JSON.stringify({ clips: clipPaths, out, opts })], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  if (r.status !== 0) {
    const e = new Error(`assemble child exited ${r.status}`);
    e.stderr = r.stderr ?? ''; // the whole thing — Node prints a code frame BEFORE the message
    throw e;
  }
  return { result: JSON.parse(r.stdout), stderr: r.stderr ?? '' };
}
const audioRate = async (file) => {
  // probeClip does not report the audio rate; read it directly.
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', file]);
  return Number(String(r.stdout).trim());
};

test('FALLBACK: continuity declared but no python — still a valid master, via concat', { skip: NEED_FF }, async () => {
  const master = path.join(tmp.dir, 'fallback.mp4');
  const { result, stderr } = assembleWithEnv(
    { PYTHON_BIN: '/nonexistent/python3', STITCH_SEAMLESS: 'auto', LOG_LEVEL: 'warn' },
    clips(), master, { nativeAudio: true, aspect: '16:9', continuity: [true] },
  );
  assert.equal(result.stitcher, 'concat', 'an unusable stitcher must never block the master');
  assert.equal(result.out, master);
  // ...and it says so, once, naming why.
  const warns = stderr.split('\n').filter((l) => l.includes('Seamless stitch skipped'));
  assert.equal(warns.length, 1, `expected exactly one fallback warning, got:\n${stderr}`);
  assert.match(warns[0], /not runnable/);

  const p = await probeClip(master);
  assert.ok(fs.existsSync(master));
  assert.equal(p.hasAudio, true);
  assert.ok(p.duration > 3, `expected the full concatenated length, got ${p.duration}s`);
  // A hard cut keeps every frame of both clips — nothing is dropped and nothing overlaps.
  const both = (2 * FRAMES) / FPS;
  assert.ok(Math.abs(p.duration - both) < 0.2, `concat should be ~${both}s, got ${p.duration}s`);
  assert.equal(fs.readdirSync(tmp.dir).filter((f) => f.includes('seamstitch')).length, 0, 'no temp files left behind');
});

test('SEAMLESS: chained clips are colour-matched, crossfaded and delivered at the canvas', { skip: NEED_BOTH }, async () => {
  const master = path.join(tmp.dir, 'seamless.mp4');
  const { assembleVideo } = await import('../../src/lib/assemble.js');
  const res = await assembleVideo(clips(), master, { nativeAudio: true, aspect: '16:9', continuity: [true] });

  assert.equal(res.stitcher, 'seamless');
  assert.equal(res.joints, 1);
  assert.equal(res.matched, 1);

  const p = await probeClip(master);
  assert.equal(p.hasAudio, true);
  assert.equal(await audioRate(master), 48000);

  // Never upscales: the master lands exactly on the canvas assemble.js chose for these sources.
  const canvas = canvasFor('16:9', Math.min(160, 90));
  assert.equal(p.width, canvas.w);
  assert.equal(p.height, canvas.h);
  assert.equal(Math.round(p.fps), FPS);

  // Σ lengths − the crossfade, with the shared boundary frame dropped once (stitch-math is the
  // independent re-derivation; the concat path above delivers a frame MORE than this).
  const expected = computeOffsets([FRAMES, FRAMES], FPS, XFADE).expectedDuration;
  assert.ok(Math.abs(p.duration - expected) <= 1 / FPS + 0.05, `expected ~${expected}s, got ${p.duration}s`);
  assert.ok(p.duration < (2 * FRAMES) / FPS, 'a crossfaded stitch must be shorter than a hard cut');
  assert.equal(fs.readdirSync(tmp.dir).filter((f) => f.includes('seamstitch')).length, 0, 'no temp files left behind');
});

test('MIXED: a re-rendered segment hard-cuts its own joint and the rest still stitch', { skip: NEED_BOTH }, async () => {
  // The whole point of per-joint lineage: before it this cut fell back to a hard cut at EVERY seam,
  // because the run could only say "chained" or "not chained" about all of it at once.
  const master = path.join(tmp.dir, 'mixed.mp4');
  const { assembleVideo } = await import('../../src/lib/assemble.js');
  const { readContinuity } = await import('../../src/lib/seamstitch.js');
  const segs = fixture.segments;

  const continuity = readContinuity(mixedRender(segs), segs.length, { ...config.stitch, assumeContinuous: false });
  assert.deepEqual(continuity, [false, true], 'derived from the recorded seams, not hand-written');

  const res = await assembleVideo(segs, master, { nativeAudio: true, aspect: '16:9', continuity });
  assert.equal(res.stitcher, 'seamless', 'one broken joint must not cost the other joint its stitch');
  assert.equal(res.joints, 2);
  assert.equal(res.matched, 1, 'exactly the joint the lineage vouches for is colour-matched');

  const p = await probeClip(master);
  assert.equal(p.hasAudio, true);
  const canvas = canvasFor('16:9', Math.min(160, 90));
  assert.equal(p.width, canvas.w);
  assert.equal(p.height, canvas.h);
  // Shorter than a hard cut (the chained joint's shared frame is dropped and crossfaded), but only
  // by that one joint — the cut joint keeps both clips' frames.
  const concatLen = (3 * FRAMES) / FPS;
  assert.ok(p.duration < concatLen, `a stitched joint must shorten the master (${p.duration}s vs ${concatLen}s)`);
  assert.ok(p.duration > concatLen - 2 * XFADE, `only ONE joint was crossfaded, got ${p.duration}s`);
  assert.equal(fs.readdirSync(tmp.dir).filter((f) => f.includes('seamstitch')).length, 0, 'no temp files left behind');
});

test('STITCH_SEAMLESS=off keeps the concat path even with continuity declared', { skip: NEED_BOTH }, async () => {
  const master = path.join(tmp.dir, 'off.mp4');
  const { result } = assembleWithEnv({ STITCH_SEAMLESS: 'off' }, clips(), master,
    { nativeAudio: true, aspect: '16:9', continuity: [true] });
  assert.equal(result.stitcher, 'concat');
  assert.ok((await probeClip(master)).duration > 3);
});

test('an all-cut map is a hard cut BY DESIGN — no warning, and force does not fail it', { skip: NEED_FF }, () => {
  // Per-joint lineage makes "every joint is a cut" the ordinary answer for a run that never chained
  // (a Kling text-to-video render, chaining switched off). Nothing was downgraded, so there is
  // nothing to warn about — and STITCH_SEAMLESS=force must not turn the correct master into an error.
  const master = path.join(tmp.dir, 'allcuts.mp4');
  const { result, stderr } = assembleWithEnv(
    { PYTHON_BIN: '/nonexistent/python3', STITCH_SEAMLESS: 'force', LOG_LEVEL: 'warn' },
    clips(), master, { nativeAudio: true, aspect: '16:9', continuity: [false] },
  );
  assert.equal(result.stitcher, 'concat');
  assert.equal(stderr.includes('Seamless stitch skipped'), false, `an all-cut timeline is not a downgrade:\n${stderr}`);
});

test('STITCH_SEAMLESS=force turns a fallback into a loud failure instead of a quiet downgrade', { skip: NEED_FF }, () => {
  const master = path.join(tmp.dir, 'force.mp4');
  assert.throws(
    () => assembleWithEnv(
      { PYTHON_BIN: '/nonexistent/python3', STITCH_SEAMLESS: 'force' },
      clips(), master, { nativeAudio: true, aspect: '16:9', continuity: [true] },
    ),
    (e) => /Seamless stitch required \(STITCH_SEAMLESS=force\)/.test(e.stderr),
  );
  assert.equal(fs.existsSync(master), false, 'force must not leave a half-made master');
});

test('no continuity means no seamless attempt — the default stays a hard cut', { skip: NEED_FF }, async () => {
  const master = path.join(tmp.dir, 'nocontinuity.mp4');
  const { assembleVideo } = await import('../../src/lib/assemble.js');
  const res = await assembleVideo(clips(), master, { nativeAudio: true, aspect: '16:9' });
  assert.equal(res.stitcher, 'concat');
  assert.equal(res.matched, 0);
});
