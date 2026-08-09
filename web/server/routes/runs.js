// Run CRUD + read models. Every absolute artifact path is translated to a same-origin media URL
// before it leaves the server — the client never sees filesystem paths except for display
// ("Reveal"/"Copy path" use `fsPath` fields explicitly).
import fs from 'node:fs';
import path from 'node:path';
import { isRunId, safeChild } from '../lib/paths.js';
import { estimateRender, estimateUpscale, jobSeconds, readProbeResolution, readRenderResolution, readUpscaleProvider, readUpscaleTargetShortSide } from '../lib/estimator.js';
// The registry is the ONE static import this server takes from the host src/ tree. It is safe
// precisely because it has zero imports and reads no env (test/unit/render-models.test.js pins
// that), so it cannot drag config.js — and a developer's real .env — into web/server's static
// graph. The canary in test/integration/runs-caps.test.js walks this graph and enforces it.
import { normalizeBackend, capsFor, castLimitFor, ALL_BACKENDS } from '../../../src/lib/render-models.js';
// The continuity rule (WS2-P2) is a pure function over a run record — no fs, no config — so it is
// safe in this static graph; everything filesystem-shaped stays in this file.
import { computeLineage, serializeContinuity } from '../lib/lineage.js';

const SPEC_FILE_RE = /^(revisions\/r\d+\/)?spec[-\w]*\.json$/;
const TAKE_DIR_RE = /^t\d+$/;

const readJsonFile = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** renders/<take>/<job>/clip.mp4 → '<take>'. A job's newest clip may sit in an OLDER take than the
 *  one composing the cut — the path is the only record of which, and only the id ever leaves here. */
const takeIdOfClip = (clip) => (clip ? path.basename(path.dirname(path.dirname(String(clip)))) : null);

/** Every take of a run, oldest first, each holding only the jobs really RENDERED into it: a composed
 *  cut lists clips from older takes too, and indexing those under the composing take would invent a
 *  chain that never existed. `wanted` (a set of take ids) trims the disk reads to the takes the cut
 *  actually names; the legacy derivation replays the WHOLE history, so it asks for all of them. */
function takesOf(runDir, cutDir, wanted = null) {
  let dirs = [];
  try {
    const rendersRoot = path.join(runDir, 'renders');
    dirs = fs.readdirSync(rendersRoot)
      .filter((n) => TAKE_DIR_RE.test(n) && (!wanted || wanted.has(n)))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((n) => path.join(rendersRoot, n));
  } catch { /* a CLI run keeps its one take beside the spec */ }
  if (!dirs.length && cutDir) dirs = [cutDir];
  return dirs.map((d) => {
    const id = path.basename(d);
    const jobs = (readJsonFile(path.join(d, 'render.json'))?.jobs ?? [])
      .filter((j) => (takeIdOfClip(j.clip) ?? id) === id)
      .map((j) => ({
        jobId: j.jobId ?? j.job ?? null,
        clip: j.clip ?? null,
        seamIn: j.seamIn ?? null,
        seamOut: j.seamOut ?? null,
        // present only on records that carry it — the legacy derivation asks whether the field
        // EXISTS before trusting its value
        ...(Object.hasOwn(j, 'startFrame') ? { startFrame: j.startFrame } : {}),
      }));
    return { take: id, jobs };
  });
}

/**
 * Per-segment continuity for the cut the review page is showing (the newest completed take — a take
 * still rendering has no render.json and honestly answers null). Ids only: `serializeContinuity`
 * strips paths and nothing here may add one back.
 * @returns {ReturnType<typeof serializeContinuity>['segments'] | null}
 */
function continuityOf(run) {
  const cutDir = run?.latestRender?.dir;
  if (!cutDir || !run?.dir) return null;
  try {
    const cut = readJsonFile(path.join(cutDir, 'render.json'));
    if (!Array.isArray(cut?.jobs) || !cut.jobs.length) return null;
    const cutTake = path.basename(cutDir);
    const entries = cut.jobs.map((j) => {
      const jobId = j.jobId ?? j.job ?? null;
      // Which take this clip came out of: its own path first (the only record a composition cannot
      // lose), then what the composer wrote, then the manifest's lineage index, and only as a last
      // resort the take doing the composing.
      return { jobId, take: takeIdOfClip(j.clip) ?? j.take ?? run.manifest?.clipLineage?.[jobId]?.take ?? cutTake };
    });
    // A cut whose every clip carries a recorded seam is answered from the takes it names; one that
    // doesn't is a pre-WS2 run, and its derivation replays the full take history.
    const recorded = cut.jobs.every((j) => j.seamIn && typeof j.seamIn === 'object');
    const record = {
      runId: run.id,
      chained: cut.chained, // tri-state on purpose: absent ≠ false for the legacy derivation
      takes: takesOf(run.dir, cutDir, recorded ? new Set(entries.map((e) => e.take)) : null),
      cut: entries,
    };
    return serializeContinuity(computeLineage(record)).segments;
  } catch {
    return null; // a badge is never worth failing the run page over
  }
}

// Mirror the engine's slug() (src/lib/util.js): the run guard must resolve an environment exactly as
// the engine will — a display name ("Neon City") resolves like the CLI would, and a traversal-shaped
// value ("../foo") collapses to a harmless token that is rejected here (before any LLM spend) instead
// of surfacing mid-plan with a half-written run.
const toSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const dirSize = (dir) => {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { bytes += fs.statSync(p).size; } catch { /* raced */ } }
    }
  };
  try { walk(dir); } catch { /* gone */ }
  return bytes;
};

export function registerRunRoutes(app) {
  const { svc, runsDir, outDir, mgr } = app.ctx;

  const urlFor = (abs) => {
    if (!abs) return null;
    for (const [base, prefix] of [[runsDir, '/api/media/runs/'], [outDir, '/api/media/out/']]) {
      const rel = path.relative(base, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return prefix + rel.split(path.sep).map(encodeURIComponent).join('/');
    }
    return null;
  };

  const serializeRender = (lr) => lr && {
    ...lr,
    masterUrl: lr.masterExists ? urlFor(lr.master) : null,
    coverUrl: urlFor(lr.cover),
    jobs: lr.jobs.map((j) => ({ ...j, clipUrl: j.clipExists ? urlFor(j.clip) : null })),
  };

  const serializeRun = (run) => run && {
    ...run,
    dir: undefined,
    continuity: continuityOf(run),
    latestRender: serializeRender(run.latestRender),
    coverUrl: urlFor(run.cover),
    finalUrl: run.manifest?.approved?.final ? urlFor(run.manifest.approved.final) : null,
    finalFsPath: run.manifest?.approved?.final ?? null,
  };

  const load = (id) => {
    if (!isRunId(id)) return null;
    return svc.detail(id);
  };
  const notFound = (reply) => reply.code(404).send({ error: 'no such run', hint: 'it may have been deleted — check the library' });

  app.get('/api/runs', async () => ({ runs: svc.list().map(serializeRun) }));

  app.post('/api/runs', async (req, reply) => {
    const { idea, backend = 'kling', aspect = '9:16', durationS = null, cast = [], environment = null } = req.body ?? {};
    if (!idea || !String(idea).trim()) throw Object.assign(new Error('idea is required'), { statusCode: 400, hint: 'one line is enough — the engine does the rest' });
    // Backend, aspect and cast are all model-derived and all rejected HERE — synchronously, before
    // svc.createRun spawns the engine child — so a bad request leaves no run directory behind.
    let caps;
    let storedBackend;
    try {
      const be = normalizeBackend(backend);
      caps = capsFor(be.id);
      // Persist a MEMBER of ALL_BACKENDS, never the raw spelling: normalizeBackend tolerates
      // " seedance ", but a raw store would fail the estimator's exact price-table lookup AFTER
      // planning already spent money. The trimmed spelling wins when it is itself a member (legacy
      // manifests stay legacy); anything else stores the canonical id (priced via its $alias hop).
      const trimmed = typeof backend === 'string' ? backend.trim() : backend;
      storedBackend = ALL_BACKENDS.includes(trimmed) ? trimmed : be.id;
    } catch (e) {
      throw Object.assign(new Error(e.message), { statusCode: 400, hint: `accepted backends: ${ALL_BACKENDS.join(', ')}` });
    }
    // aspect ratios are per-model — 21:9 is a Seedance 2.5 ratio, not a Kling one
    if (!caps.aspects.includes(aspect)) {
      throw Object.assign(new Error(`unknown aspect "${aspect}" for ${caps.label}`), {
        statusCode: 400, hint: `${caps.label} renders ${caps.aspects.join(', ')}`,
      });
    }
    if (durationS !== null && (!Number.isInteger(durationS) || durationS < 3 || durationS > 120)) {
      throw Object.assign(new Error('durationS must be 3–120 seconds or null for auto'), { statusCode: 400, hint: 'null lets the engine choose from the story' });
    }
    if (!Array.isArray(cast) || cast.some((c) => typeof c !== 'string' || !c.trim())) {
      throw Object.assign(new Error('cast must be a list of character names'), { statusCode: 400, hint: 'the slugs from GET /api/cast/characters' });
    }
    // a starred character must exist NOW — the engine would reject it later, after queue time
    for (const c of cast) {
      if (!fs.existsSync(path.join(app.ctx.profilesDir, `${c.trim()}.md`))) {
        throw Object.assign(new Error(`unknown cast member "${c}"`), { statusCode: 400, hint: 'create the character on the Cast page first' });
      }
    }
    // Cast cap, layer 2 of 3 (engine / server / UI): each model takes only so many starred
    // characters, and an over-starred run can never render — so it is refused here rather than
    // paid for in planning. Mirrors the engine's message (src/lib/engine.js buildCtx).
    const castLimit = castLimitFor(caps.id);
    if (cast.length > castLimit) {
      const over = cast.length - castLimit;
      throw Object.assign(
        new Error(`${caps.label} supports at most ${castLimit} starred character${castLimit === 1 ? '' : 's'} — you selected ${cast.length} (${cast.join(', ')})`),
        { statusCode: 400, hint: `unstar ${over === 1 ? 'one' : over}, or pick a model with a higher cast limit` },
      );
    }
    // exactly one environment per idea (single-select) — if named it must exist NOW, before any LLM spend
    let environmentSlug = null;
    if (environment !== null && environment !== undefined) {
      if (typeof environment !== 'string' || !environment.trim()) {
        throw Object.assign(new Error('environment must be a single environment name'), { statusCode: 400, hint: 'the slug from GET /api/environments' });
      }
      // resolve exactly as the engine does — slug()-normalize, then slug-match against the dir's
      // *.md files (a hand-authored "Rain_City.md" answers to "rain-city", just like loadEnvironment)
      // — so the web guard accepts what the engine accepts and rejects traversal-shaped input up front
      environmentSlug = toSlug(environment);
      let envFiles = [];
      try { envFiles = fs.readdirSync(app.ctx.environmentsDir).filter((f) => f.endsWith('.md')); } catch { /* no dir yet */ }
      if (!environmentSlug || !envFiles.some((f) => toSlug(f.replace(/\.md$/, '')) === environmentSlug)) {
        throw Object.assign(new Error(`unknown environment "${environment}"`), { statusCode: 400, hint: 'create the environment on the Cast page first' });
      }
    }
    const r = svc.createRun({ idea: String(idea).trim(), backend: storedBackend, aspect, durationS, cast: cast.map((c) => c.trim()), environment: environmentSlug });
    return reply.code(201).send(r);
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const run = load(req.params.id);
    if (!run) return notFound(reply);
    return { run: serializeRun(run) };
  });

  app.delete('/api/runs/:id', async (req, reply) => {
    const run = load(req.params.id);
    if (!run) return notFound(reply);
    const busy = ['planning', 'rendering'].includes(run.status) || run.queue;
    if (busy) throw Object.assign(new Error('this run is active'), { statusCode: 409, hint: 'cancel it first, then delete' });
    const dir = safeChild(runsDir, req.params.id);
    const bytes = dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { deleted: true, bytes };
  });

  app.get('/api/runs/:id/spec', async (req, reply) => {
    const run = load(req.params.id);
    if (!run) return notFound(reply);
    const file = String(req.query.file ?? 'spec.json');
    if (!SPEC_FILE_RE.test(file)) throw Object.assign(new Error('not a spec artifact'), { statusCode: 400, hint: 'spec.json, spec-NN.json or revisions/rN/spec-*.json' });
    const p = safeChild(runsDir, req.params.id, file);
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'spec file not found', hint: 'it may not have been written yet' });
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  });

  app.get('/api/runs/:id/log', async (req, reply) => {
    if (!isRunId(req.params.id)) return notFound(reply);
    const ring = svc.ringFor(req.params.id);
    const lines = ring.since(Number(req.query.cursor) || 0);
    return { lines, nextCursor: ring.lastCursor };
  });

  // ── Prompt preview (WS2-P3) ───────────────────────────────────────────────────────────────────
  // The prompt service is LAZY-imported inside every handler, on purpose: it reaches into the host
  // src/ tree for the pure composer and reads the run's .env as data, and this route file's STATIC
  // import graph must stay config-free (test/integration/runs-caps.test.js walks it transitively).
  const promptArgs = (run) => ({
    root: app.ctx.root,
    envRoot: app.ctx.envRoot,
    childEnv: app.ctx.childEnv,
    runDir: run.dir,
    spec: run.spec,
    backend: run.backend,
    voicesDir: path.dirname(app.ctx.voicesFile),
  });
  const plannedRunOr409 = (id, reply) => {
    const run = load(id);
    if (!run) { notFound(reply); return null; }
    if (!run.spec) throw Object.assign(new Error('no plan yet'), { statusCode: 409, hint: 'prompts are composed from the plan — wait for planning to finish' });
    return run;
  };

  app.get('/api/runs/:id/prompts', async (req, reply) => {
    const run = plannedRunOr409(req.params.id, reply);
    if (!run) return reply;
    const { buildPromptViews } = await import('../lib/prompt-service.js');
    const { backend, jobs, prompts } = await buildPromptViews(promptArgs(run));
    // `orphaned` is always present (empty until P4's overrides sidecar can strand one) so the UI
    // never has to branch on its absence.
    return { runId: run.id, backend, jobs, prompts, orphaned: [] };
  });

  app.get('/api/runs/:id/prompt', async (req, reply) => {
    const run = plannedRunOr409(req.params.id, reply);
    if (!run) return reply;
    const jobId = String(req.query.job ?? '').trim();
    const jobIds = (run.spec.kling?.jobs ?? []).map((j) => j?.job_id).filter(Boolean);
    if (!jobId) throw Object.assign(new Error('job required'), { statusCode: 400, hint: `?job=<id> — this plan has: ${jobIds.join(', ')}` });
    const take = req.query.take ? String(req.query.take) : null;
    const { buildPromptView } = await import('../lib/prompt-service.js');
    const view = await buildPromptView({ ...promptArgs(run), jobId, take });
    if (!view) {
      // Both misses are "no such prompt": an unknown job, or a take that never sent one for it.
      // The hint carries the plan's job list so the caller can fix the query without a second round.
      return reply.code(404).send({
        error: take ? `take "${take}" has no prompt for job "${jobId}"` : `job "${jobId}" is not in this plan`,
        hint: `this plan has: ${jobIds.join(', ') || '(no jobs)'}`,
      });
    }
    return view;
  });

  app.get('/api/runs/:id/estimate', async (req, reply) => {
    const run = load(req.params.id);
    if (!run) return notFound(reply);
    if (!run.spec) throw Object.assign(new Error('no plan yet'), { statusCode: 409, hint: 'estimates come from the plan — wait for planning to finish' });
    const mode = String(req.query.mode ?? 'full');
    if (mode === 'upscale') {
      const cut = req.query.cut;
      // Topaz runs on either provider now — price the one this run's approve would actually bill,
      // and say what short side it will DELIVER (the UI's "already HD" gate rides on it).
      const upscaleOpts = { provider: readUpscaleProvider(app.ctx.envRoot, run.backend, app.ctx.childEnv) };
      const targetShortSide = readUpscaleTargetShortSide(app.ctx.envRoot, run.backend, app.ctx.childEnv);
      // no cut ⇒ the latest render (approve's default): price every job in the current spec
      if (!cut) {
        const clips = (run.spec.kling?.jobs ?? []).map((j) => ({ jobId: j.job_id, seconds: jobSeconds(run.spec, j.job_id) }));
        return { ...estimateUpscale(clips, upscaleOpts), targetShortSide };
      }
      // a specific cut upscales exactly the clips in ITS take dir, priced by THAT take's own saved
      // spec (a pre-revision cut may rename jobs or change durations) and only jobs that actually
      // produced a clip (finishRender skips clipless/failed jobs) — so the price matches Topaz's work.
      if (!/^c\d{1,4}$/.test(String(cut))) throw Object.assign(new Error(`"${cut}" is not a cut id`), { statusCode: 400, hint: 'cut ids look like c1, c2, …' });
      const chosen = (run.manifest?.cuts ?? []).find((c) => c.id === cut);
      if (!chosen) throw Object.assign(new Error(`cut "${cut}" not found`), { statusCode: 400, hint: 'pick a cut shown in review' });
      const readTakeJson = (name) => {
        const p = safeChild(runsDir, req.params.id, 'renders', String(chosen.take), name);
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
      };
      const takeSpec = readTakeJson('spec.json') ?? run.spec; // the spec the take was rendered from
      const clips = ((readTakeJson('render.json')?.jobs) ?? [])
        .filter((j) => j.clip) // only jobs Topaz will actually process
        .map((j) => { const jobId = j.jobId ?? j.job; return { jobId, seconds: jobSeconds(takeSpec, jobId) }; });
      return { ...estimateUpscale(clips, upscaleOpts), targetShortSide };
    }
    return estimateRender(run.spec, {
      backend: run.backend ?? 'kling',
      mode,
      jobId: req.query.jobId,
      cascade: req.query.cascade === '1' || req.query.cascade === 'true',
      // Seedance is billed by pixel-seconds — price the resolution the render child will use, and
      // that knob is per model (2.5 reads SEEDANCE25_RESOLUTION and defaults to 720p, not 480p)
      resolution: readRenderResolution(app.ctx.envRoot, run.backend, app.ctx.childEnv),
      probeResolution: readProbeResolution(app.ctx.envRoot, run.backend, app.ctx.childEnv),
    });
  });

  // internal helper other routes reuse
  app.decorate('serializeRun', serializeRun);
}

export default { registerRunRoutes };
