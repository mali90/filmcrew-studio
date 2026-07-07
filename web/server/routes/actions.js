// Run actions — thin HTTP shims over run-service. Money-bearing actions (render, rerender-job,
// approve+upscale) return 202 with the queue position; free actions run immediately.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { isRunId } from '../lib/paths.js';

export function registerActionRoutes(app) {
  const { svc } = app.ctx;

  const guard = (req) => {
    if (!isRunId(req.params.id)) throw Object.assign(new Error('no such run'), { statusCode: 404, hint: 'check the library' });
    const run = svc.detail(req.params.id);
    if (!run) throw Object.assign(new Error('no such run'), { statusCode: 404, hint: 'check the library' });
    return run;
  };

  app.post('/api/runs/:id/render', async (req, reply) => {
    guard(req);
    const mode = req.body?.mode === 'probe' ? 'probe' : 'full';
    const r = svc.render(req.params.id, { mode });
    return reply.code(202).send(r);
  });

  app.post('/api/runs/:id/revise', async (req, reply) => {
    guard(req);
    const { feedback, scope } = req.body ?? {};
    if (!feedback || !String(feedback).trim()) throw Object.assign(new Error('feedback is required'), { statusCode: 400, hint: 'say what should change — it re-runs the planning agents' });
    const r = svc.revise(req.params.id, { feedback: String(feedback).trim(), scope });
    return reply.code(202).send(r);
  });

  app.post('/api/runs/:id/rerender-job', async (req, reply) => {
    guard(req);
    const { jobId, cascade = false, feedback, take } = req.body ?? {};
    if (!jobId) throw Object.assign(new Error('jobId is required'), { statusCode: 400, hint: 'which job should be re-rendered, e.g. K2' });
    const r = svc.rerenderJob(req.params.id, { jobId, cascade: !!cascade, feedback, take: Number(take) || undefined });
    return reply.code(202).send(r);
  });

  app.post('/api/runs/:id/assemble', async (req, reply) => {
    guard(req);
    const r = svc.assemble(req.params.id, { composition: req.body?.composition });
    return reply.code(202).send(r);
  });

  app.post('/api/runs/:id/approve', async (req, reply) => {
    guard(req);
    const r = svc.approve(req.params.id, { upscale: !!req.body?.upscale });
    return r.queued ? reply.code(202).send(r) : r; // 202 = paid upscale queued; 200 = recorded instantly
  });

  app.post('/api/runs/:id/cancel', async (req) => {
    guard(req);
    return { cancelled: svc.cancel(req.params.id) };
  });

  // Clear a persisted lastError so a run with healthy artifacts returns to its disk-derived state
  // (a failed revision or upscale must not strand an already-paid-for master on attention).
  app.post('/api/runs/:id/dismiss-error', async (req) => {
    guard(req);
    return svc.dismissError(req.params.id);
  });

  // Re-run the engine on a run whose planning failed or was interrupted (LLM cost, no render).
  app.post('/api/runs/:id/plan', async (req) => {
    guard(req);
    return svc.plan(req.params.id);
  });

  // Reveal the final (or the run dir) in the OS file manager — darwin only; harmless elsewhere.
  app.post('/api/runs/:id/reveal', async (req) => {
    const run = guard(req);
    const target = run.manifest?.approved?.final && fs.existsSync(run.manifest.approved.final)
      ? run.manifest.approved.final
      : svc.dirFor(req.params.id);
    if (process.platform === 'darwin') { spawn('open', ['-R', target], { stdio: 'ignore', detached: true }).unref(); return { revealed: true }; }
    return { revealed: false, path: target };
  });
}

export default { registerActionRoutes };
