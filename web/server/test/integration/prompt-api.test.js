// WS2-P3/P4 — the prompt read + edit surface.
//
// The promise the UI makes is "this is what we send". It is only true if the server composes the
// preview with the SAME pure composer the renderer uses (src/lib/prompt-compose.js), from the same
// spec, with the same settings. So the load-bearing assertion in this file is not a shape check —
// it is: PREVIEW BYTES === WIRE BYTES.
//
// Two constraints shape the implementation and are pinned here:
//   · web/server's STATIC import graph must stay config-free (the runs-caps canary). A prompt
//     service that needs the user's byte budgets must therefore LAZY-import config, and read the
//     .env file as DATA — never source it into the process.
//   · saving an override costs nothing and renders nothing. It is written to a sidecar next to the
//     spec, survives a revise, and is snapshotted into the take directory at enqueue so a past take
//     always shows exactly what was sent for it.
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
const { pending } = await import(path.join(HOST_ROOT, 'test/helpers/tdd.js'));
const { buildApp } = await import('../../app.js');

const FF = await hasFfmpeg();
const fal = await startFalServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-prompt-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
// A .env with a NON-DEFAULT byte budget: the preview must reflect it (proving the value was read)
// while the process must never gain the variable (proving the file was read as data, not sourced).
fs.writeFileSync(path.join(envRoot, '.env'), 'SEEDANCE_PROMPT_MAX_BYTES=4321\nKVA_PROMPT_CANARY=must-not-be-sourced\n');

const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);
const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit', FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri', SEEDANCE_PROMPT_MAX_BYTES: '4321',
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
  SEGMIND_API_KEY: '', SEGMIND_BASE_URL: 'http://127.0.0.1:1',
};

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, childEnv, envRoot });
await app.listen({ port: 0, host: '127.0.0.1' }); // the SSE assertion needs a real socket
const base = `http://127.0.0.1:${app.server.address().port}`;
test.after(async () => { await app.close(); await fal.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const put = (url, payload) => app.inject({ method: 'PUT', url, payload });
const del = (url, payload) => app.inject({ method: 'DELETE', url, payload });

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
async function plannedRun(idea = 'a lighthouse keeper on his last night') {
  const { runId } = (await post('/api/runs', { idea, backend: 'seedance', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  return runId;
}

// Two arming probes, because read (P3) and edit (P4) ship in that order and each phase has to be
// independently green: the read specs arm on the read endpoint answering, the edit specs on the
// write route existing at all (a route-table question, so no assumption about its error contract).
const probeRun = await plannedRun('an arming probe');
const READY = (await get(`/api/runs/${probeRun}/prompts`)).statusCode === 200;
const PENDING = pending(READY, 'WS2-P3: GET /api/runs/:id/prompt|/prompts');
const EDIT_READY = READY && app.hasRoute({ method: 'PUT', url: '/api/runs/:id/prompt' });
const PENDING_EDIT = pending(EDIT_READY, 'WS2-P4: PUT/DELETE /api/runs/:id/prompt');

// ── P3: read ────────────────────────────────────────────────────────────────────────────────────

test('GET /prompts returns one composed prompt per job, with the budget the .env asked for', PENDING, async () => {
  const runId = await plannedRun();
  const r = await get(`/api/runs/${runId}/prompts`);
  assert.equal(r.statusCode, 200);
  const { prompts } = r.json();
  assert.ok(prompts.length >= 1);
  for (const p of prompts) {
    assert.ok(p.jobId, 'every entry names its job');
    assert.ok(p.prompt.length > 0);
    assert.equal(p.source, 'plan', 'nothing has been edited or sent yet');
    assert.equal(p.maxBytes, 4321, "the user's own SEEDANCE_PROMPT_MAX_BYTES reached the preview");
    assert.ok(p.pinBytes > 0 && p.pinBytes < p.maxBytes, 'the byte meter needs a system-pin denominator');
    assert.ok(p.fingerprint, 'the staleness oracle travels with the prompt');
    assert.equal(p.stale, false);
  }
});

test('GET /prompt?job=… returns one job, 404s an unknown one, and leaks no filesystem paths', PENDING, async () => {
  const runId = await plannedRun();
  const jobId = (await get(`/api/runs/${runId}/prompts`)).json().prompts[0].jobId;

  const one = await get(`/api/runs/${runId}/prompt?job=${jobId}`);
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().jobId, jobId);
  assert.ok(!one.body.includes(runsDir), 'no host path in an API response');

  assert.equal((await get(`/api/runs/${runId}/prompt?job=NOPE`)).statusCode, 404);
  assert.equal((await get('/api/runs/does-not-exist/prompt?job=K1')).statusCode, 404);
});

test('reading the .env for budgets must NOT source it into the server process', PENDING, async () => {
  const runId = await plannedRun();
  assert.equal((await get(`/api/runs/${runId}/prompts`)).statusCode, 200);
  assert.equal(process.env.KVA_PROMPT_CANARY, undefined,
    'the prompt service read the .env as DATA; sourcing it would give a request the power to reconfigure the server');
});

test("web/server's static import graph still never reaches config.js (prompt service lazy-imports)", PENDING, () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(HOST_ROOT, file);
    assert.ok(!/from\s+['"]dotenv/.test(src), `${rel} must not load dotenv`);
    const specs = [
      ...src.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*export\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    for (const s of specs) {
      if (!s.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), s);
      assert.notEqual(path.basename(resolved), 'config.js', `${rel} statically imports config.js`);
      visit(resolved);
    }
  };
  for (const entry of ['web/server/routes/runs.js', 'web/server/app.js']) visit(path.join(HOST_ROOT, entry));
  assert.ok(seen.size > 1);
});

// ── The gate: preview === what is sent ──────────────────────────────────────────────────────────

test('THE CONTRACT: the previewed prompt is byte-identical to the prompt on the wire', PENDING, async () => {
  const runId = await plannedRun();
  const preview = (await get(`/api/runs/${runId}/prompts`)).json().prompts;

  const before = fal.requests.length;
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  await waitForStatus(runId, ['review', 'error'], 120000);

  const sent = fal.requests.slice(before)
    .filter((q) => q.method === 'POST' && q.path === '/seedance-submit')
    .map((q) => JSON.parse(q.body).prompt);
  assert.equal(sent.length, preview.length, 'one submit per previewed job');
  preview.forEach((p, i) => {
    assert.equal(
      Buffer.compare(Buffer.from(p.prompt, 'utf8'), Buffer.from(sent[i], 'utf8')), 0,
      `job ${p.jobId}: the preview and the paid render must not differ by a single byte`,
    );
  });
});

// ── P4: edit ────────────────────────────────────────────────────────────────────────────────────

test('PUT /prompt writes an override sidecar, flips source to "override", and renders nothing', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  const jobId = (await get(`/api/runs/${runId}/prompts`)).json().prompts[0].jobId;
  const before = fal.requests.length;

  const edited = 'A much quieter version of the same three shots, held longer on the lamp.';
  const r = await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: edited });
  assert.equal(r.statusCode, 200);
  assert.equal(fal.requests.length, before, 'saving an edit is free — nothing was submitted');

  const sidecar = path.join(runsDir, runId, 'prompt-overrides.json');
  assert.ok(fs.existsSync(sidecar), 'the override lives beside the spec, not inside it');

  const after = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json();
  assert.equal(after.source, 'override');
  assert.ok(after.prompt.includes(edited), 'the user\'s words are in the prompt');
});

test('an override NEVER loses the system pins — the words are the user\'s, the contract is ours', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  const { prompts } = (await get(`/api/runs/${runId}/prompts`)).json();
  const jobId = prompts[0].jobId;
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'just this sentence' });
  const after = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json();
  assert.ok(after.pinBytes > 0);
  assert.match(after.prompt, /No on-screen text/, 'the text rule survives an override');
  assert.ok(after.prompt.includes('just this sentence'));
});

test('an over-budget edit is REJECTED with the numbers, never silently truncated', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  const { prompts } = (await get(`/api/runs/${runId}/prompts`)).json();
  const jobId = prompts[0].jobId;
  const huge = 'x'.repeat(prompts[0].maxBytes + 1000);
  const r = await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: huge });
  assert.equal(r.statusCode, 400);
  assert.match(r.body, /\d+/, 'the message carries the byte numbers the meter shows');
  assert.equal((await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json().source, 'plan', 'nothing was saved');
});

test('DELETE /prompt discards the override and restores the agents\' text exactly', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  const { prompts } = (await get(`/api/runs/${runId}/prompts`)).json();
  const jobId = prompts[0].jobId;
  const original = prompts[0].prompt;

  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'a temporary idea' });
  assert.equal((await del(`/api/runs/${runId}/prompt`, { job: jobId })).statusCode, 200);

  const restored = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json();
  assert.equal(restored.source, 'plan');
  assert.equal(Buffer.compare(Buffer.from(restored.prompt, 'utf8'), Buffer.from(original, 'utf8')), 0);
});

test('an override SURVIVES a revise, and the fingerprint marks it stale so the user is told', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  const { prompts } = (await get(`/api/runs/${runId}/prompts`)).json();
  const jobId = prompts[0].jobId;
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'keep the lens in frame throughout' });

  await post(`/api/runs/${runId}/revise`, { feedback: 'make the ending warmer', scope: 'all' });
  await waitForStatus(runId, ['plan-ready', 'review', 'error'], 120000);

  const after = (await get(`/api/runs/${runId}/prompt?job=${jobId}`)).json();
  assert.equal(after.source, 'override', 'the agents rewriting the plan must NOT silently discard the user\'s words');
  assert.ok(after.prompt.includes('keep the lens in frame throughout'));
  assert.equal(after.stale, true, 'the plan moved underneath the edit — the banner needs to know');
  assert.ok(after.planPrompt, 'the NEW plan text is offered alongside, so "Refresh plan" has something to load');
});

test('an override reaches the wire, and is snapshotted into the take dir at enqueue', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  const { prompts } = (await get(`/api/runs/${runId}/prompts`)).json();
  const jobId = prompts[0].jobId;
  const marker = 'a single unmistakable marker sentence for this take';
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: marker });

  const before = fal.requests.length;
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  const run = await waitForStatus(runId, ['review', 'error'], 120000);

  const sent = fal.requests.slice(before).filter((q) => q.method === 'POST' && q.path === '/seedance-submit').map((q) => JSON.parse(q.body).prompt);
  assert.ok(sent.some((p) => p.includes(marker)), 'the edited words were actually rendered');

  const take = run.takes?.at(-1);
  assert.equal(take?.promptSource, 'override', 'the take records that it was rendered from an edit');
  const snap = path.join(runsDir, runId, 'renders', take.id, 'prompt-overrides.json');
  assert.ok(fs.existsSync(snap), 'a past take is immutable — it keeps its own copy of what was sent');
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(snap, 'utf8'))).includes(marker));
});

test('a past take\'s prompt is served "as sent" and can never be edited', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  const run = await waitForStatus(runId, ['review', 'error'], 120000);
  const takeId = run.takes.at(-1).id;
  const jobId = (await get(`/api/runs/${runId}/prompts`)).json().prompts[0].jobId;

  const asSent = await get(`/api/runs/${runId}/prompt?job=${jobId}&take=${takeId}`);
  assert.equal(asSent.statusCode, 200);
  assert.equal(asSent.json().source, 'take');
  assert.equal(asSent.json().take, takeId);

  const r = await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'rewriting history', take: takeId });
  assert.equal(r.statusCode, 409, 'past takes are immutable — the UI offers "Use this draft" instead');
});

test('an override for a job the plan no longer has is KEPT and reported as orphaned', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  const sidecarPath = path.join(runsDir, runId, 'prompt-overrides.json');
  const jobId = (await get(`/api/runs/${runId}/prompts`)).json().prompts[0].jobId;
  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'still wanted' });
  const sc = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  sc.jobs = { ...sc.jobs, K9: { prompt: 'for a segment that no longer exists' } };
  fs.writeFileSync(sidecarPath, JSON.stringify(sc));

  const all = (await get(`/api/runs/${runId}/prompts`)).json();
  assert.ok(all.orphaned.some((o) => o.jobId === 'K9'), 'the user\'s text is never thrown away silently');
  assert.ok(!all.prompts.some((p) => p.jobId === 'K9'), 'but it is not rendered either');
});

test('a prompt-override SSE event is emitted on save and on discard', PENDING_EDIT, async () => {
  const runId = await plannedRun();
  const jobId = (await get(`/api/runs/${runId}/prompts`)).json().prompts[0].jobId;

  const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: { accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const pump = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const f of frames) {
        const data = f.split('\n').find((l) => l.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (events.filter((e) => e.type === 'prompt-override').length >= 2) return;
    }
  })();

  await put(`/api/runs/${runId}/prompt`, { job: jobId, prompt: 'an edit worth broadcasting' });
  await del(`/api/runs/${runId}/prompt`, { job: jobId });
  await Promise.race([pump, sleep(5000)]);
  await reader.cancel().catch(() => {});

  const actions = events.filter((e) => e.type === 'prompt-override').map((e) => e.action);
  assert.deepEqual(actions, ['saved', 'discarded'], 'a second tab must see the edit without a reload');
});
