// Spawn a real project CLI as a child process (black-box e2e). Blanks all real credentials and
// neutralizes dotenv so a child can NEVER pick up a developer's real keys; the test supplies fakes.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './fixtures.js';

const BLANK_KEYS = {
  FAL_KEY: '', FAL_API_KEY: '',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '',
};

/** Run `node <relScript> ...args`; resolves { code, stdout, stderr }. */
export function runCli(relScript, args = [], { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, relScript), ...args], {
      cwd: ROOT,
      env: { ...process.env, DOTENV_CONFIG_PATH: '/nonexistent/.env.for.tests', LOG_LEVEL: 'error', ...BLANK_KEYS, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/** Parse the JSON object a CLI prints to stdout (first `{` … last `}`). */
export function jsonTail(stdout) {
  const i = stdout.indexOf('{'); const j = stdout.lastIndexOf('}');
  if (i === -1 || j === -1) return null;
  try { return JSON.parse(stdout.slice(i, j + 1)); } catch { return null; }
}
