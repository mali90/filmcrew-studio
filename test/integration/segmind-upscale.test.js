// Segmind Topaz upscale, end to end through the render pipeline's --upscale path.
//
// This is the last piece of the Segmind-ONLY story: render on Segmind, upscale on Segmind, finish a
// 1080p film without a fal key existing anywhere. It is also where the frame-rate trap becomes real
// money — Segmind's topaz-video-upscale defaults `target_fps` to 60, so an unpinned call would hand
// back an interpolated clip that no longer matches the take (and cost a full upscale to discover).
//
// The mock's clips are real 15fps ffmpeg output, so "pinned to the SOURCE rate" is observable:
// target_fps must be 15 here, and must never be 60.
//
// TDD (red first): src/lib/upscale.js has no provider dispatch and config.upscale has no `provider`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
import { hasFfmpeg, tinyMp4Bytes } from '../helpers/ffmpeg-clips.js';
import { startSegmindServer } from '../helpers/segmind-server.js';

const FF = await hasFfmpeg();
const sg = await startSegmindServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

neutralizeDotenv();
const voices = mkTmp('sgup-voices');
Object.assign(process.env, {
  SEGMIND_BASE_URL: sg.baseUrl, SEGMIND_API_KEY: 'sk-test',
  SEGMIND_UPLOAD_MODE: 'data-uri', SEGMIND_MAX_RETRIES: '1', SEGMIND_RETRY_BACKOFF_MS: '1',
  SEGMIND_TOPAZ_SLUG: 'topaz-video-upscale',
  FAL_KEY: '', FAL_API_KEY: '',          // no fal anywhere: this is the Segmind-only install
  UPSCALE_PROVIDER: 'auto',
  RENDER_BACKEND: 'seedance-2.5@segmind',
  VOICES_DIR: voices.dir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
  LOG_LEVEL: 'error',
});
const config = (await import('../../config.js')).default;
const out = mkTmp('sgup-out');
const cache = mkTmp('sgup-cache');
config.paths.out = out.dir;
config.paths.cache = cache.dir;
const { renderSpec } = await import('../../src/lib/pipeline.js');

const topazPosts = (from) => sg.requests.slice(from)
  .filter((q) => q.method === 'POST' && q.path === '/v2/topaz-video-upscale')
  .map((q) => JSON.parse(q.body));

test.before(() => fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}'));
test.after(async () => { await sg.close(); out.cleanup(); cache.cleanup(); voices.cleanup(); });

test('config.upscale gains a provider (auto) and a target resolution (1080p, 4k only on purpose)', () => {
  assert.equal(config.upscale.provider, 'auto');        // UPSCALE_PROVIDER
  assert.equal(config.upscale.targetResolution, '1080p'); // UPSCALE_TARGET_RESOLUTION
  assert.equal(config.segmind.topazSlug, 'topaz-video-upscale');
});

test('--upscale on a Segmind run calls SEGMIND Topaz per clip, with target_fps pinned to the source',
  { skip: FF ? false : 'ffmpeg not installed' }, async () => {
    const { dir, cleanup } = mkTmp('sgup-run');
    try {
      const spec = loadGoldenSpec();
      spec.kling.jobs = [
        { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
        { job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'] },
      ];
      const before = sg.requests.length;
      const r = await renderSpec(spec, { runDir: dir, upscale: true });
      assert.ok(r.master && fs.existsSync(r.master));

      const jobs = topazPosts(before);
      assert.equal(jobs.length, 2, 'per-CLIP upscale, before the stitch — one Topaz job per rendered clip');
      for (const [i, args] of jobs.entries()) {
        assert.equal(args.target_fps, 15, `clip ${i + 1}: pinned to the PROBED source rate`);
        assert.notEqual(args.target_fps, 60, 'Segmind\'s default would frame-interpolate the take');
        assert.equal(args.target_resolution, '1080p', 'the short-side plan maps onto Segmind\'s enum');
        assert.ok(args.video, 'the source rides Segmind\'s `video` key');
        assert.ok(!('upscale_factor' in args), 'Segmind has no factor parameter — that is fal\'s API');
      }
    } finally { cleanup(); }
  });

test('UPSCALE_PROVIDER=auto followed the RUN\'s provider — nothing was sent to fal',
  { skip: FF ? false : 'ffmpeg not installed' }, () => {
    // The whole run above happened with FAL_KEY unset. If the dispatch had defaulted to fal, the
    // upscale would have thrown "FAL_KEY not set" instead of producing a master.
    assert.equal(config.fal.apiKey, '');
    assert.ok(sg.queued.some((j) => j.slug === 'topaz-video-upscale'), 'the Topaz job ran on Segmind');
  });

test('UPSCALE_TARGET_RESOLUTION=4k is honoured only when someone actually asks for it',
  { skip: FF ? false : 'ffmpeg not installed' }, async () => {
    const { dir, cleanup } = mkTmp('sgup-4k');
    const prev = config.upscale.targetResolution;
    config.upscale.targetResolution = '4k';
    try {
      const spec = loadGoldenSpec();
      spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['subject'] }];
      const before = sg.requests.length;
      await renderSpec(spec, { runDir: dir, upscale: true });
      assert.equal(topazPosts(before)[0].target_resolution, '4k');
    } finally { config.upscale.targetResolution = prev; cleanup(); }
  });

test('a clip already at/above the target is skipped — no Topaz job, no charge',
  { skip: FF ? false : 'ffmpeg not installed' }, async () => {
    const { dir, cleanup } = mkTmp('sgup-skip');
    const prev = config.upscale.targetResolution;
    config.upscale.targetResolution = '720p'; // the mock clips are 128x128 → still under, so use a real no-op instead
    try {
      const { upscaleVideoSegmind } = await import('../../src/lib/upscale.js');
      const big = mkTmp('sgup-big');
      try {
        const src = path.join(big.dir, 'big.mp4');
        const { makeClip } = await import('../helpers/ffmpeg-clips.js');
        await makeClip({ out: src, seconds: 1, size: '1920x1080', fps: 24 });
        const before = sg.requests.length;
        const same = await upscaleVideoSegmind({ inPath: src, outDir: big.dir });
        assert.equal(same, src, 'already ≥1080p short side → the input path comes back unchanged');
        assert.equal(topazPosts(before).length, 0, 'nothing was submitted, so nothing was billed');
      } finally { big.cleanup(); }
    } finally { config.upscale.targetResolution = prev; cleanup(); }
  });

test('Topaz dropping the audio track is repaired — the SOURCE audio is re-muxed onto the upscale',
  { skip: FF ? false : 'ffmpeg not installed' }, async () => {
    const { dir, cleanup } = mkTmp('sgup-audio');
    try {
      const { upscaleVideoSegmind } = await import('../../src/lib/upscale.js');
      const { makeClip } = await import('../helpers/ffmpeg-clips.js');
      const src = path.join(dir, 'with-audio.mp4');
      const silent = path.join(dir, 'silent.mp4');
      await makeClip({ out: src, seconds: 1, size: '128x128', fps: 15 });                    // 440Hz tone
      await makeClip({ out: silent, seconds: 1, size: '128x128', fps: 15, withAudio: false }); // what Topaz returns
      sg.opts.upscaledBytes = fs.readFileSync(silent);
      const out = await upscaleVideoSegmind({ inPath: src, outDir: dir });
      assert.match(out, /upscaled_with_audio\.mp4$/, 'the silent Topaz output was re-muxed, not shipped mute');
      assert.ok(fs.existsSync(out));
    } finally { delete sg.opts.upscaledBytes; cleanup(); }
  });

test('a Segmind Topaz failure surfaces the provider detail without re-POSTing the (paid) job',
  { skip: FF ? false : 'ffmpeg not installed' }, async () => {
    const { dir, cleanup } = mkTmp('sgup-fail');
    try {
      const { upscaleVideoSegmind } = await import('../../src/lib/upscale.js');
      const src = path.join(dir, 'small.mp4');
      const { makeClip } = await import('../helpers/ffmpeg-clips.js');
      await makeClip({ out: src, seconds: 1, size: '128x128', fps: 15 });
      sg.opts.failed = true;
      const before = sg.requests.length;
      await assert.rejects(upscaleVideoSegmind({ inPath: src, outDir: dir }), /rejected the job/);
      assert.equal(topazPosts(before).length, 1, 'exactly one billable submit, however it ended');
    } finally { sg.opts.failed = false; cleanup(); }
  });
