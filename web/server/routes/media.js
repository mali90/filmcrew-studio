// Range-served media (mp4 scrubbing needs 206 responses — @fastify/static provides them via
// reply.sendFile). Every path is validated through safeChild before anything touches disk.
import fs from 'node:fs';
import { safeChild } from '../lib/paths.js';

export function registerMediaRoutes(app) {
  const { runsDir, outDir } = app.ctx;

  const serve = (reply, base, rawRel) => {
    let abs;
    // decodeURIComponent throws URIError on a lone "%" — that's a bad path (404), not a 500
    try { abs = safeChild(base, decodeURIComponent(rawRel ?? '')); } catch { return reply.code(404).send({ error: 'not found', hint: 'bad media path' }); }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return reply.code(404).send({ error: 'not found', hint: 'the file is not on disk (yet)' });
    return reply.sendFile(fs.realpathSync(abs).slice(fs.realpathSync(base).length + 1), fs.realpathSync(base));
  };

  app.get('/api/media/runs/*', async (req, reply) => serve(reply, runsDir, req.params['*']));
  app.get('/api/media/out/*', async (req, reply) => serve(reply, outDir, req.params['*']));
  // reference/element images for the Cast page (ctx.elementsRoot/**, isolated in demo/tests)
  app.get('/api/media/elements/*', async (req, reply) => serve(reply, app.ctx.elementsRoot, req.params['*']));
}

export default { registerMediaRoutes };
