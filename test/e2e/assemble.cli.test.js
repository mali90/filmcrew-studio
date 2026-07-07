import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, jsonTail } from '../helpers/cli.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
import { hasFfmpeg, makeClip } from '../helpers/ffmpeg-clips.js';

const FF = await hasFfmpeg();

test('assemble --from a prepared run dir stitches the cached clip', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('assemble-cli');
  try {
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(loadGoldenSpec()));
    const clip = path.join(dir, 'K1.mp4');
    await makeClip({ out: clip, seconds: 1, withAudio: true });
    fs.writeFileSync(path.join(dir, 'render.json'), JSON.stringify({ jobs: [{ jobId: 'K1', clip }] }));

    const { code, stdout } = await runCli('src/cli/assemble.js', ['--from', dir],
      { env: { VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false' } });
    assert.equal(code, 0, stdout);
    const r = jsonTail(stdout);
    assert.ok(r.master && fs.existsSync(r.master));
    try { fs.rmSync(r.master); } catch { /* master lands in out/ (gitignored) — best-effort clean */ }
  } finally { cleanup(); }
});
