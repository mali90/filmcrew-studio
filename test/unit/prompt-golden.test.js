// WS2-P0 HARD GATE — the byte-exact baseline for both prompt builders.
//
// This file pins what src/lib/kling.js and src/lib/seedance.js emit TODAY, byte for byte, across
// every option they take. P0 lifts that logic into pure src/lib/prompt-compose.js +
// prompt-settings.js; the refactor is only allowed to land if this file keeps passing UNMODIFIED
// against an UNCHANGED test/fixtures/prompt-golden.json.
//
// If this goes red, the render payload moved. That is a regression to fix in the source, not a
// fixture to regenerate — regenerate (`node test/helpers/golden-spec.js --write`) ONLY when a
// deliberate prompt change is being shipped, and say so in the commit message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { goldenCases, runCase, readFixture, pinPromptEnv } from '../helpers/golden-spec.js';

// MUST precede the builder imports: config.js snapshots process.env at import time, so a developer's
// KLING_SEGMENT_MAX_BYTES / SEEDANCE_PROMPT_MAX_BYTES (or any .env) would otherwise move the golden.
pinPromptEnv();
const { buildKlingStoryboard } = await import('../../src/lib/kling.js');
const { buildSeedanceJobPrompt } = await import('../../src/lib/seedance.js');
const builders = { buildKlingStoryboard, buildSeedanceJobPrompt };

const fixture = readFixture();
const cases = goldenCases();

/** Byte-level equality with a readable first-divergence report (assert.equal on 1.5 KB is unusable). */
function assertBytesEqual(actual, expected, label) {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (Buffer.compare(a, b) === 0) return;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = (buf) => JSON.stringify(buf.slice(Math.max(0, i - 40), i + 40).toString('utf8'));
  assert.fail(
    `${label}: prompt bytes moved (${b.length} → ${a.length}) — first divergence at byte ${i}\n`
    + `  expected …${ctx(b)}…\n`
    + `  actual   …${ctx(a)}…\n`
    + '  If this change is intentional, regenerate with: node test/helpers/golden-spec.js --write',
  );
}

test('the fixture covers every declared case (nothing silently dropped from the matrix)', () => {
  assert.deepEqual(Object.keys(fixture).sort(), cases.map((c) => c.name).sort());
  assert.ok(cases.length >= 25, `the matrix must stay wide (got ${cases.length} cases)`);
});

for (const c of cases) {
  test(`golden: ${c.name}`, () => {
    const got = runCase(c, builders);
    const want = fixture[c.name];
    assert.ok(want, `no fixture entry for "${c.name}" — regenerate with --write`);

    if (c.builder === 'kling') {
      assert.equal(got.segments.length, want.segments.length, `${c.name}: segment count`);
      assert.equal(got.totalDuration, want.totalDuration, `${c.name}: totalDuration`);
      got.segments.forEach((seg, i) => {
        assertBytesEqual(seg.prompt, want.segments[i].prompt, `${c.name} segment ${i}`);
        assert.equal(seg.bytes, want.segments[i].bytes, `${c.name} segment ${i}: UTF-8 byte length`);
        assert.equal(seg.duration, want.segments[i].duration, `${c.name} segment ${i}: duration`);
        assert.equal(seg.speaker, want.segments[i].speaker, `${c.name} segment ${i}: speaker`);
      });
      return;
    }

    assertBytesEqual(got.prompt, want.prompt, `${c.name} prompt`);
    assert.equal(got.promptBytes, want.promptBytes, `${c.name}: UTF-8 byte length`);
    assert.equal(got.totalDuration, want.totalDuration, `${c.name}: totalDuration`);
    assert.deepEqual(got.speakers, want.speakers, `${c.name}: speakers`);
    assert.equal(got.shotPrompts.length, want.shotPrompts.length, `${c.name}: shot count`);
    got.shotPrompts.forEach((s, i) => {
      assertBytesEqual(s, want.shotPrompts[i], `${c.name} shotPrompt ${i}`);
      assert.equal(got.shotPromptBytes[i], want.shotPromptBytes[i], `${c.name} shotPrompt ${i}: byte length`);
    });
  });
}

// ── Invariants the fixture must never be regenerated out of ──────────────────────────────────────
// The fixture alone cannot say WHY a byte sequence is correct. These assertions state the model
// contracts the golden is protecting, so a regeneration that quietly breaks one still goes red.

test('every Kling segment obeys the 500-byte cap in UTF-8 BYTES, never characters', () => {
  for (const [name, rec] of Object.entries(fixture)) {
    if (!rec.segments) continue;
    for (const [i, seg] of rec.segments.entries()) {
      assert.ok(seg.bytes <= 500, `${name} segment ${i}: ${seg.bytes} bytes exceeds fal's 500-byte segment budget`);
      assert.equal(seg.bytes, Buffer.byteLength(seg.prompt, 'utf8'), `${name} segment ${i}: recorded byte length is wrong`);
    }
  }
});

test('no trim ever splits a multi-byte code point (no U+FFFD anywhere in the golden)', () => {
  assert.ok(!JSON.stringify(fixture).includes('�'), 'a replacement character means a byte trim cut a code point in half');
});

test('the multi-byte shot exercises BOTH trim boundaries: exactly-at-cap and one-short', () => {
  // S5's prose is é / — / œ / 🌊. '@Element1 ' and '[Element1] ' differ by one byte, so the two
  // label styles land the trim on different sides of a multi-byte glyph — which is the whole point.
  const compact = fixture['kling/K2/fal-compact'].segments[1];
  const bracket = fixture['kling/K2/fal-bracket'].segments[1];
  assert.equal(compact.bytes, 500, 'the compact label fills the budget exactly');
  assert.equal(bracket.bytes, 499, 'the bracket label stops one byte short — the next glyph is multi-byte and would not fit');
  for (const seg of [compact, bracket]) {
    assert.match(seg.prompt, /café—naïve/, 'the multi-byte prose survives up to the boundary');
    assert.match(seg.prompt, /\.\.\./, 'the SCENE body carries the ASCII ellipsis trim marker');
  }
});

test('the over-long line takes the re-quote fallback: framing and camera dropped, quote re-closed', () => {
  const seg = fixture['kling/K3/fal-compact'].segments[0];
  assert.equal(seg.bytes, 500);
  assert.ok(seg.prompt.startsWith('@Element1 @Element2 says: "'), 'lead ref + speaker token survive');
  assert.ok(seg.prompt.endsWith('"'), 'the quoted line is RE-CLOSED, never left dangling');
  assert.ok(!seg.prompt.includes('Camera:'), 'the camera clause is dropped to make room for the words');
  assert.ok(!seg.prompt.includes('Medium-wide shot'), 'the framing lead is dropped too');
});

test('at_s-only lines are voiced by the shot whose window contains them (never silently dropped)', () => {
  const bare = fixture['kling/K1/bare'].segments;
  assert.ok(!/says:/.test(bare[0].prompt) === false, 'S1 speaks its shot_id-matched line');
  assert.match(bare[1].prompt, /says: "The light stays on\."/, 'S2 speaks the at_s=6 line via lineForShot\'s window');
  assert.match(bare[2].prompt, /No dialogue in this shot/, 'S3 has neither and gets the explicit no-speech directive');
});

test('audio off removes every dialogue and no-dialogue directive on both builders', () => {
  for (const seg of fixture['kling/K1/audio-off'].segments) {
    assert.ok(!/says:/.test(seg.prompt));
    assert.ok(!/No dialogue in this shot/.test(seg.prompt));
  }
  const sd = fixture['seedance/K1/compact/connectors/audio-off'];
  assert.ok(!sd.prompt.includes('says:'));
  assert.ok(!sd.prompt.includes('@Audio'));
  assert.deepEqual(sd.speakers, []);
});

test('the Seedance whole-prompt clamp keeps the front matter and yields the tail', () => {
  const c = fixture['seedance/K2/compact/connectors/clamped-900'];
  assert.ok(c.promptBytes <= 900, `clamped to the budget (got ${c.promptBytes})`);
  assert.ok(c.prompt.endsWith('…'), 'the clamp marks itself with an ellipsis');
  assert.match(c.prompt, /Recurring characters: Keeper = @Image1\/@Image2; Gull = @Image3/, 'identity front matter survives');
});

test('reference labels are pass-through: the builders never invent a citation style', () => {
  assert.match(fixture['seedance/K1/spaced/connectors/plain'].prompt, /Keeper = @Image 1\/@Image 2/);
  assert.match(fixture['seedance/K1/bracket/connectors/plain'].prompt, /Keeper = \[Image1\]\/\[Image2\]/);
  assert.match(fixture['seedance/K1/bracket/numbered/pinned-take2-note'].prompt, /Use \[Image4\] as the literal first frame of this clip/);
  assert.match(fixture['seedance/K1/spaced/numbered/pinned-take2-note'].prompt, /Use @Image 4 as the literal first frame of this clip/);
});

test('the case matrix really walks connectors vs numbered, nonce and director notes', () => {
  const conn = fixture['seedance/K1/compact/connectors/plain'].prompt;
  const numb = fixture['seedance/K1/compact/numbered/plain'].prompt;
  assert.match(conn, /\nMatch cut to: /, 'the authored non-default transition after S1');
  assert.match(conn, /\nCut to: /, 'S2→S3 falls through to the default connector');
  assert.ok(!numb.includes('\nCut to: '), 'numbered syntax carries no connector words');
  assert.equal((numb.match(/Shot \d+: /g) ?? []).length, 3);
  const take2 = fixture['seedance/K1/compact/connectors/pinned-take2-note'].prompt;
  assert.match(take2, /Alternate take 2: vary the staging/);
  assert.match(take2, /Director note: hold the lamp room wider and keep the lens in frame/);
  assert.ok(!conn.includes('Alternate take'), 'nonce 0 is take-free');
  assert.ok(!conn.includes('Director note'), 'no note without feedback');
});

test('a cast-less job drops the identity clause and every voice note (text-to-video shape)', () => {
  const ttv = fixture['seedance/K1/none/connectors/text-to-video'];
  assert.ok(!ttv.prompt.includes('@Image'), 'no dangling image citations');
  assert.ok(!ttv.prompt.includes('@Audio'), 'no voice-identity notes without refs');
  assert.ok(!ttv.prompt.includes('Recurring characters'));
  assert.match(ttv.prompt, /No on-screen text/, 'the strict default text rule still leads');
});

test('the golden spec is built only from the bundled sample — no proprietary asset paths leak in', () => {
  const blob = JSON.stringify(fixture);
  for (const bad of ['profiles/', 'elements/references/', 'voices/', 'runs/']) {
    assert.ok(!blob.includes(bad), `the fixture references ${bad} — golden data must stay non-proprietary`);
  }
});
