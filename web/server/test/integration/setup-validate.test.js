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

// ── …and every OTHER setup answer about a key reads the FILE, in dotenv's grammar ───────────────
// `/api/setup/status` gates the whole wizard on `complete`, and the badge beside each provider says
// "on file". Both used the settings LINE EDITOR, which answers a different question than dotenv
// does: it takes the FIRST assignment where dotenv keeps the LAST, and it does not recognise an
// `export ` prefix at all. So an ordinary .env could show a keyed provider whose very next paid call
// dies for want of a key — or trap a perfectly configured install in /setup forever.
//
// The grammar is dotenv's; the SCOPE is the file alone (never childEnv) — see the gate test below,
// which is the half of this that a browser once had to catch.
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

test('setup status reads the stored keys the way DOTENV does, not the way the line editor does', async () => {
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
  assert.equal(s.fal.hasKey, false, 'the stored FAL_KEY is the LAST line — blank; the editor read the first');
  assert.equal(s.segmind.hasKey, true, 'an export-prefixed key is a key');
  assert.equal(s.llm.provider, 'openai', 'the provider this install is configured to run');
  assert.equal(s.llm.hasKey, true, '…so it is OPENAI_API_KEY that has to be stored, and it is');
});

// The other half of that decision: with no .env yet, the wizard is still seeded from .env.example —
// which ships LLM_PROVIDER=claude / LLM_TRANSPORT=cli and every key line blank. The gate depends on
// that seeding, which is why it reads through readEnvFileOrExample rather than <envRoot>/.env alone.
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

// ── The GATE, pinned here rather than only in a browser ─────────────────────────────────────────
// `complete` is the question "has this installation been configured yet", and the wizard exists to
// WRITE the file that answers it — so an inherited variable must never be able to say the writing is
// already done. This is not hypothetical: the demo/e2e harness injects mock provider keys into
// childEnv so renders reach the mocks, and reading `hasKey` from childEnv made a fresh install with
// no .env at all report `complete: true`. The route takeover to /setup stopped happening and only
// Playwright noticed, in CI. A third app, with the harness's exact shape.
const gateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-setup-gate-'));
const gateEnvRoot = path.join(gateRoot, 'envroot');
fs.mkdirSync(gateEnvRoot, { recursive: true });
fs.copyFileSync(path.join(HOST_ROOT, '.env.example'), path.join(gateEnvRoot, '.env.example'));
const gateApp = await buildApp({
  root: HOST_ROOT,
  runsDir: path.join(gateRoot, 'runs'),
  outDir: path.join(gateRoot, 'out'),
  // every key the demo pins into its children, and nothing on disk
  childEnv: { PATH: process.env.PATH, HOME: process.env.HOME, FAL_KEY: 'demo-key', SEGMIND_API_KEY: 'demo-key', LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', ANTHROPIC_API_KEY: 'sk-demo' },
  envRoot: gateEnvRoot,
});
test.after(async () => { await gateApp.close(); fs.rmSync(gateRoot, { recursive: true, force: true }); });
const gateStatus = async () => (await gateApp.inject({ method: 'GET', url: '/api/setup/status' })).json();

test('a key in the CHILD env with no .env does not complete a fresh install', async () => {
  const s = await gateStatus();
  assert.equal(s.envSource, '.env.example', 'nothing has been written yet');
  assert.equal(s.fal.hasKey, false, 'a key the launching shell exported is not a key this install stored');
  assert.equal(s.segmind.hasKey, false);
  assert.equal(s.complete, false, 'the wizard must take over — writing that file is its whole job');
});

test('…and writing the .env is what completes it', async () => {
  fs.writeFileSync(path.join(gateEnvRoot, '.env'), 'LLM_PROVIDER=claude\nLLM_TRANSPORT=cli\nFAL_KEY=sk-written-by-the-wizard\n');

  const s = await gateStatus();
  assert.equal(s.envSource, '.env');
  assert.equal(s.fal.hasKey, true);
  assert.equal(s.complete, true);
});

// The same distinction, from the other side: the DEFAULTS are the "what will the next render do"
// answer and must keep reading childEnv first, or the create page hydrates a backend the render
// never uses and pins it into the run. Splitting the two readers must not quietly move these.
test('the effective defaults still read the child\'s way — childEnv ahead of the file', async () => {
  fs.writeFileSync(path.join(gateEnvRoot, '.env'), 'LLM_PROVIDER=claude\nLLM_TRANSPORT=cli\nFAL_KEY=sk-x\nKLING_ASPECT=9:16\n');
  const pinnedApp = await buildApp({
    root: HOST_ROOT,
    runsDir: path.join(gateRoot, 'runs'),
    outDir: path.join(gateRoot, 'out'),
    childEnv: { PATH: process.env.PATH, HOME: process.env.HOME, KLING_ASPECT: '16:9' },
    envRoot: gateEnvRoot,
  });
  try {
    const s = (await pinnedApp.inject({ method: 'GET', url: '/api/setup/status' })).json();
    assert.equal(s.defaults.aspect, '16:9', 'the child gets 16:9, so that is what the next render does');
    assert.equal(s.complete, true, '…while the gate still answers off the file, which is keyed');
  } finally { await pinnedApp.close(); }
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
