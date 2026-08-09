// The prompt-overrides sidecar: a user's hand-edited prompts for one run, kept beside the run as
// <runDir>/prompt-overrides.json so it survives a revise pass and can be snapshotted into a take.
//
// This is the READ half — parse + shape validation, pure and config-free. It exists here (rather
// than inside a CLI) so the CLIs, the pipeline and web/server all reject a malformed sidecar with
// the same message, BEFORE anything is submitted: a typo in an override must cost nothing.
//
// Shape:
//   { schema: 1, jobs: { "<job_id>": { prompt: "…", segments?: ["…", …] } } }
//   `prompt`   — the whole job prompt (Seedance, one document per job)
//   `segments` — one entry per shot (Kling, whose budget is per segment)
import fs from 'node:fs';

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
  return { schema: OVERRIDES_SCHEMA, jobs };
}

export default { readPromptOverrides, validatePromptOverrides, OVERRIDES_FILE, OVERRIDES_SCHEMA };
