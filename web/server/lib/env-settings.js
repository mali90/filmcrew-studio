// Read/preview/write the host repo's .env for the wizard + settings — built on the host's
// env-file.js primitives (ordered entries, comments preserved, blank clears a key). Secrets are
// always MASKED on the way out; the server never returns a stored key's full value.
import path from 'node:path';

const SECRET_RE = /KEY|SECRET|TOKEN|PASSWORD/i;

export const mask = (v) => {
  const s = String(v ?? '');
  if (!s) return '(blank)';
  return `${s.slice(0, 4)}${'•'.repeat(Math.max(0, Math.min(12, s.length - 4)))}${s.length > 10 ? `(${s.length})` : ''}`;
};
const shown = (key, value) => (SECRET_RE.test(key) ? mask(value) : String(value ?? ''));

export function createEnvSettings({ root, envRoot = root, envFile }) {
  return {
    /** Ordered kv rows, secrets masked; plus which file backs them (.env vs the example seed). */
    async read() {
      const { readEnvFileOrExample, parseEnv, getEnvValue } = await import(path.join(root, 'src/lib/env-file.js'));
      const { text, source } = readEnvFileOrExample(envRoot);
      const entries = parseEnv(text);
      const rows = entries.filter((e) => e.type === 'kv').map((e) => ({ key: e.key, value: shown(e.key, e.value), secret: SECRET_RE.test(e.key), set: !!e.value }));
      return { source, rows, get: (k) => getEnvValue(entries, k) };
    },
    /** Masked change preview — what POST /env would write, without writing it. */
    async preview(updates) {
      const { readEnvFileOrExample, parseEnv, upsertEnv } = await import(path.join(root, 'src/lib/env-file.js'));
      const { text } = readEnvFileOrExample(envRoot);
      const entries = parseEnv(text);
      const before = Object.fromEntries(entries.filter((e) => e.type === 'kv').map((e) => [e.key, e.value]));
      const { changed } = upsertEnv(entries, updates);
      return {
        rows: changed.map((key) => ({ key, from: shown(key, before[key]), to: shown(key, updates[key]) })),
        overwritingReal: changed.some((key) => before[key] && SECRET_RE.test(key)),
      };
    },
    /** Apply updates to <envRoot>/.env (seeding from .env.example when absent). */
    async write(updates) {
      const { readEnvFileOrExample, parseEnv, upsertEnv, writeEnv } = await import(path.join(root, 'src/lib/env-file.js'));
      const { text } = readEnvFileOrExample(envRoot);
      const { entries, changed } = upsertEnv(parseEnv(text), updates);
      writeEnv(envFile ?? path.join(envRoot, '.env'), entries);
      return { written: changed };
    },
  };
}

export default { createEnvSettings, mask };
