// A take renders the plan that was PRICED — not whatever spec.json says by the time the child runs.
//
// Everything a render records is computed from the spec read at enqueue: the estimate the button
// showed, the take's `estUsd`, the cost-ledger row, the prompt-override snapshot and the `revision`
// the take claims to be. The child, though, re-read the run's live spec.json at spawn — and revise
// runs on the PLAN lane, which drains beside the spend lane. A revision landing while a render waits
// its turn (behind another run's paid job, or just in the microtask before exec) promoted a new
// spec.json underneath a take that had already been quoted and recorded against the old one.
//
// The rewrite below is that race made deterministic: spawnCli replaces the run's spec.json in the
// one instant between the enqueue that committed the money and the exec that spends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { startFalServer } = await import(path.join(HOST_ROOT, 'test/helpers/fal-server.js'));
const { hasFfmpeg, tinyMp4Bytes } = await import(path.join(HOST_ROOT, 'test/helpers/ffmpeg-clips.js'));
const { buildApp } = await import('../../app.js');

const FF = await hasFfmpeg();
const fal = await startFalServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-priced-plan-'));
const runsDir = path.join(tmpRoot, 'runs');
const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);

const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri',
  FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit', FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
  // no developer's Segmind key may reach a test render — see api-flows for the full note
  SEGMIND_API_KEY: '', SEGMIND_BASE_URL: 'http://127.0.0.1:1',
};

const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '# isolated test env\n');

/** Rewrites the named file the moment a spend child is spawned (null ⇒ leave everything alone). */
let editInTheGap = null;
const app = await buildApp({
  root: HOST_ROOT,
  runsDir,
  outDir: path.join(tmpRoot, 'out'),
  childEnv,
  envRoot,
  spawnCli: (script, args, { env, cwd } = {}) => {
    if (editInTheGap && script.endsWith(editInTheGap.script)) {
      fs.writeFileSync(editInTheGap.file, editInTheGap.text);
      editInTheGap = null;
    }
    return spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  },
});
test.after(async () => { await app.close(); await fal.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });

async function waitForStatus(runId, statuses, timeoutMs = 90000) {
  const want = new Set([].concat(statuses));
  const t0 = Date.now();
  for (;;) {
    const run = (await get(`/api/runs/${runId}`)).json().run;
    if (want.has(run.status)) return run;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${[...want]} (last: ${run.status} err=${JSON.stringify(run.error)})`);
    await sleep(150);
  }
}
async function makePlannedRun(idea) {
  const { runId } = (await post('/api/runs', { idea, backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  return runId;
}

/** A plan that is unmistakably NOT the one the button priced: a different title and one job fewer. */
const supersededPlan = (spec) => JSON.stringify({
  ...spec,
  project: { ...spec.project, title: 'a plan nobody was quoted' },
  kling: { ...spec.kling, jobs: spec.kling.jobs.slice(0, 1) },
}, null, 2);

test('a full render spends on the spec it was QUOTED for, not the one promoted in the gap', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const runId = await makePlannedRun('render what you priced — TWO-JOB');
  const specFile = path.join(runsDir, runId, 'spec.json');
  const planned = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  assert.ok(planned.kling.jobs.length >= 2, 'this proof needs a multi-job plan to be able to lose one');

  const quoted = (await get(`/api/runs/${runId}/estimate?mode=full`)).json();
  editInTheGap = { script: 'render.js', file: specFile, text: supersededPlan(planned) };
  assert.equal((await post(`/api/runs/${runId}/render`, { mode: 'full' })).statusCode, 202);
  const run = await waitForStatus(runId, ['review', 'attention']);
  assert.equal(run.status, 'review', `the render finished (err=${JSON.stringify(run.error)})`);

  assert.equal(editInTheGap, null, 'the rewrite really did land in the gap — otherwise this proves nothing');
  assert.match(fs.readFileSync(specFile, 'utf8'), /a plan nobody was quoted/, 'and the run\'s live plan really is the other one now');

  const takeDir = path.join(runsDir, runId, 'renders', run.manifest.takes.at(-1).id);
  const rendered = JSON.parse(fs.readFileSync(path.join(takeDir, 'render.json'), 'utf8'));
  assert.deepEqual(rendered.jobs.map((j) => j.jobId ?? j.job), planned.kling.jobs.map((j) => j.job_id),
    'every job the estimate charged for was rendered — the superseded plan drops one');
  assert.equal(JSON.parse(fs.readFileSync(path.join(takeDir, 'spec.json'), 'utf8')).project.title, planned.project.title,
    'and the take keeps the plan it was paid to render, so its estUsd still describes something real');
  assert.equal(run.manifest.takes.at(-1).estUsd, quoted.totalUsd);
});

test('a scoped re-render spends on the spec it was QUOTED for too', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const runId = await makePlannedRun('re-render what you priced — TWO-JOB');
  const specFile = path.join(runsDir, runId, 'spec.json');
  const planned = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  await waitForStatus(runId, 'review');

  // The job this re-render is priced for is the one the superseded plan throws away — so an
  // unpinned child would not merely render a different plan, it would fail to find its own job.
  const jobId = planned.kling.jobs.at(-1).job_id;
  editInTheGap = { script: 'render-job.js', file: specFile, text: supersededPlan(planned) };
  const res = await post(`/api/runs/${runId}/rerender-job`, { jobId, cascade: false });
  assert.equal(res.statusCode, 202, res.body);
  const run = await waitForStatus(runId, ['review', 'attention']);
  assert.equal(run.status, 'review', `the re-render finished (err=${JSON.stringify(run.error)})`);

  assert.equal(editInTheGap, null, 'the rewrite really did land in the gap');
  // The take is named by the enqueue itself: the free cut composed afterwards rewrites this dir's
  // render.json from the run's CURRENT plan, which is the superseded one by now — composition is a
  // free, after-the-fact reading of "what does this run look like today" and re-derives on purpose.
  // The paid part is the clip, and the plan frozen beside it.
  const takeDir = path.join(runsDir, runId, 'renders', res.json().takeId);
  assert.ok(fs.existsSync(path.join(takeDir, jobId, 'out.mp4')), `${jobId} — the job this re-render was priced for — is the job that rendered`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(takeDir, 'spec.json'), 'utf8')).project.title, planned.project.title,
    'and the take holds the plan it was paid to render');
});
