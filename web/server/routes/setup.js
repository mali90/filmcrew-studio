// Setup wizard + settings + doctor + storage. Key validation runs IN-process (the validators take
// explicit args — safe despite the host config env-freeze); everything env-sensitive (doctor)
// runs as a fresh child so it reads the just-written .env.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createEnvSettings } from '../lib/env-settings.js';
// The render child's OWN env reader — dotenv's grammar over <envRoot>/.env, childEnv first. The one
// implementation the server has (see estimator.js's readEnvVar); a second one here would be a second
// set of rules for the same file. It is config-free, and already in this graph via run-service.
import { readEnvVar } from '../lib/estimator.js';
// …and the same dotenv grammar applied to the FILE ALONE (see the two-reader note below). Both are
// config-free and already static in this graph via estimator.js — no new edge, canaries unaffected.
import { dotenvValues, readEnvFileOrExample } from '../../../src/lib/env-file.js';

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
  // ── TWO QUESTIONS about one file, and they must never share a reader again ─────────────────────
  //
  // "What will the next RENDER do?" → envGet. The effective DEFAULTS (backend, aspect, resolution)
  //   and the Segmind slug a probe posts. dotenv's grammar over <envRoot>/.env with childEnv AHEAD
  //   of it, exactly as a spawned child resolves them, because those values do not just decorate a
  //   card — the create page hydrates from them and posts them back as an explicit per-run pin.
  //   Read through the line editor, a perfectly valid `SEEDANCE25_RESOLUTION="480p"` came back WITH
  //   its quotes, failed the ladder check in the browser, and pinned the run to 720p: a different
  //   output and a different bill from the one configured.
  //
  // "Is this INSTALLATION configured?" → storedEnv. The setup GATE (`complete`) and every "on file"
  //   badge that hangs off it — fal/segmind/llm `hasKey`, and the provider whose key the gate has to
  //   look for. Same dotenv grammar, over the SETTINGS FILE ALONE: no childEnv, and .env.example
  //   when there is no .env yet. Letting childEnv in here is not a nuance, it is the regression that
  //   reached CI — the demo/e2e harness injects mock provider keys into the child so renders hit the
  //   mocks, so a fresh install with no .env at all read back `complete: true` and the wizard never
  //   took over. The same hole is any user's `export FAL_KEY=…`: the wizard's whole job is to WRITE
  //   that file, so nothing inherited from the launching shell may claim the writing is already
  //   done. The UI says this out loud — "No SEGMIND_API_KEY on file", "add it in Settings → Keys".
  //
  // The line editor (envSettings.read().get) stays what it always was: the WRITE path's view of the
  // file, where a rewrite has to leave every other byte alone. It is not a reader for either
  // question above — it takes the FIRST assignment where dotenv keeps the LAST, keeps a trailing
  // `# comment` inside the value, and does not see an `export ` prefix at all.
  const envGet = (key) => readEnvVar(envRoot ?? root, key, childEnv);
  /** What the settings file itself stores, dotenv's way, seeded from .env.example on a fresh
   *  install. Re-read per request, never cached: the wizard writes this file and then immediately
   *  asks whether it is done. */
  const storedEnv = () => {
    const { text, source } = readEnvFileOrExample(envRoot ?? root);
    return { source, values: dotenvValues(text) };
  };
  const installing = new Set();          // providers with an install in flight (one at a time → 409)
  const modelsCache = new Map();         // provider → { at, live } — short TTL so dropdown flicks don't spam the provider
  const MODELS_TTL_MS = 5 * 60 * 1000;

  // This endpoint answers BOTH questions at once, which is exactly why it went wrong: the gate
  // fields (`complete` and the three `hasKey` flags, plus the provider/transport that pick WHICH key
  // the gate needs) come from `stored`; the `defaults` block comes from `envGet`.
  app.get('/api/setup/status', async () => {
    // `source` is readEnvFileOrExample's own answer — '.env', '.env.example' or 'none' — which is
    // what `envSource` has always reported, from the one read that also produces the values.
    const { source, values: stored } = storedEnv();
    // Which provider the engine runs decides WHICH key completion depends on, so it is read from
    // the same file as that key: an `export LLM_PROVIDER=openai` the line editor could not see had
    // the wizard checking ANTHROPIC_API_KEY, and a shell-exported one would have the wizard judging
    // a file that says something else entirely. With no .env yet this is .env.example's seed
    // (LLM_PROVIDER=claude / LLM_TRANSPORT=cli), which is what makes a first run's LLM step start
    // where the docs say it does.
    const provider = stored.LLM_PROVIDER || 'claude';
    const transport = stored.LLM_TRANSPORT || 'api';
    const { PROVIDER_KEY_ENV } = await import(path.join(root, 'src/lib/llm.js'));
    // The keys are the gate itself. .env.example ships every key line blank, so a fresh install
    // reads keyless and /setup takes over — which is the whole point of the wizard and the thing a
    // childEnv read destroyed.
    const llmKeySet = transport === 'cli' || !!(stored[PROVIDER_KEY_ENV[provider] ?? ''] || stored.LLM_API_KEY);
    const falKeySet = !!(stored.FAL_KEY || stored.FAL_API_KEY);
    const segmindKeySet = !!stored.SEGMIND_API_KEY;
    const { defaultResolutionFor, normalizeBackend, resolutionEnvFor } = await import(path.join(root, 'src/lib/render-models.js'));
    // RENDER_BACKEND is read TWICE, on purpose, because it stands on both sides of the split:
    //
    //   · the GATE's copy is stored, because it decides WHICH key completion depends on — a
    //     Segmind-only install (no fal account anywhere) is a valid, documented setup, and demanding
    //     FAL_KEY would trap it in /setup forever. It has to come from the same file as the key it
    //     selects, or the two disagree: an inherited `RENDER_BACKEND=` (empty) over a file storing
    //     seedance-2.5@segmind would demand a fal key the user was never asked for.
    //   · the DEFAULT reported below is envGet, because the create page hydrates from it and posts
    //     it back as an explicit per-run pin — that one must be the backend the next render resolves.
    //
    // The registry is config-free, so importing it is the allowed pattern.
    const storedBackend = stored.RENDER_BACKEND || 'kling';
    let renderProvider = 'fal';
    try { renderProvider = normalizeBackend(storedBackend).provider; }
    catch { /* unknown backend — doctor's own check names it; the fal gate stays as the fallback */ }
    const backend = envGet('RENDER_BACKEND') || 'kling';
    // The reported resolution follows the DEFAULT's rule: the knob the default backend's MODEL
    // actually reads — a Seedance default with only KLING_RESOLUTION in .env must not display a
    // value the render will never use.
    let resolution = envGet('KLING_RESOLUTION') || '1080p';
    try {
      const { model } = normalizeBackend(backend);
      // A ladder-less model (Kling) has no knob and no tier — null, not another model's env read.
      const resEnv = resolutionEnvFor(model);
      resolution = resEnv ? (envGet(resEnv) || defaultResolutionFor(model)) : null;
    } catch { /* unknown backend — the create page falls back to the model's registry default */ }
    const renderKeySet = renderProvider === 'segmind' ? segmindKeySet : falKeySet;
    return {
      envSource: source,
      // The model shown beside the provider is part of the same "what did you configure" answer.
      llm: { provider, transport, model: stored.LLM_MODEL || null, hasKey: llmKeySet },
      fal: { hasKey: falKeySet },
      segmind: { hasKey: segmindKeySet },
      renderProvider,
      defaults: { backend, aspect: envGet('KLING_ASPECT') || '9:16', resolution },
      complete: llmKeySet && renderKeySet,
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
    // An EMPTY key means "check the STORED one" (rerun flows): on the Segmind path the fal field
    // is optional and buildUpdates preserves an existing FAL_KEY — whose mere presence keeps
    // steering uploads to fal-storage. Setup must judge the key that will actually be used;
    // with nothing stored either, validateFal('') still answers { ok:false, reason:'missing' }.
    //
    // STORED is the word, so this is a "what is configured" read: the file the wizard just wrote,
    // and only that file. envGet would answer for the server's own inherited environment first, so a
    // FAL_KEY exported in the shell that started the studio would come back "ok" for a file storing
    // nothing — and "nothing stored either" would stop meaning what the card says it means. It reads
    // through storedEnv rather than the line editor for the grammar alone: `export FAL_KEY=sk-…` is
    // a stored key, and the editor reported it missing.
    const typed = String(req.body?.apiKey ?? '');
    if (typed) return validateFal(typed);
    const { values: stored } = storedEnv();
    return validateFal(stored.FAL_KEY || stored.FAL_API_KEY || '');
  });

  app.post('/api/setup/validate-segmind', async (req) => {
    const { validateSegmind } = await import(path.join(root, 'src/lib/segmind.js'));
    // Probe the MODEL the user picked, at its CONFIGURED slug: validating the default 2.5 slug for
    // a 2.0 setup would let a bad SEGMIND_SEEDANCE20_SLUG pass setup and fail on the first paid
    // render — and a customized 2.5 slug reject a perfectly valid 2.0 pick.
    //
    // Read the CHILD's way (dotenv grammar, childEnv first), because the whole point of this probe
    // is that the slug it validates is the slug the render child will POST. Through the settings
    // reader, a perfectly ordinary `SEGMIND_SEEDANCE25_SLUG="my-slug"` validated `"my-slug"` quotes
    // and all — a 404 telling the user their key is bad — and an `export `-prefixed one, or a
    // second assignment lower down, validated the DEFAULT slug and then let the first paid render
    // fail on a slug setup never touched. Nothing is seeded from .env.example here (both slug lines
    // ship commented out), so the `|| default` below covers a fresh install exactly as before.
    let slug;
    try {
      const { normalizeBackend } = await import(path.join(root, 'src/lib/render-models.js'));
      const { model, provider } = normalizeBackend(String(req.body?.backend ?? ''));
      if (provider === 'segmind') {
        slug = model === 'seedance-2.0'
          ? (envGet('SEGMIND_SEEDANCE20_SLUG') || 'seedance-2.0')
          : (envGet('SEGMIND_SEEDANCE25_SLUG') || 'seedance-2.5');
      }
    } catch { /* no/invalid backend sent — validateSegmind's default slug stands */ }
    return validateSegmind(String(req.body?.apiKey ?? ''), slug ? { slug } : undefined);
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

    // Another "what is configured" read, and it has to agree with the badge beside it: a provider
    // whose card says "no key on file" must not quietly list live models off a shell variable, and
    // one whose file says `export OPENAI_API_KEY=…` must not report 'no-key' — which is what the
    // line editor's grammar did here.
    const { values: stored } = storedEnv();
    const apiKey = stored[PROVIDER_KEY_ENV[provider] ?? ''] || stored.LLM_API_KEY;
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
    const { RENDER_MODELS, defaultResolutionFor, normalizeBackend, resolutionEnvFor } = await import(path.join(root, 'src/lib/render-models.js'));
    // The saved tier of the knob EACH MODEL actually reads (or the model's own default) — never a
    // blanket KLING_RESOLUTION read: with a Seedance default backend that knob is not what the
    // render uses, and showing its value here is exactly the lie this endpoint used to tell.
    const effectiveFor = (model) => {
      const resEnv = resolutionEnvFor(model);
      // Ladder-less model (Kling): no knob exists — null, never a sibling's env read.
      return resEnv ? (envGet(resEnv) || defaultResolutionFor(model)) : null;
    };
    const backend = envGet('RENDER_BACKEND') || 'kling';
    let resolution;
    try { resolution = effectiveFor(normalizeBackend(backend).model); } catch { resolution = null; }
    return {
      backend,
      aspect: envGet('KLING_ASPECT') || '9:16',
      resolution, // the DEFAULT backend's effective tier — what its next render will actually use
      resolutions: Object.fromEntries(Object.keys(RENDER_MODELS).map((m) => [m, effectiveFor(m)])),
      seedanceResolution: envGet('SEEDANCE_RESOLUTION') || '480p', // legacy field — old readers keep working
    };
  });

  app.post('/api/settings/defaults', async (req) => {
    const { backend, aspect, resolution, seedanceResolution } = req.body ?? {};
    const updates = {};
    if (backend !== undefined) updates.RENDER_BACKEND = backend === 'kling' ? '' : String(backend);
    if (aspect !== undefined) updates.KLING_ASPECT = String(aspect);
    if (resolution !== undefined) {
      // The tier belongs to a MODEL's knob, resolved through the registry: the backend posted with
      // it, or the saved default backend when only the tier changed. Writing KLING_RESOLUTION
      // unconditionally here is what let a Seedance default ignore the wizard's pick.
      const { capsFor, normalizeBackend } = await import(path.join(root, 'src/lib/render-models.js'));
      // …and the saved backend that stands in for an absent one is read the child's way too — the
      // DEFAULTS side of the split, not the gate's: it decides WHICH model's knob this save writes,
      // and it must resolve to the same model GET /settings/defaults just showed the user (also
      // envGet) and the same one the next render will run.
      const target = backend !== undefined ? String(backend) : (envGet('RENDER_BACKEND') || 'kling');
      let caps;
      try { caps = capsFor(normalizeBackend(target).id); } catch (e) {
        throw Object.assign(new Error(e.message), { statusCode: 400, hint: 'save a valid backend with (or before) its resolution' });
      }
      if (!caps.resolutions.includes(String(resolution))) {
        throw Object.assign(new Error(`"${resolution}" is not a ${caps.label} resolution`), { statusCode: 400, hint: `${caps.label} renders ${caps.resolutions.join(', ')}` });
      }
      updates[caps.resolutionEnv] = String(resolution);
    }
    if (seedanceResolution !== undefined) {
      // legacy field, kept accepted: pre-registry callers set the shared Seedance knob directly
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
