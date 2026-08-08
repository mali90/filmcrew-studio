// Chained-generation fixtures for the seamless stitcher, after §10.1 of
// tools/seamstitch/SEAMLESS_STITCH_SPEC.md: cut three segments out of ONE continuous source so they
// overlap by exactly one frame (segment j starts on segment j-1's last frame), then apply a per-
// segment grade shift AFTER the trim, so the duplicated frame carries the shift too — exactly how a
// chained generator drifts. Gate these on hasFfmpeg() + hasSeamstitch(), like the other ffmpeg tests.
//
// Two deliberate departures from §10.1, both measured against the §9 verify gate on this machine:
//
// 1. The base is a HELD frame, not animated testsrc2. §9's drift gate compares mean luma 0.5 s either
//    side of a joint; on animated testsrc2 that measures the CONTENT moving, not the seam — the raw
//    ungraded base scored drift 2.34 at its own joint 1, over the 1.5 threshold, before any stitching.
//    A held frame keeps the gate measuring what it is for.
// 2. The base frame is levels-compressed (eq=contrast) so §10.1's grade shifts have headroom. At full
//    range, brightness=+0.06 clips testsrc2's white bars at 255, and clipped highlights are info no
//    LUT can recover: the corrected segment stayed ~2 luma dark and the gate failed the tool for an
//    artifact of the fixture. The tool targets a generator's slight drift, not a blown test chart.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The tools/ dir that must be on PYTHONPATH for `-m seamstitch` to resolve. */
export const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools');

/** True iff `python3 -m seamstitch` can import (needs numpy + pillow). Mirrors hasFfmpeg(). */
export function hasSeamstitch({ python = 'python3', root = null } = {}) {
  const tools = root ?? TOOLS_DIR;
  return new Promise((r) => {
    const c = spawn(python, ['-c', 'import numpy, PIL, seamstitch'], {
      env: { ...process.env, PYTHONPATH: tools },
      stdio: 'ignore',
    });
    c.on('error', () => r(false));
    c.on('close', (code) => r(code === 0));
  });
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = '';
    c.stderr.on('data', (d) => (e += d));
    c.on('error', rej);
    c.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${e.slice(-500)}`))));
  });
}

const X264 = ['-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];

/**
 * Build base.mp4 + seg01/seg02/seg03.mp4 in `dir`, overlapping exactly one frame each.
 * Returns { dir, fps, frames, size, base, segments: [seg01, seg02, seg03] }.
 */
export async function makeChainedClips({ dir, fps = 24, size = '160x96', frames = 48 } = {}) {
  const p = (n) => path.join(dir, n);
  const totalFrames = 3 * frames - 2;      // three segments sharing one frame at each of the two joints
  const duration = (totalFrames + 2) / fps; // a little tail so the last trim always has frames to take

  // One textured frame, levels-compressed so the grade shifts below have room and never clip.
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=1:duration=1`,
    '-vf', 'eq=contrast=0.62:brightness=-0.03', '-frames:v', '1', p('base.png')]);
  // ...held for the whole take, with the spec's 330 Hz tone under it.
  await run('ffmpeg', ['-y', '-v', 'error', '-loop', '1', '-t', String(duration), '-i', p('base.png'),
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=44100:duration=${duration}`,
    '-r', String(fps), ...X264, '-shortest', p('base.mp4')]);

  // Grades come AFTER the trim so the shared boundary frame is graded too — the generator's drift.
  const cuts = [
    { out: 'seg01.mp4', start: 0, grade: null },
    { out: 'seg02.mp4', start: frames - 1, grade: 'eq=brightness=0.06:saturation=1.15' },
    { out: 'seg03.mp4', start: 2 * frames - 2, grade: 'eq=brightness=-0.05:gamma_g=1.06' },
  ];
  const segments = [];
  for (const { out, start, grade } of cuts) {
    const end = start + frames;
    const vf = [`trim=start_frame=${start}:end_frame=${end}`, 'setpts=PTS-STARTPTS', ...(grade ? [grade] : [])].join(',');
    const af = `atrim=${(start / fps).toFixed(7)}:${(end / fps).toFixed(7)},asetpts=PTS-STARTPTS`;
    await run('ffmpeg', ['-y', '-v', 'error', '-i', p('base.mp4'), '-vf', vf, '-af', af, ...X264, p(out)]);
    segments.push(p(out));
  }
  return { dir, fps, frames, size, base: p('base.mp4'), segments };
}

/**
 * Re-encode `seg` at another resolution, the way a generator returns a different bucket: the same
 * scene on a different pixel grid, NOT a stretched one. The scale is AR-preserving (cover + crop) on
 * purpose — a bare `scale=WxH` would squeeze the picture, which is the regression ADDENDUM_AR §6's
 * geometry gate is built to FAIL on, not something a `--fit cover` run should be asked to swallow.
 */
export async function reencodeAt(seg, size, out = null) {
  const [w, h] = String(size).split('x').map(Number);
  const dest = out ?? path.join(path.dirname(seg), `${path.basename(seg, '.mp4')}-${w}x${h}.mp4`);
  await run('ffmpeg', ['-y', '-v', 'error', '-i', seg,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`,
    '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', dest]);
  return dest;
}
