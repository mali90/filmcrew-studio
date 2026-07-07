#!/usr/bin/env node
// Guided setup wizard — the friendly replacement for the long manual README.
//   npm run init            (interactive)
//   npm run init -- --yes   (accept defaults, skip optional spends)
//   flags: --no-ai (never use the LLM), --force (overwrite .env values without confirming),
//          --provider <p>, --brief "..."
//
// Design: a DETERMINISTIC backbone (menus, live key validation, safe .env writing) that works with
// NO AI. AI (via the project's own LLM engine) is layered on ONLY where it helps — interpreting
// "what do you want to make?", rewriting failed checks in plain English, and drafting starter
// briefs — and every AI touchpoint falls back cleanly. Because config.js snapshots the environment
// at import (so a freshly-entered key isn't visible to this process), the wizard validates keys with
// explicit-arg helpers and runs doctor/mint/render as CHILD `node` processes that re-read the new .env.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import config, { ROOT } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { whichVersion, probeCliBin } from '../lib/preflight.js';
import { modelDefault } from '../lib/models.js';
import { PROVIDER_KEY_ENV, PROVIDER_CLI_BIN, PROVIDER_CLI_ONLY, completeWith, pingLlm, extractJson } from '../lib/llm.js';
import { validateFal } from '../lib/fal.js';
import { parseEnv, upsertEnv, writeEnv, readEnvFileOrExample } from '../lib/env-file.js';

const args = parseArgs();
const AUTO = !!args.yes;                 // accept defaults / skip optional spends
const NO_AI = !!args['no-ai'];           // never call the LLM
const FORCE = !!args.force;              // overwrite existing .env values without confirming
const INTERACTIVE = process.stdin.isTTY && process.stdout.isTTY;

// ── Reference data ──────────────────────────────────────────────────────────
const KEY_URL = {
  fal: 'https://fal.ai/dashboard/keys',
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/app/apikey',
};
const FFMPEG_HINT = {
  darwin: "brew install ffmpeg   (first install Homebrew from https://brew.sh if you don't have it)",
  win32: 'winget install -e --id Gyan.FFmpeg   (then close and reopen this terminal)',
  linux: "sudo apt install ffmpeg   (or your distro's package manager)",
};
// The LLM key precedence in config.js (LLM_API_KEY → ANTHROPIC → OPENAI → GEMINI): a stale key of the
// WRONG provider would silently win, so on every provider choice we blank all of these and set only
// the chosen provider's. (GITHUB_TOKEN for copilot is NOT in this chain and is left untouched.)
const FALLBACK_KEYS = ['LLM_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
const isSecret = (k) => /_KEY$|_TOKEN$|^FAL_KEY$/.test(k);
const mask = (v) => (v ? `${'*'.repeat(Math.min(8, v.length))}${v.length > 8 ? `…(${v.length})` : ''}` : '(blank)');

// ── Small prompt/helpers (no dependency; readline/promises) ──────────────────
let rl;
async function ask(q, def = '') {
  const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
  return a || def;
}
async function confirm(q, def = true) {
  if (AUTO) return def;
  const a = (await rl.question(`${q} ${def ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
  return a ? a.startsWith('y') : def;
}
async function choose(q, options, defIdx = 0) {
  process.stdout.write(`${q}\n`);
  options.forEach((o, i) => process.stdout.write(`  ${i + 1}) ${o.label}\n`));
  if (AUTO) return options[defIdx].value;
  for (;;) {
    const a = (await rl.question(`Choose 1-${options.length} [${defIdx + 1}]: `)).trim() || String(defIdx + 1);
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    process.stdout.write('  Please enter a valid number.\n');
  }
}

/** Print a URL and (interactively) offer to open it in the default browser. */
async function offerUrl(label, url) {
  process.stdout.write(`  ${label}: ${url}\n`);
  if (INTERACTIVE && !AUTO && (await confirm('  Open this page in your browser?', true))) openUrl(url);
}
function openUrl(url) {
  const map = { darwin: ['open', [url]], win32: ['cmd', ['/c', 'start', '', url]], linux: ['xdg-open', [url]] };
  const [cmd, cmdArgs] = map[process.platform] || ['xdg-open', [url]];
  try { const c = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref(); } catch { /* no opener — the URL was printed */ }
}

/** Spawn a project CLI as a child `node` process (re-reads the fresh .env). Streams output; when
 *  `capture`, also returns the collected stdout. Resolves {code, out}. */
function runScript(relScript, scriptArgs = [], { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, relScript), ...scriptArgs], {
      cwd: ROOT, stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    });
    let out = '';
    if (capture) child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.on('error', (e) => resolve({ code: 1, out, error: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

// ── Non-interactive path (piped stdin / CI): never prompt, spend, or open URLs ──
async function nonInteractive() {
  log.step('Setup (non-interactive)');
  const { path: envPath, text, source } = readEnvFileOrExample(ROOT);
  if (source === '.env.example') { writeEnv(envPath, parseEnv(text)); log.info('Created .env from .env.example — edit it to add your keys.'); }
  else if (source === 'none') log.warn('No .env or .env.example found.');
  else log.info('.env already present.');
  process.stdout.write('\nThis wizard is interactive. Run it in a terminal:\n  npm run init\n\nRunning a read-only health check now:\n\n');
  await runScript('src/cli/doctor.js', [], { capture: true });
  process.stdout.write('\nWhen the checks pass, make a video:  npm run engine -- --brief "your idea" --render\n');
  // Setup itself succeeded (seeded/confirmed .env); the health check above is advisory — its failing
  // checks (missing keys/CLIs, expected on a fresh box or in CI) must not make `init` exit non-zero.
  process.exit(0);
}

// ── AI touchpoints (each gated on aiAvailable + !NO_AI, each with a fallback) ──
let aiAvailable = false;
let llm = null; // { provider, transport, model, apiKey }

async function ai(prompt, system) {
  return completeWith({ ...llm, prompt, system, maxTokens: 700, temperature: 0.5 });
}

async function main() {
  if (!INTERACTIVE) return nonInteractive();

  rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Step 0 — Welcome
    log.step('Welcome to Filmcrew Studio');
    process.stdout.write(
      'This sets you up to turn a one-line idea into a short AI video.\n' +
      'It writes a local .mp4 only (it never posts anywhere). Rendering and the AI planner use paid\n' +
      'API providers — this wizard will help you connect them and will confirm before anything costs money.\n\n',
    );

    // Step 1 — System probe
    log.step('Step 1 — Checking your system');
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    process.stdout.write(`  Node.js ${process.versions.node} — ${nodeMajor >= 20 ? 'OK' : 'TOO OLD (need 20+, install the latest LTS)'}\n`);
    const hasFfmpeg = await whichVersion(config.video.ffmpeg);
    const hasFfprobe = await whichVersion(config.video.ffprobe);
    process.stdout.write(`  ffmpeg — ${hasFfmpeg ? 'found' : 'MISSING'}\n  ffprobe — ${hasFfprobe ? 'found' : 'MISSING'}\n`);
    if (!hasFfmpeg || !hasFfprobe) {
      process.stdout.write(`  Install ffmpeg (includes ffprobe): ${FFMPEG_HINT[process.platform] || FFMPEG_HINT.linux}\n`);
      process.stdout.write('  You can finish setup now and install ffmpeg before you render — doctor re-checks at the end.\n');
    }

    // Step 2 — Intent (captured now; AI mapping happens after the LLM is configured)
    log.step("Step 2 — What do you want to make?");
    const intent = args.brief ? String(args.brief) : (AUTO ? '' : await ask('In one line, describe the video you want (or press Enter to skip)'));

    // Accumulated .env changes (written once in Step 6).
    const updates = {};

    // Step 3 — Configure the AI planner (LLM). Deterministic; unlocks AI for later steps.
    log.step('Step 3 — Connect the AI planner (LLM)');
    llm = await configureLlm();
    for (const k of FALLBACK_KEYS) updates[k] = '';                 // clear the whole precedence chain…
    updates.LLM_PROVIDER = llm.provider;
    updates.LLM_TRANSPORT = llm.transport;
    updates.LLM_MODEL = llm.model || '';
    if (llm.transport === 'api' && llm.apiKey) updates[PROVIDER_KEY_ENV[llm.provider]] = llm.apiKey; // …then set the chosen one

    // Step 4 — Intent → preset (AI-assisted, menu fallback)
    log.step('Step 4 — Video settings');
    const preset = await resolvePreset(intent);
    if (preset.aspectRatio !== '9:16') updates.KLING_ASPECT = preset.aspectRatio;
    if (preset.resolution !== '1080p') updates.KLING_RESOLUTION = preset.resolution;
    if (preset.upscale) updates.UPSCALE_ENABLED = 'true';

    // Step 5 — Configure the fal renderer + validate its key live (no spend)
    log.step('Step 5 — Connect the video renderer (fal.ai)');
    await configureRenderer(updates);

    // Step 6 — Write .env safely
    log.step('Step 6 — Saving your settings to .env');
    await writeEnvFile(updates);

    // Step 7 — Optional character voice
    if (preset.wantsVoices && !AUTO) {
      log.step('Step 7 — Optional: a character voice');
      await maybeMintVoice();
    }

    // Step 8 — Health check (child process reads the fresh .env) + AI-friendly fixes
    log.step('Step 8 — Health check');
    const doctor = await runScript('src/cli/doctor.js', [], { capture: true });
    await explainFailures(doctor.out);

    // Step 9 — Optional cheap test render
    if (!AUTO) {
      log.step('Step 9 — Optional: a cheap test render');
      await maybeTestRender();
    }

    // Step 10 — Starter briefs + cheat-sheet
    log.step("Step 10 — You're set up!");
    await printStarterBriefs(intent);
    printCheatSheet();
  } finally {
    rl?.close();
  }
}

// ── Step 3: LLM ──────────────────────────────────────────────────────────────
async function configureLlm() {
  const providers = Object.keys(PROVIDER_KEY_ENV); // claude | openai | gemini | copilot
  // Auto-detect installed provider CLIs (a present binary is a candidate; the ping confirms login).
  const detected = [];
  for (const p of providers) if (await probeCliBin(PROVIDER_CLI_BIN[p])) detected.push(p);
  if (detected.length) process.stdout.write(`  Detected CLI(s) you may already be logged into: ${detected.map((p) => PROVIDER_CLI_BIN[p]).join(', ')}\n`);

  for (;;) {
    const opts = [];
    for (const p of detected) opts.push({ label: `Use your logged-in ${PROVIDER_CLI_BIN[p]} CLI (${p}) — no API key needed`, value: { provider: p, transport: 'cli' } });
    for (const p of providers) opts.push({ label: `${p}${PROVIDER_CLI_ONLY[p] ? ' (CLI only)' : ' (paste an API key)'}`, value: { provider: p, transport: 'menu' } });

    let choice = args.provider ? { provider: String(args.provider), transport: 'menu' } : await choose('  Which AI planner do you want to use?', opts, 0);
    const provider = choice.provider;
    let transport = choice.transport;
    let apiKey;

    if (PROVIDER_CLI_ONLY[provider]) {
      transport = 'cli';
      if (Number(process.versions.node.split('.')[0]) < 22) { process.stdout.write(`  ${provider} needs Node 22+ and a logged-in ${PROVIDER_CLI_BIN[provider]} CLI. Choose another provider or upgrade Node.\n`); continue; }
      process.stdout.write(`  Using the ${PROVIDER_CLI_BIN[provider]} CLI — make sure you've run \`${PROVIDER_CLI_BIN[provider]}\` once to log in.\n`);
    } else if (transport === 'menu') {
      transport = await choose(`  How do you want to connect to ${provider}?`, [
        { label: 'Paste an API key (simplest)', value: 'api' },
        { label: `Use the logged-in ${PROVIDER_CLI_BIN[provider]} CLI`, value: 'cli' },
      ], 0);
    }

    if (transport === 'api') {
      await offerUrl(`Get a ${provider} API key`, KEY_URL[provider]);
      apiKey = await ask(`  Paste your ${provider} API key`);
      if (!apiKey) { process.stdout.write('  No key entered — let’s try again.\n'); continue; }
    }
    const model = await ask('  Model id (press Enter for the default)', modelDefault(provider) || '');

    // Live validation (skipped under --no-ai / --yes).
    if (NO_AI || AUTO) { process.stdout.write('  (skipping the live check)\n'); return { provider, transport, model, apiKey }; }
    process.stdout.write('  Checking the connection… ');
    try {
      await pingLlm({ provider, transport, model, apiKey });
      process.stdout.write('OK ✅\n');
      aiAvailable = true;
      return { provider, transport, model, apiKey };
    } catch (e) {
      process.stdout.write('failed ❌\n');
      process.stdout.write(`  ${String(e.message).split('\n')[0].slice(0, 240)}\n`);
      if (transport === 'cli') process.stdout.write(`  Tip: run \`${PROVIDER_CLI_BIN[provider]}\` once in a terminal to log in, then retry.\n`);
      if (!(await confirm('  Try a different provider / key?', true))) return { provider, transport, model, apiKey };
    }
  }
}

// ── Step 4: preset ───────────────────────────────────────────────────────────
const ASPECTS = ['9:16', '16:9', '1:1'];
const RESOLUTIONS = ['720p', '1080p', '4k'];
export function sanitizePreset(p = {}) {
  return {
    aspectRatio: ASPECTS.includes(p.aspectRatio) ? p.aspectRatio : '9:16',
    resolution: RESOLUTIONS.includes(p.resolution) ? p.resolution : '1080p',
    wantsVoices: !!p.wantsVoices,
    upscale: !!p.upscale,
  };
}
async function resolvePreset(intent) {
  let preset = null;
  if (aiAvailable && !NO_AI && intent) {
    try {
      process.stdout.write('  Asking the AI to suggest settings for your idea… ');
      const text = await ai(
        `The user wants to make: "${intent}".\nReturn ONLY JSON: {"aspectRatio":"9:16"|"16:9"|"1:1","resolution":"720p"|"1080p"|"4k","wantsVoices":true|false,"upscale":true|false}.\n` +
        `aspectRatio 9:16 unless they mention widescreen/YouTube (16:9) or square (1:1). resolution 1080p by default. wantsVoices true only for talking characters/dialogue. upscale false unless they ask for maximum quality.`,
        'You map a short video idea to render settings. Output only compact JSON, no prose.',
      );
      preset = sanitizePreset(extractJson(text));
      process.stdout.write('done ✅\n');
      process.stdout.write(`  Suggested: shape=${preset.aspectRatio}, quality=${preset.resolution}, character voices=${preset.wantsVoices ? 'yes' : 'no'}, upscale=${preset.upscale ? 'yes' : 'no'}\n`);
      if (AUTO || await confirm('  Use these settings?', true)) return preset;
    } catch (e) { process.stdout.write('skipped (AI unavailable)\n'); log.debug(`preset AI failed: ${e.message}`); preset = null; }
  }
  // Deterministic menus (also used to tweak an AI suggestion).
  const d = preset || sanitizePreset({});
  const aspectRatio = await choose('  Video shape?', [
    { label: 'Vertical 9:16 (TikTok, Reels, Shorts)', value: '9:16' },
    { label: 'Widescreen 16:9 (YouTube)', value: '16:9' },
    { label: 'Square 1:1', value: '1:1' },
  ], ASPECTS.indexOf(d.aspectRatio));
  const resolution = await choose('  Quality?', [
    { label: '1080p (recommended)', value: '1080p' },
    { label: '720p (cheapest)', value: '720p' },
    { label: '4k (most expensive)', value: '4k' },
  ], d.resolution === '720p' ? 1 : d.resolution === '4k' ? 2 : 0);
  const wantsVoices = await confirm('  Do your videos have talking characters with distinct voices?', d.wantsVoices);
  const upscale = await confirm('  Upscale every render with fal Topaz (extra cost)?', d.upscale);
  return sanitizePreset({ aspectRatio, resolution, wantsVoices, upscale });
}

// ── Step 5: fal renderer key + backend ────────────────────────────────────────
async function configureRenderer(updates) {
  process.stdout.write('  Rendering runs on fal.ai over HTTP — one FAL_KEY serves both video models.\n');
  const backend = await choose('  Which video model should render your videos?', [
    { label: 'Kling 3.0 Omni — multi-shot storyboards, per-character minted voices (default)', value: 'kling' },
    { label: 'Seedance 2.0 (ByteDance) — one rich prompt per job, lip-sync from your voice clips', value: 'seedance' },
  ], 0);
  // Always write the key: a blank value clears a stale RENDER_BACKEND=seedance from a previous run
  // of the wizard (blank falls back to the kling default in config.js).
  updates.RENDER_BACKEND = backend === 'kling' ? '' : backend;
  updates.FAL_KEY = await promptValidatedKey('FAL_KEY', KEY_URL.fal, (k) => validateFal(k));
}

/** Prompt for a key and live-validate it (money-safe). Loops on auth failure; accepts with a warning
 *  when the key is valid but the account has no credits. Skips validation under --no-ai/--yes. */
async function promptValidatedKey(envName, url, validate) {
  await offerUrl(`Get your ${envName}`, url);
  for (;;) {
    const key = await ask(`  Paste your ${envName}`);
    if (!key) { if (await confirm('  Leave it blank for now (you can add it later)?', false)) return ''; continue; }
    if (NO_AI || AUTO) return key;
    process.stdout.write('  Checking the key… ');
    const r = await validate(key);
    if (r.ok && r.warn === 'no-credits') { process.stdout.write('valid, but the account has NO CREDITS ⚠️\n  Add credits before you render.\n'); return key; }
    if (r.ok && r.warn === 'inactive-subscription') { process.stdout.write('valid, but the subscription looks inactive ⚠️\n'); return key; }
    if (r.ok) { process.stdout.write('OK ✅\n'); return key; }
    if (r.reason === 'auth') process.stdout.write('that key was rejected ❌\n');
    else { process.stdout.write(`couldn’t verify (${r.reason})\n`); if (await confirm('  Keep this key anyway?', false)) return key; }
  }
}

// ── Step 6: write .env ────────────────────────────────────────────────────────
/** Pure: compute the upsert result + human display rows (secrets masked) for a set of updates. */
export function computeEnvChanges(entries, updates) {
  const before = Object.fromEntries(entries.filter((e) => e.type === 'kv').map((e) => [e.key, e.value]));
  const { entries: next, changed } = upsertEnv(entries, updates);
  const rows = changed.map((k) => {
    const oldV = before[k];
    const newShown = isSecret(k) ? mask(updates[k]) : (updates[k] === '' ? '(blank)' : updates[k]);
    const oldShown = oldV === undefined ? '(new)' : (isSecret(k) ? mask(oldV) : (oldV === '' ? '(blank)' : oldV));
    return { key: k, oldShown, newShown };
  });
  const overwritingReal = changed.some((k) => before[k]); // an existing non-empty value being replaced
  return { next, changed, rows, overwritingReal };
}

async function writeEnvFile(updates) {
  const { path: envPath, text, source } = readEnvFileOrExample(ROOT);
  const { next, changed, rows, overwritingReal } = computeEnvChanges(parseEnv(text), updates);
  if (!changed.length) { process.stdout.write('  Nothing to change — your .env is already up to date.\n'); return; }
  process.stdout.write(`  These ${changed.length} setting(s) will be written to ${path.relative(ROOT, envPath)}${source !== '.env' ? ` (seeded from ${source})` : ''}:\n`);
  for (const r of rows) process.stdout.write(`    ${r.key}: ${r.oldShown} → ${r.newShown}\n`);
  if (overwritingReal && !FORCE && !AUTO && !(await confirm('  Overwrite the existing value(s)?', true))) { process.stdout.write('  Skipped writing .env.\n'); return; }
  writeEnv(envPath, next);
  process.stdout.write(`  Saved ${path.relative(ROOT, envPath)} ✅\n`);
}

// ── Step 7: optional voice mint (reuses the mint-voice CLI → fresh .env) ───────
async function maybeMintVoice() {
  process.stdout.write('  Give a character a persistent voice by "minting" it from a short clip (5–30s, one speaker, clean).\n  This costs about $0.007 (less than a cent), one time per character.\n');
  if (!(await confirm('  Mint a character voice now?', false))) { process.stdout.write('  Skipped — you can do it later with: npm run mint-voice -- <name> <clip>\n'); return; }
  const name = await ask('  Character name (e.g. host)');
  const clip = await ask('  Path to the reference audio clip');
  if (!name || !clip) { process.stdout.write('  Missing name or clip — skipping.\n'); return; }
  if (!fs.existsSync(path.resolve(ROOT, clip))) { process.stdout.write(`  File not found: ${clip} — skipping.\n`); return; }
  const { code } = await runScript('src/cli/mint-voice.js', [name, clip]);
  process.stdout.write(code === 0 ? '  Voice minted ✅\n' : '  Mint failed — you can retry later.\n');
}

// ── Step 8: AI-friendly explanation of any failed checks ──────────────────────
async function explainFailures(doctorOut) {
  const fails = String(doctorOut).split('\n').filter((l) => l.includes('❌'));
  if (!fails.length) return;
  if (!aiAvailable || NO_AI) { process.stdout.write('\n  The ❌ lines above list exactly what to fix (each has a → hint).\n'); return; }
  try {
    process.stdout.write('\n  Asking the AI to explain the remaining issues…\n');
    const text = await ai(`These setup checks failed:\n${fails.join('\n')}\nFor each, give the user ONE short, friendly sentence on exactly what to do. Plain text, one line per issue.`,
      'You are a friendly setup assistant. Be concise and concrete.');
    process.stdout.write(text.split('\n').map((l) => (l.trim() ? `  ${l.trim()}` : '')).join('\n') + '\n');
  } catch (e) { log.debug(`fix AI failed: ${e.message}`); process.stdout.write('  See the → hints on each ❌ line above.\n'); }
}

// ── Step 9: optional small test render ────────────────────────────────────────
async function maybeTestRender() {
  process.stdout.write('  A test render makes the bundled ~13s example video — the cheapest way to confirm everything works.\n  It does cost a little. It uses the bundled example (examples/ocean-lighthouse).\n');
  if (!(await confirm('  Run a small test render now?', false))) { process.stdout.write('  Skipped.\n'); return; }
  const rargs = ['--spec', 'examples/ocean-lighthouse/spec.json'];
  const { code } = await runScript('src/cli/render.js', rargs);
  process.stdout.write(code === 0 ? '  Test render done ✅ — see the out/ folder.\n' : '  Test render failed — check the errors above (often: missing credits).\n');
}

// ── Step 10: starter briefs + cheat-sheet ─────────────────────────────────────
const STATIC_BRIEFS = [
  'a lighthouse keeper watching a storm roll in over the ocean at dusk',
  'a cat food-critic reviewing a bowl of cheese in a tiny restaurant',
  'a street vendor in Tokyo making the perfect bowl of ramen at night',
];
async function printStarterBriefs(intent) {
  let briefs = STATIC_BRIEFS;
  if (aiAvailable && !NO_AI) {
    try {
      const text = await ai(`Suggest 3 one-line video ideas${intent ? ` related to: "${intent}"` : ''}. Output ONLY the 3 lines, no numbering, no extra text.`,
        'You write short, vivid one-line video briefs.');
      const lines = text.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 3);
      if (lines.length) briefs = lines;
    } catch (e) { log.debug(`briefs AI failed: ${e.message}`); }
  }
  process.stdout.write('\n  Try one of these ideas:\n');
  for (const b of briefs) process.stdout.write(`    • ${b}\n`);
}
function printCheatSheet() {
  process.stdout.write(
    '\n  Make a video from a one-line idea:\n' +
    '    npm run engine -- --brief "your idea" --render            # plan it and render it\n' +
    '    npm run engine -- --brief "your idea" --render --probe    # long multi-job videos: first job only\n\n' +
    '  Your finished videos land in:  out/\n' +
    '  Swap in your own character images:  elements/references/\n' +
    '  Re-check your setup any time:  npm run doctor\n\n' +
    '  Full manual/advanced setup lives in docs/ (SETUP.md, PROVIDERS.md, COST.md).\n',
  );
}

// Run only when invoked as a script (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { rl?.close(); log.error(e.stack || e.message); process.exit(1); });
}
