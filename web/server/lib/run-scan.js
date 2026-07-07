// Disk → status. A run's state is DERIVED from its artifacts (the CLI's layout, unchanged) plus
// the web.json manifest — the server holds nothing in memory that this scan can't rebuild, so a
// restart recovers every run honestly. The UI may only claim what a file here proves.
//
// Status ladder (first match wins):
//   complete   manifest.approved.final exists on disk
//   planning   live plan/revise child (manifest.activeJob alive)          — or a plan still growing
//   rendering  live spend child (render/render-job/assemble/upscale)
//   attention  recorded-but-dead child (interrupted) | manifest.lastError | a failed job in the
//              latest take | clips exist but no assembled master (stitch missing → free recovery)
//   review     the latest take has an assembled master on disk
//   plan-ready spec.json exists, nothing rendered yet
//   planning   anything earlier (spec-NN.json still appearing, or a just-created dir)
import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from './web-manifest.js';

const PLAN_KINDS = new Set(['plan', 'revise']);
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// Liveness probe: is this pid still running? Exported so run-service shares the SAME default —
// server.js injects nothing (like spawnCli), and dismissError calls isAlive directly, not via scanRun.
export const defaultIsAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Count the engine's per-agent artifacts: spec-00..06 (+1 when any QC cycle file exists). */
function agentProgress(dir) {
  let done = 0;
  for (let i = 0; i <= 6; i++) if (exists(path.join(dir, `spec-${String(i).padStart(2, '0')}.json`))) done++;
  let qcCycles = 0;
  while (exists(path.join(dir, `spec-07-qc${qcCycles + 1}.json`))) qcCycles++;
  return { done: done + (qcCycles > 0 ? 1 : 0), total: 8, qcCycles };
}

/** The run's most recent render dir: web renders/tN (highest N) > cli ./render > the dir itself.
 *  Returns { dir, pendingDir }: `pendingDir` is a HIGHER take that exists without a render.json —
 *  a take that was reserved and is (or was) being rendered into right now. */
function latestRenderDir(dir) {
  const rendersRoot = path.join(dir, 'renders');
  if (exists(rendersRoot)) {
    const all = fs.readdirSync(rendersRoot)
      .filter((n) => /^t\d+$/.test(n))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const complete = all.filter((n) => exists(path.join(rendersRoot, n, 'render.json')));
    const newest = all.at(-1);
    const newestComplete = complete.at(-1);
    return {
      dir: newestComplete ? path.join(rendersRoot, newestComplete) : null,
      pendingDir: newest && newest !== newestComplete ? path.join(rendersRoot, newest) : null,
    };
  }
  if (exists(path.join(dir, 'render', 'render.json'))) return { dir: path.join(dir, 'render'), pendingDir: null };
  if (exists(path.join(dir, 'render.json'))) return { dir, pendingDir: null };
  return { dir: null, pendingDir: null };
}

/** A take being rendered RIGHT NOW has no render.json yet — synthesize its honest jobs view from
 *  the plan (clips checked per job dir). Without this, the page shows the PREVIOUS take's finished
 *  clips as green "done" while money is being spent on the new one. For a JOB re-render, only the
 *  targeted jobs belong to this take — the rest keep their state from the last completed take
 *  (otherwise the spinner lands on the first job in the plan instead of the one being rendered). */
function scanPendingRender(pendingDir, spec, completed, lastTake) {
  if (!pendingDir || !spec?.kling?.jobs?.length) return null;
  const specJobs = spec.kling.jobs;
  let targets = null; // null = full render: every job renders in this take
  if (lastTake?.mode === 'job' && lastTake.jobId) {
    const idx = specJobs.findIndex((j) => j.job_id === lastTake.jobId);
    targets = new Set(
      (lastTake.cascade && idx !== -1 ? specJobs.slice(idx) : specJobs.filter((j) => j.job_id === lastTake.jobId))
        .map((j) => j.job_id),
    );
  }
  const priorById = Object.fromEntries((completed?.jobs ?? []).map((j) => [j.jobId, j]));
  const jobs = specJobs.map((j) => {
    if (targets && !targets.has(j.job_id)) {
      const prior = priorById[j.job_id];
      return { jobId: j.job_id, clip: prior?.clip ?? null, clipExists: !!prior?.clipExists, error: prior?.error ?? null };
    }
    let clip = null;
    try {
      const jobDir = path.join(pendingDir, j.job_id);
      const mp4 = fs.readdirSync(jobDir).find((f) => f.endsWith('.mp4'));
      if (mp4) clip = path.join(jobDir, mp4);
    } catch { /* job not started */ }
    return { jobId: j.job_id, clip, clipExists: !!clip, error: null };
  });
  return {
    dir: pendingDir,
    backend: spec.render_backend ?? null,
    jobs,
    master: null,
    masterExists: false,
    masterShortSide: null,
    cover: completed?.cover ?? null, // keep the library thumbnail stable while the new take renders
    inProgress: true,
  };
}

/** render.json → the jobs/master view the UI needs, with on-disk existence checked per path. */
function scanRender(renderDir) {
  if (!renderDir) return null;
  const rj = readJson(path.join(renderDir, 'render.json'));
  if (!rj) return null;
  const jobs = (rj.jobs ?? []).map((j) => {
    const clip = j.clip ?? null;
    return { jobId: j.jobId ?? j.job, clip, clipExists: exists(clip), error: j.error ?? null };
  });
  const master = rj.master ?? null;
  return {
    dir: renderDir,
    backend: rj.backend ?? null,
    jobs,
    master,
    masterExists: exists(master),
    masterShortSide: rj.masterShortSide ?? null, // delivered size — the UI disables upscale at ≥1080
    cover: exists(path.join(renderDir, 'cover.png')) ? path.join(renderDir, 'cover.png') : null,
  };
}

/**
 * Scan one run directory into the UI's summary/detail shape. `isAlive` is injectable for tests.
 * Never throws on a malformed dir — worst case it reports an honest 'planning' shell.
 */
export function scanRun(dir, { isAlive = defaultIsAlive } = {}) {
  const manifest = readManifest(dir);
  const spec = readJson(path.join(dir, 'spec.json'));
  const agents = agentProgress(dir);
  // a LIVE revision: the revise child writes revisions/<id>/feedback.json (owners included) at
  // start — without this a cold page mid-revision shows a dead all-done rail and no clue why
  let revising = null;
  if (manifest?.activeJob?.kind === 'revise' && isAlive(manifest.activeJob.pid)) {
    try {
      const revRoot = path.join(dir, 'revisions');
      const latest = fs.readdirSync(revRoot).filter((n) => /^r\d+$/.test(n)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).at(-1);
      const fb = latest ? readJson(path.join(revRoot, latest, 'feedback.json')) : null;
      if (fb) revising = { id: latest, owners: Array.isArray(fb.owners) ? fb.owners : [], scope: fb.scope ?? 'whole' };
    } catch { /* no revisions dir yet */ }
  }
  const { dir: completedDir, pendingDir } = latestRenderDir(dir);
  const completedRender = scanRender(completedDir);
  const active = manifest?.activeJob ?? null;
  const alive = active ? isAlive(active.pid) : false;
  // a LIVE render child + a reserved take = that take is the run's current render, not the old one
  const renderKinds = new Set(['render', 'probe', 'render-job', 'upscale']);
  const latestRender = (alive && renderKinds.has(active?.kind) && scanPendingRender(pendingDir, spec, completedRender, manifest?.takes?.at(-1))) || completedRender;

  let status;
  let error = manifest?.lastError ?? null;
  const approvedFinal = manifest?.approved?.final;
  if (approvedFinal && exists(approvedFinal)) {
    status = 'complete';
  } else if (active && alive) {
    status = PLAN_KINDS.has(active.kind) ? 'planning' : 'rendering';
  } else if (active && !alive) {
    status = 'attention';
    error = error ?? { ts: active.startedAt, action: active.kind, message: `${active.kind} was interrupted (the server or process died mid-run) — artifacts on disk show how far it got.`, logTail: [] };
  } else if (approvedFinal) {
    status = 'attention';
    error = error ?? { ts: manifest?.approved?.at, action: 'approve', message: `the approved final (${approvedFinal}) is missing from disk`, logTail: [] };
  } else if (error) {
    status = 'attention';
  } else if (latestRender?.jobs?.some((j) => j.error)) {
    status = 'attention';
  } else if (latestRender?.masterExists) {
    status = 'review';
  } else if (latestRender?.jobs?.some((j) => j.clipExists)) {
    status = 'attention'; // clips landed but the stitch didn't — recoverable for free via assemble
  } else if (spec) {
    status = 'plan-ready';
  } else {
    status = 'planning';
  }

  const phase =
    status === 'complete' ? 'deliver'
    : status === 'review' ? 'review'
    : status === 'rendering' ? (active?.kind === 'upscale' ? 'deliver' : 'render') // post-approve Topaz = delivering
    : status === 'attention' ? (latestRender ? 'render' : 'plan')
    : 'plan';

  let createdAt = manifest?.createdAt ?? null;
  if (!createdAt) { try { createdAt = fs.statSync(dir).birthtime.toISOString(); } catch { createdAt = null; } }

  return {
    id: path.basename(dir),
    dir,
    source: manifest ? 'web' : 'cli',
    manifest,
    idea: manifest?.idea ?? null,
    backend: manifest?.backend ?? spec?.render_backend ?? latestRender?.backend ?? null,
    aspect: manifest?.aspect ?? spec?.kling?.aspect_ratio ?? null,
    revising,
    durationS: manifest ? manifest.durationS : null,
    createdAt,
    title: spec?.project?.title ?? null,
    planned: !!spec,
    agents,
    latestRender,
    cover: latestRender?.cover ?? null,
    status,
    phase,
    error,
  };
}

/** Every run under runsDir (directories only), newest first. */
export function listRuns(runsDir, opts = {}) {
  if (!exists(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => scanRun(path.join(runsDir, e.name), opts))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

export default { scanRun, listRuns };
