// The orchestration layer between the API routes and the CLI children. Owns the lifecycle rules:
//   - planning uses your LLM, never auto-renders — LLM cost, no render (creating a run only queues the engine)
//   - the STITCH ALWAYS PRECEDES REVIEW: a full render ends assembled (finishRender), a probe or
//     job re-render is auto-assembled the moment its clips land — Review always plays a master
//   - approve is UPSCALE-ONLY (optional Topaz when <1080p) + recording the final
//   - every event and every manifest update flows through here, so run state stays derivable
import fs from 'node:fs';
import path from 'node:path';
import { newManifest, writeManifest, readManifest, updateManifest } from './web-manifest.js';
import { scanRun, listRuns, defaultIsAlive, finalizedFinal } from './run-scan.js';
import { createRingLog } from './ring-log.js';
import { watchRun } from './artifact-watch.js';
import { estimateRender, estimateUpscale, readProbeResolution, readRenderResolution, readUpscaleProvider } from './estimator.js';
import { safeChild } from './paths.js';
// Both config-free by construction (the runs-caps canary walks this graph): the continuity rule is a
// pure function over a run record, and the model registry imports nothing at all.
import { computeLineage, resolveBoundaries, BOUNDARY_MODES } from './lineage.js';
import { capsFor, normalizeBackend } from '../../../src/lib/render-models.js';
// The cast count the seam rule reads, from the module that owns the rule — a job with no elements
// of its own inherits the WHOLE roster, and that subtlety is worth deriving in exactly one place.
import { castRefCountFor } from '../../../src/lib/seam-rule.js';
// config-FREE import: run-service is loaded eagerly by app.js, and the demo/e2e server sets FAL_BASE_URL
// only AFTER its static import chain — importing anything that pulls config.js here would snapshot the
// wrong (real) fal endpoint and make the validators/renders miss the mock.
import { SEEDANCE_TTV_GUIDANCE } from '../../../src/lib/seedance-guidance.js';

// Feedback for the content-policy "Revise to pass content check" button: rephrase to read as
// unambiguously benign AND follow the Seedance prompting guidance (single source of truth in
// src/lib/seedance-guidance.js). Used only by reviseForContentPolicy — the normal revise takes the user's own note.
const CONTENT_POLICY_REVISE_FEEDBACK = [
  'The previous render was rejected by the video model\'s content moderation as sensitive content — almost always a false positive on a benign idea. Keep the same story, characters, and structure, but rewrite the shot prompts to read as unambiguously benign: remove anything that could be read as violent, sexual, graphic, gory, or otherwise sensitive, and avoid ambiguous phrasing. Also apply this Seedance prompting guidance:',
  SEEDANCE_TTV_GUIDANCE,
].join('\n');

const CLI = (root, name) => path.join(root, 'src/cli', name);
const slugify = (s) => String(s ?? 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'video';
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// A take whose provider publishes no rate still SPENT money — the ledger records estUsd:null (as the
// Topaz row already does) and says why, so a null never reads as "this one was free".
const ledgerLine = (est) => ({
  estUsd: est.totalUsd,
  note: est?.unknownPrice ? 'estimate unavailable — no published rate for this backend' : 'estimate',
  // `unpriced` separates the two meanings of estUsd:null — "this spent money at a rate nobody
  // publishes" (flagged) from "this step really was free", like a local assemble (not flagged).
  ...(est?.unknownPrice ? { unpriced: true } : {}),
});

export function createRunService({ root, runsDir, outDir, envRoot, childEnv, mgr, bus, isAlive = defaultIsAlive, now = () => new Date() }) {
  // Seedance price scales with resolution, and the knob is per model (2.5 has its own) — so the
  // ledger records what THIS run's backend will actually be billed for. A per-run pick (stored on
  // the manifest, injected into every child spawn as that same knob) outranks the .env value here
  // exactly as it does in the render child; probes keep riding the separate probe knob either way.
  const estOpts = (backend, resolution) => ({
    resolution: resolution || readRenderResolution(envRoot ?? root, backend, childEnv),
    probeResolution: readProbeResolution(envRoot ?? root, backend, childEnv),
  });
  const ringLogs = new Map();   // runId → ring log
  const watchers = new Map();   // runId → watcher
  const announced = new Map();  // runId → Set<artifact rel> already sent to clients — persists across watcher restarts so a spec block is never lost to a startup race nor re-announced
  const pendingCascade = new Map(); // runId → {takeDir, takeId, jobs:[...remaining], feedback}
  const pendingApprove = new Map(); // runId → chosen cut id for the in-flight upscale (so afterDone records THAT cut, not the latest)
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
  const env = (runId) => ({ ...childEnv, ...resolutionOverride(runId), RUNS_DIR: runsDir, OUT_DIR: outDir });

  /**
   * The per-run resolution pick, as the .env knob THIS run's model actually reads
   * (caps.resolutionEnv — KLING_RESOLUTION / SEEDANCE_RESOLUTION / SEEDANCE25_RESOLUTION). Applied
   * to EVERY child spawn: dotenv never overwrites an existing variable, so the pick governs the
   * plan context, the render, every revise and every re-render without touching the user's .env.
   * Empty when the run never picked one — the configured default governs, exactly as before.
   */
  function resolutionOverride(runId) {
    const m = readManifest(dirFor(runId));
    if (!m?.resolution) return {};
    const key = capsOf(m.backend)?.resolutionEnv;
    return key ? { [key]: m.resolution } : {};
  }

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
        // only an UPSCALE failure clears its own cut slot — a sibling free-lane job erroring beside an
        // in-flight upscale must not drop the upscale's selected-cut association (→ wrong approved.cut).
        if (evt.kind === 'upscale') pendingApprove.delete(runId);
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
        mergeLineage(m, result.jobs);
        const takeId = path.basename(result.runDir ?? '');
        m.cuts.push({ id: `c${m.cuts.length + 1}`, take: takeId, master: result.master ?? null, shortSide: result.masterShortSide ?? null, ...stitchFields(result), createdAt: now().toISOString() });
        return m;
      });
      return;
    }

    if (kind === 'probe') { // stitch precedes review: assemble the probe clip now (free)
      updateManifest(dir, (m) => { mergeJobClips(m, result.jobs); mergeLineage(m, result.jobs); return m; });
      if (result.runDir) enqueueAssemble(runId, result.runDir);
      return;
    }

    if (kind === 'render-job') {
      updateManifest(dir, (m) => { mergeJobClips(m, [result]); mergeLineage(m, [result]); return m; });
      const cascade = pendingCascade.get(runId);
      if (cascade && cascade.jobs.length) {
        const nextJob = cascade.jobs.shift();
        enqueueRenderJob(runId, {
          jobId: nextJob, takeDir: cascade.takeDir, seamFrom: cascade.takeDir,
          // The closing pin belongs to the LAST job of the cascade and to no other: every earlier
          // job's ending is defined by the job that follows it in this same chain, so pinning one
          // would fight the chain it was queued to rebuild.
          lastFrameFrom: cascade.jobs.length ? undefined : cascade.lastFrameFrom,
          feedback: cascade.feedback, take: cascade.take, promptOverrides: cascade.promptOverrides,
        });
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
        m.cuts.push({ id: `c${m.cuts.length + 1}`, take: takeId, master: result.master ?? null, shortSide: result.masterShortSide ?? null, ...stitchFields(result), createdAt: now().toISOString() });
        return m;
      });
      return;
    }

    if (kind === 'upscale') { // approve's paid tail: the upscaled re-assembly is the final
      const chosenCut = pendingApprove.get(runId) ?? null; // the cut approve() upscaled (null ⇒ latest, the default)
      pendingApprove.delete(runId);
      updateManifest(dir, (m) => recordFinal(m, {
        cut: chosenCut ?? m.cuts.at(-1)?.id ?? null, final: result.master ?? null, upscaled: true, ...stitchFields(result), at: now().toISOString(),
      }));
      return;
    }
  }

  /**
   * How this master's seams were joined, for the cut/approved records: 'seamless' (colour-matched
   * chained joints) or 'concat' (a hard cut at every seam). Omitted entirely when the pipeline did
   * not report it, so a manifest written before this existed keeps reading exactly as it did.
   */
  function stitchFields(result) {
    const s = result?.stitch;
    if (!s?.stitcher) return {};
    return { stitcher: s.stitcher, joints: s.joints ?? 0, matched: s.matched ?? 0 };
  }

  /** Track the newest clip per job id — the composition source for mixed cuts. */
  function mergeJobClips(m, jobs) {
    m.jobClips = m.jobClips ?? {};
    for (const j of jobs ?? []) {
      const id = j.jobId ?? j.job;
      if (id && j.clip) m.jobClips[id] = j.clip;
    }
  }

  /**
   * The take a clip belongs to: renders/<take>/<job>/clip.mp4 → '<take>'. The path is the only
   * honest source — a job's newest clip may well live in an older take than the one being written.
   */
  const takeOfClip = (clip) => (clip ? path.basename(path.dirname(path.dirname(String(clip)))) : null);

  /**
   * Track each job's newest clip LINEAGE — which take it came out of and the seams the renderer
   * recorded for it (schema:2). `jobClips` alone cannot answer "does segment 2 still continue from
   * segment 1?", because a clip's seam names the take/job/clip it opened on and that source may
   * since have been replaced (run b1nx). Ids and the renderer's own seam records only; the
   * per-joint verdict is computed from them by lib/lineage.js, never stored.
   */
  function mergeLineage(m, jobs) {
    m.clipLineage = m.clipLineage ?? {};
    for (const j of jobs ?? []) {
      const id = j.jobId ?? j.job;
      if (!id || !j.clip) continue; // a failed job replaces nothing — its predecessor's lineage stands
      m.clipLineage[id] = { take: takeOfClip(j.clip), seamIn: j.seamIn ?? null, seamOut: j.seamOut ?? null };
    }
  }

  /**
   * The cut as the pure continuity rule wants it: one entry per plan job, pointing at that job's
   * NEWEST clip and the seams the renderer recorded for it. `clipLineage` is exactly what composeCut
   * would write into the next take, so the answer matches the cut the reviewer is looking at — and
   * it costs no disk read at all.
   */
  function cutRecordFor(runId, m, jobIds) {
    const byTake = new Map();
    const cut = jobIds.map((jobId) => {
      const lin = m?.clipLineage?.[jobId] ?? null;
      const clip = m?.jobClips?.[jobId] ?? null;
      const take = lin?.take ?? takeOfClip(clip);
      if (take && clip) {
        if (!byTake.has(take)) byTake.set(take, []);
        byTake.get(take).push({ jobId, clip, seamIn: lin?.seamIn ?? null, seamOut: lin?.seamOut ?? null });
      }
      return { jobId, take };
    });
    // Oldest take first: the legacy derivation replays history in this order, and a map keyed by
    // job order would hand it the wrong one.
    const nOf = (t) => Number(/^t(\d+)$/.exec(t)?.[1] ?? 0);
    const takes = [...byTake.entries()].sort((a, b) => nOf(a[0]) - nOf(b[0])).map(([take, jobs]) => ({ take, jobs }));
    return { runId, takes, cut };
  }

  /** The model registry's caps for a backend, or null when the run names one we no longer know. */
  const capsOf = (backend) => { try { return capsFor(normalizeBackend(backend).id); } catch { return null; } };

  /** Write a full-composition render.json into takeDir: every spec job's newest clip, in order. */
  function composeCut(runId, takeDir) {
    const dir = dirFor(runId);
    const spec = readJson(path.join(dir, 'spec.json'));
    const m = readManifest(dir);
    if (!spec || !m?.jobClips) return;
    // Each clip carries its OWN seams into the composition, read from the take it was rendered in
    // (cached per take dir — a composition of N jobs usually spans one or two takes). Dropping them
    // here is what made every mixed cut indistinguishable from an intact chain.
    const takeJobs = new Map();
    const seamsFor = (jobId, clip) => {
      const takeId = takeOfClip(clip);
      const takeDirOf = clip ? path.dirname(path.dirname(String(clip))) : null;
      if (takeDirOf && !takeJobs.has(takeDirOf)) {
        const rj = readJson(path.join(takeDirOf, 'render.json'));
        takeJobs.set(takeDirOf, new Map((rj?.jobs ?? []).map((rec) => [rec.jobId ?? rec.job, rec])));
      }
      const rec = takeDirOf ? takeJobs.get(takeDirOf)?.get(jobId) : null;
      // The manifest's own record is the fallback for a take whose render.json is gone or predates
      // the composition (the CLI writes it before the web layer ever sees the take).
      const fb = m.clipLineage?.[jobId];
      return {
        take: takeId ?? fb?.take ?? null,
        seamIn: rec?.seamIn ?? (fb?.take === takeId ? fb?.seamIn : null) ?? null,
        seamOut: rec?.seamOut ?? (fb?.take === takeId ? fb?.seamOut : null) ?? null,
      };
    };
    const jobs = (spec.kling?.jobs ?? []).map((j) => {
      const clip = m.jobClips[j.job_id] ?? null;
      return { jobId: j.job_id, clip, ...seamsFor(j.job_id, clip) };
    });
    const existing = readJson(path.join(takeDir, 'render.json')) ?? {};
    // Composition BREAKS the run-wide seam lineage: these clips come from different takes, so a
    // downstream clip may have been chained to the OLD take of the job before it (that is what the
    // cascade warning is about). Inheriting `chained: true` from the take we are overwriting would
    // tell the seamless stitcher to drop a real frame at what is now a genuine cut, so it is
    // cleared, not spread. The per-JOINT truth now lives in each job's seamIn/seamOut above —
    // `chained` stays only so readers written before those fields keep behaving exactly as they did.
    fs.writeFileSync(path.join(takeDir, 'render.json'), JSON.stringify({ ...existing, project: spec.project?.title, composed: true, chained: false, jobs }, null, 2) + '\n');
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

  function enqueueAssemble(runId, fromDir, { upscale = false, suffix, upscaleProvider = null } = {}) {
    const dir = dirFor(runId);
    const spec = readJson(path.join(dir, 'spec.json'));
    return mgr.enqueue({
      runId, lane: upscale ? 'spend' : 'free', kind: upscale ? 'upscale' : 'assemble',
      script: CLI(root, 'assemble.js'),
      args: ['--from', fromDir, '--out-name', outNameFor(runId, spec, suffix ?? (upscale ? 'final' : null)), ...(upscale ? ['--upscale'] : [])],
      // An explicit reviewer pick rides as UPSCALE_PROVIDER for THIS child only — an env var
      // already present is never overwritten by the child's dotenv, so the pick cannot be
      // out-resolved by .env or 'auto'. No pick injects nothing: the child derives exactly as before.
      env: { ...env(runId), ...(upscale && upscaleProvider ? { UPSCALE_PROVIDER: upscaleProvider } : {}) }, cwd: root,
    });
  }

  function enqueueRenderJob(runId, { jobId, takeDir, seamFrom, firstFrameFrom, lastFrameFrom, feedback, take, promptOverrides }) {
    const dir = dirFor(runId);
    return mgr.enqueue({
      runId, lane: 'spend', kind: 'render-job',
      script: CLI(root, 'render-job.js'),
      args: [
        '--spec', path.join(dir, 'spec.json'), '--job', jobId, '--out', takeDir,
        // --seam-from names the take the opening frame came off (that is what makes the joint
        // readable afterwards); --first-frame-from names the frame itself, so the boundary the user
        // chose is honoured however the chaining default is configured.
        ...(seamFrom ? ['--seam-from', seamFrom] : []),
        ...(firstFrameFrom ? ['--first-frame-from', firstFrameFrom] : []),
        ...(lastFrameFrom ? ['--last-frame-from', lastFrameFrom] : []),
        ...(feedback ? ['--feedback', feedback] : []),
        ...(take ? ['--take', String(take)] : []),
        ...(promptOverrides ? ['--prompt-overrides', promptOverrides] : []),
      ],
      env: env(runId), cwd: root,
    });
  }

  // ── Prompt overrides (WS2-P4) ──────────────────────────────────────────────
  // The sidecar lives at the RUN root so it survives a revise (which rewrites spec.json). A take is
  // immutable, so each one gets its OWN copy at enqueue: months later, "what did we send for t3?"
  // is answerable from t3 alone.

  const OVERRIDES_FILE = 'prompt-overrides.json';
  /** How many prompt-edit/discard rows the History panel keeps (the newest ones). */
  const PROMPT_HISTORY_MAX = 20;

  /**
   * Snapshot the run's prompt overrides into a reserved take dir.
   *
   * A sidecar that EXISTS but cannot be read or copied refuses the render (409). Degrading to the
   * agents' text would spend the user's money rendering words they replaced, and label the take
   * `promptSource:'plan'` — silently ignoring an edit is the one failure a user cannot see in the
   * output, which is exactly what src/lib/prompt-overrides.js exists to prevent on the CLI path.
   * No sidecar at all is not a failure: that run simply renders the plan.
   *
   * @param {string} dir  the run dir
   * @param {string} takeDir  the take reserved for this render
   * @param {string[]} jobIds  the jobs this render will actually submit
   * @returns {{args:string[], promptSource:'plan'|'override'}} the CLI flag, and whose words the
   *   take is rendering — recorded on the take so a past render explains itself.
   */
  /** Run `fn` against an already-reserved take dir, releasing the reservation if it throws — a take
   *  number must not be burned by a render that never got as far as the queue. */
  function reserved(takeDir, fn) {
    try {
      return fn();
    } catch (e) {
      fs.rmSync(takeDir, { recursive: true, force: true });
      throw e;
    }
  }

  function snapshotPromptOverrides(dir, takeDir, jobIds) {
    const src = path.join(dir, OVERRIDES_FILE);
    if (!fs.existsSync(src)) return { args: [], promptSource: 'plan' };
    const unusable = (why) => Object.assign(new Error(`this run's saved prompt edits are unusable (${why})`), {
      statusCode: 409, hint: 'discard the edited prompt (or fix prompt-overrides.json) — rendering the plan instead would spend money on words you replaced',
    });
    let jobs;
    try { jobs = JSON.parse(fs.readFileSync(src, 'utf8'))?.jobs; } catch { throw unusable(`${OVERRIDES_FILE} is not readable JSON`); }
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) throw unusable(`${OVERRIDES_FILE} has no jobs object`);
    const dest = path.join(takeDir, OVERRIDES_FILE);
    try { fs.copyFileSync(src, dest); } catch (e) { throw unusable(`it could not be snapshotted into the take — ${String(e?.message ?? e).slice(0, 80)}`); }
    // 'override' only when an edit really reaches one of the jobs being rendered — a sidecar that
    // only holds K1's edit must not label a K2-only re-render as edited.
    return { args: ['--prompt-overrides', dest], promptSource: jobIds.some((id) => jobs[id]) ? 'override' : 'plan' };
  }

  /**
   * Tell every open tab that a prompt edit landed. Free and local — no render, no spend — so this
   * broadcasts a fact, never a cost. It also files the edit as takes-adjacent lineage: the words a
   * render is about to send changed, which is exactly what the History panel exists to show, and
   * `takes[].promptSource` only says a take DID render an override, never when the decision was
   * made. Best effort on purpose — a CLI-created run has no manifest, and the edit is already
   * saved by the time we get here, so failing to note it must never fail the edit.
   */
  function promptOverrideChanged(runId, { jobId, action, source, stale = false }) {
    const kind = action === 'discarded' ? 'prompt-discard' : 'prompt-edit';
    try {
      updateManifest(dirFor(runId), (m) => {
        m.history = Array.isArray(m.history) ? m.history : [];
        // Ids stay unique across a compaction by counting from the highest one still present, never
        // from how many rows survive.
        const nth = m.history.reduce((n, h) => (h?.kind === kind ? Math.max(n, Number(/-(\d+)$/.exec(h.id ?? '')?.[1] ?? 0)) : n), 0) + 1;
        m.history.push({ id: `${kind}-${nth}`, kind, job: jobId, at: now().toISOString() });
        // A prompt edit is free and iterative — someone tuning one segment can save it fifty times,
        // and every row would then ride the manifest AND every detail payload forever. Only the
        // newest PROMPT_HISTORY_MAX edit rows are kept; reopens/takes/cuts are lifecycle facts and
        // are never compacted.
        const edits = m.history.filter((h) => h?.kind === 'prompt-edit' || h?.kind === 'prompt-discard');
        if (edits.length > PROMPT_HISTORY_MAX) {
          const drop = new Set(edits.slice(0, edits.length - PROMPT_HISTORY_MAX));
          m.history = m.history.filter((h) => !drop.has(h));
        }
        return m;
      });
    } catch { /* no manifest (a CLI run) — the event below is still the fact that matters */ }
    bus.emit(runId, { type: 'prompt-override', jobId, action, source, stale: !!stale });
  }

  // ── Public API (what the routes call) ────────────────────────────────────

  function createRun({ idea, backend, aspect, resolution = null, durationS, cast = [], environment = null }) {
    const stamp = now().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const runId = `web-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = dirFor(runId);
    fs.mkdirSync(dir, { recursive: true });
    // `resolution` (a per-run pick, or null = the configured default) is persisted BEFORE the
    // enqueue below: env(runId) reads it back off the manifest to build the plan child's knob.
    writeManifest(dir, newManifest({ idea, backend, aspect, resolution, durationS, cast, environment }, now().toISOString()));
    const queued = mgr.enqueue({
      runId, lane: 'plan', kind: 'plan',
      script: CLI(root, 'engine.js'),
      args: ['--brief', idea, '--out', dir, '--backend', backend, '--aspect', aspect,
        ...(durationS ? ['--duration', String(durationS)] : []),
        ...(cast.length ? ['--cast', cast.join(',')] : []),
        ...(environment ? ['--environment', environment] : [])],
      env: env(runId), cwd: root,
    });
    return { runId, queued };
  }

  /** Re-run the engine on an existing run (recovery after a failed/interrupted plan). LLM cost, no render. */
  function plan(runId) {
    // Guarded exactly like revise(): replanning both SPENDS (a full engine pass) and rewrites
    // spec.json under a file the user already has — the strongest form of "rewrites the plan behind
    // a delivered final", since the prompt views, the lineage and the finals history would all then
    // describe a plan the delivered video was never made from.
    assertNotFinalized(runId);
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
        ...(m.cast?.length ? ['--cast', m.cast.join(',')] : []),
        ...(m.environment ? ['--environment', m.environment] : [])],
      env: env(runId), cwd: root,
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

  /**
   * A DELIVERED run does no more work until it is deliberately reopened (WS2-P6). The UI hides the
   * spend buttons after an approval, but that is presentation: a stale tab, a second browser or a
   * curl still reach these endpoints, and every one of them either spends money or rewrites the
   * plan behind a file the user already has. Ordered BEFORE assertNoSpendInFlight everywhere,
   * because a finalized run has no in-flight spend to report — "reopen it" is the honest answer.
   */
  function assertNotFinalized(runId) {
    const final = finalizedFinal(readManifest(dirFor(runId)));
    if (final && fs.existsSync(final)) {
      throw Object.assign(new Error('this run is finalized — its final file is delivered'), {
        statusCode: 409, hint: 'reopen this run to make changes (the delivered file stays on disk)',
      });
    }
  }

  /**
   * Reopen a delivered run so it can be changed again. Nothing is deleted and nothing is unlinked:
   * `approved` (and the file it points at) stays exactly where it is until a new approval supersedes
   * it — only `reopenedAt` moves, and that is what returns the run to review and lifts the guard.
   */
  function reopen(runId) {
    const dir = dirFor(runId);
    const m = readManifest(dir);
    if (!m) throw Object.assign(new Error('not a web run'), { statusCode: 409, hint: 'CLI-created runs are driven from the terminal' });
    // An upscale is the paid tail of an approval, still writing the file being delivered — reopening
    // mid-flight would strand it. Any other paid lane job gets the same refusal for the same reason.
    const spend = liveJobsFor(runId).find((j) => j.lane === 'spend');
    if (spend) {
      throw Object.assign(new Error(`a paid ${spend.kind} is still ${spend.startedAt ? 'running' : 'queued'} for this run — reopening now would strand it`), {
        statusCode: 409, hint: 'wait for it to finish (or cancel it), then reopen',
      });
    }
    const final = finalizedFinal(m);
    if (!final) {
      throw Object.assign(
        new Error(m.approved ? 'this run is already open for changes' : 'this run was never finalized'),
        { statusCode: 409, hint: m.approved ? 'nothing is locked — render, revise or re-render as usual' : 'reopening is for delivered runs; approve a cut first' },
      );
    }
    const at = now().toISOString();
    updateManifest(dir, (mm) => {
      mm.reopenedAt = at;
      // takes-adjacent lifecycle marker, for the History panel to list beside takes/cuts/revisions
      mm.history = Array.isArray(mm.history) ? mm.history : [];
      mm.history.push({ id: `reopen-${mm.history.filter((h) => h?.kind === 'reopen').length + 1}`, kind: 'reopen', final, at });
      mm.lastError = null;
      return mm;
    });
    emitStatus(runId);
    return { reopenedAt: at, final };
  }

  /**
   * Record a delivery in `finals` and make it the current `approved`. The history is append-only:
   * the entry it supersedes keeps its own file path and gains `replacedBy`, so "where did the first
   * final go?" is always answerable — nothing on disk is touched. An approval recorded before
   * `finals` existed is backfilled here, the one moment we know it is about to be superseded.
   */
  function recordFinal(m, approved) {
    m.finals = Array.isArray(m.finals) ? m.finals : [];
    const entry = (rec) => ({ id: `final-${m.finals.length + 1}`, cut: rec.cut ?? null, final: rec.final, upscaled: !!rec.upscaled, at: rec.at ?? null });
    const prev = m.approved;
    if (prev?.final && !m.finals.some((f) => f.final === prev.final && f.at === prev.at)) m.finals.push(entry(prev));
    // A delivery with no file is a broken approval, not a delivery — it replaces nothing and is not
    // history (`approved` still records it, exactly as it did before this existed).
    if (approved.final) {
      const superseded = m.finals.at(-1);
      const row = entry(approved);
      if (superseded) superseded.replacedBy = row.id;
      m.finals.push(row);
    }
    m.approved = approved;
    return m;
  }

  function render(runId, { mode }) {
    assertNotFinalized(runId);
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
    const m0 = readManifest(dir);
    const backend = m0?.backend ?? 'kling';
    const est = estimateRender(spec, { backend, mode, ...estOpts(backend, m0?.resolution) });
    const specJobs = (spec.kling?.jobs ?? []).map((j) => j.job_id);
    // a probe renders only the FIRST job, so only its edit can be in play
    const overrides = reserved(takeDir, () => snapshotPromptOverrides(dir, takeDir, mode === 'probe' ? specJobs.slice(0, 1) : specJobs));
    updateManifest(dir, (m) => {
      m.takes.push({ id: takeId, mode, revision: m.revisions.at(-1)?.id ?? null, createdAt: now().toISOString(), estUsd: est.totalUsd, promptSource: overrides.promptSource });
      m.costLedger.push({ ts: now().toISOString(), action: mode, ...ledgerLine(est) });
      m.lastError = null;
      return m;
    });
    const queued = mgr.enqueue({
      runId, lane: 'spend', kind: mode === 'probe' ? 'probe' : 'render',
      script: CLI(root, 'render.js'),
      args: ['--spec', path.join(dir, 'spec.json'), '--out', takeDir, '--out-name', outNameFor(runId, spec, takeId),
        ...(mode === 'probe' ? ['--probe'] : []), ...overrides.args],
      env: env(runId), cwd: root,
    });
    emitStatus(runId); // the page flips to 'rendering' NOW — queued work must never look like nothing happened
    return { takeId, queued, estUsd: est.totalUsd };
  }

  function revise(runId, { feedback, scope }) {
    assertNotFinalized(runId);
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
      env: env(runId), cwd: root,
    });
    emitStatus(runId); // page flips to 'planning' NOW, even when queued behind another revision
    return { revisionId: path.basename(revDir), queued };
  }

  // Recovery for a content-policy flag: revise the existing plan with the canned benign-rewording +
  // Seedance-guidance feedback (the "Revise to pass content check" button). LLM only, no render spend.
  function reviseForContentPolicy(runId) {
    return revise(runId, { feedback: CONTENT_POLICY_REVISE_FEEDBACK });
  }

  function rerenderJob(runId, { jobId, cascade = false, feedback, take, boundaries = 'auto' }) {
    assertNotFinalized(runId);
    const dir = dirFor(runId);
    const spec = readJson(path.join(dir, 'spec.json'));
    if (!spec) throw Object.assign(new Error('this run has no plan yet'), { statusCode: 409, hint: 'plan before rendering' });
    const jobs = (spec.kling?.jobs ?? []).map((j) => j.job_id);
    if (!jobs.includes(jobId)) throw Object.assign(new Error(`job "${jobId}" is not in this plan`), { statusCode: 400, hint: `jobs: ${jobs.join(', ')}` });
    const mode = boundaries ?? 'auto';
    if (!BOUNDARY_MODES.includes(mode)) {
      throw Object.assign(new Error(`"${mode}" is not a boundary plan`), { statusCode: 400, hint: `boundaries: ${BOUNDARY_MODES.join(', ')}` });
    }
    assertNoSpendInFlight(runId);
    const m = readManifest(dir);
    const takeDir = nextTakeDir(dir);
    const takeId = path.basename(takeDir);
    fs.mkdirSync(takeDir, { recursive: true });
    const downstream = jobs.slice(jobs.indexOf(jobId) + 1);
    const cascadeJobs = cascade ? downstream : [];
    const backend = m?.backend ?? 'kling';
    const est = estimateRender(spec, { backend, mode: 'job', jobId, cascade, ...estOpts(backend, m?.resolution) });

    // WS2-P5 — which boundaries this take pins, decided by the pure rule over the cut as it stands.
    // The take is one chain: its OPENING pin belongs to the first job rendered, its CLOSING pin to
    // the last, because every job in between has both ends defined by its cascade neighbours.
    const lastRendered = cascadeJobs.at(-1) ?? jobId;
    const lineage = computeLineage(cutRecordFor(runId, m, jobs));
    const planFor = (id) => resolveBoundaries({
      jobIds: jobs, jobId: id, continuity: lineage, mode,
      caps: capsOf(backend), castRefCount: castRefCountFor(spec, id),
    });
    const opening = planFor(jobId);
    const closing = lastRendered === jobId ? opening : planFor(lastRendered);

    // Seam-in: renderJob wants <seamFrom>/<prevJob>/last_frame.png. The trustworthy source is the
    // take dir that produced the PREVIOUS job's newest clip (manifest.jobClips) — the latest cut's
    // dir may be a composed cut or a single-job take that never held the neighbour's frame.
    const prevJobId = opening.start ? opening.start.from?.jobId ?? jobs[jobs.indexOf(jobId) - 1] : null;
    const prevClip = prevJobId ? m?.jobClips?.[prevJobId] : null;
    let seamFrom;
    if (prevClip && fs.existsSync(path.join(path.dirname(prevClip), 'last_frame.png'))) {
      seamFrom = path.dirname(path.dirname(prevClip)); // <takeDir>/<prevJob>/clip.mp4 → <takeDir>
    } else if (prevJobId && m?.cuts?.at(-1)?.take) {
      seamFrom = path.join(dir, 'renders', m.cuts.at(-1).take);
    }
    const openingFrame = seamFrom && prevJobId ? path.join(seamFrom, prevJobId, 'last_frame.png') : null;
    const firstFrameFrom = openingFrame && fs.existsSync(openingFrame) ? openingFrame : undefined;
    // Seam-out: the NEXT segment's own clip, handed to the child as a CLIP — grabbing its opening
    // frame is the renderer's job (one implementation of that grab, and it is the one that already
    // knows which end of a neighbour a closing pin wants).
    const nextClip = closing.end ? m?.jobClips?.[closing.end.to?.jobId] : null;
    const lastFrameFrom = nextClip && fs.existsSync(nextClip) ? nextClip : undefined;

    // Every job this take will render — the cascade jobs land in the SAME take dir, so they read the
    // same snapshot (that is why it is taken once, here, and not per enqueue).
    const overrides = reserved(takeDir, () => snapshotPromptOverrides(dir, takeDir, [jobId, ...cascadeJobs]));
    updateManifest(dir, (mm) => {
      mm.takes.push({ id: takeId, mode: 'job', jobId, cascade, revision: mm.revisions.at(-1)?.id ?? null, createdAt: now().toISOString(), estUsd: est.totalUsd, feedback: feedback ?? null, promptSource: overrides.promptSource });
      mm.costLedger.push({ ts: now().toISOString(), action: `rerender ${jobId}${cascade ? ' + downstream' : ''}`, ...ledgerLine(est) });
      mm.lastError = null;
      return mm;
    });
    if (cascadeJobs.length) pendingCascade.set(runId, { takeDir, takeId, jobs: [...cascadeJobs], feedback, take, promptOverrides: overrides.args[1] ?? null, lastFrameFrom });
    const queued = enqueueRenderJob(runId, {
      jobId, takeDir, seamFrom, firstFrameFrom,
      lastFrameFrom: cascadeJobs.length ? undefined : lastFrameFrom, // the last cascade job gets it
      feedback, take, promptOverrides: overrides.args[1] ?? null,
    });
    emitStatus(runId);
    // What was actually pinned, not what was asked for: a boundary whose frame is not on disk is
    // reported as unpinned, so the dialog never claims a join this take will not have.
    const applied = {
      mode,
      start: seamFrom ? opening.start : null,
      end: lastFrameFrom ? closing.end : null,
      startMode: seamFrom ? opening.startMode : 'none',
      endMode: lastFrameFrom ? closing.endMode : 'none',
    };
    return { takeId, queued, estUsd: est.totalUsd, cascadeJobs, boundaries: applied };
  }

  function assemble(runId, { composition } = {}) {
    assertNotFinalized(runId);
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

  function approve(runId, { upscale = false, cut, provider = null } = {}) {
    const dir = dirFor(runId);
    const run = scanRun(dir, { isAlive });
    // Never approve while paid work runs: finalizing an older cut would mark the run complete and
    // hide the re-render/upscale the reviewer is still paying for (this covers the plain path too,
    // not just the upscale enqueue below).
    assertNoSpendInFlight(runId);
    // The upscale-provider pick is validated whenever present — junk on a free approve is still a
    // caller bug worth a 400, never a silent fallback onto whichever vendor the env resolves.
    if (provider != null && provider !== 'fal' && provider !== 'segmind') {
      throw Object.assign(new Error(`"${provider}" is not an upscale provider`), { statusCode: 400, hint: 'provider is fal or segmind' });
    }
    // The user finalizes the cut they previewed. `cut` is optional: omitted ⇒ latest (today's
    // behavior, byte-for-byte). Each cut's take dir holds that cut's own immutable composed
    // render.json, so upscaling `renders/<cut.take>/` reproduces exactly that cut; a plain
    // finalize points at the cut's existing master. `cut` is only ever compared in a .find() —
    // never used to build a path (that comes from chosen.take) — so there is no traversal risk.
    const m0 = readManifest(dir);
    const cuts = m0?.cuts ?? [];
    if (cut != null && !/^c\d{1,4}$/.test(String(cut))) {
      throw Object.assign(new Error(`"${cut}" is not a cut id`), { statusCode: 400, hint: 'cut ids look like c1, c2, …' });
    }
    const chosen = cut ? cuts.find((c) => c.id === cut) : null;
    if (cut && !chosen) {
      throw Object.assign(new Error(`cut "${cut}" not found`), { statusCode: 400, hint: 'pick a cut shown in review' });
    }
    const fromDir = chosen?.take ? path.join(dir, 'renders', chosen.take) : run.latestRender?.dir;
    const master = chosen?.master ?? run.latestRender?.master;
    const masterExists = chosen ? !!(chosen.master && fs.existsSync(chosen.master)) : !!run.latestRender?.masterExists;
    if (!master || !masterExists) {
      throw Object.assign(new Error('nothing to approve — no assembled master exists'), { statusCode: 409, hint: 'render and let the stitch finish first (assemble is free)' });
    }
    if (!upscale) {
      const m = updateManifest(dir, (mm) => recordFinal(mm, {
        cut: chosen?.id ?? mm.cuts.at(-1)?.id ?? null, final: master, upscaled: false, at: now().toISOString(),
      }));
      emitStatus(runId);
      return { final: m.approved.final, queued: null };
    }
    const spec = readJson(path.join(dir, 'spec.json'));
    // snapshot the cut this upscale delivers NOW: for the default (no cut) that's today's latest cut —
    // a free-lane assemble appending a newer cut mid-upscale must not relabel THIS final onto it.
    pendingApprove.set(runId, chosen?.id ?? cuts.at(-1)?.id ?? null);
    updateManifest(dir, (m) => {
      // `unpriced` is reserved for a provider with NO published rate. fal and Segmind both publish
      // a Topaz rate (the estimate endpoint quotes either per-clip), so flagging one would label a
      // priced spend "not on file". ASK the estimator which it is — with no clips it answers from
      // the rate row alone — rather than naming providers here, or this line goes stale the next
      // time a rate lands in prices.json.
      // A provider with no row AT ALL throws in there; that is still "no rate we can quote", and an
      // approve already past its checks must not die over a ledger note.
      // An explicit reviewer pick (validated above) beats the env derivation — it is the vendor the
      // finalize child is pinned to below, so the line records (and prices) who actually bills.
      const upscaleProvider = provider ?? readUpscaleProvider(envRoot ?? root, m.backend, childEnv);
      let unpricedUpscale = true;
      try { unpricedUpscale = Boolean(estimateUpscale([], { provider: upscaleProvider }).unknownPrice); } catch { /* unpriced */ }
      m.costLedger.push(unpricedUpscale
        ? { ts: now().toISOString(), action: 'upscale', estUsd: null, unpriced: true, provider: upscaleProvider, note: 'estimate unavailable — no published rate for this provider' }
        : { ts: now().toISOString(), action: 'upscale', estUsd: null, provider: upscaleProvider, note: 'topaz per-clip — see estimate' });
      m.lastError = null;
      return m;
    });
    return { final: null, queued: enqueueAssemble(runId, fromDir, { upscale: true, suffix: 'final', upscaleProvider: provider }), spec: !!spec };
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
    onEvent, createRun, plan, render, revise, reviseForContentPolicy, rerenderJob, assemble, approve, reopen, cancel, dismissError, detail,
    promptOverrideChanged,
    list: () => listRuns(runsDir, { isAlive }).map(withLiveStatus),
    ringFor, dirFor,
    /** Boot-time reconciliation: interrupted runs become visible without any event. */
    recover() { for (const run of listRuns(runsDir, { isAlive })) if (run.status === 'attention' && run.error?.message?.includes('interrupted')) bus.emit('*', { type: 'run-status', runId: run.id, status: 'attention' }); },
  };
}

export default { createRunService };
