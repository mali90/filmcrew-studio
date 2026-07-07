// The core loop over the REAL CLIs: create run → plan (fake LLM) → probe render (mock fal) →
// auto-assemble (stitch precedes review) → review state — all through fastify.inject, with state
// derived from the tmp runs dir. This is the server's money-path contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { startFalServer } = await import(path.join(HOST_ROOT, 'test/helpers/fal-server.js'));
const { hasFfmpeg, tinyMp4Bytes } = await import(path.join(HOST_ROOT, 'test/helpers/ffmpeg-clips.js'));
const { buildApp } = await import('../../app.js');

const FF = await hasFfmpeg();
const fal = await startFalServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-api-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);

const childEnv = {
  ...process.env,
  HOME: process.env.HOME, PATH: process.env.PATH,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit', FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  RUNS_DIR: runsDir, OUT_DIR: outDir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
};

const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '# isolated test env — the dev repo .env must never leak into assertions\n');
const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, childEnv, envRoot });
test.after(async () => { await app.close(); await fal.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = async (url) => app.inject({ method: 'GET', url });
const post = async (url, payload) => app.inject({ method: 'POST', url, payload });

/** Poll GET /api/runs/:id until its status matches (the server is event-driven; tests poll). */
async function waitForStatus(runId, statuses, timeoutMs = 60000) {
  const want = new Set([].concat(statuses));
  const t0 = Date.now();
  for (;;) {
    const res = await get(`/api/runs/${runId}`);
    const run = res.json().run;
    if (want.has(run.status)) return run;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${[...want]} (last: ${run.status}, err: ${JSON.stringify(run.error)})`);
    await sleep(150);
  }
}

test('health + setup status', async () => {
  const h = await get('/api/health');
  assert.equal(h.statusCode, 200);
  assert.equal(h.json().ok, true);
  const s = await get('/api/setup/status');
  assert.equal(s.statusCode, 200);
  assert.equal(typeof s.json().complete, 'boolean');
});

test('create → plan → plan-ready with agents 8/8 and a readable spec', async () => {
  const res = await post('/api/runs', { idea: 'a lighthouse keeper at dusk', backend: 'kling', aspect: '9:16', durationS: null });
  assert.equal(res.statusCode, 201, res.body);
  const { runId } = res.json();
  assert.match(runId, /^web-/);

  const run = await waitForStatus(runId, 'plan-ready');
  assert.equal(run.agents.done, 8);
  assert.equal(run.title, 'Ocean Lighthouse');
  assert.equal(run.spec.spec_version, '1.0');
  assert.equal(run.spec.kling.aspect_ratio, '9:16');
  assert.equal(run.idea, 'a lighthouse keeper at dusk');

  const list = await get('/api/runs');
  assert.ok(list.json().runs.some((r) => r.id === runId));

  // estimates are available as soon as the plan exists, labeled as estimates
  const est = await get(`/api/runs/${runId}/estimate?mode=probe`);
  assert.equal(est.statusCode, 200);
  assert.equal(est.json().label, 'estimate');
  assert.ok(est.json().totalUsd > 0);
});

test('probe render auto-assembles (stitch precedes review) and lands in review', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  // probes exist only on multi-job plans — the TWO-JOB brief makes the fake LLM plan K1+K2
  const { runId } = (await post('/api/runs', { idea: 'probe me TWO-JOB', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');

  const r = await post(`/api/runs/${runId}/render`, { mode: 'probe' });
  assert.equal(r.statusCode, 202, r.body);

  const run = await waitForStatus(runId, 'review');
  assert.equal(run.latestRender.masterExists, true, 'probe was auto-assembled into a playable master');
  assert.equal(run.latestRender.jobs.length, 1, 'the probe rendered only the first of the two jobs');
  assert.ok(run.latestRender.jobs[0].clipExists);
  assert.equal(run.manifest.takes.length, 1);
  assert.equal(run.manifest.takes[0].mode, 'probe');
  assert.equal(run.manifest.cuts.length, 1);

  // the master is range-servable through the media route
  const rel = path.relative(runsDir, run.latestRender.master).split(path.sep).join('/');
  const media = await app.inject({ method: 'GET', url: `/api/media/runs/${rel}`, headers: { range: 'bytes=0-3' } });
  assert.equal(media.statusCode, 206);
  assert.equal(media.headers['content-type'], 'video/mp4');
});

test('a probe on a single-job plan is refused — it would be the full render at the same price', async () => {
  const { runId } = (await post('/api/runs', { idea: 'one job, no probe', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');

  const r = await post(`/api/runs/${runId}/render`, { mode: 'probe' });
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.json().error, /single job/);
  assert.match(r.json().hint, /full render/);
  assert.ok(!fs.existsSync(path.join(runsDir, runId, 'renders/t1')), 'the refused probe reserved no take');
});

test('approve without upscale records the final and completes the run', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId } = (await post('/api/runs', { idea: 'approve me', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  await waitForStatus(runId, 'review');

  const ap = await post(`/api/runs/${runId}/approve`, { upscale: false });
  assert.equal(ap.statusCode, 200, ap.body);
  assert.ok(ap.json().final.endsWith('.mp4'));
  const run = await waitForStatus(runId, 'complete');
  assert.equal(run.status, 'complete');
});

test('delete run refuses while planning, then deletes with reclaimed bytes', async () => {
  const { runId } = (await post('/api/runs', { idea: 'delete me', backend: 'kling', aspect: '9:16', durationS: null })).json();
  const denied = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}` });
  assert.equal(denied.statusCode, 409, 'active runs cannot be deleted');
  await waitForStatus(runId, 'plan-ready');
  const ok = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}` });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().bytes > 0);
  assert.equal((await get(`/api/runs/${runId}`)).statusCode, 404);
});

test('path safety: traversal ids and media paths are rejected', async () => {
  assert.equal((await get('/api/runs/..%2F..%2Fetc')).statusCode, 404);
  assert.equal((await get('/api/media/runs/..%2F..%2Fetc%2Fpasswd')).statusCode, 404);
  assert.equal((await get('/api/media/out/..%2Fweb.json')).statusCode, 404);
});

test('unknown run id → 404 with a hint-shaped error', async () => {
  const res = await get('/api/runs/web-nope');
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.ok(body.error);
  assert.ok(body.hint);
});
