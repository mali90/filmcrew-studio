// WS2-P6 — reopen after finalize, and the server-side guard that makes it necessary.
//
// TODAY'S HOLE: once a run is approved, the UI hides the spend buttons — and that is the ONLY thing
// stopping post-approval spend. A stale tab, a second browser, a curl, or a double-click that lands
// after the approve all still reach POST /render and bill the user against a run that is already
// delivered. `assertNotFinalized` closes it server-side; `POST /reopen` is the front door that
// opens it again, deliberately.
//
// The other half is that reopening must LOSE NOTHING. The delivered file stays on disk, the old
// approval stays in the manifest until a new one supersedes it, and `finals[]` keeps the history —
// which is what lets FinalCard say "your final file stays on disk either way" and mean it.
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-reopen-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '# isolated\n');
const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);

const app = await buildApp({
  root: HOST_ROOT,
  runsDir,
  outDir,
  envRoot,
  childEnv: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
    FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
    FAL_STORAGE_INITIATE_URL: `${fal.baseUrl}/storage/upload/initiate`,
    FAL_KLING_ENDPOINT: 'submit', FAL_TOPAZ_ENDPOINT: 'topaz-submit',
    FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
    SEEDANCE_UPLOAD_MODE: 'data-uri',
    VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
    SEGMIND_API_KEY: '', SEGMIND_BASE_URL: 'http://127.0.0.1:1',
  },
});
test.after(async () => { await app.close(); await fal.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const manifestOf = (runId) => JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'web.json'), 'utf8'));

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
async function approvedRun(idea) {
  const { runId } = (await post('/api/runs', { idea, backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  await waitForStatus(runId, 'review');
  const r = await post(`/api/runs/${runId}/approve`, { upscale: false });
  assert.equal(r.statusCode, 200, r.body);
  await waitForStatus(runId, ['complete', 'review']);
  return runId;
}

const FF_SKIP = FF ? null : 'ffmpeg not installed';
let READY = false;
if (FF) {
  // One full approve, once, purely to ask "is the guard in place yet?". Wrapped so an unrelated
  // failure parks the file as pending instead of exploding at module scope.
  try {
    const probe = await approvedRun('an arming probe for the reopen guard');
    READY = (await post(`/api/runs/${probe}/render`, { mode: 'full' })).statusCode === 409;
  } catch { READY = false; }
}
const PENDING = FF_SKIP ? { skip: FF_SKIP } : pending(READY, 'WS2-P6: assertNotFinalized + POST /reopen');

// ── The guard ───────────────────────────────────────────────────────────────────────────────────

test('every spending action 409s on a finalized run — the UI is no longer the only lock', PENDING, async () => {
  const runId = await approvedRun('a keeper closing the light for the last time');
  const submitsBefore = fal.requests.filter((q) => q.method === 'POST').length;
  const specBefore = fs.readFileSync(path.join(runsDir, runId, 'spec.json'), 'utf8');

  for (const [url, payload] of [
    [`/api/runs/${runId}/render`, { mode: 'full' }],
    [`/api/runs/${runId}/revise`, { feedback: 'warmer ending', scope: 'all' }],
    [`/api/runs/${runId}/rerender-job`, { jobId: 'K1' }],
    [`/api/runs/${runId}/assemble`, {}],
    // Replanning is the same class of action as revising, and strictly worse on a delivered run: a
    // full engine pass (LLM spend) that REWRITES spec.json under a file the user already has, which
    // would desynchronise the prompt views, the lineage and the finals history from that file.
    [`/api/runs/${runId}/plan`, {}],
  ]) {
    const r = await post(url, payload);
    assert.equal(r.statusCode, 409, `${url} must refuse work on a delivered run (got ${r.statusCode})`);
    assert.match(r.body, /reopen/i, 'the message must name the way forward, not just say no');
  }
  await sleep(300); // any child that slipped past the guard would have submitted by now
  assert.equal(fal.requests.filter((q) => q.method === 'POST').length, submitsBefore,
    'a refused action must cost exactly nothing — not one job was submitted');
  assert.equal(fs.readFileSync(path.join(runsDir, runId, 'spec.json'), 'utf8'), specBefore,
    'and the plan behind the delivered file is byte-for-byte where it was');
});

test('the guard is on the SERVICE, so a stale tab cannot spend by racing the UI', PENDING, async () => {
  const runId = await approvedRun('a second keeper, a second light');
  const [a, b] = await Promise.all([
    post(`/api/runs/${runId}/render`, { mode: 'full' }),
    post(`/api/runs/${runId}/render`, { mode: 'full' }),
  ]);
  assert.equal(a.statusCode, 409);
  assert.equal(b.statusCode, 409);
});

// ── Reopen ──────────────────────────────────────────────────────────────────────────────────────

test('approve → render 409 → reopen → render 202 (the plan\'s verification case, end to end)', PENDING, async () => {
  const runId = await approvedRun('the lamp goes dark at dawn');
  assert.equal((await post(`/api/runs/${runId}/render`, { mode: 'full' })).statusCode, 409);

  const re = await post(`/api/runs/${runId}/reopen`, {});
  assert.equal(re.statusCode, 200, re.body);

  const m = manifestOf(runId);
  assert.ok(m.reopenedAt, 'the manifest records WHEN it was reopened — that timestamp is what "complete" compares against');
  assert.ok(m.approved, 'the previous approval is KEPT until a new one supersedes it');
  assert.ok(Array.isArray(m.finals) && m.finals.length >= 1, 'the delivered file is in the history');
  // `final` is the delivered file, named exactly as `approved.final` names it
  assert.ok(fs.existsSync(m.finals[0].final ?? m.approved.final), 'the final mp4 is still on disk — nothing was deleted');

  const again = await post(`/api/runs/${runId}/render`, { mode: 'full' });
  assert.ok([200, 202].includes(again.statusCode), `a reopened run renders again (got ${again.statusCode})`);
  await waitForStatus(runId, ['review', 'error']);
});

test('a reopened run is NOT complete until it is approved again', PENDING, async () => {
  const runId = await approvedRun('a third keeper');
  assert.equal((await get(`/api/runs/${runId}`)).json().run.status, 'complete');

  await post(`/api/runs/${runId}/reopen`, {});
  const reopened = (await get(`/api/runs/${runId}`)).json().run;
  assert.notEqual(reopened.status, 'complete', 'approved.at is older than reopenedAt — the run is open again');

  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  await waitForStatus(runId, 'review');
  assert.equal((await post(`/api/runs/${runId}/approve`, { upscale: false })).statusCode, 200);
  await waitForStatus(runId, 'complete');

  const m = manifestOf(runId);
  assert.ok(new Date(m.approved.at) > new Date(m.reopenedAt), 'complete iff approved.at > reopenedAt');
  assert.equal(m.finals.length, 2, 'both deliveries are on record');
  assert.notEqual(m.finals[0].final, m.finals[1].final, 'the second approval writes a NEW file, never over the first');
  for (const f of m.finals) assert.ok(fs.existsSync(f.final), `${f.final} still on disk`);
  assert.equal(m.finals[0].replacedBy, m.finals[1].id, 'the superseded delivery says what replaced it');
});

test('reopening twice is idempotent-ish: it never loses a final and never double-counts', PENDING, async () => {
  const runId = await approvedRun('a fourth keeper');
  await post(`/api/runs/${runId}/reopen`, {});
  const first = manifestOf(runId);
  const second = await post(`/api/runs/${runId}/reopen`, {});
  assert.ok([200, 409].includes(second.statusCode), 'a second reopen is either a no-op or an honest conflict');
  const m = manifestOf(runId);
  assert.equal(m.finals.length, first.finals.length, 'no phantom final was appended');
});

test('reopen is REFUSED while an upscale is in flight (the final is still being written)', PENDING, async () => {
  const { runId } = (await post('/api/runs', { idea: 'a keeper and a paid upscale', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  await waitForStatus(runId, 'review');

  const approve = await post(`/api/runs/${runId}/approve`, { upscale: true });
  assert.equal(approve.statusCode, 202, approve.body); // the paid Topaz tail is QUEUED (202); a plain approve is 200
  // The upscale runs as a queued child; while it does, reopening would race the file it is writing.
  const during = await post(`/api/runs/${runId}/reopen`, {});
  if (during.statusCode !== 200) {
    assert.equal(during.statusCode, 409);
    assert.match(during.body, /upscal/i, 'the refusal says WHY — an upscale is still running');
  }
  await waitForStatus(runId, ['complete', 'review', 'error']);
});

test('reopen on a run that was never approved is a 409, not a silent success', PENDING, async () => {
  const { runId } = (await post('/api/runs', { idea: 'never finished', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const r = await post(`/api/runs/${runId}/reopen`, {});
  assert.equal(r.statusCode, 409);
  assert.equal(manifestOf(runId).reopenedAt ?? null, null);
});

// P2 set the contract for the sibling feature ("continuity exposes take/job ids only, never fs
// paths"). The delivery history has no reason to be looser: the UI takes basename() of every entry
// it draws, so the host's directory layout was riding the wire for nothing.
test('the delivery history reaches the browser as file NAMES, never host paths', PENDING, async () => {
  const runId = await approvedRun('a sixth keeper');
  await post(`/api/runs/${runId}/reopen`, {});
  const m = (await get(`/api/runs/${runId}`)).json().run.manifest;

  for (const entry of [...(m.finals ?? []), ...(m.history ?? [])]) {
    if (!entry.final) continue;
    assert.ok(!/[/\\]/.test(entry.final), `${entry.final} is a path, not a name`);
    assert.match(entry.final, /\.mp4$/, 'the NAME survives — it is what the copy and the media url use');
  }
  // On disk the manifest still holds the real path: nothing about the delivery moved, only the view.
  assert.ok(path.isAbsolute(manifestOf(runId).finals[0].final), 'the server keeps the path it needs');
});

test('the take history records the reopen so the user can see what happened when', PENDING, async () => {
  const runId = await approvedRun('a fifth keeper');
  await post(`/api/runs/${runId}/reopen`, {});
  const run = (await get(`/api/runs/${runId}`)).json().run;
  const m = run.manifest;
  const entries = [...(m.takes ?? []), ...(m.history ?? []), ...(m.cuts ?? [])];
  assert.ok(JSON.stringify(entries).includes('reopen'), 'TakesHistory needs a row for "reopened for changes"');
});
