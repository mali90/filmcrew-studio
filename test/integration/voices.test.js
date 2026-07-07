import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';

// VOICES_DIR is env-overridable → point the registry at a temp dir before importing voices.js.
neutralizeDotenv();
const { dir, cleanup } = mkTmp('voices');
process.env.VOICES_DIR = dir;
const { setVoice, getVoiceId, loadVoices, voicesInventoryText } = await import('../../src/lib/voices.js');

test.after(() => cleanup());

test('empty registry', () => {
  assert.deepEqual(loadVoices(), {});
  assert.match(voicesInventoryText(), /no character voices registered/);
  assert.equal(getVoiceId('anyone'), null);
});

test('setVoice persists and getVoiceId resolves case-insensitively by slug', () => {
  setVoice('Host', 'v123', 'ref.wav', '2026-01-01T00:00:00Z');
  assert.equal(getVoiceId('Host'), 'v123');
  assert.equal(getVoiceId('host'), 'v123');
  assert.equal(getVoiceId('HOST'), 'v123');
  assert.equal(getVoiceId('nobody'), null);
  assert.equal(loadVoices().host.voice_id, 'v123');
  assert.match(voicesInventoryText(), /- Host/);
});
