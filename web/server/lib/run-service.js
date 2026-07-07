// The orchestration layer between the API routes and the CLI children. Owns the lifecycle rules:
//   - planning uses your LLM, never auto-renders — LLM cost, no render (creating a run only queues the engine)
//   - the STITCH ALWAYS PRECEDES REVIEW: a full render ends assembled (finishRender), a probe or
//     job re-render is auto-assembled the moment its clips land — Review always plays a master
//   - approve is UPSCALE-ONLY (optional Topaz when <1080p) + recording the final
//   - every event and every manifest update flows through here, so run state stays derivable
import fs from 'node:fs';
import path from 'node:path';
import { newManifest, writeManifest, readManifest, updateManifest } from './web-manifest.js';
import { scanRun, listRuns, defaultIsAlive } from './run-scan.js';
import { createRingLog } from './ring-log.js';
import { watchRun } from './artifact-watch.js';
import { estimateRender, readSeedanceResolution } from './estimator.js';
import { safeChild } from './paths.js';

const CLI = (root, name) => path.join(root, 'src/cli', name);
const slugify = (s) => String(s ?? 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'video';
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

export function createRunService({ root, runsDir, outDir, envRoot, childEnv, mgr, bus, isAlive = defaultIsAlive, now = () => new Date() }) {
  const estOpts = () => ({ resolution: readSeedanceResolution(envRoot ?? root) }); // seedance price scales with resolution
  const ringLogs = new Map();   // runId → ring log
  const watchers = new Map();   // runId → watcher
  const announced = new Map();  // runId → Set<artifact rel> already sent to clients — persists across watcher restarts so a spec block is never lost to a startup race nor re-announced
  const pendingCascade = new Map(); // runId → {takeDir, takeId, jobs:[...remaining], feedback}
  const running = new Map();    // runId → Map<queueId, {kind, pid, startedAt}> — lanes can overlap per run

  // manifest.activeJob is a single slot; when several lanes work one run (a free assemble beside a
  // paid render), record the job whose interruption matters MOST for restart honesty.
  const KIND_PRIORITY = { render: 5, 'render-job': 5, probe: 5, upscale: 5, 'mint-voice': 4, plan: 3, revise: 3, assemble: 1 };
  const topRunningJob = (runId) => {
    const jobs = [...(running.get(runId)?.values() ?? [])];
    jobs.sort((a, b) => (KIND_PRIORITY[b.kind] ?? 0) - (KIND_PRIORITY[a.kind] ?? 0));
    return jobs[0] ?? null;
  };

  const ringFor = (runId) => {
    if (!ringLogs.has(runId)) ringLogs.set(runId, createRingLog());
    return ringLogs.get(runId);
  };
  const dirFor = (runId) => safeChild(runsDir, runId);
  const env = () => ({ ...childEnv, RUNS_DIR: runsDir, OUT_DIR: outDir });

  /** Queued/active manager jobs for one run — memory truth the disk scan can't see. */
  const liveJobsFor = (runId) => {
    const snap = mgr.snapshot();
    return [...snap.active, ...snap.queued].filter((j) => j.runId === runId);
  };

  /**
   * Overlay live-queue truth on a disk-derived run. Between a job's 'done' and its auto-assemble's
   * 'start' (or while work waits behind a busy lane) the disk says attention/plan-ready/review —
   * but work is committed, so the honest status is planning/rendering. Memory-only by design:
   * after a restart the queue is empty and disk truth stands (interrupted detection intact).
   */
  function withLiveStatus(run) {
    if (!run || run.status === 'complete') return run;
    const jobs = liveJobsFor(run.id);
    if (!jobs.length) return run;
    const planOnly = jobs.every((j) => j.lane === 'plan');
    const status = planOnly ? 'planning' : 'rendering';
    // a QUEUED render's reserved take must not show the previous take's finished clips as green
    // "done" — while the new take has no render.json and no live child scanning it, hand the UI
    // NOTHING (it falls back to the plan's job list and live job events patch it honestly).
    let latestRender = run.latestRender;
    if (!planOnly && latestRender && !latestRender.inProgress) {
      const lastTake = run.manifest?.takes?.at(-1)?.id;
      if (lastTake && path.basename(latestRender.dir ?? '') !== lastTake
        && fs.existsSync(path.join(dirFor(run.id), 'renders', lastTake))
        && !fs.existsSync(path.join(dirFor(run.id), 'renders', lastTake, 'render.json'))) {
        latestRender = null;
      }
    }
    if (run.status === status && latestRender === run.latestRender) return run;
    const kinds = new Set(jobs.map((j) => j.kind));
    const delivering = kinds.has('upscale') && !kinds.has('render') && !kinds.has('render-job') && !kinds.has('probe');
    return { ...run, status, phase: planOnly ? 'plan' : delivering ? 'deliver' : 'render', latestRender };
  }

  function emitStatus(runId) {
    const run = withLiveStatus(scanRun(dirFor(runId), { isAlive }));
    bus.emit(runId, { type: 'status', status: run.status, phase: run.phase });
    bus.emit('*', { type: 'run-status', runId, status: run.status });
  }

  /** Central consumer for every job-manager event. */
  function onEvent(runId, evt) {
    if (runId === '*') { bus.emit('*', evt); return; }
    const dir = dirFor(runId);
    if (evt.type === 'log') {
      const cursor = ringFor(runId).append(evt.line);
      bus.emit(runId, { type: 'log', cursor, line: evt.line });
      return;
    }
    if (evt.type === 'start') {
      if (!running.has(runId)) running.set(runId, new Map());
      running.get(runId).set(evt.jobIdRef, { kind: evt.kind, pid: evt.pid, startedAt: now().toISOString() });
      try { updateManifest(dir, (m) => { m.activeJob = { ...topRunningJob(runId), queueId: evt.jobIdRef }; return m; }); } catch { /* cli run */ }
      if (!watchers.has(runId)) {
        if (!announced.has(runId)) announced.set(runId, new Set());
        watchers.set(runId, watchRun(dir, { seen: announced.get(runId), onEvent: (e) => bus.emit(runId, e.file.includes('spec') ? { type: 'spec-block', file: e.file } : { type: 'artifact', file: e.file }) }));
      }
      bus.emit(runId, { type: 'action-start', kind: evt.kind });
      emitStatus(runId);
      return;
    }
    if (evt.type === 'done' || evt.type === 'error') {
      running.get(runId)?.delete(evt.jobIdRef);
      const remaining = topRunningJob(runId);
      if (!remaining) { // stop watching only when the run has NO live children left
        watchers.get(runId)?.stop();
        watchers.delete(runId);
        running.delete(runId);
      }
      try {
        updateManifest(dir, (m) => {
          m.activeJob = remaining; // the paid render's pid survives a sibling assemble finishing
          if (evt.type === 'error') m.lastError = { ts: now().toISOString(), action: evt.kind, message: evt.message, logTail: evt.logTail ?? [] };
          return m;
        });
      } catch { /* cli run */ }
      if (evt.type === 'done') {
        try { afterDone(runId, evt); } catch (e) {
          updateManifest(dir, (m) => { m.lastError = { ts: now().toISOString(), action: evt.kind, message: `post-processing failed: ${e.message}`, logTail: [] }; return m; });
        }
      } else {
        pendingCascade.delete(runId);
      }
      bus.emit(runId, { type: evt.type, kind: evt.kind, ...(evt.type === 'done' ? { result: summarizeResult(evt) } : { message: evt.message }) });
      emitStatus(runId);
      return;
    }
    // parsed sentinel events (agent/qc/job/assemble/master/upscale) pass straight through
    bus.emit(runId, evt);
  }

  const summarizeResult = (evt) => {
    const r = evt.result;
    if (!r || typeof r !== 'object') return null;
    const { spec, ...rest } = r; // specs are fetched via GET, not pushed through events
    return rest;
  };

  /** Post-completion rules per kind — this is where "stitch precedes review" is enforced. */
  function afterDone(runId, evt) {
    const dir = dirFor(runId);
    const kind = evt.kind;
    const result = evt.result ?? {};
    if (kind === 'plan') return; // plan-ready is visible from spec.json

    if (kind === 'revise') {
      // promote the revised spec to the run's canonical plan (history stays in revisions/rN)
      const revised = result.runDir ? path.join(result.runDir, 'spec.json') : null;
      if (revised && fs.existsSync(revised)) fs.copyFileSync(revised, path.join(dir, 'spec.json'));
      // attribution comes from the revision's OWN feedback.json (written by the revise CLI) — a
      // manifest-level "pending" slot would misattribute when two revisions overlap
      const meta = result.runDir ? readJson(path.join(result.runDir, 'feedback.json')) : null;
      updateManifest(dir, (m) => {
        m.revisions.push({
          id: path.basename(result.runDir ?? `r${m.revisions.length + 1}`),
          feedback: meta?.feedback ?? null,
          scope: meta?.scope ?? 'whole',
          owners: result.owners ?? [],
          createdAt: now().toISOString(),
        });
        return m;
      });
      return;
    }

    if (kind === 'render') { // full render — finishRender already assembled + wrote render.json
      updateManifest(dir, (m) => {
        mergeJobClips(m, result.jobs);
        const takeId = path.basename(result.runDir ?? '');
        m.cuts.push({ id: `c${m.cuts.length + 1}`, take: takeId, master: result.master ?? null, shortSide: result.masterShortSide ?? null, createdAt: now().toISOString() });
        return m;
      });
      return;
    }

    if (kind === 'probe') { // stitch precedes review: assemble the probe clip now (free)
      updateManifest(dir, (m) => { mergeJobClips(m, result.jobs); return m; });
      if (result.runDir) enqueueAssemble(runId, result.runDir);
      return;
    }

    if (kind === 'render-job') {
      updateManifest(dir, (m) => { mergeJobClips(m, [{ jobId: result.jobId, clip: result.clip }]); return m; });
      const cascade = pendingCascade.get(runId);
      if (cascade && cascade.jobs.length) {
        const nextJob = cascade.jobs.shift();
        enqueueRenderJob(runId, { jobId: nextJob, takeDir: cascade.takeDir, seamFrom: cascade.takeDir, feedback: cascade.feedback, take: cascade.take });
        return;
      }
      pendingCascade.delete(runId);
      // compose the full cut (new clips over the previous composition) then stitch — free
      const takeDir = cascade?.takeDir ?? result.runDir;
      if (takeDir) { composeCut(runId, takeDir); enqueueAssemble(runId, takeDir); }
      return;
    }

    if (kind === 'assemble') {
      updateManifest(dir, (m) => {
        const takeId = path.basename(result.runDir ?? '');
        m.cuts.push({ id: `c${m.cuts.length + 1}`, take: takeId, master: result.master ?? null, shortSide: result.masterShortSide ?? null, createdAt: now().toISOString() });
        return m;
      });
      return;
    }

    if (kind === 'upscale') { // approve's paid tail: the upscaled re-assembly is the final
      updateManifest(dir, (m) => {
        m.approved = { cut: m.cuts.at(-1)?.id ?? null, final: result.master ?? null, upscaled: true, at: now().toISOString() };
        return m;
      });
      return;
    }
  }

  /** Track the newest clip per job id — the composition source for mixed cuts. */
  function mergeJobClips(m, jobs) {
    m.jobClips = m.jobClips ?? {};
    for (const j of jobs ?? []) {
      const id = j.jobId ?? j.job;
      if (id && j.clip) m.jobClips[id] = j.clip;
    }
  }

  /** Write a full-composition render.json into takeDir: every spec job's newest clip, in order. */
  function composeCut(runId, takeDir) {
    const dir = dirFor(runId);
    const spec = readJson(path.join(dir, 'spec.json'));
    const m = readManifest(dir);
    if (!spec || !m?.jobClips) return;
    const jobs = (spec.kling?.jobs ?? []).map((j) => ({ jobId: j.job_id, clip: m.jobClips[j.job_id] ?? null }));
    const existing = readJson(path.join(takeDir, 'render.json')) ?? {};
    fs.writeFileSync(path.join(takeDir, 'render.json'), JSON.stringify({ ...existing, project: spec.project?.title, composed: true, jobs }, null, 2) + '\n');
  }

  // Take numbers are NEVER reused: lowest-free once resurrected a deleted t2 AFTER t3 existed,
  // breaking every "highest tN = newest" assumption (latestRender, seams, cut lineage). Max over
  // both the dirs on disk and the manifest's take records, +1.
  const nextTakeDir = (dir) => {
    let maxN = 0;
    try {
      for (const n of fs.readdirSync(path.join(dir, 'renders'))) {
        const m = /^t(\d+)$/.exec(n);
        if (m) maxN = Math.max(maxN, Number(m[1]));
      }
    } catch { /* first take */ }
    for (const t of readManifest(dir)?.takes ?? []) {
      const m = /^t(\d+)$/.exec(t?.id ?? '');
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    return path.join(dir, 'renders', `t${maxN + 1}`);
  };

  function outNameFor(runId, spec, suffix) {
    const short = runId.split('-').pop();
    return `${slugify(spec?.project?.title)}-${short}${suffix ? `-${suffix}` : ''}`;
  }

  function enqueueAssemble(runId, fromDir, { upscale = false, suffix } = {}) {
    const dir = dirFor(runId);
    const spec = readJson(path.join(dir, 'spec.json'));
    return mgr.enqueue({
      runId, lane: upscale ? 'spend' : 'free', kind: upscale ? 'upscale' : 'assemble',
      script: CLI(root, 'assemble.js'),
      args: ['--from', fromDir, '--out-name', outNameFor(runId, spec, suffix ?? (upscale ? 'final' : null)), ...(upscale ? ['--upscale'] : [])],
      env: env(), cwd: root,
    });
  }

  function enqueueRenderJob(runId, { jobId, takeDir, seamFrom, feedback, take }) {
    const dir = dirFor(runId);
    return mgr.enqueue({
      runId, lane: 'spend', kind: 'render-job',
      script: CLI(root, 'render-job.js'),
      args: [
        '--spec', path.join(dir, 'spec.json'), '--job', jobId, '--out', takeDir,
        ...(seamFrom ? ['--seam-from', seamFrom] : []),
        ...(feedback ? ['--feedback', feedback] : []),
        ...(take ? ['--take', String(take)] : []),
      ],
      env: env(), cwd: root,
    });
  }

  // ── Public API (what the routes call) ────────────────────────────────────

  function createRun({ idea, backend, aspect, durationS, cast = [] }) {
    const stamp = now().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const runId = `web-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = dirFor(runId);
    fs.mkdirSync(dir, { recursive: true });
    writeManifest(dir, newManifest({ idea, backend, aspect, durationS, cast }, now().toISOString()));
    const queued = mgr.enqueue({
      runId, lane: 'plan', kind: 'plan',
      script: CLI(root, 'engine.js'),
      args: ['--brief', idea, '--out', dir, '--backend', backend, '--aspect', aspect,
        ...(durationS ? ['--duration', String(durationS)] : []),
        ...(cast.length ? ['--cast', cast.join(',')] : [])],
      env: env(), cwd: root,
    });
    return { runId, queued };
  }

  /** Re-run the engine on an existing run (recovery after a failed/interrupted plan). LLM cost, no render. */
  function plan(runId) {
    const dir = dirFor(runId);
    const m = readManifest(dir);
    if (!m) throw Object.assign(new Error('not a web run'), { statusCode: 409, hint: 'CLI-created runs are planned from the terminal' });
    if (liveJobsFor(runId).some((j) => j.lane === 'plan')) {
      throw Object.assign(new Error('planning is already running for this run'), { statusCode: 409, hint: 'watch the agent rail — or cancel first' });
    }
    updateManifest(dir, (mm) => { mm.lastError = null; mm.activeJob = null; return mm; });
    const queued = mgr.enqueue({
      runId, lane: 'plan', kind: 'plan',
      script: CLI(root, 'engine.js'),
      args: ['--brief', m.idea, '--out', dir, '--backend', m.backend, '--aspect', m.aspect,
        ...(m.durationS ? ['--duration', String(m.durationS)] : []),
        ...(m.cast?.length ? ['--cast', m.cast.join(',')] : [])],
      env: env(), cwd: root,
    });
    emitStatus(runId);
    return { queued };
  }

  /** One PAID job per run at a time: a double-tap once queued the same K-job twice (two reserved
   *  takes, two estimates). Cross-run queueing stays allowed — this guard is per run. */
  function assertNoSpendInFlight(runId) {
    const spend = liveJobsFor(runId).find((j) => j.lane === 'spend');
    if (spend) {
      const state = spend.startedAt ? 'already rendering' : 'already queued to render';
      throw Object.assign(new Error(`this run is ${state} (${spend.kind})`), { statusCode: 409, hint: 'wait for it to finish, or cancel it first' });
    }
  }

  function render(runId, { mode }) {
    const dir = dirFor(runId);
    const spec = readJson(path.join(dir, 'spec.json'));
    if (!spec) throw Object.assign(new Error('this run has no plan yet'), { statusCode: 409, hint: 'wait for planning to finish (or revise it) before rendering' });
    if (mode === 'probe' && (spec.kling?.jobs?.length ?? 0) < 2) {
      // a probe renders only the FIRST job — on a single-job plan that IS the full render, so
      // offering it would just be a second button with the same price (the UI hides it too)
      throw Object.assign(new Error('this plan renders as a single job — a probe would be the full render'), { statusCode: 409, hint: 'start the full render; probes only save money on multi-job plans' });
    }
    assertNoSpendInFlight(runId);
    const takeDir = nextTakeDir(dir);
    const takeId = path.basename(takeDir);
    fs.mkdirSync(takeDir, { recursive: true }); // reserve the tN NOW — a queued sibling must not resolve to the same take
    const est = estimateRender(spec, { backend: readManifest(dir)?.backend ?? 'kling', mode, ...estOpts() });
    updateManifest(dir, (m) => {
      m.takes.push({ id: takeId, mode, revision: m.revisions.at(-1)?.id ?? null, createdAt: now().toISOString(), estUsd: est.totalUsd });
      m.costLedger.push({ ts: now().toISOString(), action: mode, estUsd: est.totalUsd, note: 'estimate' });
      m.lastError = null;
      return m;
    });
    const queued = mgr.enqueue({
      runId, lane: 'spend', kind: mode === 'probe' ? 'probe' : 'render',
      script: CLI(root, 'render.js'),
      args: ['--spec', path.join(dir, 'spec.json'), '--out', takeDir, '--out-name', outNameFor(runId, spec, takeId),
        ...(mode === 'probe' ? ['--probe'] : [])],
      env: env(), cwd: root,
    });
    emitStatus(runId); // the page flips to 'rendering' NOW — queued work must never look like nothing happened
    return { takeId, queued, estUsd: est.totalUsd };
  }

  function revise(runId, { feedback, scope }) {
    const dir = dirFor(runId);
    if (!fs.existsSync(path.join(dir, 'spec.json'))) {
      throw Object.assign(new Error('this run has no plan to revise'), { statusCode: 409, hint: 'planning must finish once before a revision' });
    }
    let revDir;
    for (let n = 1; ; n++) { revDir = path.join(dir, 'revisions', `r${n}`); if (!fs.existsSync(revDir)) break; }
    fs.mkdirSync(revDir, { recursive: true }); // reserve rN — a concurrent revise must not share it
    updateManifest(dir, (m) => { m.lastError = null; return m; });
    const queued = mgr.enqueue({
      runId, lane: 'plan', kind: 'revise',
      script: CLI(root, 'revise.js'),
      args: ['--from', dir, '--feedback', feedback, '--out', revDir, ...(scope && scope !== 'whole' ? ['--scope', scope] : [])],
      env: env(), cwd: root,
    });
    emitStatus(runId); // page flips to 'planning' NOW, even when queued behind another revision
    return { revisionId: path.basename(revDir), queued };
  }

  function rerenderJob(runId, { jobId, cascade = false, feedback, take }) {
    const dir = dirFor(runId);
    const spec = readJson(path.join(dir, 'spec.json'));
    if (!spec) throw Object.assign(new Error('this run has no plan yet'), { statusCode: 409, hint: 'plan before rendering' });
    const jobs = (spec.kling?.jobs ?? []).map((j) => j.job_id);
    if (!jobs.includes(jobId)) throw Object.assign(new Error(`job "${jobId}" is not in this plan`), { statusCode: 400, hint: `jobs: ${jobs.join(', ')}` });
    assertNoSpendInFlight(runId);
    const m = readManifest(dir);
    const takeDir = nextTakeDir(dir);
    const takeId = path.basename(takeDir);
    fs.mkdirSync(takeDir, { recursive: true });
    const downstream = jobs.slice(jobs.indexOf(jobId) + 1);
    const cascadeJobs = cascade ? downstream : [];
    const est = estimateRender(spec, { backend: m?.backend ?? 'kling', mode: 'job', jobId, cascade, ...estOpts() });
    // Seam-in: renderJob wants <seamFrom>/<prevJob>/last_frame.png. The trustworthy source is the
    // take dir that produced the PREVIOUS job's newest clip (manifest.jobClips) — the latest cut's
    // dir may be a composed cut or a single-job take that never held the neighbour's frame.
    const prevJobId = jobs[jobs.indexOf(jobId) - 1];
    const prevClip = prevJobId ? m?.jobClips?.[prevJobId] : null;
    let seamFrom;
    if (prevClip && fs.existsSync(path.join(path.dirname(prevClip), 'last_frame.png'))) {
      seamFrom = path.dirname(path.dirname(prevClip)); // <takeDir>/<prevJob>/clip.mp4 → <takeDir>
    } else if (m?.cuts?.at(-1)?.take) {
      seamFrom = path.join(dir, 'renders', m.cuts.at(-1).take);
    }
    updateManifest(dir, (mm) => {
      mm.takes.push({ id: takeId, mode: 'job', jobId, cascade, revision: mm.revisions.at(-1)?.id ?? null, createdAt: now().toISOString(), estUsd: est.totalUsd, feedback: feedback ?? null });
      mm.costLedger.push({ ts: now().toISOString(), action: `rerender ${jobId}${cascade ? ' + downstream' : ''}`, estUsd: est.totalUsd, note: 'estimate' });
      mm.lastError = null;
      return mm;
    });
    if (cascadeJobs.length) pendingCascade.set(runId, { takeDir, takeId, jobs: [...cascadeJobs], feedback, take });
    const queued = enqueueRenderJob(runId, { jobId, takeDir, seamFrom, feedback, take });
    emitStatus(runId);
    return { takeId, queued, estUsd: est.totalUsd, cascadeJobs };
  }

  function assemble(runId, { composition } = {}) {
    const dir = dirFor(runId);
    if (composition) {
      const spec = readJson(path.join(dir, 'spec.json'));
      const validJobs = new Set((spec?.kling?.jobs ?? []).map((j) => j.job_id));
      for (const [jobId, takeId] of Object.entries(composition)) {
        // both keys and values are client input — never let them touch path.join unchecked
        if (!validJobs.has(jobId)) throw Object.assign(new Error(`"${jobId}" is not a job in this plan`), { statusCode: 400, hint: `jobs: ${[...validJobs].join(', ')}` });
        if (!/^t\d{1,4}$/.test(String(takeId))) throw Object.assign(new Error(`"${takeId}" is not a take id`), { statusCode: 400, hint: 'take ids look like t1, t2, …' });
      }
      updateManifest(dir, (m) => {
        m.jobClips = { ...m.jobClips };
        for (const [jobId, takeId] of Object.entries(composition)) {
          const takeRj = readJson(safeChild(dir, 'renders', String(takeId), 'render.json'));
          const hit = takeRj?.jobs?.find((j) => (j.jobId ?? j.job) === jobId);
          if (hit?.clip) m.jobClips[jobId] = hit.clip;
        }
        return m;
      });
    }
    const takeDir = nextTakeDir(dir);
    fs.mkdirSync(takeDir, { recursive: true });
    composeCut(runId, takeDir);
    if (!readJson(path.join(takeDir, 'render.json'))?.jobs?.some((j) => j.clip)) {
      // nothing composable in a fresh dir — fall back to re-finishing the latest render dir
      fs.rmSync(takeDir, { recursive: true, force: true });
      const latest = scanRun(dir, { isAlive }).latestRender?.dir;
      if (!latest) throw Object.assign(new Error('nothing to assemble — no rendered clips found'), { statusCode: 409, hint: 'render (or probe) first' });
      return { queued: enqueueAssemble(runId, latest) };
    }
    // the composed dir needs the spec beside it for assembleRun
    fs.copyFileSync(path.join(dir, 'spec.json'), path.join(takeDir, 'spec.json'));
    return { queued: enqueueAssemble(runId, takeDir) };
  }

  function approve(runId, { upscale = false } = {}) {
    const dir = dirFor(runId);
    const run = scanRun(dir, { isAlive });
    if (!run.latestRender?.masterExists) {
      throw Object.assign(new Error('nothing to approve — no assembled master exists'), { statusCode: 409, hint: 'render and let the stitch finish first (assemble is free)' });
    }
    if (!upscale) {
      const m = updateManifest(dir, (mm) => {
        mm.approved = { cut: mm.cuts.at(-1)?.id ?? null, final: run.latestRender.master, upscaled: false, at: now().toISOString() };
        return mm;
      });
      emitStatus(runId);
      return { final: m.approved.final, queued: null };
    }
    const spec = readJson(path.join(dir, 'spec.json'));
    updateManifest(dir, (m) => {
      m.costLedger.push({ ts: now().toISOString(), action: 'upscale', estUsd: null, note: 'topaz per-clip — see estimate' });
      m.lastError = null;
      return m;
    });
    return { final: null, queued: enqueueAssemble(runId, run.latestRender.dir, { upscale: true, suffix: 'final' }), spec: !!spec };
  }

  function cancel(runId) {
    const outcome = mgr.cancel(runId);
    if (outcome === 'active') {
      // the running child was killed — its 'close' handler clears bookkeeping; nothing else to do
    } else if (outcome === 'queued') {
      // only a QUEUED sibling was dropped — any running child stays tracked (activeJob untouched)
    } else {
      // the manager knows nothing about this run: clear a stale manifest activeJob (e.g. recorded
      // by a previous server process whose pid was recycled) so a run can't stay pinned forever
      try {
        const m = readManifest(dirFor(runId));
        if (m?.activeJob) {
          updateManifest(dirFor(runId), (mm) => {
            mm.lastError = { ts: now().toISOString(), action: mm.activeJob?.kind ?? 'unknown', message: `${mm.activeJob?.kind ?? 'work'} was cancelled after a restart — artifacts on disk show how far it got.`, logTail: [] };
            mm.activeJob = null;
            return mm;
          });
          emitStatus(runId);
          return 'stale';
        }
      } catch { /* cli run */ }
    }
    emitStatus(runId);
    return outcome;
  }

  /**
   * Acknowledge a run's error and return it to its disk-derived state. Clears the persisted
   * lastError and — when nothing is actually running — a dead activeJob (interruption record).
   * Without this, a failed revision or upscale strands an already-paid-for master on the
   * attention page forever (lastError outranks review and nothing else ever cleared it).
   */
  function dismissError(runId) {
    const dir = dirFor(runId);
    const m = readManifest(dir);
    if (!m) return { dismissed: false };
    const staleActive = !!m.activeJob && !running.get(runId)?.size && !isAlive(m.activeJob.pid);
    if (!m.lastError && !staleActive) return { dismissed: false };
    updateManifest(dir, (mm) => { mm.lastError = null; if (staleActive) mm.activeJob = null; return mm; });
    emitStatus(runId);
    return { dismissed: true };
  }

  function detail(runId) {
    const dir = dirFor(runId);
    if (!fs.existsSync(dir)) return null;
    const run = withLiveStatus(scanRun(dir, { isAlive }));
    const spec = readJson(path.join(dir, 'spec.json'));
    // position within the job's OWN lane — lanes drain independently, so a cross-lane index lies
    const queued = mgr.snapshot().queued;
    const mine = queued.find((j) => j.runId === runId);
    const queuePosition = mine ? queued.filter((j) => j.lane === mine.lane).findIndex((j) => j.runId === runId) : -1;
    return {
      ...run,
      spec,
      queue: queuePosition >= 0 ? { position: queuePosition + 1 } : null,
      logCursor: ringFor(runId).lastCursor,
    };
  }

  return {
    onEvent, createRun, plan, render, revise, rerenderJob, assemble, approve, cancel, dismissError, detail,
    list: () => listRuns(runsDir, { isAlive }).map(withLiveStatus),
    ringFor, dirFor,
    /** Boot-time reconciliation: interrupted runs become visible without any event. */
    recover() { for (const run of listRuns(runsDir, { isAlive })) if (run.status === 'attention' && run.error?.message?.includes('interrupted')) bus.emit('*', { type: 'run-status', runId: run.id, status: 'attention' }); },
  };
}

export default { createRunService };
