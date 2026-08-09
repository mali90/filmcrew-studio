// WS2-P1 (WS2-03) — firstFrameOf(): grab a clip's OPENING frame.
//
// P5 conditions a re-rendered segment's END on the NEXT clip's opening frame, which is the one
// boundary today's pipeline has no way to produce (lastFrameOf only reads backwards from a clip's
// tail). Contract mirrors lastFrameOf exactly: best-effort, ensureDir, returns the path or null,
// NEVER throws — a failed frame grab must degrade a seam, never kill a paid render.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { hasFfmpeg, makeTwoToneClip, pixelRgb } from '../helpers/ffmpeg-clips.js';
import { armed, pending } from '../helpers/tdd.js';

neutralizeDotenv();
const FF = await hasFfmpeg();
const assemble = await import('../../src/lib/assemble.js');
const ready = typeof assemble.firstFrameOf === 'function';
const PENDING = pending(ready, 'WS2-03: src/lib/assemble.js#firstFrameOf');
const skipNoFfmpeg = FF ? {} : { skip: 'ffmpeg not installed' };
const opts = { ...PENDING, ...skipNoFfmpeg };

test('firstFrameOf is exported both named and on the module default (mirrors lastFrameOf)', PENDING, () => {
  assert.equal(typeof assemble.firstFrameOf, 'function');
  assert.equal(typeof assemble.default.firstFrameOf, 'function');
  assert.equal(assemble.default.firstFrameOf, assemble.firstFrameOf);
});

test('firstFrameOf writes a PNG and returns its path, creating the parent directory', opts, async () => {
  const { dir, cleanup } = mkTmp('first-frame');
  try {
    const clip = path.join(dir, 'clip.mp4');
    await makeTwoToneClip({ out: clip });
    const png = path.join(dir, 'nested', 'deeper', 'first_frame.png');
    const got = await assemble.firstFrameOf(clip, png);
    assert.equal(got, png, 'returns the path it wrote (never a boolean)');
    assert.ok(fs.existsSync(png));
    assert.ok(fs.statSync(png).size > 0, 'a real still, not a zero-byte file');
    assert.equal(fs.readFileSync(png).subarray(1, 4).toString('ascii'), 'PNG', 'PNG magic bytes');
  } finally { cleanup(); }
});

test("firstFrameOf and lastFrameOf disagree on a clip whose ends are different colours", opts, async () => {
  const { dir, cleanup } = mkTmp('first-vs-last');
  try {
    const clip = path.join(dir, 'two-tone.mp4');
    await makeTwoToneClip({ out: clip, first: 'red', last: 'blue', seconds: 1 });
    const firstPng = await assemble.firstFrameOf(clip, path.join(dir, 'first.png'));
    const lastPng = await assemble.lastFrameOf(clip, path.join(dir, 'last.png'));
    assert.ok(firstPng && lastPng);

    const [fr, fg, fb] = await pixelRgb(firstPng);
    const [lr, lg, lb] = await pixelRgb(lastPng);
    assert.ok(fr > 150 && fb < 100, `the opening frame is the RED half (got ${fr},${fg},${fb})`);
    assert.ok(lb > 150 && lr < 100, `the closing frame is the BLUE half (got ${lr},${lg},${lb})`);
    assert.notEqual(fs.readFileSync(firstPng).toString('base64'), fs.readFileSync(lastPng).toString('base64'));
  } finally { cleanup(); }
});

test('firstFrameOf resolves null (never throws) on a missing or unreadable input', opts, async () => {
  const { dir, cleanup } = mkTmp('first-frame-bad');
  try {
    assert.equal(await assemble.firstFrameOf(path.join(dir, 'does-not-exist.mp4'), path.join(dir, 'a.png')), null);

    const garbage = path.join(dir, 'garbage.mp4');
    fs.writeFileSync(garbage, 'this is not a video');
    assert.equal(await assemble.firstFrameOf(garbage, path.join(dir, 'b.png')), null);

    // Same contract as lastFrameOf, checked side by side so the two can never drift apart.
    assert.equal(await assemble.lastFrameOf(garbage, path.join(dir, 'c.png')), null);
  } finally { cleanup(); }
});
