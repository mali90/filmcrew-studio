// The prompt-overrides sidecar: a user's hand-edited prompts for one run, kept beside the run as
// <runDir>/prompt-overrides.json so it survives a revise pass and can be snapshotted into a take.
//
// This is the READ half — parse + shape validation, pure and config-free. It exists here (rather
// than inside a CLI) so the CLIs, the pipeline and web/server all reject a malformed sidecar with
// the same message, BEFORE anything is submitted: a typo in an override must cost nothing.
//
// Shape:
//   { schema: 1, jobs: { "<job_id>": { prompt: "…", segments?: ["…", …],
//                                      fingerprint?: "…", updatedAt?: "…" } } }
//   `prompt`      — the whole job prompt (Seedance, one document per job)
//   `segments`    — one entry per shot (Kling, whose budget is per segment)
//   `fingerprint` — promptFingerprint(spec, jobId) at the moment the edit was saved; a mismatch
//                   against today's plan is what marks the override stale in the UI
//   `updatedAt`   — when it was saved
//
// What is NEVER in here: the system front matter, the identity clause and the seam pin sentences.
// Those are re-composed at render time (prompt-compose.applyOverride) because they name reference
// labels — `@Image3` — that only exist once a particular render has laid its references out.
import fs from 'node:fs';
import path from 'node:path';

export const OVERRIDES_FILE = 'prompt-overrides.json';
export const OVERRIDES_SCHEMA = 1;

/**
 * Parse and validate an overrides sidecar.
 * @param {string} file  absolute path
 * @returns {{schema:number, jobs:Record<string,{prompt?:string, segments?:string[]}>}}
 * @throws with the path the user typed, so a bad flag reads as a bad flag
 */
export function readPromptOverrides(file) {
  if (!fs.existsSync(file)) throw new Error(`prompt overrides: no such file — ${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`prompt overrides: ${file} is not valid JSON (${e.message})`);
  }
  return validatePromptOverrides(raw, file);
}

/** The same checks against an already-parsed object (the server holds one in memory). */
export function validatePromptOverrides(raw, where = 'prompt overrides') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: expected an object with { schema, jobs }`);
  if (raw.schema !== undefined && raw.schema !== OVERRIDES_SCHEMA) {
    throw new Error(`${where}: unknown schema ${JSON.stringify(raw.schema)} — this build writes schema ${OVERRIDES_SCHEMA}`);
  }
  const jobs = raw.jobs ?? {};
  if (typeof jobs !== 'object' || Array.isArray(jobs)) throw new Error(`${where}: "jobs" must be an object keyed by job id`);
  for (const [jobId, entry] of Object.entries(jobs)) {
    if (!entry || typeof entry !== 'object') throw new Error(`${where}: jobs.${jobId} must be an object`);
    if (entry.prompt !== undefined && typeof entry.prompt !== 'string') throw new Error(`${where}: jobs.${jobId}.prompt must be a string`);
    if (entry.segments !== undefined) {
      if (!Array.isArray(entry.segments) || entry.segments.some((s) => typeof s !== 'string')) {
        throw new Error(`${where}: jobs.${jobId}.segments must be an array of strings (one per shot)`);
      }
    }
    if (entry.prompt === undefined && entry.segments === undefined) {
      throw new Error(`${where}: jobs.${jobId} carries neither "prompt" nor "segments" — remove it or write one`);
    }
  }
  // Handed back with NO prototype: callers look an arbitrary (validated) job id up in this map, and
  // on a plain object `jobs['toString']` answers with an inherited function — an "edit" the renderer
  // would then act on for a job that has none. JSON.parse defines even `__proto__` as an ordinary
  // own key, so a sidecar that really names one is copied across unharmed.
  return { schema: OVERRIDES_SCHEMA, jobs: Object.assign(Object.create(null), jobs) };
}

/**
 * The override a RUN DIR carries for one job, or null. This is the renderers' entry point: the
 * pipeline snapshots the sidecar into the take dir before anything is submitted, so a renderer only
 * ever has to ask its own `runDir`. A malformed sidecar throws (before submit, so it costs nothing)
 * rather than quietly rendering the agents' text — silently ignoring an edit is the one failure a
 * user cannot see in the output.
 * @param {string} runDir
 * @param {string} jobId
 * @returns {{prompt?:string, segments?:string[]}|null}
 */
export function readJobOverride(runDir, jobId) {
  const file = path.join(String(runDir ?? ''), OVERRIDES_FILE);
  if (!fs.existsSync(file)) return null;
  return readPromptOverrides(file).jobs?.[jobId] ?? null;
}

export default { readPromptOverrides, validatePromptOverrides, readJobOverride, OVERRIDES_FILE, OVERRIDES_SCHEMA };
