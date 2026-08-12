// WS2-P4a — prompt overrides: editing the words we send.
//
// The contract this file pins, end to end:
//
//   · saving is FREE and local — one file write at the RUN root, nothing submitted;
//   · the sidecar holds the user's words VERBATIM and NEVER the system pins (those name reference
//     labels a future render has not laid out yet, so storing one would pin the wrong image);
//   · it survives a revise, which rewrites spec.json underneath it — and says so (stale), while
//     still being what gets sent, word for word;
//   · every take gets its OWN copy at enqueue, because a take is immutable and has to be able to
//     answer "what did we send for t3?" from t3 alone.
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
const { createRunService } = await import('../../lib/run-service.js');
const { newManifest, writeManifest, readManifest } = await import('../../lib/web-manifest.js');

const FF = await hasFfmpeg();
const fal = await startFalServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-prompt-edit-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), 'SEEDANCE_PROMPT_MAX_BYTES=4321\n');

const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);
const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri', SEEDANCE_PROMPT_MAX_BYTES: '4321',
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
};

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, childEnv, envRoot });
test.after(async () => { await app.close(); await fal.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const put = (url, payload) => app.inject({ method: 'PUT', url, payload });
const del = (url, payload) => app.inject({ method: 'DELETE', url, payload });

const sidecarOf = (runId) => path.join(runsDir, runId, 'prompt-overrides.json');
const specOf = (runId) => path.join(runsDir, runId, 'spec.json');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

async function waitForStatus(runId, statuses, timeoutMs = 120000) {
  const want = new Set([].concat(statuses));
  const t0 = Date.now();
  for (;;) {
    const run = (await get(`/api/runs/${runId}`)).json().run;
    if (want.has(run.status)) return run;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${[...want]} (last: ${run.status} err=${JSON.stringify(run.error)})`);
    await sleep(150);
  }
}
async function plannedRun(idea = 'a lighthouse keeper on his last night') {
  const { runId } = (await post('/api/runs', { idea, backend: 'seedance', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  return runId;
}
const firstJob = async (runId) => (await get(`/api/runs/${runId}/prompts`)).json().prompts[0].jobId;

// ── Save / read / discard ───────────────────────────────────────────────────────────────────────

test('PUT stores the words verbatim; GET /prompt serves them as an override, and submits nothing', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  const before = fal.requests.length;

  const mine = 'A much quieter version of the same three shots, held longer on the lamp.';
  const saved = await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: mine });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().source, 'override');
  assert.equal(fal.requests.length, before, 'saving an edit is genuinely free — nothing left the machine');

  // Stored at the RUN root (not the take dir, not inside spec.json), words only.
  const stored = readJson(sidecarOf(runId));
  assert.equal(stored.jobs[jobId].prompt, mine, 'byte for byte what was typed — no trimming, no pins');
  assert.ok(stored.jobs[jobId].fingerprint, 'the plan it was written against is recorded, for the stale banner');
  assert.ok(!JSON.stringify(stored).includes('literal first frame'), 'a seam pin sentence is NEVER stored');
  assert.ok(!/@Image\d/.test(JSON.stringify(stored)), 'no reference label is frozen into the sidecar');

  const view = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json();
  assert.equal(view.source, 'override');
  assert.equal(view.stale, false);
  assert.ok(view.prompt.includes(mine), 'the words are in the prompt we would send');
  assert.match(view.prompt, /No on-screen text/, 'the system contract is re-composed over them');
  assert.ok(view.pinBytes > 0);
});

test('DELETE discards the edit and restores the agents\' text byte for byte', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  const original = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json().prompt;

  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'a temporary idea' });
  const gone = await del(`/api/runs/${runId}/prompt?job=${jobId}`);
  assert.equal(gone.statusCode, 200);
  assert.equal(gone.json().source, 'plan');
  assert.ok(!fs.existsSync(sidecarOf(runId)), 'the last edit discarded takes the sidecar with it');

  const restored = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json();
  assert.equal(restored.source, 'plan');
  assert.equal(Buffer.compare(Buffer.from(restored.prompt, 'utf8'), Buffer.from(original, 'utf8')), 0);
});

// `jobs` is a plain object literal, so a bracket read of '__proto__'/'constructor'/'toString' finds
// an INHERITED member and answers "yes, there was an edit here". That would turn a 404 into a 200,
// broadcast a prompt-override event to every open tab and file a discard row in the History panel
// for a job that never existed.
test('DELETE /prompt on an Object.prototype key is a 404, not a bogus success', async () => {
  const runId = await plannedRun();
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const r = await del(`/api/runs/${runId}/prompt?job=${encodeURIComponent(key)}`);
    assert.equal(r.statusCode, 404, `"${key}" is not a job in this plan (got ${r.statusCode}: ${r.body})`);
  }
  assert.ok(!fs.existsSync(sidecarOf(runId)), 'and nothing was written on the way out');
  const m = readManifest(path.join(runsDir, runId));
  assert.equal((m?.history ?? []).filter((h) => h?.kind === 'prompt-discard').length, 0, 'no junk history row');
});

// The mirror image of the read above: a plan may legitimately CALL a job `__proto__` (the spec asks
// only that a job_id is non-empty), and `jobs[jobId] = edit` on a plain object then hits
// Object.prototype's setter — no own key, `Object.keys` empty, the sidecar deleted as "no edits
// left", and the words the user typed for a paid render gone with a 200 in front of them.
test('a job the plan named "__proto__" keeps its edit — the sidecar is a null-prototype map', async () => {
  const runId = await plannedRun();
  const jobId = '__proto__';
  const spec = readJson(specOf(runId));
  spec.kling.jobs[0].job_id = jobId;
  fs.writeFileSync(specOf(runId), JSON.stringify(spec, null, 2));

  const mine = 'the lamp room, held, nothing moving';
  const saved = await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: mine });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().source, 'override');

  assert.ok(fs.existsSync(sidecarOf(runId)), 'the sidecar survives the save');
  assert.equal(readJson(sidecarOf(runId)).jobs[jobId].prompt, mine, 'stored under the id the plan used');

  const view = (await get(`/api/runs/${runId}/prompt?job=${encodeURIComponent(jobId)}`)).json();
  assert.equal(view.source, 'override');
  assert.ok(view.prompt.includes(mine), 'and it is what a later render would send');

  // Every other job still reads as the plan's — the map answers for own keys only.
  const other = (await get(`/api/runs/${runId}/prompt?job=${spec.kling.jobs[1]?.job_id ?? 'K2'}`)).json();
  if (other?.jobId) assert.equal(other.source, 'plan');
});

test('an over-budget edit is refused WITH the numbers — never silently truncated', async () => {
  const runId = await plannedRun();
  const view = (await get(`/api/runs/${runId}/prompts`)).json().prompts[0];
  const huge = 'x'.repeat(view.maxBytes + 1000);
  const r = await put(`/api/runs/${runId}/prompt`, { job: view.jobId, prompt: huge });
  assert.equal(r.statusCode, 400);
  assert.match(r.body, /\d+ bytes/, 'the message carries the byte numbers the meter shows');
  assert.equal((await get(`/api/runs/${runId}/prompt?job=${view.jobId}`)).json().source, 'plan', 'nothing was stored');
  assert.ok(!fs.existsSync(sidecarOf(runId)));
});

test('an unknown job 404s and writes nothing', async () => {
  const runId = await plannedRun();
  assert.equal((await put(`/api/runs/${runId}/prompt`, { job: 'K9', prompt: 'hello' })).statusCode, 404);
  assert.equal((await put(`/api/runs/${runId}/prompt`, { prompt: 'hello' })).statusCode, 400);
  assert.ok(!fs.existsSync(sidecarOf(runId)));
});

// ── Staleness: the plan moves, the words do not ─────────────────────────────────────────────────

test('when the plan moves under an edit, GET reports stale AND still returns the user\'s text', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  const mine = 'keep the lens in frame throughout';
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: mine });

  // The agents rewrite a shot this job renders — exactly what a revise pass does to the prompt inputs.
  const spec = readJson(specOf(runId));
  const shotId = spec.kling.jobs.find((j) => j.job_id === jobId).shots[0];
  const shot = spec.shots.find((s) => s.shot_id === shotId);
  shot.kling.content_prompt = `${shot.kling.content_prompt} The gale drops to nothing.`;
  fs.writeFileSync(specOf(runId), JSON.stringify(spec, null, 2));

  const view = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json();
  assert.equal(view.stale, true, 'the banner needs to know the plan moved');
  assert.equal(view.source, 'override');
  assert.ok(view.prompt.includes(mine), 'a stale override is STILL what we send, word for word');
  assert.ok(!view.prompt.includes('The gale drops to nothing.'), 'the new plan text did not sneak into what we send');
  assert.ok(view.planPrompt, 'the new plan text is offered alongside, so "Refresh from plan" has something to load');
  assert.ok(view.planPrompt.includes('The gale drops to nothing.'));
});

test('cosmetic churn does NOT stale an edit (a banner nobody believes is worse than none)', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'hold on the lamp' });
  const spec = readJson(specOf(runId));
  spec.project.title = 'A Completely Different Title';
  spec.project.logline = 'rewritten';
  fs.writeFileSync(specOf(runId), JSON.stringify(spec, null, 2));
  assert.equal((await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json().stale, false);
});

// ── revise: the agents rewrite the plan, never the user's words ─────────────────────────────────

test('a revise leaves the sidecar exactly as it was', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'the beam sweeps once, then stops' });
  const before = fs.readFileSync(sidecarOf(runId), 'utf8');

  await post(`/api/runs/${runId}/revise`, { feedback: 'make the ending warmer', scope: 'all' });
  await waitForStatus(runId, ['plan-ready', 'review', 'attention'], 120000);

  assert.ok(fs.existsSync(sidecarOf(runId)), 'a revision rewrites spec.json — the edit lives beside it for exactly this reason');
  assert.equal(fs.readFileSync(sidecarOf(runId), 'utf8'), before, 'not one byte of the user\'s text moved');
  const view = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json();
  assert.equal(view.source, 'override', 'the agents rewriting the plan must not silently discard an edit');
  assert.ok(view.prompt.includes('the beam sweeps once, then stops'));
});

// ── An orphaned edit is kept and said out loud ──────────────────────────────────────────────────

test('an edit whose job the plan no longer has is KEPT, reported, and discardable', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'still wanted' });
  const sc = readJson(sidecarOf(runId));
  sc.jobs.K9 = { prompt: 'for a segment that no longer exists', fingerprint: 'old', updatedAt: new Date().toISOString() };
  fs.writeFileSync(sidecarOf(runId), JSON.stringify(sc, null, 2));

  const all = (await get(`/api/runs/${runId}/prompts`)).json();
  const orphan = all.orphaned.find((o) => o.jobId === 'K9');
  assert.ok(orphan, 'the user\'s text is never thrown away silently');
  assert.equal(orphan.prompt, 'for a segment that no longer exists', 'reported WITH its text, so "Copy the text" has something to copy');
  assert.ok(!all.prompts.some((p) => p.jobId === 'K9'), 'but nothing will send it');
  assert.equal((await del(`/api/runs/${runId}/prompt?job=K9`)).statusCode, 200, 'and it can be cleared');
  assert.ok(!readJson(sidecarOf(runId)).jobs.K9);
});

// ── A past take is a record, not a draft ────────────────────────────────────────────────────────

test('editing a past take\'s prompt is a 409 — the only immutable record in the run stays true', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  const r = await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'rewriting history', take: 't1' });
  assert.equal(r.statusCode, 409);
  assert.ok(!fs.existsSync(sidecarOf(runId)));
});

// ── The broadcast ───────────────────────────────────────────────────────────────────────────────

test('a prompt-override event is broadcast on save and on discard', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  const seen = [];
  const unsub = app.ctx.bus.subscribe(runId, (e) => { if (e.type === 'prompt-override') seen.push(e); });
  try {
    await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'an edit worth broadcasting' });
    await del(`/api/runs/${runId}/prompt?job=${jobId}`);
  } finally { unsub(); }

  assert.deepEqual(seen.map((e) => e.action), ['saved', 'discarded'], 'a second tab must see the edit without a reload');
  assert.equal(seen[0].jobId, jobId);
  assert.equal(seen[0].source, 'override');
  assert.equal(seen[0].stale, false);
  assert.equal(seen[1].source, 'plan');
});

// ── Enqueue: the snapshot, the flag, and the take record ────────────────────────────────────────
//
// Driven against run-service with a recording job manager: this is about the ARGV and the manifest,
// and spawning a real render to observe them would only add minutes and flake.

function fakeService(runId, spec) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeManifest(dir, newManifest({ idea: 'x', backend: 'seedance', aspect: '9:16' }, new Date().toISOString()));
  const enqueued = [];
  const mgr = {
    enqueue: (job) => { enqueued.push(job); return { id: `j${enqueued.length}`, position: 0 }; },
    snapshot: () => ({ active: [], queued: [] }),
    cancel: () => false,
  };
  const svc = createRunService({
    root: HOST_ROOT, runsDir, outDir, envRoot, childEnv, mgr,
    bus: { emit() {}, subscribe: () => () => {} },
    isAlive: () => false,
  });
  return { dir, svc, enqueued };
}

test('render() snapshots the sidecar into the RESERVED take dir, flags the child, and records the source', async () => {
  const planned = await plannedRun();
  const spec = readJson(specOf(planned));
  const jobId = spec.kling.jobs[0].job_id;
  const runId = 'web-19990101000000-edit';
  const { dir, svc, enqueued } = fakeService(runId, spec);
  fs.writeFileSync(path.join(dir, 'prompt-overrides.json'), JSON.stringify({ schema: 1, jobs: { [jobId]: { prompt: 'a marker sentence', fingerprint: 'f', updatedAt: 'now' } } }, null, 2));

  const { takeId } = svc.render(runId, { mode: 'full' });

  const snap = path.join(dir, 'renders', takeId, 'prompt-overrides.json');
  assert.ok(fs.existsSync(snap), 'a take is immutable — it keeps its own copy of what was sent');
  assert.equal(readJson(snap).jobs[jobId].prompt, 'a marker sentence');
  const args = enqueued.at(-1).args;
  assert.ok(args.includes('--prompt-overrides'), 'the render child is told where the words are');
  assert.equal(args[args.indexOf('--prompt-overrides') + 1], snap, 'and it is pointed at the TAKE\'s copy, not the run\'s living one');
  assert.equal(readManifest(dir).takes.at(-1).promptSource, 'override', 'the take records that it rendered an edit');
});

// A sidecar that EXISTS but cannot be used is the one case where degrading is worse than failing:
// the render is PAID, and it would silently ship the agents' words in place of the user's, labelled
// `promptSource:'plan'` with no error anywhere. src/lib/prompt-overrides.js makes the CLI path throw
// for exactly this reason; the web path — the only one a UI user takes — has to agree.
// Editing a prompt is free and iterative — someone tuning one segment saves it dozens of times, and
// every save filed a row that then rode the manifest AND every SSE-triggered detail payload forever.
// The History panel only draws these chronologically, so keeping the newest N costs nothing visible.
test('prompt-edit history is capped — a long tuning session does not grow the manifest forever', async () => {
  const planned = await plannedRun();
  const spec = readJson(specOf(planned));
  const jobId = spec.kling.jobs[0].job_id;
  const runId = 'web-19990101000010-history';
  const { dir, svc } = fakeService(runId, spec);

  for (let i = 0; i < 60; i++) svc.promptOverrideChanged(runId, { jobId, action: 'saved', source: 'override' });
  const history = readManifest(dir).history;
  const edits = history.filter((h) => h.kind === 'prompt-edit');
  assert.ok(edits.length > 0 && edits.length <= 20, `capped, not unbounded (got ${edits.length})`);
  assert.equal(new Set(edits.map((h) => h.id)).size, edits.length, 'ids stay unique across a compaction');
  assert.equal(edits.at(-1).id, 'prompt-edit-60', 'the newest row is still numbered for what it is');
  // Only the edit rows are compacted: a reopen is a lifecycle FACT, and dropping one would rewrite
  // what happened to the run (its shape is asserted in reopen-finalize.test.js).
  assert.equal(history.filter((h) => h.kind !== 'prompt-edit' && h.kind !== 'prompt-discard').length,
    0, 'this fixture only ever filed edits — nothing else was touched');
});

test('a corrupt overrides sidecar REFUSES the render (409) rather than quietly rendering the plan', async () => {
  const planned = await plannedRun();
  const spec = readJson(specOf(planned));
  const runId = 'web-19990101000009-corrupt';
  const { dir, svc, enqueued } = fakeService(runId, spec);
  const before = enqueued.length;
  fs.writeFileSync(path.join(dir, 'prompt-overrides.json'), '{ "schema": 1, "jobs": { oops');

  assert.throws(() => svc.render(runId, { mode: 'full' }), (e) => {
    assert.equal(e.statusCode, 409);
    assert.match(String(e.message), /prompt edits are unusable/i);
    return true;
  });
  assert.equal(enqueued.length, before, 'nothing was queued — a refused render costs exactly nothing');
  assert.equal(readManifest(dir).takes.length, 0, 'and no take pretends to have happened');
  assert.ok(!fs.existsSync(path.join(dir, 'renders', 't1')), 'the reserved take dir is released, not left to burn a number');
});

test('a run with no edits keeps today\'s argv and records promptSource "plan"', async () => {
  const planned = await plannedRun();
  const spec = readJson(specOf(planned));
  const runId = 'web-19990101000001-plain';
  const { dir, svc, enqueued } = fakeService(runId, spec);

  const { takeId } = svc.render(runId, { mode: 'full' });
  assert.ok(!enqueued.at(-1).args.includes('--prompt-overrides'));
  assert.ok(!fs.existsSync(path.join(dir, 'renders', takeId, 'prompt-overrides.json')));
  assert.equal(readManifest(dir).takes.at(-1).promptSource, 'plan');
});

test('a re-render of a job with no edit is not labelled edited, even when a sibling job has one', async () => {
  const planned = await plannedRun('a two-job idea — TWO-JOB');
  const spec = readJson(specOf(planned));
  assert.ok(spec.kling.jobs.length > 1, 'this case needs a multi-job plan');
  const [first, second] = spec.kling.jobs.map((j) => j.job_id);
  const runId = 'web-19990101000002-sibling';
  const { dir, svc } = fakeService(runId, spec);
  fs.writeFileSync(path.join(dir, 'prompt-overrides.json'), JSON.stringify({ schema: 1, jobs: { [first]: { prompt: 'only the first', fingerprint: 'f', updatedAt: 'now' } } }, null, 2));

  svc.rerenderJob(runId, { jobId: second });
  assert.equal(readManifest(dir).takes.at(-1).promptSource, 'plan', 'K1\'s edit says nothing about a K2-only re-render');

  svc.rerenderJob(runId, { jobId: first });
  assert.equal(readManifest(dir).takes.at(-1).promptSource, 'override');
});

// ── The whole point: the edited words are what gets rendered ────────────────────────────────────

test('the edit reaches the wire, and the take\'s own record says whose words they were', async () => {
  const runId = await plannedRun();
  const jobId = await firstJob(runId);
  const marker = 'a single unmistakable marker sentence for this take';
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: marker });

  const before = fal.requests.length;
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  const run = await waitForStatus(runId, ['review', 'attention'], 180000);

  const sent = fal.requests.slice(before)
    .filter((q) => q.method === 'POST' && q.path === '/seedance-submit')
    .map((q) => JSON.parse(q.body).prompt);
  assert.ok(sent.some((p) => p.includes(marker)), 'the edited words were actually rendered');
  assert.ok(sent.every((p) => p.includes('No on-screen text')), 'and the system contract rode along on every one');

  const take = run.manifest.takes.at(-1);
  assert.equal(take.promptSource, 'override');
  assert.ok(fs.existsSync(path.join(runsDir, runId, 'renders', take.id, 'prompt-overrides.json')));
  const sidecar = readJson(path.join(runsDir, runId, 'renders', take.id, jobId, 'prompts.json'));
  assert.equal(sidecar.prompt_source, 'override', 'the take explains why its text differs from the plan');
  assert.ok(sidecar.prompt.includes(marker));

  // And the preview promise still holds for an override: what we showed is what we sent.
  const asSent = (await get(`/api/runs/${runId}/prompt?job=${jobId}&take=${take.id}`)).json();
  assert.equal(asSent.source, 'take');
  assert.equal(Buffer.compare(Buffer.from(asSent.prompt, 'utf8'), Buffer.from(sent.find((p) => p.includes(marker)), 'utf8')), 0);
});
