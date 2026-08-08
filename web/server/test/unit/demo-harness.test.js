// The zero-spend demo harness (web/server/dev/demo.js) is what Playwright e2e drives and what a
// human uses to walk the app for free. The moment a Segmind backend is selectable in the UI, the
// demo has to be able to render it — otherwise "try Seedance 2.5 on Segmind" in the demo reaches for
// api.segmind.com with a fake key and hangs, or worse, a real key and bills.
//
// demo.js starts servers on import, so it is asserted at the SOURCE level (the same technique as the
// environments-route leak canary). These are structural facts, not prose:
//   * it boots the segmind mock alongside the fal mock
//   * childEnv points the render child at BOTH mocks, including the 2.5 endpoint and the Topaz slug
//   * /__demo/segmind-opts mirrors /__demo/fal-opts so e2e can flip failure modes
//   * /__demo/health reports the segmind base url
//   * SIGINT/SIGTERM close it (a leaked listener wedges the next `npm run demo` on EADDRINUSE)
//
// TDD (red first): demo.js knows nothing about Segmind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SRC = fs.readFileSync(path.join(ROOT, 'web/server/dev/demo.js'), 'utf8');

test('the demo boots the Segmind mock next to the fal mock', () => {
  assert.match(SRC, /test\/helpers\/segmind-server\.js/, 'it imports the same mock the suite uses');
  assert.match(SRC, /startSegmindServer\(/);
  // real ffmpeg clips for BOTH mocks, or a Segmind render produces bytes the player cannot show
  assert.match(SRC, /startSegmindServer\(\{[^}]*videoBytes/s, 'the segmind mock serves the same tiny mp4');
});

test('childEnv points the render child at the mocks — every Segmind knob included', () => {
  for (const key of [
    'SEGMIND_BASE_URL', 'SEGMIND_API_KEY', 'SEGMIND_UPLOAD_MODE',
    'SEGMIND_SEEDANCE25_SLUG', 'SEGMIND_SEEDANCE20_SLUG', 'SEGMIND_TOPAZ_SLUG',
    'FAL_SEEDANCE25_ENDPOINT',
  ]) {
    assert.match(SRC, new RegExp(`\\b${key}\\b`), `childEnv must set ${key}`);
  }
  // data-uri: the demo has no fal storage for Segmind refs, and this is the keyless path anyway
  assert.match(SRC, /SEGMIND_UPLOAD_MODE:\s*'data-uri'/);
  // the mock's base url, never the real host
  assert.ok(!/api\.segmind\.com/.test(SRC), 'the demo must never name the real Segmind host');
});

test('/__demo/segmind-opts mirrors /__demo/fal-opts, and health reports the mock', () => {
  assert.match(SRC, /'\/__demo\/segmind-opts'/, 'e2e flips segmind failure modes the same way it flips fal\'s');
  assert.match(SRC, /segmind\.opts/, 'it assigns onto the mock\'s mutable opts object');
  assert.match(SRC, /__demo\/health[\s\S]{0,260}segmind/, 'health names the segmind mock so a walkthrough can verify it');
});

test('both mocks are closed on SIGINT and SIGTERM (a leaked listener wedges the next demo run)', () => {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const block = SRC.match(new RegExp(`process\\.on\\('${sig}'[\\s\\S]{0,220}?\\}\\);`));
    assert.ok(block, `${sig} handler exists`);
    assert.match(block[0], /segmind\.close\(\)/, `${sig} closes the segmind mock`);
    assert.match(block[0], /fal\.close\(\)/, `${sig} still closes the fal mock`);
  }
});
