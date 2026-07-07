// Run CRUD + read models. Every absolute artifact path is translated to a same-origin media URL
// before it leaves the server — the client never sees filesystem paths except for display
// ("Reveal"/"Copy path" use `fsPath` fields explicitly).
import fs from 'node:fs';
import path from 'node:path';
import { isRunId, safeChild } from '../lib/paths.js';
import { estimateRender, estimateUpscale, jobSeconds, readSeedanceResolution } from '../lib/estimator.js';

const SPEC_FILE_RE = /^(revisions\/r\d+\/)?spec[-\w]*\.json$/;

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
    const { idea, backend = 'kling', aspect = '9:16', durationS = null, cast = [] } = req.body ?? {};
    if (!idea || !String(idea).trim()) throw Object.assign(new Error('idea is required'), { statusCode: 400, hint: 'one line is enough — the engine does the rest' });
    if (!['kling', 'seedance'].includes(backend)) throw Object.assign(new Error(`unknown backend "${backend}"`), { statusCode: 400, hint: 'use kling or seedance' });
    if (!['9:16', '16:9', '1:1'].includes(aspect)) throw Object.assign(new Error(`unknown aspect "${aspect}"`), { statusCode: 400, hint: 'use 9:16, 16:9 or 1:1' });
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
    const r = svc.createRun({ idea: String(idea).trim(), backend, aspect, durationS, cast: cast.map((c) => c.trim()) });
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

  app.get('/api/runs/:id/estimate', async (req, reply) => {
    const run = load(req.params.id);
    if (!run) return notFound(reply);
    if (!run.spec) throw Object.assign(new Error('no plan yet'), { statusCode: 409, hint: 'estimates come from the plan — wait for planning to finish' });
    const mode = String(req.query.mode ?? 'full');
    if (mode === 'upscale') {
      const clips = (run.spec.kling?.jobs ?? []).map((j) => ({ jobId: j.job_id, seconds: jobSeconds(run.spec, j.job_id) }));
      return estimateUpscale(clips);
    }
    return estimateRender(run.spec, {
      backend: run.backend ?? 'kling',
      mode,
      jobId: req.query.jobId,
      cascade: req.query.cascade === '1' || req.query.cascade === 'true',
      // Seedance is billed by pixel-seconds — price the resolution the render child will use
      resolution: readSeedanceResolution(app.ctx.envRoot),
    });
  });

  // internal helper other routes reuse
  app.decorate('serializeRun', serializeRun);
}

export default { registerRunRoutes };
