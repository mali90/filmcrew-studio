// Environments: descriptive-only world/mood/style bibles (environments/<slug>.md) — no images, no
// voice, just a name + markdown. A DISK convention the engine understands (--environment <slug>), so
// the web UI and CLI produce identical artifacts. All paths come from app.ctx (environmentsDir), so
// the demo server and tests isolate their environments workspace completely. This module is
// CONFIG-FREE by design (see web/README.md "Children, not imports"): it statically imports ONLY
// node:fs / node:path and reaches host lib code through a dynamic import off app.ctx.root — a static
// config.js import here would make the demo/e2e validators miss the mock and hang the wizard flow.
import fs from 'node:fs';
import path from 'node:path';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SLUG_FILE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function registerEnvironmentsRoutes(app) {
  const { root, environmentsDir } = app.ctx;
  const host = async (rel) => import(path.join(root, 'src/lib', rel));

  // ——— shared local helpers (ctx paths, no host-config coupling) ———

  const listEnvironments = () => {
    let files = [];
    try { files = fs.readdirSync(environmentsDir).filter((f) => f.endsWith('.md')).sort(); } catch { /* none */ }
    return files;
  };
  const displayName = (content, fallback) => content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
  /** The stored file is "# Name\n\n<body>" — never let a body that already starts with the
   *  heading double it (the editor once did; CLI callers may too). */
  const stripLeadingHeading = (body, name) => {
    const lines = String(body).split('\n');
    if ((lines[0] ?? '').trim() === `# ${name}`) {
      lines.shift();
      while ((lines[0] ?? '').trim() === '') lines.shift();
    }
    return lines.join('\n');
  };
  const envPath = (slugName) => {
    if (!SLUG_FILE.test(slugName)) throw Object.assign(new Error('not an environment id'), { statusCode: 400, hint: 'lowercase letters, digits and dashes' });
    return path.join(environmentsDir, `${slugName}.md`);
  };
  /** Resolve an id to the on-disk file the ENGINE would load: loadEnvironment slug()-maps every
   *  *.md in the dir, so a hand-authored "Rain_City.md" answers to "rain-city". The API must
   *  resolve (and collide) exactly the same way — probing only for the literal <slug>.md would
   *  list a file it then can't edit, delete, or plan with. Returns null when nothing matches. */
  const resolveFile = (id, slug) => {
    if (!SLUG_FILE.test(id)) throw Object.assign(new Error('not an environment id'), { statusCode: 400, hint: 'lowercase letters, digits and dashes' });
    const hit = listEnvironments().find((f) => slug(f.replace(/\.md$/, '')) === id);
    return hit ? path.join(environmentsDir, hit) : null;
  };

  // ——— CRUD ———

  app.get('/api/environments', async () => {
    const { slug } = await host('util.js');
    const environments = listEnvironments().map((f) => {
      const eslug = slug(f.replace(/\.md$/, ''));
      const content = fs.readFileSync(path.join(environmentsDir, f), 'utf8');
      return { slug: eslug, name: displayName(content, eslug), description: content };
    });
    return { environments };
  });

  app.post('/api/environments', async (req, reply) => {
    const { slug } = await host('util.js');
    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim();
    if (!name || !SAFE_NAME.test(name)) {
      throw Object.assign(new Error('an environment name is required'), { statusCode: 400, hint: 'letters/numbers/spaces, up to 64 characters — e.g. "Neon City"' });
    }
    const eslug = slug(name);
    if (!eslug) throw Object.assign(new Error('that name has no usable characters'), { statusCode: 400, hint: 'use letters or numbers' });
    const file = envPath(eslug);
    if (resolveFile(eslug, slug)) throw Object.assign(new Error(`"${name}" already exists`), { statusCode: 409, hint: 'edit the existing environment, or pick another name' });
    fs.mkdirSync(environmentsDir, { recursive: true });
    fs.writeFileSync(file, `# ${name}\n\n${stripLeadingHeading(description, name)}\n`.replace(/\n+$/, '\n'));
    return reply.code(201).send({ slug: eslug });
  });

  app.put('/api/environments/:slug', async (req) => {
    const { slug } = await host('util.js');
    const file = resolveFile(req.params.slug, slug);
    if (!file) throw Object.assign(new Error('no such environment'), { statusCode: 404, hint: 'GET /api/environments lists them' });
    // name/slug are immutable after creation (like cast) — keep the existing heading.
    const name = displayName(fs.readFileSync(file, 'utf8'), req.params.slug);
    const description = String(req.body?.description ?? '').trim();
    fs.writeFileSync(file, `# ${name}\n\n${stripLeadingHeading(description, name)}\n`.replace(/\n+$/, '\n'));
    return { slug: req.params.slug };
  });

  app.delete('/api/environments/:slug', async (req) => {
    const { slug } = await host('util.js');
    const file = resolveFile(req.params.slug, slug);
    if (!file) throw Object.assign(new Error('no such environment'), { statusCode: 404, hint: 'GET /api/environments lists them' });
    fs.rmSync(file);
    return { deleted: req.params.slug };
  });
}

export default { registerEnvironmentsRoutes };
