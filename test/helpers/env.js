// Env discipline for tests. config.js snapshots process.env at import (and `import 'dotenv/config'`
// reads the real .env), and many modules snapshot config at import — so a test MUST set env BEFORE
// dynamic-importing the module under test. ESM hoists static imports above assignments, so config
// modules are ALWAYS loaded via `await import(...)`, never a static top-of-file import.
import path from 'node:path';

/** Point dotenv at a nonexistent file so a developer's real .env can never leak into a test. */
export function neutralizeDotenv() {
  process.env.DOTENV_CONFIG_PATH = path.join('/nonexistent', '.env.for.tests');
}

/** Baseline test env: no real keys, quiet logs, transports pointed nowhere real by default. */
export function baseEnv(extra = {}) {
  neutralizeDotenv();
  const base = {
    LOG_LEVEL: 'error',
    // Ensure no real credentials are ever present unless a test sets fakes explicitly.
    FAL_KEY: '', FAL_API_KEY: '',
    LLM_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '',
  };
  Object.assign(process.env, base, extra);
  return process.env;
}

/** Set `vars`, run `fn` (which should dynamic-import the module under test), then restore env. */
export async function withEnv(vars, fn) {
  const saved = { ...process.env };
  neutralizeDotenv();
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
