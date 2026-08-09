// GET /api/runs/:id must say, per segment, whether it really continues from the one before it —
// and it must be RIGHT about the case that motivated the whole rule (run b1nx): a cut that mixes
// take 2's K1 with take 1's K2 looks chained from every angle (K2 does open on a K1 last frame)
// but the frame it opens on is no longer in the cut. Calling that a continuation hands the joint to
// the seamless stitcher and promises the user a join that will visibly jump.
//
// Nothing here spends, spawns or renders: the run directories are fabricated on disk in exactly the
// layout the render CLIs and run-service.composeCut leave behind, and the assertions run against the
// real HTTP read model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildApp } = await import('../../app.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-continuity-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir });
test.after(async () => { await app.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });

// ── fabricating runs ────────────────────────────────────────────────────────────────────────────

const clipOf = (runId, take, job) => path.join(runsDir, runId, 'renders', take, job, 'clip.mp4');
const at = (runId, take, job) => ({ take, job, clip: clipOf(runId, take, job) });

// The opening frame really is a still grabbed off the source clip — same dir, `last_frame.png`.
const seamIn = (from) => (from ? { mode: 'soft', frame: path.join(path.dirname(from.clip), 'last_frame.png'), from } : { mode: 'none', frame: null, from: null });
const seamOut = (to) => (to ? { mode: 'soft', frame: null, frameSource: 'ffmpeg', to } : { mode: 'none', frame: null, to: null });

/** One job record as the renderers write it into a take's render.json (schema:2). */
function rec(runId, take, jobId, { from = null, to = null, legacy = false } = {}) {
  const clip = clipOf(runId, take, jobId);
  return legacy
    ? { jobId, job: jobId, clip, error: null }
    : { jobId, job: jobId, clip, error: null, seamIn: seamIn(from), seamOut: seamOut(to) };
}

/**
 * Write a take dir: every job's clip file (so the scan sees real artifacts) plus the render.json.
 * `jobs` are already-built records — a COMPOSED cut legitimately lists clips belonging to older
 * takes, which is the shape the continuity rule has to see through.
 */
function writeTake(runId, take, jobs, extra = {}) {
  const takeDir = path.join(runsDir, runId, 'renders', take);
  for (const j of jobs) {
    if (!j.clip) continue;
    fs.mkdirSync(path.dirname(j.clip), { recursive: true });
    fs.writeFileSync(j.clip, 'FAKE-MP4');
  }
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(path.join(takeDir, 'render.json'), JSON.stringify({ project: 'Ocean Lighthouse', backend: 'kling-o3@fal', jobs, ...extra }, null, 2) + '\n');
  return takeDir;
}

/** A master on disk under the newest take puts the run in `review` — the page the strip lives on. */
function finish(runId, take) {
  const master = path.join(outDir, `${runId}.mp4`);
  fs.writeFileSync(master, 'FAKE-MP4');
  const p = path.join(runsDir, runId, 'renders', take, 'render.json');
  const rj = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...rj, master, masterShortSide: 720 }, null, 2) + '\n');
}

function writeRun(runId, jobIds, manifest = null) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({
    spec_version: '1.0',
    project: { title: 'Ocean Lighthouse' },
    shots: jobIds.map((_, i) => ({ shot_id: `S${i + 1}` })),
    kling: { jobs: jobIds.map((j, i) => ({ job_id: j, shots: [`S${i + 1}`] })) },
  }, null, 2));
  if (manifest) fs.writeFileSync(path.join(dir, 'web.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

// b1nx — t1 rendered the whole chain, then K1 alone was re-rendered into t2 and composed with t1's
// K2. The composition is what composeCut writes: each clip carrying its OWN seams.
{
  const id = 'b1nx';
  writeRun(id, ['K1', 'K2'], {
    v: 1, idea: 'a keeper at dusk', backend: 'kling-o3@fal', aspect: '9:16', durationS: null,
    createdAt: '2026-07-02T09:00:00.000Z', revisions: [], cuts: [], costLedger: [], approved: null,
    lastError: null, activeJob: null,
    takes: [{ id: 't1', mode: 'full', revision: null, createdAt: '2026-07-02T10:00:00.000Z' },
      { id: 't2', mode: 'job', jobId: 'K1', revision: null, createdAt: '2026-07-02T11:30:00.000Z' }],
    jobClips: { K1: clipOf(id, 't2', 'K1'), K2: clipOf(id, 't1', 'K2') },
    clipLineage: {
      K1: { take: 't2', seamIn: seamIn(null), seamOut: seamOut(null) },
      K2: { take: 't1', seamIn: seamIn(at(id, 't1', 'K1')), seamOut: seamOut(null) },
    },
  });
  writeTake(id, 't1', [
    rec(id, 't1', 'K1', { to: at(id, 't1', 'K2') }),
    rec(id, 't1', 'K2', { from: at(id, 't1', 'K1') }),
  ], { chained: true });
  writeTake(id, 't2', [
    rec(id, 't2', 'K1'),                                         // the new K1: nothing before it
    { ...rec(id, 't1', 'K2', { from: at(id, 't1', 'K1') }), take: 't1' }, // t1's K2, carried in
  ], { composed: true, chained: false });
  finish(id, 't2');
}

// 5mjo — t4 re-rendered the whole chain in one pass, so every seam source is the clip that really
// precedes it. This is the fixture that stops "always false" from passing.
{
  const id = '5mjo';
  writeRun(id, ['K1', 'K2', 'K3']);
  writeTake(id, 't3', [
    rec(id, 't3', 'K1', { to: at(id, 't3', 'K2') }),
    rec(id, 't3', 'K2', { from: at(id, 't3', 'K1'), to: at(id, 't3', 'K3') }),
    rec(id, 't3', 'K3', { from: at(id, 't3', 'K2') }),
  ], { chained: true });
  writeTake(id, 't4', [
    rec(id, 't4', 'K1', { to: at(id, 't4', 'K2') }),
    rec(id, 't4', 'K2', { from: at(id, 't4', 'K1'), to: at(id, 't4', 'K3') }),
    rec(id, 't4', 'K3', { from: at(id, 't4', 'K2') }),
  ], { chained: true });
  finish(id, 't4');
}

// c7qa — rendered before WS2-P1: no seam was ever recorded. The cut mixes takes exactly like b1nx.
{
  const id = 'c7qa';
  writeRun(id, ['K1', 'K2']);
  writeTake(id, 't1', [rec(id, 't1', 'K1', { legacy: true }), rec(id, 't1', 'K2', { legacy: true })], { chained: true });
  writeTake(id, 't2', [
    rec(id, 't2', 'K1', { legacy: true }),
    { ...rec(id, 't1', 'K2', { legacy: true }) },
  ], { composed: true, chained: false });
  finish(id, 't2');
}

// d3kw — the same pre-P1 era, but nothing was ever re-rendered: one take, chained end to end.
{
  const id = 'd3kw';
  writeRun(id, ['K1', 'K2']);
  writeTake(id, 't1', [rec(id, 't1', 'K1', { legacy: true }), rec(id, 't1', 'K2', { legacy: true })], { chained: true });
  finish(id, 't1');
}

const continuityOf = async (id) => {
  const res = await get(`/api/runs/${id}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().run;
};

// ── the rule, over HTTP ─────────────────────────────────────────────────────────────────────────

test('b1nx: the cut mixes takes, so the second segment does NOT continue from the first', async () => {
  const run = await continuityOf('b1nx');
  assert.equal(run.status, 'review');
  assert.ok(Array.isArray(run.continuity), 'a reviewed run always answers with a continuity list');
  assert.equal(run.continuity.length, run.latestRender.jobs.length, 'one entry per clip on the strip');
  assert.deepEqual(run.continuity.map((c) => c.jobId), run.latestRender.jobs.map((j) => j.jobId), 'aligned 1:1, in cut order');

  assert.equal(run.continuity[0].continuesFromPrev, false, 'the first segment continues from nothing');
  assert.equal(run.continuity[0].reason, 'no-prev');

  assert.equal(run.continuity[1].continuesFromPrev, false,
    "t1's K2 opened on t1's K1 — the cut now starts with t2's K1, so this join is broken");
  assert.equal(run.continuity[1].confidence, 'recorded', 'the seam was written down; nothing was guessed');
  assert.equal(run.continuity[1].reason, 'source-replaced');
  assert.deepEqual(run.continuity[1].from, { take: 't1', job: 'K1' }, 'the badge can name the clip it WAS joined to');
  assert.equal(run.continuity[1].take, 't1', 'and which take the segment itself came from');
});

test('5mjo: an intact chain within one take continues on every joint', async () => {
  const run = await continuityOf('5mjo');
  assert.deepEqual(run.continuity.map((c) => c.jobId), ['K1', 'K2', 'K3']);
  assert.deepEqual(run.continuity.map((c) => c.continuesFromPrev), [false, true, true]);
  for (const c of run.continuity) assert.equal(c.confidence, 'recorded');
  assert.deepEqual(run.continuity[2].from, { take: 't4', job: 'K2' });
});

test('a pre-P1 run answers DERIVED instead of throwing — and still refuses to invent a link', async () => {
  const mixed = await continuityOf('c7qa');
  assert.equal(mixed.continuity.length, 2);
  for (const c of mixed.continuity) assert.equal(c.confidence, 'derived', 'nothing was recorded — say so');
  assert.equal(mixed.continuity[1].continuesFromPrev, false, 'the cut mixes takes; a derivation must not claim a join');

  const intact = await continuityOf('d3kw');
  assert.deepEqual(intact.continuity.map((c) => c.continuesFromPrev), [false, true]);
  assert.equal(intact.continuity[1].confidence, 'derived', "reconstructed from take history — the UI draws 'join unknown'");
});

// ── the wire contract: ids only ─────────────────────────────────────────────────────────────────

test('continuity carries take/job ids and NEVER a filesystem path', async () => {
  for (const id of ['b1nx', '5mjo', 'c7qa', 'd3kw']) {
    const run = await continuityOf(id);
    const blob = JSON.stringify(run.continuity);
    assert.ok(!/(^|")\/(Users|tmp|private)\//.test(blob), `${id}: an absolute host path leaked into continuity`);
    assert.ok(!blob.includes(tmpRoot), `${id}: the run directory leaked into continuity`);
    assert.ok(!/[/\\]/.test(blob), `${id}: no path separator of any kind belongs in this shape`);
    assert.ok(!/\.mp4|\.png/.test(blob), `${id}: no clip or frame filenames either`);
    for (const key of ['dir', 'clip', 'frame']) {
      assert.ok(!new RegExp(`"${key}"`).test(blob), `${id}: continuity must not expose a "${key}" field`);
    }
  }
});

test('runs with nothing rendered answer null — the strip claims nothing it cannot prove', async () => {
  writeRun('e5pl', ['K1', 'K2']);
  const planOnly = await continuityOf('e5pl');
  assert.equal(planOnly.status, 'plan-ready');
  assert.equal(planOnly.continuity, null);

  const list = (await get('/api/runs')).json().runs;
  const listed = list.find((r) => r.id === 'b1nx');
  assert.deepEqual(listed.continuity.map((c) => c.continuesFromPrev), [false, false], 'the library read model agrees with the detail one');
});
