// Segmind seed control, server side — "fix this take" vs "fresh take" on a paid segment re-render.
//
// What this pins is again the ARGV, plus the two records that have to agree with it (the take row
// and the reply): which seed reaches the render-job child, for each mode, on each backend. That is
// where the choice becomes money, and it is the one thing a dialog cannot fake.
//
//   --seed <n>   emitted ONE WAY ONLY. A chosen seed rides; no choice rides as NO flag, because the
//                alternative to a chosen seed is not "no seed" — it is the child's own deterministic
//                default (pipeline.seedForJob), and every backend without seed control must keep
//                being sent byte-for-byte what it was sent before this control existed.
//
// "Fix" is only honest if the number really is the one the clip on screen rendered from, so it is
// read back out of THAT take's prompts.json — not recomputed and hoped for. The mixed-take run
// below is the case that catches a recompute: K2's newest clip lives in t1 while the run's latest
// take is t2.
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
const { ALL_BACKENDS, capsFor } = await import('../../../../src/lib/render-models.js');
const { seedForJob } = await import('../../../../src/lib/render-seed.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-seed-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
const voicesDir = path.join(tmpRoot, 'voices');
const voicesFile = path.join(voicesDir, 'voices.json');
for (const d of [runsDir, outDir, envRoot, voicesDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '');

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, envRoot, voicesFile });
test.after(async () => { await app.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });

// The backend the control exists for, and one that deliberately does not have it.
const SEGMIND = 'seedance-2.0@segmind';
const CAPLESS = ALL_BACKENDS.filter((b) => !capsFor(b).seedControl);

// ── fabricating a reviewed run ──────────────────────────────────────────────────────────────────

const JOBS = ['K1', 'K2', 'K3'];
const clipOf = (runId, take, job) => path.join(runsDir, runId, 'renders', take, job, 'clip.mp4');
const frameOf = (runId, take, job) => path.join(runsDir, runId, 'renders', take, job, 'last_frame.png');
const sidecarOf = (runId, take, job) => path.join(runsDir, runId, 'renders', take, job, 'prompts.json');

/**
 * A run whose cut is `layout` — one `{job, take, sidecar}` per segment, in cut order — with every
 * clip, closing still and (where given) prompts.json really on disk. `sidecar` is what the renderer
 * wrote for THAT take: `null` means the take predates sidecars entirely.
 */
function seedRun(runId, layout, over = {}) {
  const backend = over.backend ?? SEGMIND;
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({
    spec_version: '1.0',
    render_backend: backend,
    project: { title: 'Seed Drill', aspect_ratio: '9:16' },
    shots: JOBS.map((_, i) => ({ shot_id: `S${i + 1}`, duration_s: 5, description: 'a shot' })),
    kling: {
      elements: [{ id: 'subject', image: 'subject.png' }],
      jobs: JOBS.map((j, i) => ({ job_id: j, shots: [`S${i + 1}`], elements: ['subject'] })),
    },
  }, null, 2));

  // Null-prototype, exactly like the manifest maps run-service writes: a plan may legitimately name
  // a job `__proto__`, and a plain `{}` would swallow it here, before any assertion could see it.
  const jobClips = Object.create(null);
  const clipLineage = Object.create(null);
  for (const { job, take, sidecar } of layout) {
    fs.mkdirSync(path.join(dir, 'renders', take, job), { recursive: true });
    fs.writeFileSync(clipOf(runId, take, job), 'FAKE-MP4');
    fs.writeFileSync(frameOf(runId, take, job), 'FAKE-PNG');
    if (sidecar !== null) fs.writeFileSync(sidecarOf(runId, take, job), JSON.stringify(sidecar ?? {}, null, 2));
    jobClips[job] = clipOf(runId, take, job);
    clipLineage[job] = { take, seamIn: { mode: 'none', frame: null, from: null }, seamOut: { mode: 'soft', frame: frameOf(runId, take, job), to: null } };
  }
  const takes = [...new Set(layout.map((l) => l.take))]
    .map((id) => ({ id, mode: 'full', createdAt: '2026-08-01T00:00:00.000Z' }));
  writeManifest(dir, {
    ...newManifest({ idea: 'seed drill', backend, aspect: '9:16', durationS: 15 }, '2026-08-01T00:00:00.000Z'),
    takes,
    cuts: [{ id: 'c1', take: layout.at(-1).take, master: null, createdAt: '2026-08-01T00:00:00.000Z' }],
    jobClips,
    clipLineage,
  });
  return dir;
}

/** A prompts.json as the Seedance renderer writes it, with only the fields the seed reader looks at. */
const sidecar = (over) => ({ job_id: 'K2', schema: 3, seed: null, seed_unused: null, nonce: 0, ...over });

/** The MIXED-take shape this file exists for: K1 was re-rendered into t2, but the cut still shows
 *  t1's K2 — so K2's current starting point is t1's, not the newest take's. */
const mixed = (seeds = {}) => [
  { job: 'K1', take: 't2', sidecar: sidecar({ job_id: 'K1', seed: 111 }) },
  { job: 'K2', take: 't1', sidecar: sidecar({ seed: seeds.k2Old ?? 222 }) },
  { job: 'K3', take: 't1', sidecar: sidecar({ job_id: 'K3', seed: 333 }) },
];

/** …and the same run's NEWER take of K2, present on disk but NOT in the cut — the number a reader
 *  that trusted "latest take" instead of the lineage would hand back. */
const decoyNewerK2 = (runId, seed) => {
  fs.mkdirSync(path.join(runsDir, runId, 'renders', 't2', 'K2'), { recursive: true });
  fs.writeFileSync(sidecarOf(runId, 't2', 'K2'), JSON.stringify(sidecar({ seed })));
};

/** `over` shapes the run on disk; `wiring` overrides what the service is BUILT with — here, the
 *  injected seed source, so a "fresh" draw is a knowable number rather than a surprise. */
function fakeService(runId, layout, over = {}, wiring = {}) {
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
    ...wiring,
  });
  return { dir, svc, enqueued, drain: () => { live.length = 0; } };
}

/** The value of one flag in a recorded enqueue, or undefined when the flag is absent. */
const flag = (job, name) => {
  const i = job.args.indexOf(name);
  return i === -1 ? undefined : job.args[i + 1];
};
const renderJobs = (enqueued) => enqueued.filter((j) => j.kind === 'render-job');
const takeRow = (dir, takeId) => readManifest(dir).takes.find((t) => t.id === takeId);

// ── 'fix': the seed the segment's CURRENT take rendered from ────────────────────────────────────

test("'fix' re-sends the seed of the take in the CUT, not of the newest take on disk", () => {
  const runId = 'web-19990201000001-fix';
  const { dir, svc, enqueued } = fakeService(runId, mixed({ k2Old: 4242 }));
  decoyNewerK2(runId, 9999); // a t2/K2 exists on disk; the cut does not use it

  const r = svc.rerenderJob(runId, { jobId: 'K2', seedMode: 'fix' });

  assert.equal(flag(enqueued.at(-1), '--seed'), '4242', "t1's K2 is the clip on screen — that is the take being fixed");
  assert.equal(r.seed, 4242, 'and the reply says what was applied, as it does for boundaries');
  assert.equal(takeRow(dir, r.takeId).seed, 4242, 'the take row records the starting point it was paid to reuse');
});

// The sidecar records the seed honestly in two keys and exactly one is ever non-null: `seed` is what
// was SENT, `seed_unused` what an endpoint accepting none would have been sent. A run that switched
// backends therefore still has a recoverable starting point — reading only `seed` would answer with
// the formula instead, and "fix this take" would fix a number nothing rendered from.
test("'fix' falls back to seed_unused, then to the deterministic default", () => {
  const runId = 'web-19990201000002-fallback';
  const { svc, enqueued, drain } = fakeService(runId, [
    { job: 'K1', take: 't1', sidecar: sidecar({ job_id: 'K1', seed: 111 }) },
    { job: 'K2', take: 't1', sidecar: sidecar({ seed: null, seed_unused: 555 }) },
    { job: 'K3', take: 't1', sidecar: null }, // a take that predates sidecars entirely
  ]);

  assert.equal(svc.rerenderJob(runId, { jobId: 'K2', seedMode: 'fix' }).seed, 555,
    'the seed a fal-2.0 take could not send is still the seed it would have started from');

  drain();
  assert.equal(svc.rerenderJob(runId, { jobId: 'K3', seedMode: 'fix' }).seed, seedForJob(2, 0),
    'with no sidecar at all, the deterministic default for THIS job index');
});

test("'fix' reads the take's own nonce, so a retake's default is recovered too", () => {
  const runId = 'web-19990201000003-nonce';
  const { svc } = fakeService(runId, [
    { job: 'K1', take: 't1', sidecar: sidecar({ job_id: 'K1', seed: 111 }) },
    // the renderer wrote no seed but did record which retake it was — seedForJob offsets by it
    { job: 'K2', take: 't1', sidecar: sidecar({ seed: null, seed_unused: null, nonce: 3 }) },
    { job: 'K3', take: 't1', sidecar: sidecar({ job_id: 'K3', seed: 333 }) },
  ]);

  assert.equal(svc.rerenderJob(runId, { jobId: 'K2', seedMode: 'fix' }).seed, seedForJob(1, 3));
});

// ── 'fresh': a NEW starting point, and never the one already on disk ────────────────────────────

test("'fresh' draws a new seed, records it in the take row and the reply, and sends it", () => {
  const runId = 'web-19990201000004-fresh';
  const { dir, svc, enqueued } = fakeService(runId, mixed({ k2Old: 4242 }), {}, { newSeed: () => 777001 });

  const r = svc.rerenderJob(runId, { jobId: 'K2', seedMode: 'fresh' });

  assert.equal(flag(enqueued.at(-1), '--seed'), '777001');
  assert.equal(r.seed, 777001);
  assert.equal(takeRow(dir, r.takeId).seed, 777001);
  assert.notEqual(r.seed, 4242, "a 'fresh' take that reused the stored seed would be the money trap this removes");
});

// A draw that happens to equal the seed already on disk is a paid re-render of the same starting
// point — sold as "fresh". It is re-drawn instead. The retry count is bounded, so a constant source
// resolves rather than hanging the request (with the take row, reply and argv still agreeing).
test("'fresh' re-draws when the draw equals the stored seed, and still terminates", () => {
  const runId = 'web-19990201000005-redraw';
  const draws = [4242, 4242, 606060];
  const { svc, enqueued } = fakeService(runId, mixed({ k2Old: 4242 }), {}, { newSeed: () => draws.shift() });

  assert.equal(svc.rerenderJob(runId, { jobId: 'K2', seedMode: 'fresh' }).seed, 606060);
  assert.equal(flag(enqueued.at(-1), '--seed'), '606060');

  const stuck = 'web-19990201000006-stuck';
  const s2 = fakeService(stuck, mixed({ k2Old: 4242 }), {}, { newSeed: () => 4242 });
  const r = s2.svc.rerenderJob(stuck, { jobId: 'K2', seedMode: 'fresh' });
  assert.equal(r.seed, 4242, 'bounded retries: a constant source is accepted rather than looped on');
  assert.equal(flag(s2.enqueued.at(-1), '--seed'), '4242', 'and the argv still matches what was reported');
});

// ── the default: nothing said, nothing changed ──────────────────────────────────────────────────

test('no seedMode ⇒ no --seed, no take-row seed, and null in the reply', () => {
  const runId = 'web-19990201000007-default';
  const { dir, svc, enqueued } = fakeService(runId, mixed());

  const r = svc.rerenderJob(runId, { jobId: 'K2' });

  assert.equal(flag(enqueued.at(-1), '--seed'), undefined,
    'the alternative to a chosen seed is the CHILD\'s deterministic default, not a number spelled out here');
  assert.equal(r.seed, null);
  assert.ok(!Object.hasOwn(takeRow(dir, r.takeId), 'seed'), 'the row says nothing rather than saying "none"');
});

// The seed is not a prompt nonce: --take varies the WORDS ("Alternate take n"), the seed varies the
// starting point. Emitting one for the other would change the prompt bytes of a take whose whole
// point is that only the seed moved.
test('--take is absent in BOTH modes — the seed never rides as a prompt nonce', () => {
  const runId = 'web-19990201000008-notake';
  const { svc, enqueued, drain } = fakeService(runId, mixed(), {}, { newSeed: () => 515151 });

  for (const seedMode of ['fix', 'fresh']) {
    drain();
    svc.rerenderJob(runId, { jobId: 'K2', seedMode });
    const child = enqueued.at(-1);
    assert.equal(flag(child, '--take'), undefined, seedMode);
    assert.ok(flag(child, '--seed'), `${seedMode} still carries its seed`);
  }
});

// ── the cascade carries no seed ─────────────────────────────────────────────────────────────────
// A cascade re-renders the downstream segments to rebuild the chain, not because the user disliked
// them. Handing them the chosen seed would change footage nobody asked to change — and on 'fix' it
// would pin them to another segment's starting point.
test('a cascade child carries no --seed at all', () => {
  const runId = 'web-19990201000009-cascade';
  const { dir, svc, enqueued } = fakeService(runId, mixed(), {}, { newSeed: () => 818181 });

  const r = svc.rerenderJob(runId, { jobId: 'K1', cascade: true, seedMode: 'fresh' });
  assert.deepEqual(r.cascadeJobs, ['K2', 'K3']);
  const takeDir = path.join(dir, 'renders', r.takeId);
  assert.equal(flag(enqueued.at(-1), '--seed'), '818181', 'the chosen segment gets it…');

  // Drive the cascade the way the job manager does: each 'done' enqueues the next job.
  for (const jobId of ['K1', 'K2', 'K3']) {
    fs.mkdirSync(path.join(takeDir, jobId), { recursive: true });
    fs.writeFileSync(path.join(takeDir, jobId, 'clip.mp4'), 'FAKE-MP4');
    svc.onEvent(runId, {
      type: 'done', kind: 'render-job', jobIdRef: `q-${jobId}`,
      result: { jobId, clip: path.join(takeDir, jobId, 'clip.mp4'), runDir: takeDir, seamIn: { mode: 'none', frame: null, from: null }, seamOut: { mode: 'soft', frame: null, to: null } },
    });
  }

  const children = renderJobs(enqueued);
  assert.deepEqual(children.map((j) => flag(j, '--job')), ['K1', 'K2', 'K3']);
  for (const child of children.slice(1)) {
    assert.equal(flag(child, '--seed'), undefined, `${flag(child, '--job')} is re-rendered for the CHAIN, not for a new starting point`);
  }
});

// ── every backend without the cap ───────────────────────────────────────────────────────────────

test('a backend with no seedControl never receives --seed, and refuses the mode outright', () => {
  let n = 0;
  for (const backend of CAPLESS) {
    const runId = `web-199902010001${String(10 + n).padStart(2, '0')}-capless`;
    n += 1;
    const { svc, enqueued } = fakeService(runId, mixed(), { backend });

    // The refusals come first, on a run with nothing in flight — so a 400 here is really the cap
    // check and not the one-paid-job-per-run 409 wearing its clothes.
    for (const seedMode of ['fix', 'fresh']) {
      assert.throws(() => svc.rerenderJob(runId, { jobId: 'K2', seedMode }), (e) => {
        assert.equal(e.statusCode, 400, backend);
        // Refused rather than ignored: quietly dropping it would sell a paid "fresh take" that
        // re-sends the very same starting point.
        assert.match(e.hint, /deterministic seed/);
        return true;
      }, `${backend} / ${seedMode}`);
    }
    assert.equal(renderJobs(enqueued).length, 0, `${backend}: the refusals queued nothing`);

    // …and the ordinary re-render is byte-for-byte what it was before this control existed
    const r = svc.rerenderJob(runId, { jobId: 'K2' });
    assert.equal(flag(enqueued.at(-1), '--seed'), undefined, backend);
    assert.equal(r.seed, null, backend);
  }
  assert.ok(CAPLESS.length >= 3, 'fal Kling, fal Seedance 2.0 and fal Seedance 2.5 all lack the control');
});

// ── guards: a typo costs nothing ────────────────────────────────────────────────────────────────

test('POST /rerender-job refuses an unknown seed mode BEFORE it reserves anything', async () => {
  const runId = 'web-19990201000020-http';
  const dir = seedRun(runId, mixed());
  const takesBefore = fs.readdirSync(path.join(dir, 'renders')).length;
  const rowsBefore = readManifest(dir).takes.length;

  const bad = await post(`/api/runs/${runId}/rerender-job`, { jobId: 'K2', seedMode: 'bogus' });

  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().hint, /seedMode: fix, fresh/);
  assert.equal(fs.readdirSync(path.join(dir, 'renders')).length, takesBefore, 'a typo reserves no take dir');
  assert.equal(readManifest(dir).takes.length, rowsBefore, 'and records no take row');
  assert.equal(readManifest(dir).costLedger.length, 0, 'and no cost');
});

test('a valid mode on a cap-less backend is a 400 over HTTP too, with an honest hint', async () => {
  const runId = 'web-19990201000021-httpcapless';
  const dir = seedRun(runId, mixed(), { backend: 'seedance-2.5@fal' });
  const rowsBefore = readManifest(dir).takes.length;

  const bad = await post(`/api/runs/${runId}/rerender-job`, { jobId: 'K2', seedMode: 'fix' });

  assert.equal(bad.statusCode, 400, bad.body);
  // 2.5 on fal ACCEPTS a seed argument; it just does not offer the choice. The hint must say what
  // the render will do, not claim the endpoint is seedless.
  assert.match(bad.json().hint, /omit seedMode/);
  assert.equal(readManifest(dir).takes.length, rowsBefore, 'and nothing was reserved on the way to the 400');
});

test('the seed rides all the way through the HTTP route, raw', async () => {
  const runId = 'web-19990201000022-httpok';
  const dir = seedRun(runId, mixed({ k2Old: 4242 }));

  const ok = await post(`/api/runs/${runId}/rerender-job`, { jobId: 'K2', seedMode: 'fix' });

  assert.equal(ok.statusCode, 202, ok.body);
  assert.equal(ok.json().seed, 4242);
  assert.equal(readManifest(dir).takes.at(-1).seed, 4242);
});

// ── config-free canary, walked transitively ─────────────────────────────────────────────────────
// run-service is loaded eagerly by app.js, and the demo/e2e server points FAL_BASE_URL at its mock
// only AFTER that static chain has run: anything here reaching config.js would snapshot the real
// endpoints and make every validator and render miss the mock. seed-choice.js is new in that graph.
test('seed-choice.js\'s STATIC import graph never reaches config.js or dotenv', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const specifiers = [
      ...src.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*export\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (!spec.startsWith('.')) continue; // node: builtins and npm deps carry no repo config
      const resolved = path.resolve(path.dirname(file), spec);
      assert.notEqual(path.basename(resolved), 'config.js',
        `${path.relative(HOST_ROOT, file)} statically imports config.js — the demo/e2e mock would be bypassed`);
      visit(resolved);
    }
    assert.ok(!/from\s+['"]dotenv/.test(src), `${path.relative(HOST_ROOT, file)} must not load dotenv`);
  };
  visit(path.join(HOST_ROOT, 'web/server/lib/seed-choice.js'));
  assert.ok([...seen].some((f) => f.endsWith(path.join('src', 'lib', 'render-seed.js'))),
    'the seed module IS reachable — that is the intended pattern, not an accident');
  // …and the reason that import is safe: the seed module pulls in nothing at all, so it can never
  // become a back door to config.js no matter what a later edit adds to src/lib.
  const core = fs.readFileSync(path.join(HOST_ROOT, 'src/lib/render-seed.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments talk ABOUT imports
  assert.ok(!/\bfrom\s+['"]|\bimport\s*[({]|\brequire\s*\(/.test(core),
    'src/lib/render-seed.js must keep ZERO imports — that is what makes it safe to import here');
});
