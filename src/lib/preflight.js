// Shared preflight checks — the source of truth behind `npm run doctor` and reused by the init
// wizard. runChecks() builds the {ok,label,hint}[] list (no printing / no process.exit); the CLI
// wrapper (src/cli/doctor.js) formats and sets the exit code. Keeping this in a lib (not a CLI)
// lets init.js reuse whichVersion() without a CLI importing another CLI.
import { spawn } from 'node:child_process';
import config from '../../config.js';
import { PROVIDER_KEY_ENV, PROVIDER_CLI_BIN, PROVIDER_CLI_ONLY } from './llm.js';
import { buildInventory } from './elements.js';
import { loadVoices, getVoiceRefClip } from './voices.js';
import { RENDER_BACKENDS } from './spec-schema.js';

// Failed checks whose label starts with one of these are SOFT (a warning, not a hard blocker): you
// may still render a hand-authored spec, or a fal spec with no dialogue, later.
export const SOFT = ['reference images', 'character voices', 'voice ref clips'];

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

/** Run every preflight check and return the {ok,label,hint}[] list (no output, no exit). */
export async function runChecks() {
  const checks = [];
  // `id` is the STABLE machine name — the web app maps it to a fix action (jump to the key form,
  // the guided ffmpeg install, the Cast page). Labels/hints stay human and may change freely.
  const add = (id, ok, label, hint = '') => checks.push({ id, ok, label, hint });

  // 1. fal.ai render credentials, backend choice + character voices.
  add('fal-key', !!config.fal.apiKey, 'FAL_KEY set', 'Get a key at fal.ai/dashboard/keys and put it in .env');
  add('backend', RENDER_BACKENDS.includes(config.render.backend), `render backend valid (${config.render.backend})`,
    `set RENDER_BACKEND to one of: ${RENDER_BACKENDS.join(', ')} in .env`);
  const voices = loadVoices();
  const n = Object.keys(voices).length;
  add('voices', n > 0, `character voices registered (${n})`, 'mint at least one: npm run mint-voice -- <name> <clip>');
  if (config.render.backend === 'seedance' && n > 0) {
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
    const hasKey = !!(process.env[keyEnv] || process.env.LLM_API_KEY);
    add('llm', hasKey, `LLM API key for ${provider} (${keyEnv})`, `set ${keyEnv} in .env, or use LLM_TRANSPORT=cli`);
  }

  // 3. ffmpeg / ffprobe
  add('ffmpeg', await whichVersion(config.video.ffmpeg), `ffmpeg present (${config.video.ffmpeg})`, 'install ffmpeg and/or set FFMPEG_BIN');
  add('ffprobe', await whichVersion(config.video.ffprobe), `ffprobe present (${config.video.ffprobe})`, 'install ffmpeg (ffprobe) and/or set FFPROBE_BIN');

  // 4. elements
  const inv = buildInventory();
  const refs = inv.filter((e) => e.type === 'reference').length;
  add('references', refs > 0, `reference images found (${refs})`, 'add at least one image under elements/references/');

  return checks;
}

/** The subset of failed checks that are HARD (block a render). */
export function hardFailures(checks) {
  return checks.filter((c) => !c.ok && !SOFT.some((s) => c.label.startsWith(s)));
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

export default { runChecks, hardFailures, formatChecks, whichVersion, probeCli, probeCliBin, SOFT };
