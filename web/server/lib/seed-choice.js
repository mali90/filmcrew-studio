// Which seed a paid re-render is sent with — the server side of "fix this take" vs "fresh take".
//
// "Fix" is only honest if the number really is the one the clip on screen rendered from, so it is
// READ BACK off that take's own prompts.json rather than recomputed from a formula and hoped for:
// a take rendered with an explicit seed, or on a build whose default differed, would otherwise be
// "fixed" to a starting point it never had — a paid re-render sold as a targeted tweak that comes
// back as a different clip. The formula is the LAST fallback, not the first answer.
//
// Config-free by construction (node:fs, node:path and the zero-import seed module, nothing else):
// run-service is loaded eagerly by app.js, and anything reaching config.js from here would snapshot
// the real fal/Segmind endpoints before the demo/e2e server points them at its mock. The import
// graph is walked by the canaries in web/server/test/integration/.
import fs from 'node:fs';
import path from 'node:path';
import { seedForJob } from '../../../src/lib/render-seed.js';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// Manifest maps are keyed by JOB ID, and a plan may legitimately name a job `__proto__` — a bare
// lookup would then answer with Object.prototype's member instead of "this job has no record".
const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
// Take ids as this build writes them (nextTakeDir). Validated because the value is joined into a
// filesystem path: a manifest is a file on disk, and a take id is never a reason to leave the run.
const TAKE_ID = /^t\d{1,4}$/;

/** Job order as the SOURCE take rendered it: a re-render take snapshots its plan (snapshotSpec),
 *  and a revision that reordered jobs since must not shift a recovered default onto another
 *  segment's formula. The caller's live index is the fallback for takes that predate snapshots
 *  (a first full render, a legacy run). */
function jobIndexAt({ runDir, take, jobId, jobIndex }) {
  const snap = take ? readJson(path.join(runDir, 'renders', take, 'spec.json')) : null;
  const ids = snap?.kling?.jobs?.map?.((j) => j?.job_id);
  const i = Array.isArray(ids) ? ids.indexOf(jobId) : -1;
  return i === -1 ? jobIndex : i;
}

/** Which take holds this job's CURRENT clip — the one the reviewer is looking at, which is what
 *  "fix this take" means. `clipLineage` is the record composeCut keeps; the clip path is the
 *  fallback for a manifest written before it existed (its take dir is two levels up from the clip). */
function currentTakeOf(manifest, jobId) {
  const recorded = own(manifest?.clipLineage, jobId)?.take;
  if (typeof recorded === 'string' && TAKE_ID.test(recorded)) return recorded;
  const clip = own(manifest?.jobClips, jobId);
  if (typeof clip === 'string' && clip) {
    const take = path.basename(path.dirname(path.dirname(clip)));
    if (TAKE_ID.test(take)) return take;
  }
  return null;
}

/**
 * The seed this job's CURRENT clip was rendered from.
 *
 * The sidecar records the seed honestly in two keys — `seed` is what was SENT, `seed_unused` what an
 * endpoint that accepts none would have been sent — and exactly one is ever non-null, so both are
 * read: a run that switched backends still has a recoverable starting point. With no sidecar at all
 * (a legacy or cleaned take) the manifest take row that queued the re-render is asked next — it
 * records the CHOSEN seed beside the jobId it was chosen for — and only then is the deterministic
 * default recomputed from the take's own prompt nonce, which is what the renderer would have used.
 *
 * @param {{runDir:string, manifest:object|null, jobId:string, jobIndex:number}} args
 * @returns {number} always a number — "fix" must never be the option that cannot be offered
 */
export function currentSeedFor({ runDir, manifest, jobId, jobIndex }) {
  const take = currentTakeOf(manifest, jobId);
  const sidecar = take ? readJson(path.join(runDir, 'renders', take, jobId, 'prompts.json')) : null;
  if (Number.isInteger(sidecar?.seed)) return sidecar.seed;
  if (Number.isInteger(sidecar?.seed_unused)) return sidecar.seed_unused;
  // Sidecar gone (cleaned take dir): the take row still records the seed rerenderJob chose. Matched
  // on BOTH ids — a cascade renders downstream jobs into the primary's take dir, and the primary's
  // chosen seed must never be "fixed" onto a downstream job that rendered from its own default.
  const row = manifest?.takes?.find?.((t) => t && t.id === take && t.jobId === jobId);
  if (Number.isInteger(row?.seed)) return row.seed;
  // `nonce` is the take number the renderer offset its default by; absent/garbage ⇒ 0, which is the
  // plain seedForJob(index, 0) the very first take rendered from — at the index the SOURCE take
  // gave this job, which a later reordering revision does not move.
  return seedForJob(jobIndexAt({ runDir, take, jobId, jobIndex }), Number(sidecar?.nonce) || 0);
}

/** How many times a 'fresh' draw may come back equal to the current seed before it is accepted. */
const FRESH_RETRIES = 2;

/**
 * The seed to send for this re-render, or null when the caller chose no mode (the child then uses
 * its own deterministic default and nothing changes).
 *
 * A 'fresh' draw that happens to equal the seed already on disk would be a paid re-render of the
 * same starting point — the exact money trap this control exists to remove — so it is re-drawn. The
 * retry count is bounded rather than looping: with a 2^31 window a repeat is a coincidence, but an
 * injected `newSeed` that returns a constant must not hang the request.
 *
 * @param {{mode:string|null|undefined, runDir:string, manifest:object|null, jobId:string,
 *          jobIndex:number, newSeed:() => number}} args  `newSeed` is injected by createRunService,
 *   so the drawn number is knowable in tests (it lands in a manifest row, the reply and the argv).
 * @returns {number|null}
 */
export function resolveSeed({ mode, runDir, manifest, jobId, jobIndex, newSeed }) {
  if (mode !== 'fix' && mode !== 'fresh') return null;
  const current = currentSeedFor({ runDir, manifest, jobId, jobIndex });
  if (mode === 'fix') return current;
  let seed = newSeed();
  for (let i = 0; i < FRESH_RETRIES && seed === current; i += 1) seed = newSeed();
  return seed;
}
