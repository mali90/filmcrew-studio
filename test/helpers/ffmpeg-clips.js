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
