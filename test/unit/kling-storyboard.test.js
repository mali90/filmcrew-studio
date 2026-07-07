import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
neutralizeDotenv();
const { buildKlingStoryboard, klingConfigFor } = await import('../../src/lib/kling.js');

test('klingConfigFor: spec values override, else config defaults', () => {
  const spec = loadGoldenSpec();
  assert.deepEqual(klingConfigFor(spec), { model: 'kling-v3-omni', resolution: '1080p', aspectRatio: '9:16', generateAudio: true });
  // empty kling → hardcoded config defaults (env neutralized)
  const d = klingConfigFor({ kling: {} });
  assert.equal(d.model, 'kling-v3-omni');
  assert.equal(d.aspectRatio, '9:16');
});

test('default storyboard: segment count, total duration, framing + folded VO line', () => {
  const spec = loadGoldenSpec();
  const { segments, totalDuration } = buildKlingStoryboard(spec.kling.jobs[0], spec);
  assert.equal(segments.length, 3);
  assert.equal(totalDuration, 13); // 5 + 4 + 4
  assert.match(segments[0].prompt, /Extreme wide shot/);
  assert.match(segments[0].prompt, /Camera: slow push in toward the tower\./);
  assert.match(segments[0].prompt, /says: "Forty years I kept this light\."/);
});

test('fal opts: leadRef prefix + lowercased speech + speaker → @ElementN', () => {
  const spec = loadGoldenSpec();
  spec.audio.voice.lines[0].speaker = 'keeper';
  const { segments } = buildKlingStoryboard(spec.kling.jobs[0], spec, {
    lowercaseSpeech: true,
    leadRef: '@Element1',
    voiceTokenFor: (sp) => (sp === 'keeper' ? '@Element1' : ''),
  });
  assert.ok(segments[0].prompt.startsWith('@Element1 '));
  assert.match(segments[0].prompt, /@Element1 says: "forty years i kept this light\."/);
});

test('throws when a job exceeds the 6-storyboard cap', () => {
  const spec = loadGoldenSpec();
  const job = { job_id: 'X', shots: ['S1', 'S1', 'S1', 'S1', 'S1', 'S1', 'S1'] };
  assert.throws(() => buildKlingStoryboard(job, spec), /storyboard cap/);
});

test('throws on an unknown shot id', () => {
  const spec = loadGoldenSpec();
  assert.throws(() => buildKlingStoryboard({ job_id: 'X', shots: ['NOPE'] }, spec), /not found in spec\.shots/);
});

test('512 cap is enforced in UTF-8 BYTES (fal’s unit) — the K2 regression', () => {
  const spec = loadGoldenSpec();
  const job = spec.kling.jobs[0];
  const shotId = job.shots[0];
  const shot = spec.shots.find((s) => s.shot_id === shotId);
  // long prose FULL of multibyte characters: curly quotes, em-dashes, accents — under the old
  // char-based clamp this trimmed to 512 chars but WAY over 512 bytes → fal HTTP 422
  shot.kling.content_prompt = '“Café—naïve—œuvre” '.repeat(60);
  const { segments } = buildKlingStoryboard(job, spec, { leadRef: '@Element1' });
  const sent = segments[0].prompt;
  assert.ok(Buffer.byteLength(sent, 'utf8') <= 500, `must stay under fal's REAL cap — 512 bytes is rejected, ≤490 observed accepted (got ${Buffer.byteLength(sent, 'utf8')})`);
  assert.match(sent, /\.\.\./, 'trim is marked with an ASCII ellipsis');
  assert.match(sent, /says: "Forty years I kept this light\."/, 'the dialogue suffix survives the trim');
  assert.match(sent, /Camera: /, 'the camera suffix survives the trim');
  assert.match(sent, /^@Element1 /, 'the lead reference survives the trim');
});

test('at_s-only line is voiced by the shot whose window contains it (not silently dropped)', () => {
  const spec = loadGoldenSpec();
  // S1=5s [0,5), S2=4s [5,9), S3=4s [9,13). An at_s=6 line belongs to S2, with no shot_id.
  spec.audio.voice.lines = [{ text: 'The light stays on.', at_s: 6 }];
  const { segments } = buildKlingStoryboard(spec.kling.jobs[0], spec);
  assert.ok(!/says:/.test(segments[0].prompt), 'S1 has no line');
  assert.match(segments[1].prompt, /says: "The light stays on\."/, 'S2 (window contains at_s=6) speaks it');
});

test('audio-on shot with no line gets a no-dialogue directive (keeps SFX, no invented speech)', () => {
  const spec = loadGoldenSpec(); // line only on S1
  const { segments } = buildKlingStoryboard(spec.kling.jobs[0], spec);
  assert.match(segments[0].prompt, /says: "forty years/i, 'S1 speaks its line');
  assert.match(segments[1].prompt, /No dialogue in this shot; ambient sound and SFX only\./, 'S2 is explicitly wordless');
  assert.ok(!/says:/.test(segments[1].prompt), 'S2 has no scripted speech');
});

test('audio OFF → neither a dialogue nor a no-dialogue directive', () => {
  const spec = loadGoldenSpec();
  spec.kling.generate_audio = false;
  const { segments } = buildKlingStoryboard(spec.kling.jobs[0], spec);
  for (const s of segments) {
    assert.ok(!/says:/.test(s.prompt));
    assert.ok(!/No dialogue in this shot/.test(s.prompt));
  }
});

test('smart punctuation / em-dashes in a line are sanitized to speakable ASCII', () => {
  const spec = loadGoldenSpec();
  spec.audio.voice.lines = [{ shot_id: 'S1', text: 'Weather’s turning — I can feel it. 🌊' }];
  const { segments } = buildKlingStoryboard(spec.kling.jobs[0], spec); // default: no lowercasing
  assert.match(segments[0].prompt, /says: "Weather's turning, I can feel it\."/);
  assert.ok(!/🌊|—|’/.test(segments[0].prompt), 'no emoji / em-dash / curly quote reaches the prompt');
});

test('an over-long line is never truncated mid-word — the scene body is trimmed, the words survive', () => {
  const spec = loadGoldenSpec();
  const line = 'The light stays on, it always does, and it always will, no matter what the sea throws at us.';
  spec.shots[0].kling.content_prompt = 'storm '.repeat(120).trim(); // ~700B scene → must be trimmed
  spec.audio.voice.lines = [{ shot_id: 'S1', text: line }];
  const p = buildKlingStoryboard(spec.kling.jobs[0], spec, { leadRef: '@Element1', voiceTokenFor: () => '@Element1', lowercaseSpeech: true }).segments[0].prompt;
  assert.ok(Buffer.byteLength(p, 'utf8') <= 500, `under the 500B cap (got ${Buffer.byteLength(p, 'utf8')})`);
  assert.match(p, /\.\.\./, 'the SCENE was trimmed');
  assert.match(p, new RegExp(`says: "${line.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), 'the full spoken line survives, close-quote intact');
});
