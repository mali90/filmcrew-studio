// buildApp — the Fastify factory. Every dependency (dirs, child env, spawner, liveness probe) is
// injectable so tests drive the whole server through fastify.inject against tmp dirs, and the
// demo server swaps in the mock-fal/fake-LLM environment. Real work always happens in spawned CLI
// children (the host config.js freezes process.env at import — children re-read .env fresh).
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { createEventBus } from './lib/events.js';
import { createJobManager } from './lib/job-manager.js';
import { createRunService } from './lib/run-service.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerEventRoutes } from './routes/events.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerCastRoutes } from './routes/cast.js';

export async function buildApp({
  root,                       // host repo root (src/cli lives here; children cwd)
  runsDir, outDir,
  envRoot,                    // where .env lives (defaults to root; the demo isolates it)
  profilesDir,                // character profiles (defaults to <root>/profiles; demo/tests isolate)
  elementsRoot,               // reference images + media serving root (defaults to <root>/elements)
  voicesFile,                 // voices.json (defaults to <root>/voices/voices.json)
  childEnv = { PATH: process.env.PATH, HOME: process.env.HOME },
  spawnCli, isAlive,          // injectable for tests
  lifecycle,                  // { quit(), restart() } — provided by server.js; absent in tests/inject
  uiDist,                     // serve the built SPA from here when provided
  logger = false,
} = {}) {
  if (!root) throw new Error('buildApp needs the host repo root');
  runsDir = path.resolve(runsDir ?? path.join(root, 'runs'));
  outDir = path.resolve(outDir ?? path.join(root, 'out'));
  envRoot = path.resolve(envRoot ?? root);
  profilesDir = path.resolve(profilesDir ?? path.join(root, 'profiles'));
  elementsRoot = path.resolve(elementsRoot ?? path.join(root, 'elements'));
  voicesFile = path.resolve(voicesFile ?? path.join(root, 'voices', 'voices.json'));
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  // isolated env root (demo/e2e): children must read THAT .env, not the repo's
  if (envRoot !== path.resolve(root)) childEnv = { ...childEnv, DOTENV_CONFIG_PATH: path.join(envRoot, '.env') };
  // isolated cast roots: engine/mint children must see the SAME profiles/refs/voices the API serves
  if (profilesDir !== path.resolve(root, 'profiles')) childEnv = { ...childEnv, PROFILES_DIR: profilesDir };
  if (elementsRoot !== path.resolve(root, 'elements')) childEnv = { ...childEnv, ELEMENTS_REFERENCES_DIR: path.join(elementsRoot, 'references') };
  if (voicesFile !== path.resolve(root, 'voices', 'voices.json')) childEnv = { ...childEnv, VOICES_DIR: path.dirname(voicesFile) };

  const app = Fastify({ logger });
  const bus = createEventBus();
  let svc; // late-bound: the manager streams events into the service
  const mgr = createJobManager({ spawnCli, onEvent: (runId, evt) => svc?.onEvent(runId, evt) });
  svc = createRunService({ root, runsDir, outDir, envRoot, childEnv, mgr, bus, isAlive });

  app.decorate('ctx', { root, runsDir, outDir, envRoot, profilesDir, elementsRoot, voicesFile, childEnv, svc, mgr, bus, lifecycle });

  // App lifecycle — quit stops the server (children get SIGTERM + 5s grace via close hooks);
  // restart respawns the same process and the UI reconnects. Only real servers wire `lifecycle`.
  const lifecycleRoute = (kind) => async (req, reply) => {
    const fn = lifecycle?.[kind];
    if (!fn) return reply.code(501).send({ error: `${kind} is not available here`, hint: 'run the real server (npm run web)' });
    reply.send({ ok: true, [kind]: true });
    setTimeout(() => fn(), 150); // let the response flush first
  };
  app.post('/api/app/quit', lifecycleRoute('quit'));
  app.post('/api/app/restart', lifecycleRoute('restart'));

  // {error, hint} everywhere — mirrors the doctor's label+hint style.
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log?.error?.(err);
    reply.code(status).send({ error: err.message, hint: err.hint ?? (status >= 500 ? 'see the server log' : 'check the request and try again') });
  });

  await app.register(fastifyStatic, { root: runsDir, serve: false });
  await app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 ** 3 } });

  // bootId lets the restart flow tell the NEW process from the dying one (the corpse still
  // answers health checks for a beat) — the UI only reloads when it sees a different id.
  const bootId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  app.get('/api/health', async () => ({ ok: true, version: 1, bootId, setupComplete: fs.existsSync(path.join(envRoot, '.env')) }));

  registerSetupRoutes(app);
  registerRunRoutes(app);
  registerActionRoutes(app);
  registerMediaRoutes(app);
  registerEventRoutes(app);
  await registerCastRoutes(app);

  // Production: serve the built SPA on the same origin; client routes fall back to index.html.
  if (uiDist && fs.existsSync(path.join(uiDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/', decorateReply: false, index: 'index.html' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html', uiDist);
      return reply.code(404).send({ error: 'not found', hint: 'unknown API route' });
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not found', hint: req.url.startsWith('/api/') ? 'unknown API route' : 'the UI is not built — run: npm --prefix web/ui run build (or use the Vite dev server)' }));
  }

  app.addHook('onClose', async () => { mgr.shutdown(); });
  svc.recover();
  return app;
}

export default { buildApp };
