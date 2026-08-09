// Real ffmpeg tiny-clip generator for assembly tests. Gate tests on hasFfmpeg().
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function hasFfmpeg() {
  return new Promise((r) => {
    const c = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
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
    c.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${e.slice(-400)}`))));
  });
}

/** Make a tiny clip (128x128, 15fps by default). `withAudio` adds a 440Hz tone; `fps` sets its rate. */
export function makeClip({ out, seconds = 1, withAudio = true, size = '128x128', fps = 15 }) {
  const a = ['-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}:duration=${seconds}`];
  if (withAudio) a.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  a.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (withAudio) a.push('-c:a', 'aac');
  a.push('-shortest', out);
  return run('ffmpeg', a);
}

/**
 * A clip that STARTS one solid colour and ENDS another, so a first-frame grab and a last-frame grab
 * are distinguishable by pixel value rather than by "the bytes differ" (WS2-P1's firstFrameOf).
 * `seconds` is per half, so the clip runs 2×seconds.
 */
export function makeTwoToneClip({ out, first = 'red', last = 'blue', seconds = 1, size = '128x128', fps = 15 }) {
  return run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${first}:s=${size}:r=${fps}:d=${seconds}`,
    '-f', 'lavfi', '-i', `color=c=${last}:s=${size}:r=${fps}:d=${seconds}`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
  ]);
}

/** The RGB triple of an image's centre pixel, via ffmpeg (no image library in this repo). */
export function pixelRgb(imagePath) {
  return new Promise((resolve, reject) => {
    const c = spawn('ffmpeg', ['-v', 'error', '-i', imagePath, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let err = '';
    c.stdout.on('data', (d) => chunks.push(d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < 3) return reject(new Error(`ffmpeg pixel read failed (${code}): ${err.slice(-200)}`));
      resolve([buf[0], buf[1], buf[2]]);
    });
  });
}

let cachedBytes = null;
/** Bytes of one real, ffprobe-parseable tiny mp4 (built once). Requires ffmpeg (check hasFfmpeg first). */
export async function tinyMp4Bytes() {
  if (cachedBytes) return cachedBytes;
  const tmp = path.join(os.tmpdir(), `kva-tiny-${process.pid}.mp4`);
  await makeClip({ out: tmp, seconds: 1, withAudio: true });
  cachedBytes = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return cachedBytes;
}
