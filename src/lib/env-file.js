// Safe .env reader/writer for the init wizard. The wizard — not the human — writes values, which
// kills the classic dotenv syntax mistakes (spaces around `=`, stray quotes, typo'd keys failing
// silently). We parse into ordered entries so comments and untouched lines are preserved verbatim
// on rewrite, and upsert only the keys the wizard actually sets (idempotent re-runs).
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util.js';

// An ACTIVE assignment line: KEY=value (KEY is a shell-style identifier). Commented lines (`# KEY=…`)
// do NOT match — they're preserved as comments, so a template's `# VOICES_DIR=` stays untouched.
const KV = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Parse .env text into ordered entries: {type:'kv',key,value,raw} | {type:'comment'|'blank',raw}. */
export function parseEnv(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline → drop empty tail
  return lines.map((raw) => {
    if (raw.trim() === '') return { type: 'blank', raw };
    if (raw.trimStart().startsWith('#')) return { type: 'comment', raw };
    const m = raw.match(KV);
    if (m) return { type: 'kv', key: m[1], value: m[2], raw };
    return { type: 'comment', raw }; // anything unrecognized is preserved verbatim
  });
}

/** Current value of an active KEY= entry, or undefined. */
export function getEnvValue(entries, key) {
  const e = entries.find((x) => x.type === 'kv' && x.key === key);
  return e ? e.value : undefined;
}

/**
 * Upsert `updates` (a {KEY: value} map) into `entries`: replace an existing active KEY= in place,
 * else append a new `KEY=value` line at the end. Values are written raw (no quotes, no spaces around
 * `=`); a newline in a value is rejected. Returns {entries, changed[]} (changed = keys whose value
 * actually differs). Pass an empty-string value to blank a key (e.g. clearing a wrong provider's key).
 */
export function upsertEnv(entries, updates) {
  const changed = [];
  const next = entries.slice();
  for (const [key, raw] of Object.entries(updates)) {
    if (raw === undefined) continue;
    const value = String(raw);
    if (/[\r\n]/.test(value)) throw new Error(`env value for ${key} contains a newline`);
    const idx = next.findIndex((x) => x.type === 'kv' && x.key === key);
    if (idx >= 0) {
      if (next[idx].value !== value) { next[idx] = { type: 'kv', key, value, raw: `${key}=${value}` }; changed.push(key); }
    } else {
      next.push({ type: 'kv', key, value, raw: `${key}=${value}` });
      changed.push(key);
    }
  }
  return { entries: next, changed };
}

/** Serialize entries back to .env text (trailing newline). */
export function serializeEnv(entries) {
  return entries.map((e) => (e.type === 'kv' ? `${e.key}=${e.value}` : e.raw)).join('\n') + '\n';
}

/** Write entries to `file` (creating parent dirs). */
export function writeEnv(file, entries) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, serializeEnv(entries));
  return file;
}

/** Load the .env to edit: prefer an existing .env, else seed from .env.example, else empty.
 *  Always targets `<root>/.env` for writing. Returns {path, text, source}. */
export function readEnvFileOrExample(root) {
  const envPath = path.join(root, '.env');
  const examplePath = path.join(root, '.env.example');
  if (fs.existsSync(envPath)) return { path: envPath, text: fs.readFileSync(envPath, 'utf8'), source: '.env' };
  if (fs.existsSync(examplePath)) return { path: envPath, text: fs.readFileSync(examplePath, 'utf8'), source: '.env.example' };
  return { path: envPath, text: '', source: 'none' };
}

export default { parseEnv, getEnvValue, upsertEnv, serializeEnv, writeEnv, readEnvFileOrExample };
