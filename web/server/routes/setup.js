// Setup wizard + settings + doctor + storage. Key validation runs IN-process (the validators take
// explicit args — safe despite the host config env-freeze); everything env-sensitive (doctor)
// runs as a fresh child so it reads the just-written .env.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createEnvSettings } from '../lib/env-settings.js';

const dirStats = (dir) => {
  let bytes = 0; let count = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { count++; try { bytes += fs.statSync(p).size; } catch { /* raced */ } }
    }
  };
  walk(dir);
  return { bytes, count };
};

export function registerSetupRoutes(app) {
  const { root, runsDir, outDir, envRoot, childEnv } = app.ctx;
  const envSettings = createEnvSettings({ root, envRoot });
  const installing = new Set();          // providers with an install in flight (one at a time → 409)
  const modelsCache = new Map();         // provider → { at, live } — short TTL so dropdown flicks don't spam the provider
  const MODELS_TTL_MS = 5 * 60 * 1000;

  app.get('/api/setup/status', async () => {
    const { source, get } = await envSettings.read();
    const provider = get('LLM_PROVIDER') || 'claude';
    const transport = get('LLM_TRANSPORT') || 'api';
    const { PROVIDER_KEY_ENV } = await import(path.join(root, 'src/lib/llm.js'));
    const llmKeySet = transport === 'cli' || !!(get(PROVIDER_KEY_ENV[provider] ?? '') || get('LLM_API_KEY'));
    const falKeySet = !!(get('FAL_KEY') || get('FAL_API_KEY'));
    return {
      envSource: fs.existsSync(path.join(envRoot, '.env')) ? '.env' : source === '.env.example' ? '.env.example' : 'none',
      llm: { provider, transport, model: get('LLM_MODEL') || null, hasKey: llmKeySet },
      fal: { hasKey: falKeySet },
      defaults: { backend: get('RENDER_BACKEND') || 'kling', aspect: get('KLING_ASPECT') || '9:16', resolution: get('KLING_RESOLUTION') || '1080p' },
      complete: llmKeySet && falKeySet,
    };
  });

  app.post('/api/setup/validate-llm', async (req) => {
    const { provider, transport = 'api', model, apiKey } = req.body ?? {};
    if (!provider) throw Object.assign(new Error('provider is required'), { statusCode: 400, hint: 'claude | openai | gemini | copilot' });
    const { pingLlm } = await import(path.join(root, 'src/lib/llm.js'));
    const { modelDefault } = await import(path.join(root, 'src/lib/models.js'));
    const { pathWithLocalBin, pathWithNpmGlobal } = await import(path.join(root, 'src/lib/cli-install.js'));
    try {
      // A blank model means "provider default" — resolve it to a real id (the engine does this via
      // config.js, but this explicit-args path would otherwise ping the CLI with --model undefined).
      // Validate with the CHILD env — the engine runs with childEnv, not the server's env, and on
      // macOS the claude CLI's keychain login depends on it ("valid" here must mean valid at run time).
      // Include ~/.local/bin (native installs like claude) + the npm global bin so a just-installed CLI
      // is found even before the user reopens their shell.
      const cliEnv = transport === 'cli'
        ? { ...app.ctx.childEnv, PATH: pathWithLocalBin(await pathWithNpmGlobal(app.ctx.childEnv.PATH)) }
        : undefined;
      await pingLlm({ provider, transport, model: model || modelDefault(provider), apiKey, env: cliEnv });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  app.post('/api/setup/validate-fal', async (req) => {
    const { validateFal } = await import(path.join(root, 'src/lib/fal.js'));
    return validateFal(String(req.body?.apiKey ?? ''));
  });

  // Model list for the Keys/wizard dropdown: always the curated catalog (default + alternatives);
  // additionally the provider's LIVE list when its API key is set and it has an HTTP models API
  // (copilot doesn't). Degrades to `live: null` + a `liveError` reason otherwise.
  app.get('/api/setup/models', async (req) => {
    const provider = String(req.query?.provider ?? '');
    const { curatedFor } = await import(path.join(root, 'src/lib/models.js'));
    const { PROVIDER_KEY_ENV, PROVIDER_NPM_PKG } = await import(path.join(root, 'src/lib/llm.js'));
    if (!PROVIDER_NPM_PKG[provider]) throw Object.assign(new Error(`unknown provider "${provider}"`), { statusCode: 400, hint: `use one of: ${Object.keys(PROVIDER_NPM_PKG).join(', ')}` });
    const curated = curatedFor(provider);
    const base = { provider, default: curated.default, options: curated.options, live: null };

    const { hasLiveModelApi, listProviderModels } = await import(path.join(root, 'src/lib/provider-models.js'));
    if (!hasLiveModelApi(provider)) return { ...base, liveError: 'cli-only' };

    const { get } = await envSettings.read();
    const apiKey = get(PROVIDER_KEY_ENV[provider] ?? '') || get('LLM_API_KEY');
    if (!apiKey) return { ...base, liveError: 'no-key' };

    const cached = modelsCache.get(provider);
    if (cached && Date.now() - cached.at < MODELS_TTL_MS) return { ...base, live: cached.live };
    try {
      const { models } = await listProviderModels({ provider, apiKey });
      modelsCache.set(provider, { at: Date.now(), live: models });
      return { ...base, live: models };
    } catch {
      return { ...base, liveError: 'fetch-failed' };
    }
  });

  app.get('/api/settings/env', async () => {
    const { source, rows } = await envSettings.read();
    return { source, rows };
  });

  app.post('/api/settings/env/preview', async (req) => envSettings.preview(req.body?.updates ?? {}));

  app.post('/api/settings/env', async (req) => {
    const updates = req.body?.updates ?? {};
    if (!Object.keys(updates).length) throw Object.assign(new Error('no updates given'), { statusCode: 400, hint: 'send {updates:{KEY:"value"}} — a blank value clears a key' });
    return envSettings.write(updates);
  });

  app.get('/api/settings/defaults', async () => {
    const { get } = await envSettings.read();
    return {
      backend: get('RENDER_BACKEND') || 'kling',
      aspect: get('KLING_ASPECT') || '9:16',
      resolution: get('KLING_RESOLUTION') || '1080p',
      seedanceResolution: get('SEEDANCE_RESOLUTION') || '480p',
    };
  });

  app.post('/api/settings/defaults', async (req) => {
    const { backend, aspect, resolution, seedanceResolution } = req.body ?? {};
    const updates = {};
    if (backend !== undefined) updates.RENDER_BACKEND = backend === 'kling' ? '' : String(backend);
    if (aspect !== undefined) updates.KLING_ASPECT = String(aspect);
    if (resolution !== undefined) updates.KLING_RESOLUTION = String(resolution);
    if (seedanceResolution !== undefined) {
      if (!['480p', '720p', '1080p'].includes(String(seedanceResolution))) {
        throw Object.assign(new Error(`"${seedanceResolution}" is not a Seedance resolution`), { statusCode: 400, hint: '480p, 720p or 1080p' });
      }
      updates.SEEDANCE_RESOLUTION = String(seedanceResolution);
    }
    return envSettings.write(updates);
  });

  // Doctor runs as a fresh child so it reads the CURRENT .env (the server process's env snapshot
  // is frozen at boot). Exit 1 just means hard failures — the JSON body reports them either way.
  app.post('/api/doctor', async () => {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'src/cli/doctor.js'), '--json'], { cwd: root, env: { ...childEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', () => stdout.trim() ? resolve(stdout) : reject(new Error(`doctor produced no output: ${stderr.slice(-300)}`)));
    });
    return JSON.parse(out);
  });

  // Is the selected provider's CLI installed? Fast `<bin> --version` probe (login is verified
  // separately by validate-llm). ?provider= → one; no param → all four (drives badges + guidance).
  app.get('/api/setup/cli-status', async (req) => {
    const { PROVIDER_CLI_BIN, PROVIDER_NPM_PKG, PROVIDER_INSTALL_METHOD } = await import(path.join(root, 'src/lib/llm.js'));
    const { probeCli } = await import(path.join(root, 'src/lib/preflight.js'));
    const { pathWithNpmGlobal, pathWithLocalBin, nativeInstallSpec } = await import(path.join(root, 'src/lib/cli-install.js'));
    const env = { ...childEnv, PATH: pathWithLocalBin(await pathWithNpmGlobal(childEnv.PATH)) };
    const statusFor = async (p) => {
      const bin = PROVIDER_CLI_BIN[p];
      const { installed, version } = await probeCli(bin, { env });
      const native = nativeInstallSpec(p);
      const installCmd = native ? native.display : `npm install -g ${PROVIDER_NPM_PKG[p]}`;
      return { provider: p, bin, npmPackage: PROVIDER_NPM_PKG[p], installMethod: PROVIDER_INSTALL_METHOD[p], installCmd, installed, version };
    };
    const provider = req.query?.provider ? String(req.query.provider) : null;
    if (provider) {
      if (!PROVIDER_CLI_BIN[provider]) throw Object.assign(new Error(`unknown provider "${provider}"`), { statusCode: 400, hint: `use one of: ${Object.keys(PROVIDER_CLI_BIN).join(', ')}` });
      return statusFor(provider);
    }
    return { providers: await Promise.all(Object.keys(PROVIDER_CLI_BIN).map(statusFor)) };
  });

  // Install a provider's CLI: streams the installer output as newline-delimited JSON. POST
  // (state-changing); one install per provider at a time (409). Claude uses Anthropic's official native
  // script (curl|bash from claude.ai); the rest use `npm install -g <pkg>` — provider is allowlisted,
  // the package/command is a constant from the trusted map, and spawn uses an arg array (no user input).
  app.post('/api/setup/install-cli', async (req, reply) => {
    const provider = String(req.body?.provider ?? '');
    const { PROVIDER_CLI_BIN, PROVIDER_NPM_PKG } = await import(path.join(root, 'src/lib/llm.js'));
    const pkg = PROVIDER_NPM_PKG[provider];
    const bin = PROVIDER_CLI_BIN[provider];
    const cli = await import(path.join(root, 'src/lib/cli-install.js'));
    const native = cli.nativeInstallSpec(provider); // Claude → Anthropic's official native installer; others → npm
    if (!native && !pkg) throw Object.assign(new Error(`unknown provider "${provider}"`), { statusCode: 400, hint: `use one of: ${Object.keys(PROVIDER_NPM_PKG).join(', ')}` });
    if (installing.has(provider)) throw Object.assign(new Error(`already installing ${provider}`), { statusCode: 409, hint: 'wait for the current install to finish' });

    installing.add(provider);
    reply.hijack(); // take over the socket — the NDJSON stream is written by hand, not by Fastify
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const emit = (o) => { try { raw.write(`${JSON.stringify(o)}\n`); } catch { /* client gone */ } };

    // Claude installs via Anthropic's official native script; every other provider via `npm install -g`.
    const spec = native
      ? { file: native.file, args: native.args, shell: native.shell, env: { ...childEnv, PATH: cli.pathWithLocalBin(childEnv.PATH) }, start: { type: 'start', provider, command: native.display }, failHint: cli.nativeFailureHint, startFail: 'The installer could not start. Check your connection, or run the shown command in a terminal.' }
      : { file: cli.npmBin(), args: cli.npmInstallArgs(pkg), shell: cli.npmNeedsShell(), env: { ...childEnv, PATH: await cli.pathWithNpmGlobal(childEnv.PATH) }, start: { type: 'start', provider, pkg, command: `npm ${cli.npmInstallArgs(pkg).join(' ')}` }, failHint: cli.npmFailureHint, startFail: 'Install Node.js (which includes npm), then restart the studio.' };
    const env = spec.env;
    emit(spec.start);

    let child;
    let tail = '';
    let done = false;
    let timer;
    const finish = (evt) => { if (done) return; done = true; clearTimeout(timer); installing.delete(provider); emit(evt); try { raw.end(); } catch { /* gone */ } };
    try {
      child = spawn(spec.file, spec.args, { cwd: root, env, shell: spec.shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ type: 'error', ok: false, message: `could not start the installer: ${e.message}`, hint: spec.startFail });
    }
    timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } finish({ type: 'error', ok: false, message: 'Install timed out after 3 minutes.', hint: 'Check your connection, or run the shown command in a terminal.' }); }, 180000);

    const pump = (stream) => {
      let buf = '';
      return (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          tail = `${tail}\n${line}`.slice(-4000);
          emit({ type: 'log', stream, line });
        }
      };
    };
    child.stdout.on('data', pump('stdout'));
    child.stderr.on('data', pump('stderr'));
    child.on('error', (e) => finish({ type: 'error', ok: false, message: `the installer failed to start: ${e.message}`, hint: e.code === 'ENOENT' ? spec.startFail : 'See the server log.' }));
    child.on('close', async (code) => {
      if (done) return;
      if (code === 0) {
        const { probeCli } = await import(path.join(root, 'src/lib/preflight.js'));
        const { installed, version } = await probeCli(bin, { env });
        finish({ type: 'done', ok: true, bin, installed, version });
      } else {
        finish({ type: 'error', ok: false, code, message: `the install exited with code ${code}`, hint: spec.failHint(code, tail) });
      }
    });
    raw.on('close', () => { if (done) return; try { child.kill('SIGTERM'); } catch { /* gone */ } done = true; clearTimeout(timer); installing.delete(provider); });
  });

  app.get('/api/storage', async () => ({ runs: dirStats(runsDir), out: dirStats(outDir) }));
}

export default { registerSetupRoutes };
