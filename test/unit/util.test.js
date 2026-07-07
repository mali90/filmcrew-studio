import test from 'node:test';
import assert from 'node:assert/strict';
import { slug, newRunId, sanitizeSpeech } from '../../src/lib/util.js';

test('sanitizeSpeech: typographic punctuation → ASCII, emoji/markdown/embedded-quotes gone', () => {
  // em-dash → a spoken pause (no space before the comma); curly apostrophe → straight
  assert.equal(sanitizeSpeech('Weather’s turning — I can feel it.'), "Weather's turning, I can feel it.");
  // curly & straight double quotes → single (they'd otherwise break the "…" wrapper)
  assert.equal(sanitizeSpeech('He said “stop” and "go"'), "He said 'stop' and 'go'");
  // ellipsis → three dots; emoji stripped; whitespace collapsed
  assert.equal(sanitizeSpeech('Ready…  set…  go 🚀🌊'), 'Ready... set... go');
  // markdown markers stripped; control chars → space
  assert.equal(sanitizeSpeech('*bold* and `code`\tand\nnewline'), 'bold and code and newline');
  // plain speakable text (and ASCII hyphens) pass through unchanged
  assert.equal(sanitizeSpeech('keep hyphen-words and 123'), 'keep hyphen-words and 123');
  assert.equal(sanitizeSpeech(''), '');
  assert.equal(sanitizeSpeech(null), '');
});

test('slug lowercases and dashes non-alphanumerics, trims edge dashes', () => {
  assert.equal(slug('Ocean Lighthouse!'), 'ocean-lighthouse');
  assert.equal(slug('  --Foo__Bar--  '), 'foo-bar');
  assert.equal(slug('already-good'), 'already-good');
});

test('newRunId has the timestamp+uuid shape (value is non-deterministic)', () => {
  assert.match(newRunId('render'), /^render-\d{14}-[0-9a-f]{6}$/);
  assert.match(newRunId(), /^run-\d{14}-[0-9a-f]{6}$/);
});
