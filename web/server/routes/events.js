// SSE. One stream per run (snapshot first, then live events; Last-Event-ID resumes LOG lines from
// the ring buffer — all other state is covered by the snapshot, so a reconnecting client is never
// wrong, only briefly stale) and one global stream (queue + run status changes).
import { isRunId } from '../lib/paths.js';
import { listArtifacts } from '../lib/artifact-watch.js';

const sseHead = (reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
};
const send = (reply, event, id) => {
  reply.raw.write(`${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
};

export function registerEventRoutes(app) {
  const { svc, bus, mgr } = app.ctx;

  app.get('/api/runs/:id/events', (req, reply) => {
    if (!isRunId(req.params.id)) return reply.code(404).send({ error: 'no such run', hint: 'check the library' });
    const runId = req.params.id;
    const detail = svc.detail(runId);
    if (!detail) return reply.code(404).send({ error: 'no such run', hint: 'check the library' });

    sseHead(reply);
    send(reply, { type: 'snapshot', run: app.serializeRun(detail) });

    // resume: replay missed LOG lines by cursor
    const lastId = Number(req.headers['last-event-id']) || 0;
    if (lastId) for (const e of svc.ringFor(runId).since(lastId)) send(reply, { type: 'log', cursor: e.cursor, line: e.line }, e.cursor);

    const unsub = bus.subscribe(runId, (evt) => send(reply, evt, evt.type === 'log' ? evt.cursor : undefined));
    // After subscribing (so no live event is missed), replay spec-block events for spec files already
    // on disk. The live watcher only streams NEW files, so a client that connects mid-planning would
    // otherwise never learn about a spec block emitted before it subscribed. Duplicates are harmless
    // (the UI keys agents by file; the union of replay + live is complete with no gap).
    for (const file of listArtifacts(svc.dirFor(runId))) if (file.includes('spec')) send(reply, { type: 'spec-block', file });
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15000);
    keepAlive.unref?.();
    req.raw.on('close', () => { clearInterval(keepAlive); unsub(); });
  });

  app.get('/api/events', (req, reply) => {
    sseHead(reply);
    send(reply, { type: 'snapshot', queue: mgr.snapshot() });
    const unsub = bus.subscribe('*', (evt, channel) => {
      if (evt.type === 'queue' || evt.type === 'run-status') send(reply, evt);
      else if (channel !== '*') send(reply, { type: 'run-activity', runId: channel, eventType: evt.type });
    });
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15000);
    keepAlive.unref?.();
    req.raw.on('close', () => { clearInterval(keepAlive); unsub(); });
  });
}

export default { registerEventRoutes };
