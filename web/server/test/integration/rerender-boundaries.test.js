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
const voicesDir = path.join(tmpRoot, 'voices');
const voicesFile = path.join(voicesDir, 'voices.json');
for (const d of [runsDir, outDir, envRoot, voicesDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '');
// A bundled clip on disk IS a registered voice (voices.js stages one from any clip it finds), so
// "keeper" costs an @Audio reference here without a minted voices.json.
fs.writeFileSync(path.join(voicesDir, 'keeper.mp3'), 'ID3');

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, envRoot, voicesFile });
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
function seedRun(runId, layout, over = {}) {
  const backend = over.backend ?? 'seedance';
  const elements = over.elements ?? [{ id: 'subject', image: 'subject.png' }];
  const jobIds = over.jobs ?? JOBS;
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({
    spec_version: '1.0',
    render_backend: backend,
    project: { title: 'Boundary Drill', aspect_ratio: '9:16' },
    shots: jobIds.map((_, i) => ({ shot_id: `S${i + 1}`, duration_s: 5, description: 'a shot' })),
    kling: {
      elements,
      jobs: jobIds.map((j, i) => ({ job_id: j, shots: [`S${i + 1}`], elements: elements.map((e) => e.id) })),
      // ABSENT is "whatever the .env defaults to"; `false` is the plan itself turning audio off
      ...(over.specAudio === undefined ? {} : { generate_audio: over.specAudio }),
    },
    ...(over.voiceLines ? { audio: { voice: { lines: over.voiceLines } } } : {}),
  }, null, 2));

  // Null-prototype, exactly like the manifest maps run-service writes: a plan may legitimately name
  // a job `__proto__`, and a plain `{}` would swallow it HERE, before any assertion could see it.
  const jobClips = Object.create(null);
  const clipLineage = Object.create(null);
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
    ...newManifest({ idea: 'boundary drill', backend, aspect: '9:16', durationS: 20 }, '2026-08-01T00:00:00.000Z'),
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

function fakeService(runId, layout, over = {}) {
  const dir = seedRun(runId, layout, over);
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
    root: HOST_ROOT, runsDir, outDir, envRoot, voicesFile, childEnv: { PATH: process.env.PATH }, mgr,
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

// ── the COMBINED reference budget (fal Seedance 2.5) ────────────────────────────────────────────
// 2.5 on fal budgets images + audio + video against ONE 50-reference cap, so a registered voice clip
// and a soft boundary pin want the same slot — and only the pin is sacrificial: SEAM_PRIORITY gives
// it up, while nothing ever drops a voice clip (the renderer throws rather than ship a job over the
// cap). With 49 cast images and one voiced speaker the render therefore has 49 image slots and opens
// on a scene cut, so a reply that reports a pin sells continuity this PAID take cannot deliver.
// The renderer has always subtracted the demand (render-seedance.js hands planSeamRefs its
// `otherRefCount`); this is the same subtraction on the side that quotes the seam before the spend.

const CAST_49 = Array.from({ length: 49 }, (_, i) => ({ id: `cast${i}`, image: `cast${i}.png` }));
const on25 = { backend: 'seedance-2.5@fal', elements: CAST_49 };
const lineFor = (speaker) => [{ shot_id: 'S2', speaker, text: 'Forty years I kept this light.' }];

test('a voice reference spends the slot the opening pin wanted, and the reply stops promising it', () => {
  const runId = 'web-19990101000011-voicebudget';
  const { svc } = fakeService(runId, intact, { ...on25, voiceLines: lineFor('keeper') });

  const r = svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'both' });

  assert.equal(r.boundaries.startMode, 'none', '49 cast refs + 1 voice clip fill the 50-reference budget');
  assert.equal(r.boundaries.endMode, 'none', 'the closing pin went first, as it always does');
});

test('…and with nothing voiced the same cast still affords the opening pin', () => {
  const runId = 'web-19990101000012-novoice';
  const { svc } = fakeService(runId, intact, on25);

  const r = svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'both' });

  assert.equal(r.boundaries.startMode, 'soft', 'the 50th slot is free, so SEAM_PRIORITY keeps the opening pin');
  assert.equal(r.boundaries.endMode, 'none');
});

// The demand is what will RIDE, not who speaks: a speaker with no registered clip is voiced by the
// model natively and costs no reference at all. Reserving a slot for one would give up a pin the
// render was going to keep — and the strip would then offer a downstream cascade nobody needs.
test('a speaker with no registered clip costs no slot at all', () => {
  const runId = 'web-19990101000013-clipless';
  const { svc } = fakeService(runId, intact, { ...on25, voiceLines: lineFor('stranger') });

  const r = svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'both' });

  assert.equal(r.boundaries.startMode, 'soft');
});

// …and the same is true when the PLAN is what turned audio off. The renderer resolves
// `generate_audio` spec-first (prompt-settings.js `audioFlag`: a spec flag outranks the .env
// default), so a plan with `generate_audio:false` ships no @Audio reference whatever
// SEEDANCE_GENERATE_AUDIO says. Reading the environment alone here reserved a slot the render never
// spends and answered `none` for an opening pin the PAID take was always going to keep.
test('a spec that disables audio spends no voice slot — the pin it leaves free is still promised', () => {
  const runId = 'web-19990101000016-specaudio';
  const { svc } = fakeService(runId, intact, { ...on25, voiceLines: lineFor('keeper'), specAudio: false });

  const r = svc.rerenderJob(runId, { jobId: 'K2', boundaries: 'both' });

  assert.equal(r.boundaries.startMode, 'soft', 'audio off ⇒ no voice reference ⇒ the 50th slot is the opening pin\'s');
  assert.deepEqual(svc.detail(runId).voiceRefs, { K1: 0, K2: 0, K3: 0, K4: 0 }, 'and the dialog is told the same');
});

test('the run payload carries the same count, because the browser cannot read the voices dir', () => {
  const runId = 'web-19990101000014-wire';
  const { svc } = fakeService(runId, intact, { ...on25, voiceLines: lineFor('keeper') });

  const detail = svc.detail(runId);

  assert.deepEqual(detail.voiceRefs, { K1: 0, K2: 1, K3: 0, K4: 0 }, 'ids only — the count, never a path');
  assert.equal(JSON.stringify(detail.voiceRefs).includes(tmpRoot), false);
});

test('a model with no combined budget has nothing to report', () => {
  const runId = 'web-19990101000015-nocombined';
  const { svc } = fakeService(runId, intact, { voiceLines: lineFor('keeper') });

  assert.equal(svc.detail(runId).voiceRefs, null, 'per-kind caps never make a voice clip and a pin compete');
});

// ── the lineage mirror `auto` reads ─────────────────────────────────────────────────────────────
// Every `auto` plan above answers out of m.clipLineage, so composing a cut has to leave an entry
// there for EVERY job it composed — including one the plan named `__proto__` (the spec asks only for
// a non-empty string, and this build supports such an id everywhere else). On a manifest that
// predates clipLineage the mirror was recreated as a plain `{}`, where that assignment hits
// Object.prototype's setter: the cut was written, but the job's seams silently vanished from
// web.json and every later `auto` plan lost the joint.

test('composing a cut on a pre-lineage manifest keeps a `__proto__` job\'s seams', () => {
  const runId = 'web-19990101000017-protolineage';
  const jobs = ['K1', '__proto__'];
  const layout = [{ job: 'K1', take: 't1', from: null }, { job: '__proto__', take: 't1', from: { take: 't1', job: 'K1' } }];
  const { dir, svc } = fakeService(runId, layout, { jobs });
  // a run rendered before WS2-P2: clips on record, no lineage at all
  const pre = readManifest(dir);
  delete pre.clipLineage;
  writeManifest(dir, pre);

  svc.assemble(runId, { composition: { ['__proto__']: 't1' } }); // computed key: `{__proto__: …}` is the OTHER thing

  const lineage = readManifest(dir).clipLineage;
  assert.ok(Object.hasOwn(lineage, '__proto__'), 'the oddly named job is an OWN key, not a swallowed prototype write');
  assert.equal(lineage['__proto__'].take, 't1');
  assert.equal(lineage.K1.take, 't1', 'and the ordinary job is mirrored beside it');
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
