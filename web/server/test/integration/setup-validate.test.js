// POST /api/setup/validate-fal with an EMPTY key must judge the STORED key (rerun flows): on the
// Segmind path the fal field is optional and buildUpdates preserves an existing FAL_KEY — whose
// mere presence keeps steering SEGMIND_UPLOAD_MODE to fal-storage. Setup must answer for the key
// that will actually be used, and say 'missing' only when nothing is stored either.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { startFalServer } = await import(path.join(HOST_ROOT, 'test/helpers/fal-server.js'));
const fal = await startFalServer({ videoBytes: Buffer.from('FAKE-MP4') });

// The web/server import graph is config-free (the runs-caps canary pins it), so config.js loads
// only inside the route's LAZY import — after these lines. The stored-key check must reach the
// mock (any non-auth answer validates), never the real fal endpoint.
process.env.FAL_BASE_URL = fal.baseUrl;
process.env.FAL_MAX_RETRIES = '0';

const { buildApp } = await import('../../app.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-setup-validate-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
const envFile = path.join(envRoot, '.env');
fs.writeFileSync(envFile, 'FAL_KEY=sk-stored-key\n');

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, childEnv: { ...process.env }, envRoot });
test.after(async () => { await app.close(); await fal.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const post = (url, payload) => app.inject({ method: 'POST', url, payload });

test('an empty key validates the STORED FAL_KEY — the .env one, which uploads would actually use', async () => {
  const r = await post('/api/setup/validate-fal', { apiKey: '' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true, 'the stored key was consulted (the mock answers non-auth)');
});

test('with no key stored either, the answer is "missing" — short-circuited, no request leaves', async () => {
  fs.writeFileSync(envFile, '# no keys stored\n');
  const r = await post('/api/setup/validate-fal', { apiKey: '' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, false);
  assert.equal(r.json().reason, 'missing');
});
