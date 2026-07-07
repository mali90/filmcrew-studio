// Status derivation from disk artifacts — the honesty core: the UI may only claim what a file
// proves. Fixtures are built programmatically so each case documents exactly what's on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanRun, listRuns } from '../../lib/run-scan.js';
import { newManifest, writeManifest } from '../../lib/web-manifest.js';

const mkRunsDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-scan-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const SPEC = { spec_version: '1.0', project: { title: 'Ocean Lighthouse' }, kling: { jobs: [{ job_id: 'K1', shots: ['S1'] }, { job_id: 'K2', shots: ['S2'] }] } };
const mk = (base, id, files = {}) => {
  const dir = path.join(base, id);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const webManifest = (over = {}) => ({ ...newManifest({ idea: 'a keeper at dusk', backend: 'kling', aspect: '9:16', durationS: null }, '2026-07-04T10:00:00.000Z'), ...over });

test('planning: agent artifacts appearing, live plan job → planning, agentsDone counted from disk', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-1', {
      'spec-00.json': SPEC, 'spec-01.json': SPEC, 'spec-02.json': SPEC,
    });
    writeManifest(dir, webManifest({ activeJob: { kind: 'plan', pid: 4242, startedAt: 'x' } }));
    const r = scanRun(dir, { isAlive: (pid) => pid === 4242 });
    assert.equal(r.status, 'planning');
    assert.equal(r.phase, 'plan');
    assert.equal(r.source, 'web');
    assert.deepEqual(r.agents, { done: 3, total: 8, qcCycles: 0 });
    assert.equal(r.idea, 'a keeper at dusk');
  } finally { t.cleanup(); }
});

test('plan-ready: final spec.json, no renders', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-2', {
      'spec-00.json': SPEC, 'spec-01.json': SPEC, 'spec-02.json': SPEC, 'spec-03.json': SPEC,
      'spec-04.json': SPEC, 'spec-05.json': SPEC, 'spec-06.json': SPEC, 'spec-07-qc1.json': SPEC,
      'spec.json': SPEC,
    });
    writeManifest(dir, webManifest());
    const r = scanRun(dir);
    assert.equal(r.status, 'plan-ready');
    assert.equal(r.title, 'Ocean Lighthouse');
    assert.deepEqual(r.agents, { done: 8, total: 8, qcCycles: 1 });
    assert.equal(r.latestRender, null);
  } finally { t.cleanup(); }
});

test('rendering: live spend job wins regardless of partial artifacts', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-3', {
      'spec.json': SPEC,
      'renders/t1/K1/clip.mp4': 'BYTES',
    });
    writeManifest(dir, webManifest({ activeJob: { kind: 'render', pid: 999, startedAt: 'x' } }));
    const r = scanRun(dir, { isAlive: () => true });
    assert.equal(r.status, 'rendering');
    assert.equal(r.phase, 'render');
  } finally { t.cleanup(); }
});

test('re-render: a live take-in-progress shows ITS OWN job progress, never the previous take as done', () => {
  const t = mkRunsDir();
  try {
    // t1 is a finished take (render.json + master); t2 is RESERVED — the re-render running right now
    const dir = mk(t.dir, 'web-rerender', {
      'spec.json': SPEC,
      'renders/t1/K1/clip.mp4': 'BYTES',
      'renders/t2/K1/out.mp4': 'BYTES', // K1 of the NEW take just landed; K2 still rendering
    });
    const master = path.join(dir, 'renders/t1/master.mp4');
    fs.writeFileSync(master, 'MP4');
    fs.writeFileSync(path.join(dir, 'renders/t1/render.json'), JSON.stringify({
      jobs: [{ jobId: 'K1', clip: path.join(dir, 'renders/t1/K1/clip.mp4') }, { jobId: 'K2', clip: path.join(dir, 'renders/t1/K1/clip.mp4') }],
      master,
    }));
    writeManifest(dir, webManifest({ activeJob: { kind: 'render', pid: 999, startedAt: 'x' } }));

    const r = scanRun(dir, { isAlive: () => true });
    assert.equal(r.status, 'rendering');
    assert.match(r.latestRender.dir, /renders\/t2$/, 'the in-progress take is the current one');
    assert.equal(r.latestRender.inProgress, true);
    assert.equal(r.latestRender.masterExists, false, 'no stitched master claimed mid-render');
    const byId = Object.fromEntries(r.latestRender.jobs.map((j) => [j.jobId, j.clipExists]));
    assert.deepEqual(byId, { K1: true, K2: false }, 'K1 landed, K2 must NOT read done');

    // once the child is gone (crash), the scan falls back to the completed take — old behavior
    const dead = scanRun(dir, { isAlive: () => false });
    assert.match(dead.latestRender.dir, /renders\/t1$/);
    assert.equal(dead.status, 'attention'); // dead pid → interrupted
  } finally { t.cleanup(); }
});

test('JOB re-render: only the targeted job renders — the rest keep their completed state (spinner lands on the right card)', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-job-rerender', {
      'spec.json': SPEC,
      'renders/t1/K1/clip.mp4': 'BYTES',
      'renders/t2/.reserved': '', // K2-only re-render in progress; NOTHING rendered into t2 yet
    });
    const k1clip = path.join(dir, 'renders/t1/K1/clip.mp4');
    const master = path.join(dir, 'renders/t1/master.mp4');
    fs.writeFileSync(master, 'MP4');
    fs.writeFileSync(path.join(dir, 'renders/t1/render.json'), JSON.stringify({
      jobs: [{ jobId: 'K1', clip: k1clip }, { jobId: 'K2', clip: k1clip }],
      master,
    }));
    writeManifest(dir, webManifest({
      activeJob: { kind: 'render-job', pid: 999, startedAt: 'x' },
      takes: [
        { id: 't1', mode: 'full', createdAt: 'x' },
        { id: 't2', mode: 'job', jobId: 'K2', cascade: false, createdAt: 'y' },
      ],
    }));
    const r = scanRun(dir, { isAlive: () => true });
    assert.match(r.latestRender.dir, /renders\/t2$/);
    const byId = Object.fromEntries(r.latestRender.jobs.map((j) => [j.jobId, j.clipExists]));
    // K1 is NOT part of this take: it keeps its completed clip — so the "first job without a
    // clip" (the UI's spinner rule) is K2, the one actually rendering
    assert.deepEqual(byId, { K1: true, K2: false });
  } finally { t.cleanup(); }
});

test('a live revision exposes its owners (a cold page must not show a dead all-done rail)', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-revising', {
      'spec.json': SPEC,
      'spec-00.json': SPEC, 'spec-01.json': SPEC, 'spec-02.json': SPEC, 'spec-03.json': SPEC,
      'spec-04.json': SPEC, 'spec-05.json': SPEC, 'spec-06.json': SPEC, 'spec-07-qc1.json': SPEC,
      'revisions/r1/feedback.json': { feedback: 'fix the dialogue', scope: 'K3', owners: [4, 5], at: 'now' },
    });
    writeManifest(dir, webManifest({ activeJob: { kind: 'revise', pid: 999, startedAt: 'x' } }));
    const r = scanRun(dir, { isAlive: () => true });
    assert.equal(r.status, 'planning');
    assert.deepEqual(r.revising, { id: 'r1', owners: [4, 5], scope: 'K3' });
    // dead child → no live revision claimed
    const dead = scanRun(dir, { isAlive: () => false });
    assert.equal(dead.revising, null);
  } finally { t.cleanup(); }
});

test('a live post-approve upscale is the DELIVER step, never a bounce back to rendering', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-upscaling', {
      'spec.json': SPEC,
      'renders/t1/K1/clip.mp4': 'BYTES',
    });
    const master = path.join(dir, 'renders/t1/master.mp4');
    fs.writeFileSync(master, 'MP4');
    fs.writeFileSync(path.join(dir, 'renders/t1/render.json'), JSON.stringify({ jobs: [{ jobId: 'K1', clip: path.join(dir, 'renders/t1/K1/clip.mp4') }], master }));
    writeManifest(dir, webManifest({ activeJob: { kind: 'upscale', pid: 999, startedAt: 'x' } }));
    const r = scanRun(dir, { isAlive: () => true });
    assert.equal(r.status, 'rendering'); // money is being spent and it is cancellable
    assert.equal(r.phase, 'deliver');    // but the JOURNEY step is delivery, not a render regression
  } finally { t.cleanup(); }
});

test('attention: a dead recorded pid means interrupted (persisted honestly across restarts)', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-4', { 'spec.json': SPEC });
    writeManifest(dir, webManifest({ activeJob: { kind: 'render', pid: 1, startedAt: 'x' } }));
    const r = scanRun(dir, { isAlive: () => false });
    assert.equal(r.status, 'attention');
    assert.match(r.error.message, /interrupted/i);
  } finally { t.cleanup(); }
});

test('attention: persisted lastError; and a failed job in the latest take', () => {
  const t = mkRunsDir();
  try {
    const d1 = mk(t.dir, 'web-5', { 'spec.json': SPEC });
    writeManifest(d1, webManifest({ lastError: { ts: 'x', action: 'render', message: 'fal exploded', logTail: [] } }));
    assert.equal(scanRun(d1).status, 'attention');
    assert.equal(scanRun(d1).error.message, 'fal exploded');

    const d2 = mk(t.dir, 'web-6', {
      'spec.json': SPEC,
      'renders/t1/render.json': { project: 'x', backend: 'kling', jobs: [{ job: 'K1', clip: null, error: 'boom' }] },
    });
    writeManifest(d2, webManifest());
    const r2 = scanRun(d2);
    assert.equal(r2.status, 'attention');
    assert.equal(r2.latestRender.jobs[0].error, 'boom');
  } finally { t.cleanup(); }
});

test('attention: clips exist but no assembled master (stitch missing → free recovery)', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-7', { 'spec.json': SPEC });
    const clip = path.join(dir, 'renders/t1/K1/clip.mp4');
    fs.mkdirSync(path.dirname(clip), { recursive: true });
    fs.writeFileSync(clip, 'BYTES');
    fs.writeFileSync(path.join(dir, 'renders/t1/render.json'), JSON.stringify({ jobs: [{ job: 'K1', clip }] }));
    writeManifest(dir, webManifest());
    const r = scanRun(dir);
    assert.equal(r.status, 'attention');
    assert.equal(r.latestRender.jobs[0].clipExists, true);
    assert.equal(r.latestRender.masterExists, false);
  } finally { t.cleanup(); }
});

test('review: the latest take has an assembled master on disk; takes pick the highest tN', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-8', { 'spec.json': SPEC });
    for (const take of ['t1', 't2']) {
      const clip = path.join(dir, `renders/${take}/K1/clip.mp4`);
      const master = path.join(dir, `renders/${take}/master.mp4`);
      fs.mkdirSync(path.dirname(clip), { recursive: true });
      fs.writeFileSync(clip, 'C');
      fs.writeFileSync(master, 'M');
      fs.writeFileSync(path.join(dir, `renders/${take}/render.json`), JSON.stringify({ master, jobs: [{ job: 'K1', clip }] }));
    }
    writeManifest(dir, webManifest());
    const r = scanRun(dir);
    assert.equal(r.status, 'review');
    assert.equal(r.phase, 'review');
    assert.ok(r.latestRender.dir.endsWith('t2'), 'highest take number wins');
    assert.equal(r.latestRender.masterExists, true);
  } finally { t.cleanup(); }
});

test('complete: approved final exists → complete; approved but file deleted → attention', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'web-9', { 'spec.json': SPEC, 'final.mp4': 'F' });
    writeManifest(dir, webManifest({ approved: { cut: 'c1', final: path.join(dir, 'final.mp4'), upscaled: false, at: 'x' } }));
    assert.equal(scanRun(dir).status, 'complete');
    assert.equal(scanRun(dir).phase, 'deliver');
    fs.rmSync(path.join(dir, 'final.mp4'));
    assert.equal(scanRun(dir).status, 'attention');
  } finally { t.cleanup(); }
});

test('cli-legacy: no web.json — engine run with nested render/ scans as source cli', () => {
  const t = mkRunsDir();
  try {
    const dir = mk(t.dir, 'engine-20260101-ab', { 'spec.json': SPEC });
    const clip = path.join(dir, 'render/K1/clip.mp4');
    const master = path.join(dir, 'render/master.mp4');
    fs.mkdirSync(path.dirname(clip), { recursive: true });
    fs.writeFileSync(clip, 'C');
    fs.writeFileSync(master, 'M');
    fs.writeFileSync(path.join(dir, 'render/render.json'), JSON.stringify({ master, jobs: [{ job: 'K1', clip }] }));
    const r = scanRun(dir);
    assert.equal(r.source, 'cli');
    assert.equal(r.status, 'review');
    assert.equal(r.idea, null, 'cli runs have no recorded idea');
    assert.equal(r.title, 'Ocean Lighthouse');
  } finally { t.cleanup(); }
});

test('fresh empty web run scans as planning; listRuns sorts newest first and skips non-runs', () => {
  const t = mkRunsDir();
  try {
    const d1 = mk(t.dir, 'web-old', {});
    writeManifest(d1, webManifest({ createdAt: '2026-07-01T00:00:00.000Z' }));
    const d2 = mk(t.dir, 'web-new', {});
    writeManifest(d2, webManifest({ createdAt: '2026-07-03T00:00:00.000Z' }));
    fs.writeFileSync(path.join(t.dir, 'stray-file.txt'), 'not a run');
    assert.equal(scanRun(d1).status, 'planning');
    const runs = listRuns(t.dir);
    assert.deepEqual(runs.map((r) => r.id), ['web-new', 'web-old']);
  } finally { t.cleanup(); }
});
