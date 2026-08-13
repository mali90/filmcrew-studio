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
 * The values DOTENV would load from this text — the only honest reading for anything that has to
 * agree with a process configured by `import 'dotenv/config'` (the render child, and the web
 * server's prompt preview, which exists to promise "this is exactly what we send").
 *
 * Deliberately not parseEnv: that one is the wizard's line editor and answers a different question
 * — what does line N say, so a rewrite can leave every other byte alone — which is why it keeps a
 * trailing `# comment` inside the value, ignores an `export ` prefix, and reports the FIRST
 * assignment. dotenv strips the comment, accepts the prefix, and lets the LAST assignment win, so
 * an ordinary .env read through the editor's eyes disagrees with the render it is describing.
 * The line grammar and the quote/escape handling below are dotenv@16's own (lib/main.js) — copied
 * rather than approximated, because "close enough" is the same bug in a smaller font.
 */
export function dotenvValues(text) {
  // Null-prototype: a dotenv key is `[\w.-]+`, which spells `__proto__` just fine.
  const out = Object.create(null);
  const lines = String(text ?? '').replace(/\r\n?/mg, '\n');
  const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  for (let m = LINE.exec(lines); m !== null; m = LINE.exec(lines)) {
    let value = (m[2] || '').trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');
    if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    out[m[1]] = value; // a repeated key overwrites, exactly as dotenv's own object write does
  }
  return out;
}

/**
 * How a boolean knob is read out of an environment — config.js's `boolEnv` rule, in the ONE place
 * every mirror of it shares (config.js itself, and the web server's preview/budget mirrors, which
 * may not import config.js).
 *
 * The trim is the whole point, and it belongs next to dotenvValues: reading the .env the same WAY
 * is not enough if the two sides then COERCE the value differently. dotenv keeps padding INSIDE a
 * quoted value, so a dotenv-valid `KLING_CHAIN_FRAMES=" true "` reaches the render child as
 * ` true ` and config.js trims it to ON — while an untrimmed regex reads it OFF, and the preview
 * describes a render nobody is going to pay for. Unset (`undefined`) and empty both mean "not set"
 * and take the caller's default; a string knob is NOT trimmed anywhere, because there the padding
 * is part of the value the child was handed.
 * @param {string|undefined} value  the raw value, as dotenv would have loaded it
 * @param {boolean} dflt            what an unset knob means
 */
export const envBool = (value, dflt) =>
  (value === undefined || value === '' ? dflt : /^(1|true|yes|on)$/i.test(String(value).trim()));

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

export default { parseEnv, getEnvValue, dotenvValues, envBool, upsertEnv, serializeEnv, writeEnv, readEnvFileOrExample };
