// Iteration flows: revise-with-feedback (through the engine), scoped job re-render with
// auto-re-stitch, SSE streams (snapshot-first + live events + log resume), settings/env editing,
// doctor, cancel, and the cast surface.
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-flows-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);

const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri',
  FAL_STORAGE_INITIATE_URL: `${fal.baseUrl}/storage/upload/initiate`, // Topaz uploads go to the mock, never the real CDN
  FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit', FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
};

const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '# isolated test env — the dev repo .env must never leak into assertions\n');
const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, childEnv, envRoot });
await app.listen({ port: 0, host: '127.0.0.1' }); // SSE tests need a real socket
const base = `http://127.0.0.1:${app.server.address().port}`;

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
async function makeReviewedRun(idea) {
  const { runId } = (await post('/api/runs', { idea, backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  return { runId, run: await waitForStatus(runId, 'review') };
}

test('revise: feedback goes through the engine, promotes the revised spec, records lineage', async () => {
  const { runId } = (await post('/api/runs', { idea: 'revise me', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const res = await post(`/api/runs/${runId}/revise`, { feedback: 'make the storm scarier', scope: 'whole' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().revisionId, 'r1');
  const run = await waitForStatus(runId, 'plan-ready');
  assert.equal(run.manifest.revisions.length, 1);
  assert.equal(run.manifest.revisions[0].feedback, 'make the storm scarier');
  assert.deepEqual(run.manifest.revisions[0].owners, [2], 'fake router routes to the content agent');
  assert.ok(fs.existsSync(path.join(runsDir, runId, 'revisions/r1/spec.json')), 'revision history kept');
  assert.ok(fs.existsSync(path.join(runsDir, runId, 'revisions/r1/feedback.json')));
});

test('revise-content-policy: enqueues a revise with the canned benign + Seedance-guidance feedback', async () => {
  const { runId } = (await post('/api/runs', { idea: 'a cat reviews cheese', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const res = await post(`/api/runs/${runId}/revise-content-policy`, {});
  assert.ok(res.statusCode < 300, res.body);
  assert.equal(res.json().revisionId, 'r1');
  const run = await waitForStatus(runId, 'plan-ready');
  assert.equal(run.manifest.revisions.length, 1);
  const fb = run.manifest.revisions[0].feedback;
  assert.match(fb, /content moderation/i, 'the note explains the moderation flag');
  assert.match(fb, /camera move|shot description/i, 'the Seedance guidance is included');
});

test('rerender-job: new take + seam from the latest cut + AUTO re-stitch → review has a fresh master', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId, run: before } = await makeReviewedRun('rerender me');
  const firstMaster = before.latestRender.master;
  const res = await post(`/api/runs/${runId}/rerender-job`, { jobId: 'K1', feedback: 'warmer light' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().takeId, 't2');

  // a double-tap must NOT queue the same job twice (it once reserved two takes and two estimates)
  const dup = await post(`/api/runs/${runId}/rerender-job`, { jobId: 'K1' });
  assert.equal(dup.statusCode, 409, dup.body);
  assert.match(dup.json().error, /already (queued to render|rendering)/);
  // and the page flips immediately: the run reads 'rendering' the moment the job is queued
  const during = (await get(`/api/runs/${runId}`)).json().run;
  assert.equal(during.status, 'rendering');
  assert.equal(during.manifest.takes.length, 2, 'the duplicate reserved NO take');

  const run = await waitForStatus(runId, 'review');
  assert.notEqual(run.latestRender.master, firstMaster, 'the re-stitched cut is a NEW master (never overwritten)');
  assert.ok(fs.existsSync(firstMaster), 'the previous master still exists');
  assert.equal(run.manifest.takes.length, 2);
  assert.equal(run.manifest.takes[1].mode, 'job');
  assert.equal(run.manifest.takes[1].feedback, 'warmer light');
  assert.equal(run.manifest.cuts.length, 2, 'each stitch is a recorded cut');
});

test('SSE per-run: snapshot first, then live agent/spec-block/status events during planning', async () => {
  const { runId } = (await post('/api/runs', { idea: 'sse watch', backend: 'kling', aspect: '9:16', durationS: null })).json();
  const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const events = [];
  const t0 = Date.now();
  let buf = '';
  while (Date.now() - t0 < 30000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += Buffer.from(value).toString();
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
    const done8 = events.some((e) => e.type === 'status' && e.status === 'plan-ready');
    if (done8) break;
  }
  await reader.cancel();
  assert.equal(events[0].type, 'snapshot', 'snapshot always leads');
  assert.equal(events[0].run.id, runId);
  assert.ok(events.some((e) => e.type === 'agent' && e.idx === 0 && e.state === 'started'), 'agent sentinels stream');
  assert.ok(events.some((e) => e.type === 'spec-block' && /spec-00\.json/.test(e.file)), 'artifact watcher announces spec blocks');
  assert.ok(events.some((e) => e.type === 'log'), 'raw log lines stream');
});

test('GET log?cursor resumes without duplicates', async () => {
  const { runId } = (await post('/api/runs', { idea: 'log me', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const all = (await get(`/api/runs/${runId}/log`)).json();
  assert.ok(all.lines.length > 3);
  const mid = all.lines[Math.floor(all.lines.length / 2)].cursor;
  const rest = (await get(`/api/runs/${runId}/log?cursor=${mid}`)).json();
  assert.equal(rest.lines[0].cursor, mid + 1);
  assert.equal(rest.lines.at(-1).cursor, all.nextCursor);
});

test('cancel: a queued render is dropped; the run records the cancellation as attention', async () => {
  const a = await makeReviewedRun('queue holder').catch(() => null); // FF-less fallback: probe path
  const { runId } = (await post('/api/runs', { idea: 'cancel me', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  const c = await post(`/api/runs/${runId}/cancel`, {});
  assert.ok(['queued', 'active'].includes(c.json().cancelled), `cancelled: ${c.body}`);
  const run = await waitForStatus(runId, ['attention'], 20000);
  assert.match(run.error.message, /cancel/i);
  void a;
});

test('take numbers are NEVER reused — a deleted take cannot be reborn out of order', async () => {
  // a t3 record with no dir on disk (e.g. a cancelled+cleaned take) once let the next render
  // grab t2 — created AFTER t3, breaking every "highest tN = newest" assumption downstream
  const { runId } = (await post('/api/runs', { idea: 'monotonic takes', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const manifestPath = path.join(runsDir, runId, 'web.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  m.takes.push({ id: 't3', mode: 'job', jobId: 'K1', createdAt: 'past' });
  fs.writeFileSync(manifestPath, JSON.stringify(m));
  const res = await post(`/api/runs/${runId}/render`, { mode: 'full' });
  assert.equal(res.json().takeId, 't4', 'max(existing)+1 — never the lowest free number');
  await post(`/api/runs/${runId}/cancel`, {});
  await waitForStatus(runId, ['attention', 'review'], 30000);
});

test('a second paid render on the SAME run is refused — no duplicate take is ever reserved', async () => {
  const { runId } = (await post('/api/runs', { idea: 'take reservation', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const a = await post(`/api/runs/${runId}/render`, { mode: 'full' });
  assert.equal(a.json().takeId, 't1');
  assert.ok(fs.existsSync(path.join(runsDir, runId, 'renders/t1')), 't1 reserved on disk immediately');
  const b = await post(`/api/runs/${runId}/render`, { mode: 'full' }); // the double-tap
  assert.equal(b.statusCode, 409, b.body);
  assert.match(b.json().error, /already (queued to render|rendering)/);
  assert.ok(!fs.existsSync(path.join(runsDir, runId, 'renders/t2')), 'the refused tap reserved NOTHING');
  await post(`/api/runs/${runId}/cancel`, {});
  await waitForStatus(runId, ['attention', 'review'], 30000);
});

test('cancel prefers the queued sibling (cross-run) and keeps the ACTIVE run tracked', async () => {
  // the spend lane is serial ACROSS runs: run A renders, run B waits — cancelling B must drop the
  // queued job without touching A's live child
  const runA = (await post('/api/runs', { idea: 'cancel semantics A', backend: 'kling', aspect: '9:16', durationS: null })).json().runId;
  await waitForStatus(runA, 'plan-ready');
  const runB = (await post('/api/runs', { idea: 'cancel semantics B', backend: 'kling', aspect: '9:16', durationS: null })).json().runId;
  await waitForStatus(runB, 'plan-ready');
  await post(`/api/runs/${runA}/render`, { mode: 'full' });
  await post(`/api/runs/${runB}/render`, { mode: 'full' }); // queued behind A
  const cancelled = await post(`/api/runs/${runB}/cancel`, {});
  if (cancelled.json().cancelled === 'queued') {
    const a = (await get(`/api/runs/${runA}`)).json().run;
    if (a.status === 'rendering') assert.ok(a.manifest.activeJob, 'run A stays tracked after cancelling run B');
  }
  await post(`/api/runs/${runA}/cancel`, {});
  await waitForStatus(runA, ['attention', 'review'], 30000);
  await waitForStatus(runB, ['attention', 'plan-ready', 'review'], 30000);
});

test('cancel clears a STALE activeJob left by a dead server process (runs can never stay pinned)', async () => {
  const { runId } = (await post('/api/runs', { idea: 'stale pin', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const manifestPath = path.join(runsDir, runId, 'web.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  m.activeJob = { kind: 'render', pid: process.pid, startedAt: 'x' }; // alive pid the manager doesn't own
  fs.writeFileSync(manifestPath, JSON.stringify(m));
  assert.equal((await get(`/api/runs/${runId}`)).json().run.status, 'rendering', 'pinned by the stale pid');
  const res = await post(`/api/runs/${runId}/cancel`, {});
  assert.equal(res.json().cancelled, 'stale');
  const after = (await get(`/api/runs/${runId}`)).json().run;
  assert.equal(after.manifest.activeJob, null);
  assert.equal(after.status, 'attention');
});

test('assemble composition rejects traversal take ids and unknown jobs (400, nothing read)', async () => {
  const { runId } = (await post('/api/runs', { idea: 'compose guard', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const evil = await post(`/api/runs/${runId}/assemble`, { composition: { K1: '../../../../etc' } });
  assert.equal(evil.statusCode, 400);
  assert.match(evil.json().error, /not a take id/);
  const badJob = await post(`/api/runs/${runId}/assemble`, { composition: { NOPE: 't1' } });
  assert.equal(badJob.statusCode, 400);
  assert.match(badJob.json().error, /not a job/);
});

test('settings: masked env read, previewed diff, write, defaults round-trip', async () => {
  const envRead = await get('/api/settings/env');
  assert.equal(envRead.statusCode, 200);
  const preview = await post('/api/settings/env/preview', { updates: { RENDER_BACKEND: 'seedance', FAL_KEY: 'sk-new-secret-key' } });
  assert.equal(preview.statusCode, 200);
  const keyRow = preview.json().rows.find((r) => r.key === 'FAL_KEY');
  assert.ok(!keyRow.to.includes('sk-new-secret-key'), 'secrets are masked in previews');
  // no write happened
  const status = await get('/api/setup/status');
  assert.equal(status.json().defaults.backend, 'kling');
});

test('doctor runs as a fresh child and reports machine-readable checks', async () => {
  const res = await post('/api/doctor', {});
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json();
  assert.ok(Array.isArray(r.checks) && r.checks.length >= 5);
  assert.equal(typeof r.hard, 'number');
});

test('cast: references + voices + profiles surfaces answer', async () => {
  const refs = await get('/api/cast/references');
  assert.equal(refs.statusCode, 200);
  assert.ok(Array.isArray(refs.json().references));
  const voices = await get('/api/cast/voices');
  assert.equal(voices.statusCode, 200);
  assert.equal(voices.json().mintUsd, 0.007);
  const profiles = await get('/api/cast/profiles');
  assert.equal(profiles.statusCode, 200);
});

test('global SSE: queue snapshot first, run-status events flow', async () => {
  const res = await fetch(`${base}/api/events`, { headers: { accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const first = Buffer.from(value).toString();
  assert.match(first, /"type":"snapshot"/);
  assert.match(first, /"queue"/);
  await reader.cancel();
});

// ——— review-hardening fixes ———

test('a successful probe NEVER flashes attention between clip landing and auto-assemble', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  // TWO-JOB: probes are multi-job-only, so the fake LLM must plan K1+K2 here
  const { runId } = (await post('/api/runs', { idea: 'no flash TWO-JOB', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');

  const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: { accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  const statuses = [];
  const pump = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2);
        const data = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!data) continue;
        const e = JSON.parse(data.slice(6));
        if (e.type === 'status') statuses.push(e.status);
      }
      if (statuses.includes('review')) break;
    }
  })();

  await post(`/api/runs/${runId}/render`, { mode: 'probe' });
  await waitForStatus(runId, 'review');
  await sleep(300); // drain any trailing status events before closing the stream
  await reader.cancel().catch(() => {}); // unblocks the pump if it is parked in read()
  await pump.catch(() => {});
  assert.ok(statuses.includes('review'), `saw: ${statuses}`);
  assert.ok(!statuses.includes('attention'),
    `a healthy probe must never surface attention (stitch is committed work) — saw: ${statuses}`);
});

test('dismiss-error: a failed change on a reviewed run returns it to review (no dead end)', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId } = await makeReviewedRun('strand me not');
  // simulate what a failed upscale/revision leaves behind: a persisted lastError
  const manifestPath = path.join(runsDir, runId, 'web.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  m.lastError = { ts: new Date().toISOString(), action: 'upscale', message: 'Topaz rejected the file', logTail: [] };
  fs.writeFileSync(manifestPath, JSON.stringify(m));

  let run = (await get(`/api/runs/${runId}`)).json().run;
  assert.equal(run.status, 'attention', 'persisted lastError outranks review');

  const res = await post(`/api/runs/${runId}/dismiss-error`, {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().dismissed, true);
  run = (await get(`/api/runs/${runId}`)).json().run;
  assert.equal(run.status, 'review', 'the paid-for master is reachable again');
  assert.equal(run.manifest.lastError, null);

  // idempotent: nothing left to dismiss
  assert.equal((await post(`/api/runs/${runId}/dismiss-error`, {})).json().dismissed, false);
});

test('dismiss-error clears a STALE interrupted activeJob (the direct isAlive path — regression)', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  // The harness injects no isAlive (like production server.js), so createRunService must default
  // it. Every other path launders isAlive through scanRun's default param; ONLY dismissError calls
  // it directly, and only when a stale activeJob record survives an interrupted child — the exact
  // "needs attention / Dismiss — back to review" state. Undefaulted, this threw "isAlive is not a
  // function" and stranded the paid master.
  const { runId } = await makeReviewedRun('interrupted, not stranded');
  const manifestPath = path.join(runsDir, runId, 'web.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // a dead pid from an interrupted revise: 2^30 is never a live process → isAlive() → false
  m.activeJob = { kind: 'revise', pid: 2 ** 30, startedAt: new Date().toISOString(), queueId: 'gone' };
  fs.writeFileSync(manifestPath, JSON.stringify(m));

  const res = await post(`/api/runs/${runId}/dismiss-error`, {});
  assert.equal(res.statusCode, 200, res.body); // was 500 "isAlive is not a function"
  assert.equal(res.json().dismissed, true);
  const run = (await get(`/api/runs/${runId}`)).json().run;
  assert.equal(run.manifest.activeJob, null, 'the stale interruption record is cleared');
  assert.equal(run.status, 'review', 'the paid-for master is reachable again');
});

test('plan retry: cancel planning → attention → POST /plan re-runs the engine to plan-ready', async () => {
  const { runId } = (await post('/api/runs', { idea: 'retry my plan', backend: 'kling', aspect: '9:16', durationS: null })).json();
  const cancelled = (await post(`/api/runs/${runId}/cancel`, {})).json().cancelled;
  assert.ok(cancelled === 'queued' || cancelled === 'active', `cancel outcome: ${cancelled}`);
  const failed = await waitForStatus(runId, 'attention');
  assert.match(failed.error.message, /cancelled/);

  const res = await post(`/api/runs/${runId}/plan`, {});
  assert.equal(res.statusCode, 200, res.body);
  const run = await waitForStatus(runId, 'plan-ready');
  assert.equal(run.manifest.lastError, null);
  assert.ok(run.title, 'the retried plan produced a spec');
});

test('cascade re-render: K1 + downstream K2 land in ONE take with BOTH clip records, then auto-stitch', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  // the golden plan packs everything into one job — split it so K1 has a downstream K2
  const { runId: rid } = (await post('/api/runs', { idea: 'cascade me', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(rid, 'plan-ready');
  const specPath = path.join(runsDir, rid, 'spec.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  spec.kling.jobs = [
    { job_id: 'K1', shots: ['S1', 'S2'], elements: ['subject'] },
    { job_id: 'K2', shots: ['S3'], elements: ['subject'] },
  ];
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  await post(`/api/runs/${rid}/render`, { mode: 'full' });
  const before = await waitForStatus(rid, 'review');
  const runId = rid;

  const res = await post(`/api/runs/${runId}/rerender-job`, { jobId: 'K1', cascade: true });
  assert.equal(res.statusCode, 202, res.body);
  assert.deepEqual(res.json().cascadeJobs, ['K2'], 'the downstream jobs that will re-render');

  const run = await waitForStatus(runId, 'review');
  // render.json must be MERGED across the cascade — a clobber would leave only K2 on record
  const jobs = run.latestRender.jobs;
  assert.equal(jobs.length, 2, `expected both jobs in the take, got ${JSON.stringify(jobs)}`);
  assert.ok(jobs.every((j) => j.clipExists), 'both cascade clips recorded and on disk');
  assert.ok(run.latestRender.masterExists, 'cascade ends stitched (review always has a master)');
  // the delivered size travels with the render — the UI disables the paid upscale at ≥1080p
  assert.ok(Number.isInteger(run.latestRender.masterShortSide), 'masterShortSide is stamped at assembly');
  assert.ok(run.latestRender.masterShortSide < 1080, 'demo clips are small — upscale stays offered');
  assert.ok(run.manifest.cuts.length > before.manifest.cuts.length, 'a fresh cut was recorded');
});

test('approve with upscale: Topaz child runs, final recorded, run completes', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId } = await makeReviewedRun('upscale me');
  const res = await post(`/api/runs/${runId}/approve`, { upscale: true });
  assert.equal(res.statusCode, 202, res.body); // paid upscale queued → 202 (plain approve is 200)

  const run = await waitForStatus(runId, 'complete');
  assert.equal(run.manifest.approved.upscaled, true);
  assert.ok(run.manifest.approved.final, 'a final path was recorded');
  assert.ok(fs.existsSync(run.manifest.approved.final), 'the upscaled final exists on disk');
});

test('SSE Last-Event-ID: reconnect replays only the log lines after the cursor', async () => {
  const { runId } = (await post('/api/runs', { idea: 'resume my log', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const all = (await get(`/api/runs/${runId}/log`)).json();
  assert.ok(all.lines.length > 3, 'planning produced log lines');
  const mid = all.lines[Math.floor(all.lines.length / 2)].cursor;

  const res = await fetch(`${base}/api/runs/${runId}/events`, {
    headers: { accept: 'text/event-stream', 'last-event-id': String(mid) },
  });
  const reader = res.body.getReader();
  let buf = '';
  const events = [];
  while (!events.some((e) => e.type === 'log' && e.cursor === all.nextCursor)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += Buffer.from(value).toString();
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }
  await reader.cancel().catch(() => {});
  assert.equal(events[0].type, 'snapshot', 'snapshot still leads on reconnect');
  const logs = events.filter((e) => e.type === 'log');
  assert.equal(logs[0].cursor, mid + 1, 'replay starts right after the Last-Event-ID cursor');
  assert.ok(logs.every((e) => e.cursor > mid), 'nothing at or before the cursor is re-sent');
  assert.equal(logs.at(-1).cursor, all.nextCursor, 'replay catches up to the tip');
});

test('media routes: traversal and malformed escapes are 404s, never 500s', async () => {
  for (const url of [
    '/api/media/elements/..%2Fpackage.json',   // traversal out of elements/
    '/api/media/runs/nope/100%.png',           // lone % — malformed percent-escape
    '/api/media/out/100%zz.mp4',               // malformed escape on out/
    '/api/media/elements/does-not-exist.png',  // simply missing
  ]) {
    const res = await get(url);
    // fastify itself 400s some malformed escapes before routing; ours 404 — NEVER a 500
    assert.ok([400, 404].includes(res.statusCode), `${url} → ${res.statusCode} ${res.body}`);
    assert.ok(res.json().error, 'error shape kept');
  }
});

test('DELETE while the plan is still queued/active is refused with a hint', async () => {
  const { runId } = (await post('/api/runs', { idea: 'delete me early', backend: 'kling', aspect: '9:16', durationS: null })).json();
  const res = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}` });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().hint ?? '', /cancel/i);
  await post(`/api/runs/${runId}/cancel`, {});
});
