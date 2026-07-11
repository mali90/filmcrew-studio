// The per-run `web.json` manifest — the ONLY web-owned state on disk. Everything else (specs,
// clips, render.json, masters) is the CLI's artifact layout, and run status is DERIVED from those
// artifacts (run-scan.js); the manifest only records what disk can't: the idea text, take/revision
// lineage, cost ledger, approval, the last persisted error, and the active child process.
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_V = 1;
export const MANIFEST_FILE = 'web.json';

/** A fresh manifest for a just-created run. */
export function newManifest({ idea, backend, aspect, durationS = null, cast = [], environment = null }, createdAt = new Date().toISOString()) {
  return {
    v: MANIFEST_V,
    idea: String(idea ?? ''),
    backend, aspect,
    durationS, // number of seconds, or null = "auto" (the engine decides)
    cast,     // starred character slugs (their profiles/refs/voices steer the plan)
    environment, // selected world/mood/style bible slug, or null — the engine injects it, revisions re-inject it
    createdAt,
    revisions: [],  // [{id:'r1', feedback, scope, owners, createdAt}]
    takes: [],      // [{id:'t1', mode:'probe'|'full'|'job', jobId?, revision?, composition?, createdAt, estUsd?}]
    cuts: [],       // [{id:'c1', take, composition, master, createdAt}]
    costLedger: [], // [{ts, action, estUsd, note}]
    approved: null, // {cut, final, upscaled, at}
    lastError: null,   // {ts, action, message, logTail:[]}
    activeJob: null,   // {kind, pid, startedAt, queueId}
  };
}

/** Parse `<dir>/web.json`, or null when absent/corrupt (a CLI-created run has none). */
export function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename) so a crash can never leave a half-written manifest. */
export function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${MANIFEST_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmp, path.join(dir, MANIFEST_FILE));
  return manifest;
}

/** Read-modify-write; `fn` mutates (or returns a replacement). Throws when the run has no manifest. */
export function updateManifest(dir, fn) {
  const m = readManifest(dir);
  if (!m) throw new Error(`no web.json in ${dir} — not a web-created run (or it is corrupt)`);
  return writeManifest(dir, fn(m) ?? m);
}

export default { MANIFEST_V, MANIFEST_FILE, newManifest, readManifest, writeManifest, updateManifest };
