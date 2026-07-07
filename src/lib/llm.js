// Provider-agnostic LLM layer for the engine. One `complete({prompt, system}) -> text`
// dispatches on config.llm.provider × transport:
//   transport 'api' — HTTP call to the provider (Anthropic | OpenAI/Codex | Gemini). Most portable.
//   transport 'cli' — spawn a logged-in agent CLI (claude | codex | gemini), locally or over SSH.
// Adding a provider = one entry in PROVIDERS below; nothing else in the engine changes.
import { spawn } from 'node:child_process';
import config from '../../config.js';
import log from './logger.js';
import { fetchJson } from './util.js';

const LLM = config.llm;
const LLM_TIMEOUT = { retries: 2, timeoutMs: 180000 };

/** Simple {{var}} substitution for prompt templates. */
export function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? '').toString());
}

/** Pull the first balanced JSON object out of arbitrary model text (strips ``` fences + prose). */
export function extractJson(text) {
  if (typeof text !== 'string') return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}

// ── Provider adapters ────────────────────────────────────────────────────────
const PROVIDERS = {
  claude: {
    keyEnv: 'ANTHROPIC_API_KEY',
    cliBin: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    installMethod: 'native', // Anthropic's official installer (curl|bash), not npm — see cli-install.js
    cliArgs: (model) => ['-p', '--model', model],
    async api({ model, system, prompt, temperature, maxTokens, apiKey }) {
      const body = {
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      };
      const data = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, LLM_TIMEOUT);
      return (data.content ?? []).map((b) => b.text ?? '').join('').trim();
    },
  },

  openai: {
    keyEnv: 'OPENAI_API_KEY',
    cliBin: 'codex',
    npmPackage: '@openai/codex',
    cliArgs: (model) => (model ? ['exec', '--model', model] : ['exec']),
    async api({ model, system, prompt, temperature, maxTokens, apiKey }) {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      }, LLM_TIMEOUT);
      return (data.choices?.[0]?.message?.content ?? '').trim();
    },
  },

  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    cliBin: 'gemini',
    npmPackage: '@google/gemini-cli',
    cliArgs: (model) => ['-m', model],
    async api({ model, system, prompt, temperature, maxTokens, apiKey }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      };
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, LLM_TIMEOUT);
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return parts.map((p) => p.text ?? '').join('').trim();
    },
  },

  // GitHub Copilot CLI (`copilot`). CLI-only here — no plain chat HTTP API in this wrapper.
  // The prompt is piped via stdin (no size limit); do NOT pass -p (that would ignore stdin).
  // Auth is GitHub's (run `copilot` once to log in, or set GITHUB_TOKEN). Set LLM_MODEL to a
  // Copilot model id (e.g. claude-sonnet-4.5, gpt-5); omit to use Copilot's default model.
  copilot: {
    keyEnv: 'GITHUB_TOKEN',
    cliOnly: true,
    cliBin: 'copilot',
    npmPackage: '@github/copilot',
    cliArgs: (model) => (model ? ['--model', model] : []),
    api() { throw new Error('Provider "copilot" is the GitHub Copilot CLI — set LLM_TRANSPORT=cli (no chat HTTP API).'); },
  },
};

/** Run a child process, piping `input` to stdin, resolving with stdout. */
function run(cmd, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      // some CLIs (claude) print their diagnostics to stdout — never swallow them
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ').slice(-2000);
      reject(new Error(`${cmd} exited ${code}: ${detail || '(no output)'}`));
    });
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  });
}

/** transport:'cli' — spawn the provider CLI (locally or over SSH) and return its stdout text.
 *  NOTE: agent-CLI flags vary by tool/version; override the binary with LLM_CLI_BIN and adjust
 *  the per-provider cliArgs() above if your installed CLI differs. The 'api' transport is the
 *  recommended, most portable path. */
async function completeViaCli(p, prompt) {
  const bin = LLM.cli.bin || p.cliBin;
  const args = [...p.cliArgs(LLM.model), ...(LLM.cli.args ?? [])];
  if (LLM.ssh.host) {
    const keyPrefix = LLM.apiKey ? `${p.keyEnv}=${LLM.apiKey} ` : '';
    const remoteCmd = `${keyPrefix}${bin} ${args.join(' ')}`;
    const sshArgs = [];
    if (LLM.ssh.key) sshArgs.push('-i', LLM.ssh.key);
    sshArgs.push('-o', 'StrictHostKeyChecking=accept-new', `${LLM.ssh.user}@${LLM.ssh.host}`, remoteCmd);
    log.info(`LLM via ${bin} over SSH @ ${LLM.ssh.user}@${LLM.ssh.host}`);
    return (await run('ssh', sshArgs, { input: prompt })).trim();
  }
  const env = { ...process.env };
  if (LLM.apiKey) env[p.keyEnv] = LLM.apiKey;
  log.info(`LLM via ${bin} CLI (model ${LLM.model})`);
  return (await run(bin, args, { env, input: prompt })).trim();
}

/**
 * Generate a completion from the configured provider. Returns plain text.
 * @param {{prompt: string, system?: string}} p
 */
export async function complete({ prompt, system }) {
  const provider = PROVIDERS[LLM.provider];
  if (!provider) throw new Error(`Unknown llm.provider "${LLM.provider}" (use: ${Object.keys(PROVIDERS).join(' | ')}).`);

  if (LLM.transport === 'cli') return completeViaCli(provider, prompt);

  if (provider.cliOnly) {
    throw new Error(`Provider "${LLM.provider}" is CLI-only — set LLM_TRANSPORT=cli (it drives the ${provider.cliBin} CLI).`);
  }
  if (!LLM.apiKey) {
    throw new Error(
      `No LLM API key set for provider "${LLM.provider}" — set ${provider.keyEnv} (or LLM_API_KEY) in .env, ` +
      `or use LLM_TRANSPORT=cli with a logged-in ${provider.cliBin} CLI.`,
    );
  }
  log.info(`LLM via ${LLM.provider} API (model ${LLM.model})`);
  const text = await provider.api({
    model: LLM.model, system, prompt,
    temperature: LLM.temperature, maxTokens: LLM.maxTokens, apiKey: LLM.apiKey,
  });
  if (!text) throw new Error(`${LLM.provider} returned an empty completion`);
  return text;
}

/**
 * Like complete(), but every provider/transport/model/apiKey is passed EXPLICITLY instead of read
 * from the module-level config snapshot. The init wizard uses this to talk to the provider the user
 * JUST chose (config.llm was frozen at import and wouldn't reflect it). Local spawn only (no SSH).
 * @param {{provider:string, transport?:string, model?:string, apiKey?:string, prompt:string,
 *          system?:string, maxTokens?:number, temperature?:number}} p
 */
export async function completeWith({ provider, transport = 'api', model, apiKey, prompt, system, maxTokens = 1024, temperature = 0.7, env: envOverride }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider "${provider}" (use: ${Object.keys(PROVIDERS).join(' | ')}).`);
  if (transport === 'cli') {
    // `env` (when given) is the EXACT environment the caller's real jobs will run with — the web
    // server validates with its child env so "valid" at setup time means valid at render time.
    const env = { ...(envOverride ?? process.env) };
    if (apiKey) env[p.keyEnv] = apiKey;
    // Honor LLM_CLI_BIN / LLM_CLI_ARGS (like completeViaCli) so a test/fake CLI can be injected.
    const bin = envOverride?.LLM_CLI_BIN || LLM.cli.bin || p.cliBin;
    const args = [...p.cliArgs(model), ...(LLM.cli.args ?? [])];
    return (await run(bin, args, { env, input: prompt })).trim();
  }
  if (p.cliOnly) throw new Error(`Provider "${provider}" is CLI-only — set transport=cli (${p.cliBin}).`);
  if (!apiKey) throw new Error(`No API key provided for "${provider}".`);
  return p.api({ model, system, prompt, temperature, maxTokens, apiKey });
}

/** A cheap 1-token auth check for the given provider config; throws if the key/CLI login is bad.
 *  Returns the model's (tiny) reply. Used by the init wizard to validate an LLM choice live. */
export function pingLlm({ provider, transport, model, apiKey, env }) {
  return completeWith({ provider, transport, model, apiKey, env, prompt: 'Reply with the single word: ok', system: 'You are a setup probe. Reply with exactly: ok', maxTokens: 16, temperature: 0 });
}

/** Provider metadata — used by doctor.js for preflight. */
export const PROVIDER_KEY_ENV = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.keyEnv]));
export const PROVIDER_CLI_BIN = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.cliBin]));
export const PROVIDER_CLI_ONLY = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, !!v.cliOnly]));
// provider → the npm package that installs its CLI (the web app's one-click install + docs/PROVIDERS.md).
export const PROVIDER_NPM_PKG = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.npmPackage]));
// provider → how the web app installs its CLI: 'native' (official installer script) or 'npm' (default).
export const PROVIDER_INSTALL_METHOD = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.installMethod || 'npm']));

export default { complete, completeWith, pingLlm, extractJson, renderTemplate, PROVIDER_KEY_ENV, PROVIDER_CLI_BIN, PROVIDER_CLI_ONLY, PROVIDER_NPM_PKG, PROVIDER_INSTALL_METHOD };
