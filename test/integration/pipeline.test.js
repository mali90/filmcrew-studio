import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
import { hasFfmpeg, tinyMp4Bytes } from '../helpers/ffmpeg-clips.js';
import { startFalServer } from '../helpers/fal-server.js';

const FF = await hasFfmpeg();
const videoBytes = FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4'); // real mp4 so assembly runs

const fal = await startFalServer({ videoBytes });

// Set ALL env BEFORE importing config.js (which snapshots process.env at import), then mutate the
// non-env paths (out/cache) on the config singleton before importing pipeline.js.
neutralizeDotenv();
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit', FAL_CREATE_VOICE_ENDPOINT: 'create-voice',
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('pipeline-out');
const cache = mkTmp('pipeline-cache');
config.paths.out = out.dir;   // paths are read at call time / cloud-refs snapshots cache at its import (below)
config.paths.cache = cache.dir;
const { renderSpec } = await import('../../src/lib/pipeline.js');

test.after(async () => { await fal.close(); out.cleanup(); cache.cleanup(); });

test('renderSpec --probe: renders the first job, skips assembly', async () => {
  const { dir, cleanup } = mkTmp('pipe-probe');
  try {
    const r = await renderSpec(loadGoldenSpec(), { runDir: dir, probe: true });
    assert.equal(r.probe, true);
    assert.ok(r.clip && fs.existsSync(r.clip));
  } finally { cleanup(); }
});

test('renderSpec full: renders → stitches → master mp4', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('pipe-full');
  try {
    const r = await renderSpec(loadGoldenSpec(), { runDir: dir });
    assert.ok(r.master && fs.existsSync(r.master), 'master mp4 exists');
    const { probeClip } = await import('../../src/lib/assemble.js');
    const p = await probeClip(r.master);
    assert.ok(p.duration > 0.5, `master has duration, got ${p.duration}`);
  } finally { cleanup(); }
});

test('repeat renders of one title never overwrite the out/ master (unique -2, -3 names)', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const a = mkTmp('pipe-unique-a');
  const b = mkTmp('pipe-unique-b');
  try {
    const r1 = await renderSpec(loadGoldenSpec(), { runDir: a.dir });
    const r2 = await renderSpec(loadGoldenSpec(), { runDir: b.dir });
    assert.notEqual(r2.master, r1.master, 'second master gets a fresh name');
    assert.ok(fs.existsSync(r1.master) && fs.existsSync(r2.master), 'both masters exist');
    assert.match(r2.master, /-\d+\.mp4$/);
    // an explicit outName is respected (and still uniquified against existing files)
    const c = mkTmp('pipe-unique-c');
    try {
      const r3 = await renderSpec(loadGoldenSpec(), { runDir: c.dir, outName: 'my custom cut' });
      assert.match(r3.master, /my-custom-cut\.mp4$/);
    } finally { c.cleanup(); }
  } finally { a.cleanup(); b.cleanup(); }
});
