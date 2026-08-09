// Shared preflight checks — the source of truth behind `npm run doctor` and reused by the init
// wizard. runChecks() builds the {ok,label,hint}[] list (no printing / no process.exit); the CLI
// wrapper (src/cli/doctor.js) formats and sets the exit code. Keeping this in a lib (not a CLI)
// lets init.js reuse whichVersion() without a CLI importing another CLI.
import { spawn } from 'node:child_process';
import { buildConfig } from '../../config.js';
import { PROVIDER_KEY_ENV, PROVIDER_CLI_BIN, PROVIDER_CLI_ONLY } from './llm.js';
import { buildInventory } from './elements.js';
import { loadVoices, getVoiceRefClip } from './voices.js';
import { seamstitchAvailable } from './seamstitch.js';
import { resolveUpscaleProvider } from './upscale.js';
import { RENDER_BACKENDS } from './spec-schema.js';
import { normalizeBackend, RENDER_MODELS } from './render-models.js';

// Failed checks whose label starts with one of these are SOFT (a warning, not a hard blocker): you
// may still render a hand-authored spec, or a fal spec with no dialogue, later.
export const SOFT = ['reference images', 'character voices', 'voice ref clips', 'seamless stitcher'];

/**
 * Is this failed check a warning rather than a blocker? Two rules, in order:
 *   1. an explicit `soft` on the check itself — the provider checks decide their own severity from
 *      the effective config (SEGMIND_API_KEY blocks a Segmind render and merely informs a fal user),
 *      which no label prefix can express;
 *   2. otherwise the historical label-prefix rule above, so every existing check keeps its severity.
 */
export const isSoft = (c) => (typeof c.soft === 'boolean' ? c.soft : SOFT.some((s) => c.label.startsWith(s)));

/** Spawn `bin -version` and resolve true iff it runs (used for ffmpeg/ffprobe presence). */
export function whichVersion(bin) {
  return new Promise((resolve) => {
    const c = spawn(bin, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}

/** Spawn `bin --version` (double dash — what the node agent CLIs claude/codex/gemini/copilot want,
 *  unlike ffmpeg's -version) and resolve {installed, version}. Killed after timeoutMs so a CLI that
 *  hangs on --version can't wedge the doctor. `env` defaults to process.env so the doctor child
 *  inherits its own (already .env-loaded) environment. */
export function probeCli(bin, { env, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let c;
    try {
      c = spawn(bin, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return done({ installed: false, version: null });
    }
    const t = setTimeout(() => { try { c.kill(); } catch { /* already gone */ } done({ installed: false, version: null }); }, timeoutMs);
    c.stdout?.on('data', (d) => { out += d; });
    c.on('error', () => { clearTimeout(t); done({ installed: false, version: null }); });
    c.on('close', (code) => { clearTimeout(t); done({ installed: code === 0, version: out.trim().split('\n')[0] || null }); });
  });
}

/** True iff the CLI binary is present on PATH (thin boolean wrapper over probeCli). */
export const probeCliBin = async (bin, opts) => (await probeCli(bin, opts)).installed;

/**
 * Run every preflight check and return the {id,ok,label,hint,soft?}[] list (no output, no exit).
 * Settings are re-derived from `env` with config.js's own rules rather than read off the snapshot
 * this process booted with: the doctor's whole job is to describe the environment as it is NOW
 * (keys get edited and the check re-run), and duplicating those defaulting rules here would be a
 * second source of truth. The fs-backed checks (voices, elements) still read through their own
 * modules, which is the same workspace those libs would use at render time.
 * @param {{env?:Record<string,string|undefined>}} [p]
 */
export async function runChecks({ env = process.env } = {}) {
  const config = buildConfig(env);
  const checks = [];
  // `id` is the STABLE machine name — the web app maps it to a fix action (jump to the key form,
  // the guided ffmpeg install, the Cast page). Labels/hints stay human and may change freely.
  // `extra` carries an explicit `soft` for the checks whose severity depends on the config.
  const add = (id, ok, label, hint = '', extra = {}) => checks.push({ id, ok, label, hint, ...extra });

  // 1. Render credentials — per PROVIDER, because a render only ever needs the one it runs on.
  // Normalize ONCE and reuse: the runtime accepts every spelling normalizeBackend accepts (padded,
  // legacy, canonical), so the doctor must judge validity — and the Seedance family below — by the
  // same rule, or Setup blocks a backend that renders fine.
  const beNorm = (() => { try { return normalizeBackend(config.render.backend); } catch { return null; } })();
  // An unreadable backend counts as fal: the `backend` check below is already red, and the familiar
  // "FAL_KEY set" failure beats inventing a provider the user has never chosen.
  const renderProvider = beNorm?.provider ?? 'fal';
  // Family, not a literal compare: every Seedance model lip-syncs from the mint-time clips and
  // shares the `seedance` knobs block (upload mode included).
  const renderFamily = beNorm ? RENDER_MODELS[beNorm.model].family : null;
  const upscaleProvider = String(config.upscale.provider || 'auto').trim().toLowerCase();
  const segmindViaFalStorage = renderProvider === 'segmind' && config.segmind.uploadMode === 'fal-storage';
  // Everything in the EFFECTIVE config that genuinely needs a fal key. Empty ⇒ this is a
  // Segmind-only install and a missing FAL_KEY must not block it (minting character voices is
  // fal-only too, but it is an optional side-quest — the `voices` check below is soft — so it
  // colours the hint rather than the severity).
  const falNeeds = [
    renderProvider === 'fal' && `the ${config.render.backend} backend renders on fal`,
    upscaleProvider === 'fal' && 'UPSCALE_PROVIDER=fal',
    segmindViaFalStorage && 'SEGMIND_UPLOAD_MODE=fal-storage puts your references on fal storage',
  ].filter(Boolean);
  add('fal-key', !!config.fal.apiKey, 'FAL_KEY set',
    falNeeds.length
      ? `Get a key at fal.ai/dashboard/keys and put it in .env — needed because ${falNeeds.join('; ')}`
      : 'Optional here — nothing in this setup runs on fal. Get one at fal.ai/dashboard/keys to mint character voices or to switch to a fal backend',
    { soft: falNeeds.length === 0 });
  // Segmind's key is reported for everyone (switching provider is then a known step) but BLOCKS
  // whoever's money would actually route there: a Segmind default backend, OR an enabled upscale
  // that resolves to Segmind — doctor passing while the approve-time upscale is guaranteed to fail
  // would be a lie that costs a render to discover.
  const effectiveUpscaleProvider = resolveUpscaleProvider({
    configured: config.upscale.provider,
    runProvider: renderProvider,
    hasFalKey: !!config.fal.apiKey,
    hasSegmindKey: !!config.segmind.apiKey,
  });
  // An EXPLICIT UPSCALE_PROVIDER=segmind blocks even with the auto-upscale flag off: the review
  // UI offers approve-time upscaling regardless, and that manual action honors the explicit pick.
  const segmindBills = renderProvider === 'segmind'
    || String(config.upscale.provider || '').trim().toLowerCase() === 'segmind'
    || (config.upscale.enabled && effectiveUpscaleProvider === 'segmind');
  add('segmind-key', !!config.segmind.apiKey, 'SEGMIND_API_KEY set',
    'Get a key at segmind.com (Console → API keys) and put SEGMIND_API_KEY in .env',
    { soft: !segmindBills });
  // How a local reference reaches the render provider. fal uploads to fal; Segmind can EITHER reuse
  // fal storage (small POST bodies, needs FAL_KEY) or inline data URIs (no fal account at all) —
  // the first combination fails on the very first upload of every render, silently until then.
  // Report the knob this backend actually reads — Seedance-on-fal rides SEEDANCE_UPLOAD_MODE, not
  // FAL_UPLOAD_MODE, and a label naming the wrong one sends people to edit a variable that does
  // nothing for them.
  const assetMode = renderProvider === 'segmind' ? config.segmind.uploadMode
    : renderFamily === 'seedance' ? config.seedance.uploadMode
    : config.fal.uploadMode;
  add('render-assets', !segmindViaFalStorage || !!config.fal.apiKey,
    `render assets reachable (${renderProvider} · ${assetMode})`,
    'set FAL_KEY (fal storage hosts the references Segmind downloads), or set SEGMIND_UPLOAD_MODE=data-uri to inline them and keep this a keyless-fal setup');
  add('backend', beNorm !== null, `render backend valid (${config.render.backend})`,
    `set RENDER_BACKEND to one of: ${RENDER_BACKENDS.join(', ')} in .env`);
  const voices = loadVoices();
  const n = Object.keys(voices).length;
  add('voices', n > 0, `character voices registered (${n})`, 'mint at least one: npm run mint-voice -- <name> <clip>');
  if (renderFamily === 'seedance' && n > 0) {
    // Seedance lip-syncs to the mint-time CLIP, not the voice_id — the file must exist on disk.
    const withClip = Object.keys(voices).filter((name) => getVoiceRefClip(name)).length;
    add('voice-clips', withClip === n, `voice ref clips on disk (${withClip}/${n})`,
      're-mint the missing ones: npm run mint-voice -- <name> <clip> (Seedance lip-syncs to the clip itself)');
  }

  // 2. LLM provider
  const provider = config.llm.provider;
  const keyEnv = PROVIDER_KEY_ENV[provider];
  if (!keyEnv) add('llm', false, `llm.provider "${provider}" is valid`, `use one of: ${Object.keys(PROVIDER_KEY_ENV).join(', ')}`);
  else if (config.llm.transport !== 'cli' && PROVIDER_CLI_ONLY[provider]) {
    add('llm', false, `provider "${provider}" requires LLM_TRANSPORT=cli`, 'set LLM_TRANSPORT=cli (it is CLI-only)');
  } else if (config.llm.transport === 'cli') {
    // Actually probe the binary on PATH — a hardcoded pass here is why selecting a provider whose
    // CLI isn't installed (e.g. openai → `codex`) used to report green. (login is verified separately
    // by the Keys card's "Test connection", which runs pingLlm — too slow/costly for every doctor run.)
    const bin = config.llm.cli.bin || PROVIDER_CLI_BIN[provider];
    add('llm', await probeCliBin(bin), `LLM CLI present (provider ${provider}, bin "${bin}")`,
      `install and log in to the ${bin} CLI (or set LLM_CLI_BIN), then re-check`);
  } else {
    // Check the SELECTED provider's own key (LLM_API_KEY is the intentional cross-provider override),
    // not config.llm.apiKey — that fallback chain lets a Claude key satisfy an OpenAI check.
    const hasKey = !!(env[keyEnv] || env.LLM_API_KEY);
    add('llm', hasKey, `LLM API key for ${provider} (${keyEnv})`, `set ${keyEnv} in .env, or use LLM_TRANSPORT=cli`);
  }

  // 3. ffmpeg / ffprobe
  add('ffmpeg', await whichVersion(config.video.ffmpeg), `ffmpeg present (${config.video.ffmpeg})`, 'install ffmpeg and/or set FFMPEG_BIN');
  add('ffprobe', await whichVersion(config.video.ffprobe), `ffprobe present (${config.video.ffprobe})`, 'install ffmpeg (ffprobe) and/or set FFPROBE_BIN');
  // SOFT: the stitcher only improves CHAINED seams. Without it every cut still assembles, just with
  // a hard cut (and a small lighting pop) at each seam — so this must never block a render.
  add('seamstitch', (await seamstitchAvailable()).ok, 'seamless stitcher available (python3 + numpy + pillow)',
    'pip3 install numpy pillow — optional; without it cuts stitch with hard cuts at every seam');

  // 4. elements
  const inv = buildInventory();
  const refs = inv.filter((e) => e.type === 'reference').length;
  add('references', refs > 0, `reference images found (${refs})`, 'add at least one image under elements/references/');

  return checks;
}

/** The subset of failed checks that are HARD (block a render). */
export function hardFailures(checks) {
  return checks.filter((c) => !c.ok && !isSoft(c));
}

/** Render the checks[] as the padded report + summary line (byte-identical to doctor's output). */
export function formatChecks(checks) {
  const pad = Math.max(...checks.map((c) => c.label.length));
  let out = '';
  for (const c of checks) out += `${c.ok ? '✅' : '❌'}  ${c.label.padEnd(pad)}${c.ok ? '' : `   → ${c.hint}`}\n`;
  const failed = checks.filter((c) => !c.ok);
  const hard = hardFailures(checks);
  out += `\n${failed.length ? `${failed.length} issue(s)` : 'All checks passed'} — ${hard.length ? 'fix the ❌ above before rendering.' : 'ready.'}\n`;
  return out;
}

export default { runChecks, hardFailures, formatChecks, whichVersion, probeCli, probeCliBin, isSoft, SOFT };
