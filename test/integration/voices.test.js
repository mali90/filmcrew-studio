import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';

// VOICES_DIR is env-overridable → point the registry at a temp dir before importing voices.js.
neutralizeDotenv();
const { dir, cleanup } = mkTmp('voices');
process.env.VOICES_DIR = dir;
const { setVoice, getVoiceId, getVoiceEntry, getVoiceRefClip, loadVoices, loadVoicesWithClips, voicesInventoryText } = await import('../../src/lib/voices.js');
const fs = await import('node:fs');
const path = await import('node:path');

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

test('a bundled clip on disk with no registry entry is auto-detected as a STAGED voice (the sample cast)', () => {
  fs.writeFileSync(path.join(dir, 'wren.mp3'), 'fake-clip'); // ship a clip, no voices.json entry
  const entry = getVoiceEntry('Wren');
  assert.ok(entry, 'Wren is recognized from the shipped clip');
  assert.equal(entry.voice_id, null, 'staged, not minted');
  assert.match(getVoiceRefClip('wren') ?? '', /wren\.mp3$/, 'the engine resolves the shipped clip');
  assert.equal(getVoiceId('wren'), null, 'no voice_id until minted');
  assert.ok(loadVoicesWithClips().wren, 'appears in the augmented map');
  assert.equal(loadVoices().wren, undefined, 'but is NOT written into the account voices.json');
});

test('a minted registry entry wins over the shipped-clip fallback', () => {
  setVoice('Wren', 'vWREN', 'voices/wren.mp3', '2026-01-01T00:00:00Z');
  assert.equal(getVoiceId('wren'), 'vWREN', 'the real minted entry overrides the synthetic staged one');
});
