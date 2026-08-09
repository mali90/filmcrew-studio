// src/lib/upscale.js is 100% fal/Topaz-hardcoded today. Segmind runs Topaz too (slug
// `topaz-video-upscale`), and a Segmind-only install has to be able to finish a film — so upscaling
// grows a provider dispatch. These are the PURE pieces of it, asserted without ffmpeg or a network.
//
// The dangerous one is the frame rate. Segmind's Topaz takes `target_fps` (15–120) and DEFAULTS TO
// 60 — hand it our 24fps (or the tests' 15fps) clip and it silently FRAME-INTERPOLATES, inventing
// motion the take never had and changing the film. fal's factor-based API has no such parameter, so
// nothing in the existing code protects against it. `target_fps` must therefore be pinned to the
// PROBED source rate, and must never be allowed to fall back to 60.
//
// TDD (red first): resolveUpscaleProvider / segmindTopazArgs / parseFrameRate do not exist, and
// config.upscale has only `enabled`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { resolveUpscaleProvider, segmindTopazArgs, parseFrameRate, upscalePlan } = await import('../../src/lib/upscale.js');

// ── provider choice ─────────────────────────────────────────────────────────
// UPSCALE_PROVIDER=auto|fal|segmind. `auto` follows the RUN'S render provider — a Segmind render
// upscales on Segmind, so the master never makes a round trip through a second vendor — and falls
// back to whichever provider actually has a key configured.
test('an explicit provider always wins, whatever the run rendered on', () => {
  for (const runProvider of ['fal', 'segmind', null]) {
    assert.equal(resolveUpscaleProvider({ configured: 'fal', runProvider, hasFalKey: true, hasSegmindKey: true }), 'fal');
    assert.equal(resolveUpscaleProvider({ configured: 'segmind', runProvider, hasFalKey: true, hasSegmindKey: true }), 'segmind');
  }
  // …even when its key is missing: the caller reports "set SEGMIND_API_KEY", which is far more
  // useful than silently billing the other vendor for work the user did not ask them to do.
  assert.equal(resolveUpscaleProvider({ configured: 'segmind', runProvider: 'fal', hasFalKey: true, hasSegmindKey: false }), 'segmind');
});

test('auto follows the run\'s render provider when that provider is configured', () => {
  assert.equal(resolveUpscaleProvider({ configured: 'auto', runProvider: 'segmind', hasFalKey: true, hasSegmindKey: true }), 'segmind');
  assert.equal(resolveUpscaleProvider({ configured: 'auto', runProvider: 'fal', hasFalKey: true, hasSegmindKey: true }), 'fal');
});

test('auto falls back to whichever provider HAS a key (a Segmind-only install upscales on Segmind)', () => {
  assert.equal(resolveUpscaleProvider({ configured: 'auto', runProvider: 'fal', hasFalKey: false, hasSegmindKey: true }), 'segmind');
  assert.equal(resolveUpscaleProvider({ configured: 'auto', runProvider: 'segmind', hasFalKey: true, hasSegmindKey: false }), 'fal');
  assert.equal(resolveUpscaleProvider({ configured: 'auto', runProvider: null, hasFalKey: false, hasSegmindKey: true }), 'segmind');
  assert.equal(resolveUpscaleProvider({ configured: 'auto', runProvider: null, hasFalKey: true, hasSegmindKey: false }), 'fal');
});

test('auto with no keys at all resolves to fal — the familiar FAL_KEY error is the right one', () => {
  assert.equal(resolveUpscaleProvider({ configured: 'auto', runProvider: null, hasFalKey: false, hasSegmindKey: false }), 'fal');
  assert.equal(resolveUpscaleProvider({}), 'fal', 'a bare call is the shipped default');
});

test('an unknown UPSCALE_PROVIDER is rejected loudly, listing the three legal values', () => {
  assert.throws(() => resolveUpscaleProvider({ configured: 'runway', hasFalKey: true }), (e) => {
    assert.match(e.message, /runway/);
    for (const v of ['auto', 'fal', 'segmind']) assert.ok(e.message.includes(v), v);
    return true;
  });
});

// ── frame rate: the interpolation trap ──────────────────────────────────────
test('parseFrameRate reads ffprobe\'s r_frame_rate fraction; unreadable input is 0, never a guess', () => {
  assert.equal(parseFrameRate('24/1'), 24);
  assert.equal(parseFrameRate('30000/1001'), 30);   // 29.97 → 30
  assert.equal(parseFrameRate('24000/1001'), 24);   // 23.976 → 24
  assert.equal(parseFrameRate('15/1'), 15);
  assert.equal(parseFrameRate('60/1'), 60);
  for (const bad of ['', '0/0', 'N/A', null, undefined, 'nonsense']) {
    assert.equal(parseFrameRate(bad), 0, JSON.stringify(bad));
  }
});

test('segmindTopazArgs PINS target_fps to the probed source rate — never Segmind\'s 60 default', () => {
  const a = segmindTopazArgs('https://cdn/x.mp4', { targetResolution: '1080p', sourceFps: 24 });
  assert.equal(a.video, 'https://cdn/x.mp4', 'Segmind\'s key is `video`, not fal\'s `video_url`');
  assert.equal(a.target_resolution, '1080p');
  assert.equal(a.target_fps, 24, 'the clip keeps its own cadence — 60 would fabricate frames');
  assert.equal(segmindTopazArgs('u', { sourceFps: 15 }).target_fps, 15);
  assert.equal(segmindTopazArgs('u', { sourceFps: 23.976 }).target_fps, 24);
  // and nothing fal-shaped leaks across
  for (const k of ['upscale_factor', 'model', 'video_url']) {
    assert.ok(!(k in segmindTopazArgs('u', { sourceFps: 24 })), `${k} is a fal parameter`);
  }
});

test('an unprobeable source falls back to 24 (both Seedance models render 24fps), NEVER 60', () => {
  for (const fps of [0, null, undefined, NaN]) {
    assert.equal(segmindTopazArgs('u', { sourceFps: fps }).target_fps, 24, String(fps));
  }
});

test('target_fps is clamped into Segmind\'s documented 15–120 window', () => {
  assert.equal(segmindTopazArgs('u', { sourceFps: 8 }).target_fps, 15);
  assert.equal(segmindTopazArgs('u', { sourceFps: 240 }).target_fps, 120);
});

// ── resolution: the short-side plan → Segmind's enum ────────────────────────
test('target_resolution defaults to 1080p and reaches 4k ONLY when explicitly configured', () => {
  assert.equal(segmindTopazArgs('u', { sourceFps: 24 }).target_resolution, '1080p');
  assert.equal(segmindTopazArgs('u', { sourceFps: 24, targetResolution: '720p' }).target_resolution, '720p');
  assert.equal(segmindTopazArgs('u', { sourceFps: 24, targetResolution: '4k' }).target_resolution, '4k');
  // 4k is 4× the pixels and 4× the bill: an auto-derived plan must never reach it
  for (const plan of [upscalePlan(480, 854), upscalePlan(100, 100)]) {
    assert.ok(plan.needsUpscale);
    assert.notEqual(segmindTopazArgs('u', { sourceFps: 24, targetShort: 1080 }).target_resolution, '4k');
  }
  assert.throws(() => segmindTopazArgs('u', { sourceFps: 24, targetResolution: '8k' }), /8k/);
});
