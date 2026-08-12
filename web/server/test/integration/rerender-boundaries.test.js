// WS2-P5a — frame-conditioned segment re-render, server side.
//
// What this pins is the ARGV: which boundary flags reach the render-job child, for each of the five
// boundary plans. That is the only place the decision becomes real money, and it is the one thing a
// dialog cannot fake.
//
//   --seam-from        the take the opening frame came off (this is what keeps the joint READABLE
//                      afterwards — the recorded seam source is how lib/lineage.js tells a chain
//                      from a coincidence)
//   --first-frame-from the opening frame itself, so the user's choice survives whatever the
//                      chain-frames default is set to
//   --last-frame-from  the NEXT segment's clip; the renderer grabs its opening frame
//
// Nothing spends, spawns or renders: the run dirs are fabricated in the layout the render CLIs
// leave behind, and the job manager is a stub that records what it was handed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildApp } = await import('../../app.js');
const { createRunService } = await import('../../lib/run-service.js');
const { newManifest, writeManifest, readManifest } = await import('../../lib/web-manifest.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-boundaries-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
for (const d of [runsDir, outDir, envRoot]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '');

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, envRoot });
test.after(async () => { await app.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });

// ── fabricating a reviewed run ──────────────────────────────────────────────────────────────────

const JOBS = ['K1', 'K2', 'K3', 'K4'];
const clipOf = (runId, take, job) => path.join(runsDir, runId, 'renders', take, job, 'clip.mp4');
const frameOf = (runId, take, job) => path.join(runsDir, runId, 'renders', take, job, 'last_frame.png');

/** The seam a chained clip records: the still it opened on, and the clip that still came off. */
const seamIn = (runId, take, job) => (job
  ? { mode: 'soft', frame: frameOf(runId, take, job), from: { take, job, clip: clipOf(runId, take, job) } }
  : { mode: 'none', frame: null, from: null });

/**
 * A run whose cut is `layout` — one `{job, take}` per segment, in cut order — with every clip and
 * closing still really on disk. `chainedFrom` names, per job, the {take, job} its opening frame was
 * grabbed from, which is what makes a joint whole or broken.
 */
function seedRun(runId, layout) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({
    spec_version: '1.0',
    render_backend: 'seedance',
    project: { title: 'Boundary Drill', aspect_ratio: '9:16' },
    shots: JOBS.map((_, i) => ({ shot_id: `S${i + 1}`, duration_s: 5, description: 'a shot' })),
    kling: { elements: [{ id: 'subject', image: 'subject.png' }], jobs: JOBS.map((j, i) => ({ job_id: j, shots: [`S${i + 1}`], elements: ['subject'] })) },
  }, null, 2));

  const jobClips = {};
  const clipLineage = {};
  for (const { job, take, from } of layout) {
    fs.mkdirSync(path.join(dir, 'renders', take, job), { recursive: true });
    fs.writeFileSync(clipOf(runId, take, job), 'FAKE-MP4');
    fs.writeFileSync(frameOf(runId, take, job), 'FAKE-PNG');
    jobClips[job] = clipOf(runId, take, job);
    clipLineage[job] = {
      take,
      seamIn: from ? seamIn(runId, from.take, from.job) : seamIn(runId, null, null),
      seamOut: { mode: 'soft', frame: frameOf(runId, take, job), to: null },
    };
  }
  const newestTake = layout.at(-1).take;
  writeManifest(dir, {
    ...newManifest({ idea: 'boundary drill', backend: 'seedance', aspect: '9:16', durationS: 20 }, '2026-08-01T00:00:00.000Z'),
    takes: [{ id: newestTake, mode: 'full', createdAt: '2026-08-01T00:00:00.000Z' }],
    cuts: [{ id: 'c1', take: newestTake, master: null, createdAt: '2026-08-01T00:00:00.000Z' }],
    jobClips,
    clipLineage,
  });
  return dir;
}

/** An intact chain: every clip in t1, each opening on the one before it (the 5mjo shape). */
const intact = JOBS.map((job, i) => ({ job, take: 't1', from: i ? { take: 't1', job: JOBS[i - 1] } : null }));
/** The b1nx shape: K1 was re-rendered into t2, but the cut kept t1's K2 — which opens on t1's K1. */
const mixed = [{ job: 'K1', take: 't2', from: null }, ...JOBS.slice(1).map((job, i) => ({
  job, take: 't1', from: { take: 't1', job: JOBS[i] },
}))];

function fakeService(runId, layout) {
  const dir = seedRun(runId, layout);
  const enqueued = [];
  const live = [];
  const mgr = {
    enqueue(job) {
      enqueued.push(job);
      live.push({ id: `j${enqueued.length}`, runId: job.runId, lane: job.lane, kind: job.kind, startedAt: null });
      return { id: `j${enqueued.length}`, position: live.length };
    },
    snapshot: () => ({ active: [], queued: [...live] }),
    cancel: () => false,
  };
  const svc = createRunService({
    root: HOST_ROOT, runsDir, outDir, envRoot, childEnv: { PATH: process.env.PATH }, mgr,
    bus: { emit() {}, subscribe: () => () => {} },
    isAlive: () => false,
  });
  return { dir, svc, enqueued, drain: () => { live.length = 0; } };
}

/** The value of one flag in a recorded enqueue, or undefined when the flag is absent. */
const flag = (job, name) => {
  const i = job.args.indexOf(name);
  return i === -1 ? undefined : job.args[i + 1];
};
const jobsOf = (enqueued, jobId) => enqueued.filter((j) => flag(j, '--job') === jobId);

// ── the five plans ──────────────────────────────────────────────────────────────────────────────

test('auto mirrors an intact chain: both ends of a middle segment are pinned', () => {
  const { dir, svc, enqueued } = fakeService('web-19990101000001-auto', intact);
  const r = svc.rerenderJob('web-19990101000001-auto', { jobId: 'K2' }); // boundaries defaults to auto

  const child = enqueued.at(-1);
  assert.equal(flag(child, '--seam-from'), path.join(dir, 'renders', 't1'), 'the TAKE, so the seam source is recorded');
  assert.equal(flag(child, '--first-frame-from'), frameOf('web-19990101000001-auto', 't1', 'K1'),
    "the opening pin is the previous clip's closing still");
  assert.equal(flag(child, '--last-frame-from'), clipOf('web-19990101000001-auto', 't1', 'K3'),
    "the closing pin is the NEXT segment's clip — the child grabs its opening frame");

  assert.equal(r.boundaries.mode, 'auto');
  assert.equal(r.boundaries.start.from.jobId, 'K1');
  assert.equal(r.boundaries.end.to.jobId, 'K3');
  assert.ok(!JSON.stringify(r.boundaries).includes(path.sep), 'the reply names ids, never a host path');
  assert.equal(readManifest(dir).lastError, null);
});

test('auto never silently repairs: a broken joint (b1nx shape) buys no opening pin', () => {
  const runId = 'web-19990101000002-mixed';
  const { svc, enqueued } = fakeService(runId, mixed);
  svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'auto' });

  const child = enqueued.at(-1);
  assert.equal(flag(child, '--seam-from'), undefined, 'K2 does not open on the K1 that is in the cut — auto leaves it that way');
  assert.equal(flag(child, '--first-frame-from'), undefined);
  assert.equal(flag(child, '--last-frame-from'), clipOf(runId, 't1', 'K3'), 'the intact joint on the other side is kept');
});

test('both REPAIRS the joint auto left alone', () => {
  const runId = 'web-19990101000003-repair';
  const { dir, svc, enqueued } = fakeService(runId, mixed);
  const r = svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'both' });

  const child = enqueued.at(-1);
  assert.equal(flag(child, '--seam-from'), path.join(dir, 'renders', 't2'), "the CURRENT K1's take, not the one K2 used to follow");
  assert.equal(flag(child, '--first-frame-from'), frameOf(runId, 't2', 'K1'));
  assert.equal(flag(child, '--last-frame-from'), clipOf(runId, 't1', 'K3'));
  assert.equal(r.boundaries.start.from.take, 't2');
});

// `--seam-from` is a place to LOOK, never evidence that anything is there. When the previous clip's
// own take carries no closing still — a KLING_CHAIN_FRAMES=0 render, a cleaned or legacy take — the
// fallback aims at the latest cut's take dir, which for a cut assembled from several takes need not
// hold that segment at all. The user PAID for that opening join, so the neighbour's CLIP is handed
// over instead and the child reads the missing still out of it: dropping the pin here queued a spend
// that rendered as if nobody had asked for one, and the strip afterwards reported the joint broken
// for no visible reason.
test("a paid opening pin whose closing still is gone is derived from the neighbour's CLIP", () => {
  const runId = 'web-19990101000006-noframe';
  const { dir, svc, enqueued } = fakeService(runId, mixed);
  // K1 lives in t2; take away its closing still. The cut's take is t1, which never held a K1.
  fs.rmSync(frameOf(runId, 't2', 'K1'));

  const r = svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'both' });

  const child = enqueued.at(-1);
  assert.equal(flag(child, '--seam-from'), path.join(dir, 'renders', 't1'), 'the child is still told where to look');
  assert.equal(flag(child, '--first-frame-from'), clipOf(runId, 't2', 'K1'),
    "the clip itself — its LAST frame is exactly the still that is missing");
  assert.equal(r.boundaries.start.from.take, 't2', 'and the reply promises the join this take will really have');
  assert.notEqual(r.boundaries.startMode, 'none');
  // the other end is judged on its own file and is untouched by any of this
  assert.equal(r.boundaries.end.to.jobId, 'K3');
  assert.notEqual(r.boundaries.endMode, 'none');
});

test('with neither the still nor the clip on disk, no opening pin is claimed', () => {
  const runId = 'web-19990101000010-nothing';
  const { svc, enqueued } = fakeService(runId, mixed);
  // Nothing is left of K1 to read a frame out of — the honest answer is that this take opens on
  // nothing, not a promise the render cannot keep.
  fs.rmSync(frameOf(runId, 't2', 'K1'));
  fs.rmSync(clipOf(runId, 't2', 'K1'));

  const r = svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'both' });

  assert.equal(flag(enqueued.at(-1), '--first-frame-from'), undefined);
  assert.equal(r.boundaries.start, null, 'so the reply promises no opening join');
  assert.equal(r.boundaries.startMode, 'none');
});

test('start and end each pin one side only; none renders standalone', () => {
  const runId = 'web-19990101000004-sides';
  const { svc, enqueued, drain } = fakeService(runId, intact);

  svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'start' });
  let child = enqueued.at(-1);
  assert.ok(flag(child, '--seam-from') && flag(child, '--first-frame-from'));
  assert.equal(flag(child, '--last-frame-from'), undefined);

  drain();
  svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'end' });
  child = enqueued.at(-1);
  assert.equal(flag(child, '--seam-from'), undefined);
  assert.equal(flag(child, '--first-frame-from'), undefined);
  assert.ok(flag(child, '--last-frame-from'));

  drain();
  const r = svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'none' });
  child = enqueued.at(-1);
  for (const f of ['--seam-from', '--first-frame-from', '--last-frame-from']) assert.equal(flag(child, f), undefined, `${f} must be absent`);
  assert.equal(r.boundaries.start, null);
  assert.equal(r.boundaries.end, null);
  assert.equal(r.boundaries.startMode, 'none');
  assert.equal(r.boundaries.endMode, 'none');
});

test('the ends of the cut are never pinned outward', () => {
  const runId = 'web-19990101000005-edges';
  const { svc, enqueued, drain } = fakeService(runId, intact);

  svc.rerenderJob(runId, { jobId: 'K1', boundaries: 'both' });
  assert.equal(flag(enqueued.at(-1), '--first-frame-from'), undefined, 'the first segment opens the cut');
  assert.ok(flag(enqueued.at(-1), '--last-frame-from'));

  drain();
  svc.rerenderJob(runId, { jobId: 'K4', boundaries: 'both' });
  assert.ok(flag(enqueued.at(-1), '--first-frame-from'));
  assert.equal(flag(enqueued.at(-1), '--last-frame-from'), undefined, 'the last segment ends the cut');
});

// ── the cascade rule ────────────────────────────────────────────────────────────────────────────

test('a cascade end-conditions ONLY its last job — the earlier ones are defined by the chain', () => {
  const runId = 'web-19990101000006-cascade';
  const { dir, svc, enqueued } = fakeService(runId, intact);

  // The control: the very same request without a cascade DOES buy K2 a closing pin.
  const solo = fakeService('web-19990101000007-control', intact);
  solo.svc.rerenderJob('web-19990101000007-control', { jobId: 'K2', boundaries: 'both' });
  assert.equal(flag(solo.enqueued.at(-1), '--last-frame-from'), clipOf('web-19990101000007-control', 't1', 'K3'));

  const r = svc.rerenderJob(runId, { jobId: 'K2', cascade: true, boundaries: 'both' });
  assert.deepEqual(r.cascadeJobs, ['K3', 'K4']);
  const takeDir = path.join(dir, 'renders', r.takeId);

  // K2 is the FIRST job of the cascade, so its ending belongs to K3 — which this take re-renders.
  // Pinning it would fight the chain, so the pin is withheld even though 'both' asked for it.
  assert.equal(flag(enqueued.at(-1), '--last-frame-from'), undefined, "the cascade's first job gets no closing pin");
  assert.ok(flag(enqueued.at(-1), '--first-frame-from'), 'its opening pin is unaffected — nothing upstream is re-rendered');

  // Drive the cascade the way the job manager does: each 'done' enqueues the next job.
  const done = (jobId) => svc.onEvent(runId, {
    type: 'done', kind: 'render-job', jobIdRef: `q-${jobId}`,
    result: { jobId, clip: path.join(takeDir, jobId, 'clip.mp4'), runDir: takeDir, seamIn: seamIn(runId, 't1', 'K1'), seamOut: { mode: 'soft', frame: null, to: null } },
  });
  for (const j of ['K2', 'K3', 'K4']) {
    fs.mkdirSync(path.join(takeDir, j), { recursive: true });
    fs.writeFileSync(path.join(takeDir, j, 'clip.mp4'), 'FAKE-MP4');
    done(j);
  }

  assert.deepEqual(enqueued.filter((j) => j.kind === 'render-job').map((j) => flag(j, '--job')), ['K2', 'K3', 'K4'],
    'the cascade enqueues sequentially, one per completion');
  for (const jobId of ['K3', 'K4']) {
    const child = jobsOf(enqueued, jobId).at(-1);
    assert.equal(flag(child, '--seam-from'), takeDir, `${jobId} chains from the take being rendered`);
  }
  // K4 ends the plan, so even the LAST job of the cascade has nothing to close on: the rule allows
  // exactly one closing pin per take, and here there is no segment left to pin to. (A cascade always
  // runs to the end of the plan, so this is the only shape it can take.)
  assert.equal(enqueued.filter((j) => flag(j, '--last-frame-from') !== undefined).length, 0,
    'no job of the cascade carries a closing pin');
  assert.equal(readManifest(dir).lastError, null, 'the cascade ran clean');
  assert.ok(enqueued.some((j) => j.kind === 'assemble'), 'and the new cut is still auto-assembled');
});

// ── guards ──────────────────────────────────────────────────────────────────────────────────────

test('one paid job per run still holds: a second re-render while one is queued is a 409', () => {
  const runId = 'web-19990101000008-guard';
  const { svc } = fakeService(runId, intact);
  svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'both' });
  assert.throws(() => svc.rerenderJob(runId, { jobId: 'K3' }), (e) => {
    assert.equal(e.statusCode, 409);
    assert.match(e.message, /already (queued to render|rendering)/);
    return true;
  });
});

test('POST /rerender-job refuses a boundary plan it does not know — before it reserves anything', async () => {
  const runId = 'web-19990101000009-http';
  const dir = seedRun(runId, intact);
  const takesBefore = fs.readdirSync(path.join(dir, 'renders')).length;

  const bad = await post(`/api/runs/${runId}/rerender-job`, { jobId: 'K2', boundaries: 'bogus' });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().hint, /auto, both, start, end, none/);
  assert.equal(fs.readdirSync(path.join(dir, 'renders')).length, takesBefore, 'a typo reserves no take');
  assert.equal(readManifest(dir).takes.length, 1, 'and records no cost');
});
