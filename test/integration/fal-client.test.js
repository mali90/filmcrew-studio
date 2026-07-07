import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFalServer } from '../helpers/fal-server.js';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';

// Start the mock, point config.fal at it, THEN dynamic-import fal.js (which snapshots config at import).
const opts = {};
const server = await startFalServer({ videoBytes: Buffer.from('FAKE-MP4-DATA'), opts });
neutralizeDotenv();
Object.assign(process.env, {
  FAL_BASE_URL: server.baseUrl, FAL_KEY: 'fake-key', FAL_UPLOAD_MODE: 'data-uri',
  FAL_KLING_ENDPOINT: 'submit', FAL_CREATE_VOICE_ENDPOINT: 'create-voice', FAL_MAX_RETRIES: '1',
});
const { generateKling, mintVoice, validateFal } = await import('../../src/lib/fal.js');

test.after(() => server.close());

test('generateKling: submit → poll → download writes a file', async () => {
  const { dir, cleanup } = mkTmp('fal');
  try {
    const paths = await generateKling({ prompt: 'x', elements: [] }, { destDir: dir });
    assert.equal(paths.length, 1);
    assert.ok(fs.existsSync(paths[0]));
    assert.equal(fs.readFileSync(paths[0], 'utf8'), 'FAKE-MP4-DATA');
    // the auth header carried the key
    assert.ok(server.requests.some((r) => r.auth === 'Key fake-key'));
  } finally { cleanup(); }
});

test('mintVoice returns the minted voice_id', async () => {
  const { dir, cleanup } = mkTmp('mint');
  try {
    const clip = path.join(dir, 'ref.wav'); fs.writeFileSync(clip, 'RIFFxxxx');
    assert.equal(await mintVoice(clip), 'voice_abc');
  } finally { cleanup(); }
});

test('validateFal: ok when key accepted, auth when rejected', async () => {
  assert.equal((await validateFal('fake-key')).ok, true);
  opts.authFail = true;
  assert.deepEqual(await validateFal('bad'), { ok: false, reason: 'auth', status: 401 });
  opts.authFail = false;
});

test('generateKling throws immediately on a validation (4xx) error', async () => {
  const { dir, cleanup } = mkTmp('falerr');
  try {
    opts.validationFail = true;
    await assert.rejects(generateKling({ prompt: 'x' }, { destDir: dir }), /HTTP 400|invalid/);
  } finally { opts.validationFail = false; cleanup(); }
});
