// The ffmpeg version floor behind doctor's `ffmpeg-version` check. Parsing is a pure function over
// the `ffmpeg -version` banner, so this spawns nothing; the check row itself is exercised in
// test/e2e/doctor.cli.test.js. Floor is 4.3 because the seamless stitcher crossfades with `xfade`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { parseFfmpegVersion, ffmpegVersionOk, FFMPEG_MIN_VERSION } = await import('../../src/lib/preflight.js');

const banner = (v) => `ffmpeg version ${v} Copyright (c) 2000-2024 the FFmpeg developers\nbuilt with clang 15\n`;

test('parses the release out of real-world banners', () => {
  const cases = [
    ['6.1.1-3ubuntu5', 6, 1],   // Debian/Ubuntu glue the packaging revision on
    ['8.1.2', 8, 1],
    ['n7.1', 7, 1],             // Arch and BtbN builds prefix with n
    ['4.2.7', 4, 2],
    ['4.3', 4, 3],
    ['5', 5, 0],                // no minor at all ⇒ .0
  ];
  for (const [v, major, minor] of cases) {
    const parsed = parseFfmpegVersion(banner(v));
    assert.deepEqual([parsed?.major, parsed?.minor], [major, minor], v);
    assert.equal(parsed.release, v);
  }
});

test('a git snapshot has no release number — unknown, not too old', () => {
  const parsed = parseFfmpegVersion(banner('N-1234-gabcdef'));
  assert.equal(parsed, null);
  assert.equal(ffmpegVersionOk(parsed), true);
});

test('garbage and empty output parse to unknown, and unknown PASSES', () => {
  for (const out of ['', '   ', null, undefined, 'not ffmpeg at all\n', 'ffmpeg\n', 'ffmpeg version\n', 'ffmpeg version -\n']) {
    assert.equal(parseFfmpegVersion(out), null, JSON.stringify(out));
  }
  // A binary that runs but won't label itself is no evidence of a problem — doctor must not cry wolf.
  assert.equal(ffmpegVersionOk(null), true);
});

test(`the floor is ${FFMPEG_MIN_VERSION}: 4.2.x fails, 4.3 passes`, () => {
  assert.equal(FFMPEG_MIN_VERSION, '4.3');
  const ok = (v) => ffmpegVersionOk(parseFfmpegVersion(banner(v)));
  assert.equal(ok('4.2.7'), false);
  assert.equal(ok('3.4.11'), false);
  assert.equal(ok('4.3'), true);
  assert.equal(ok('4.4.4'), true);
  assert.equal(ok('6.1.1-3ubuntu5'), true);
  assert.equal(ok('n7.1'), true);
  assert.equal(ok('10.0'), true); // numeric compare, not string: "10" beats "4"
});

test('only the first line is read (the banner never repeats below it)', () => {
  const parsed = parseFfmpegVersion('ffmpeg version 4.2.7 Copyright\nffmpeg version 7.1 something else\n');
  assert.equal(parsed.major, 4);
  assert.equal(ffmpegVersionOk(parsed), false);
});
