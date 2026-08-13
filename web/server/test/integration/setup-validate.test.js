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
const { startSegmindServer } = await import(path.join(HOST_ROOT, 'test/helpers/segmind-server.js'));
const fal = await startFalServer({ videoBytes: Buffer.from('FAKE-MP4') });
const sg = await startSegmindServer({ videoBytes: Buffer.from('FAKE-MP4') });

// The web/server import graph is config-free (the runs-caps canary pins it), so config.js loads
// only inside the route's LAZY import — after these lines. The stored-key check must reach the
// mock (any non-auth answer validates), never the real fal endpoint.
process.env.FAL_BASE_URL = fal.baseUrl;
process.env.FAL_MAX_RETRIES = '0';
process.env.SEGMIND_BASE_URL = sg.baseUrl;

const { buildApp } = await import('../../app.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-setup-validate-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
const envFile = path.join(envRoot, '.env');
fs.writeFileSync(envFile, 'FAL_KEY=sk-stored-key\n');

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, childEnv: { ...process.env }, envRoot });
test.after(async () => { await app.close(); await fal.close(); await sg.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

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

// ── …and every OTHER setup answer about a key reads the .env the CHILD's way ────────────────────
// `/api/setup/status` gates the whole wizard on `complete`, and the badge beside each provider says
// "keyed". Both used the settings LINE EDITOR, which answers a different question than dotenv does:
// it takes the FIRST assignment where dotenv keeps the LAST, and it does not recognise an `export `
// prefix at all. So an ordinary .env could show a keyed provider whose very next paid call dies for
// want of a key — or trap a perfectly configured install in /setup forever.
//
// A separate app, because the harness above hands its children `{...process.env}`: the point here is
// what the FILE says, so nothing may pre-empt it from the server's own environment.
const dotenvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-setup-dotenv-'));
const dotenvEnvRoot = path.join(dotenvRoot, 'envroot');
fs.mkdirSync(dotenvEnvRoot, { recursive: true });
const dotenvApp = await buildApp({
  root: HOST_ROOT,
  runsDir: path.join(dotenvRoot, 'runs'),
  outDir: path.join(dotenvRoot, 'out'),
  childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  envRoot: dotenvEnvRoot,
});
test.after(async () => { await dotenvApp.close(); fs.rmSync(dotenvRoot, { recursive: true, force: true }); });
const status = async () => (await dotenvApp.inject({ method: 'GET', url: '/api/setup/status' })).json();

test('setup status reports the keys the CHILD will get, not the ones the line editor sees', async () => {
  fs.writeFileSync(path.join(dotenvEnvRoot, '.env'), [
    'FAL_KEY=sk-was-here',                 // …and cleared again lower down: dotenv keeps the LAST
    'FAL_KEY=',                            //     assignment, the editor the first
    'export SEGMIND_API_KEY=sk-segmind',   // dotenv obeys the shell prefix; the editor sees no line
    'export LLM_PROVIDER=openai',          // …so the editor checked ANTHROPIC_API_KEY for an openai run
    'LLM_TRANSPORT=api',
    'OPENAI_API_KEY=sk-openai',
    '',
  ].join('\n'));

  const s = await status();
  assert.equal(s.fal.hasKey, false, 'the render child gets no FAL_KEY — the line the editor read was overwritten');
  assert.equal(s.segmind.hasKey, true, 'an export-prefixed key is a key');
  assert.equal(s.llm.provider, 'openai', 'the provider the engine child will actually run');
  assert.equal(s.llm.hasKey, true, '…so it is OPENAI_API_KEY that has to be set, and it is');
});

// The other half of that decision: with no .env yet, the wizard is still seeded from .env.example —
// which ships LLM_PROVIDER=claude / LLM_TRANSPORT=cli and every key line blank. That seeding is the
// reason the provider/transport reads keep the settings reader as a FALLBACK instead of dropping it.
test('a fresh install is still seeded from .env.example — and still keyless', async () => {
  fs.rmSync(path.join(dotenvEnvRoot, '.env'));
  fs.copyFileSync(path.join(HOST_ROOT, '.env.example'), path.join(dotenvEnvRoot, '.env.example'));

  const s = await status();
  assert.equal(s.envSource, '.env.example');
  assert.equal(s.llm.provider, 'claude');
  assert.equal(s.llm.transport, 'cli');
  assert.equal(s.fal.hasKey, false, 'the example ships FAL_KEY blank');
  assert.equal(s.segmind.hasKey, false);
});

// The Segmind slug is the same species of read, one step further downstream: the probe exists to
// prove the model the render child will POST is reachable, so it has to resolve that slug the way
// the child resolves it. Quotes are dotenv's, not the value's — validating `"seedance-2.5"` verbatim
// is a 404 that tells the user their key is bad about a setup that is fine.
test('validate-segmind probes the slug the render child would POST, quotes and all stripped', async () => {
  fs.writeFileSync(envFile, 'SEGMIND_SEEDANCE25_SLUG="my-2-5-slug"   # copied off the model page\n');
  const before = sg.requests.length;

  const r = await post('/api/setup/validate-segmind', { apiKey: 'sk-test', backend: 'seedance-2.5@segmind' });
  assert.equal(r.statusCode, 200, r.body);

  const probed = sg.requests.slice(before).filter((q) => q.method === 'POST');
  assert.equal(probed.length, 1);
  assert.equal(probed[0].path, '/v2/my-2-5-slug', 'the slug the child posts — not the quotes dotenv would have stripped');
});
