// Render a Production Spec → a final mp4. Shared by the `engine --render` and `render` CLIs.
//   validate → render each kling.job on the selected backend (multi-job renders chain last→first
//   frames for a continuous seam) → stitch in job order (native audio, seam-faded) → optional
//   Topaz upscale → out/<project>.mp4
import path from 'node:path';
import fs from 'node:fs';
import config, { resolvePath } from '../../config.js';
import log from './logger.js';
import { ensureDir, writeJson, readJson, slug } from './util.js';
import { validateSpec } from './spec-schema.js';
import { BACKEND_IDS, LEGACY_BACKENDS, capsFor, normalizeBackend } from './render-models.js';
import { renderKlingJobFal } from './fal-kling.js';
import { falAdapter } from './fal-seedance.js';
import { segmindAdapter } from './segmind-seedance.js';
import { renderSeedanceJob } from './render-seedance.js';
import { assembleVideo, grabFrame, lastFrameOf, firstFrameOf } from './assemble.js';
import { readPromptOverrides, OVERRIDES_FILE } from './prompt-overrides.js';
import { readContinuity } from './seamstitch.js';
import { upscaleVideoTopaz, probeDims } from './upscale.js';

// Seedance transports by PROVIDER id — a new provider is a binding module exporting an adapter
// plus one line here. The generalized renderer then runs with EACH ENTRY'S OWN caps, so a sibling
// model (seedance-2.5@fal) or a sibling provider (seedance-2.0@segmind) can never silently render
// through another entry's limits or transport.
const SEEDANCE_ADAPTERS = { fal: falAdapter, segmind: segmindAdapter };

// Render backends — one entry per renderable `<model>@<provider>`, all honoring the same per-job
// contract ({ job, spec, runDir, seed, lowRes, startFrame, nonce }) → { jobId, clip, totalDuration,
// segments }. DERIVED from the render-models registry, and each entry is bound to ITS id's caps —
// so adding a model/provider is a registry entry (+ an adapter for a new provider) and labels can
// never drift from the registry's own names.
export const RENDERERS = (() => {
  const table = {};
  for (const id of BACKEND_IDS) {
    const caps = capsFor(id);
    let render = null;
    if (caps.family === 'kling' && caps.provider === 'fal') {
      // Kling's renderer is fal-specific (elements + bound voice_id have no equivalent elsewhere),
      // but it still stamps THIS entry's canonical id into its prompts.json sidecar — model/provider
      // traceability must not be a Seedance-only property.
      render = (a) => renderKlingJobFal({ ...a, backend: id });
    } else if (caps.family === 'seedance' && SEEDANCE_ADAPTERS[caps.provider]) {
      const adapter = SEEDANCE_ADAPTERS[caps.provider];
      render = (a) => renderSeedanceJob(a, { caps, adapter });
    }
    if (!render) continue; // registry knows the model; this build has no renderer for this entry
    table[id] = { render, label: `${caps.label} (${caps.providerLabel})` };
  }
  // The legacy one-word names are aliases onto the SAME entry object — nothing on disk migrates,
  // and there is exactly one label per backend however it was spelled.
  for (const alias of LEGACY_BACKENDS) {
    const entry = table[normalizeBackend(alias).id];
    if (entry) table[alias] = entry;
  }
  return table;
})();

/**
 * The effective render backend as its CANONICAL `<model>@<provider>` id: CLI flag >
 * spec.render_backend > config default. Legacy one-word names ('kling'/'seedance') are accepted and
 * canonicalized HERE, so everything downstream — render.json's `backend`, the stamped
 * spec.render_backend, the web estimator's price lookup — speaks a single vocabulary.
 * Throws on unknown.
 */
export function resolveBackend(spec, explicit) {
  const name = explicit || spec?.render_backend || config.render.backend;
  const { id } = normalizeBackend(name, { hint: 'RENDER_BACKEND in .env, or --backend' });
  if (!RENDERERS[id]) throw new Error(`Render backend "${id}" has no renderer in this build — use one of: ${Object.keys(RENDERERS).join(', ')}.`);
  return id;
}

/** Deterministic per-job seed (recorded in the renderers' prompts.json sidecars for traceability —
 *  neither fal endpoint accepts a seed input); `take` offsets it so retakes are distinguishable. */
export const seedForJob = (index, take = 0) => 70000 + index * 100 + (Number(take) || 0) * 7;

/** Job ids after `jobId` in stitch order — their seam frames go stale when `jobId` is re-rendered. */
export function downstreamJobs(spec, jobId) {
  const jobs = spec?.kling?.jobs ?? [];
  const idx = jobs.findIndex((j) => j?.job_id === jobId);
  if (idx === -1) throw new Error(`job "${jobId}" not found in spec.kling.jobs`);
  return jobs.slice(idx + 1).map((j) => j.job_id);
}

/**
 * Merge a patch into ONE job's `seam_out` block in its prompts.json. The renderer writes the sidecar
 * before its own clip exists, so the closing frame it hands forward — and the clip that opens on it —
 * can only be stamped once the NEXT job has rendered. Best-effort: the sidecar is a review artifact,
 * never a render input, and a run must not fail because it could not be updated.
 */
function stampSeamOut(runDir, jobId, patch) {
  const file = path.join(runDir, jobId, 'prompts.json');
  try {
    const sidecar = JSON.parse(fs.readFileSync(file, 'utf8'));
    sidecar.seam_out = { ...(sidecar.seam_out ?? {}), ...patch };
    fs.writeFileSync(file, JSON.stringify(sidecar, null, 2));
  } catch { /* the sidecar is best-effort */ }
}

/**
 * The closing frame a job hands to the next one. The PROVIDER's own still (asked for with
 * `return_last_frame`) is the exact image the next segment should open on; an ffmpeg grab is a
 * re-encode of it, so it is the fallback, not the default. Recorded either way — a seam whose
 * provenance is unknown cannot be reasoned about later.
 * @returns {Promise<{frame:string|null, frameSource:'provider'|'ffmpeg'|null}>}
 */
async function closingFrameFor(result, runDir, jobId) {
  if (result.providerLastFrame && fs.existsSync(result.providerLastFrame)) {
    return { frame: result.providerLastFrame, frameSource: 'provider' };
  }
  const frame = await lastFrameOf(result.clip, path.join(runDir, jobId, 'last_frame.png'));
  return { frame, frameSource: frame ? 'ffmpeg' : null };
}

// A still is used as it is; anything else is treated as a CLIP to read a frame out of.
const IS_STILL = /\.(png|jpe?g|webp)$/i;

/**
 * A `--first-frame-from` / `--last-frame-from` value → an actual still on disk.
 *
 * Pointing the flag at a CLIP is the useful case: the clip is where the neighbouring shot lives, so
 * the frame that matters is the one TOUCHING this segment — the neighbour's LAST frame for an
 * opening pin ("start where that clip ended") and its FIRST frame for a closing pin ("end where
 * that clip begins"). Getting that backwards would pin the wrong end of the neighbour and pay for
 * a clip that jumps twice.
 * @param {'in'|'out'} end
 */
export async function resolveBoundaryFrame(input, { end, destDir }) {
  const flag = end === 'in' ? '--first-frame-from' : '--last-frame-from';
  const src = resolvePath(input);
  if (!fs.existsSync(src)) throw new Error(`${flag}: no such file — ${input}`);
  if (IS_STILL.test(src)) return src;
  ensureDir(destDir);
  const png = path.join(destDir, end === 'in' ? 'pin_first_frame.png' : 'pin_last_frame.png');
  const got = end === 'in' ? await lastFrameOf(src, png) : await firstFrameOf(src, png);
  if (!got) throw new Error(`${flag}: could not read a frame out of ${input} — pass a still (.png/.jpg) or a readable video.`);
  return got;
}

/**
 * Boundary-frame PRECEDENCE, decided in ONE place:
 *
 *   1. an explicit `--first-frame-from` / `--last-frame-from` (the operator, right now)
 *   2. the spec's authored `job.first_frame` / `job.last_frame`
 *   3. the chained seam frame (the previous clip's closing still)
 *
 * The renderers only know rules 2–3 (`job.first_frame || startFrame`), so an explicit pin has to
 * reach them as the seam frame with the authored field REMOVED — otherwise a spec that authors an
 * opening frame would quietly ignore the flag and render (and bill for) a boundary nobody asked for.
 * The job is returned untouched when no pin is in play, so an ordinary render is unchanged.
 */
function jobWithPins(job, { startPin = false, endPin = false } = {}) {
  if (!startPin && !endPin) return job;
  const eff = { ...job };
  if (startPin) delete eff.first_frame;
  if (endPin) delete eff.last_frame;
  return eff;
}

/**
 * Copy a validated overrides sidecar into the run dir, where it lives from now on
 * (<runDir>/prompt-overrides.json). Validation already happened at the flag, so a bad file never
 * reaches a submit; this only puts the good one where the run's own readers look for it.
 */
function snapshotPromptOverrides(file, runDir) {
  if (!file) return;
  const parsed = readPromptOverrides(resolvePath(file)); // re-validated: the file may have moved since
  fs.writeFileSync(path.join(runDir, OVERRIDES_FILE), JSON.stringify(parsed, null, 2));
}

/** Where a seam frame really came from: the source take's own record of that job's clip. */
async function seamSourceFor(takeDir, jobId) {
  const prior = await readJson(path.join(takeDir, 'render.json')).catch(() => null);
  const rec = (prior?.jobs ?? []).find((j) => (j.jobId ?? j.job) === jobId);
  return { take: path.basename(takeDir), job: jobId, clip: rec?.clip ?? null };
}

/** First free `<dir>/<base>.mp4`, then `<base>-2.mp4`, `<base>-3.mp4`, … — masters are never overwritten. */
export function uniqueOutPath(dir, base) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}.mp4`);
    if (!fs.existsSync(p)) return p;
  }
}

/**
 * @param {object} spec  a render-ready Production Spec
 * @param {{runDir:string, probe?:boolean, upscale?:boolean, backend?:string, take?:number,
 *          firstFrameFrom?:string, lastFrameFrom?:string, promptOverrides?:string}} opts
 *   `backend` overrides the spec/config backend; `take` (Seedance) varies a regen without a seed.
 *   `firstFrameFrom`/`lastFrameFrom` bracket the RUN — the opening frame pins the FIRST job it
 *   renders, the closing frame the LAST — and outrank both the authored `job.first_frame` and the
 *   chained seam (jobWithPins); `promptOverrides` is a sidecar file snapshotted into the run dir.
 * @returns {Promise<{runDir:string, master?:string, cover?:string, probe?:boolean, jobs:object[]}>}
 */
export async function renderSpec(spec, { runDir, probe = false, upscale = false, backend, take, outName, firstFrameFrom, lastFrameFrom, promptOverrides } = {}) {
  const be = resolveBackend(spec, backend);
  const v = validateSpec(spec, { upTo: 7, backend: be });
  if (!v.ok) throw new Error(`Spec failed validation:\n - ${v.errors.join('\n - ')}`);
  ensureDir(runDir);
  await writeJson(path.join(runDir, 'spec.json'), spec);
  snapshotPromptOverrides(promptOverrides, runDir);

  const jobs = spec.kling.jobs;
  const toRender = probe ? jobs.slice(0, 1) : jobs;
  log.step(`Render — "${spec.project.title}" — ${RENDERERS[be].label} — ${toRender.length}/${jobs.length} job(s)${probe ? ' [PROBE]' : ''}`);

  // Seam continuity for a full multi-job (>15s) render: feed each clip's LAST frame to the NEXT job as
  // its start frame (start_image_url on fal / first_frame seed on cloud) so the cut is continuous
  // instead of the next job starting fresh from the reference Elements. Never on --probe (one job) or
  // when disabled; the chained frame is the LOWEST-ranked opening frame — an explicit
  // --first-frame-from and then a spec-authored job.first_frame both outrank it (see jobWithPins).
  // The audio seam fade (assemble.js) smooths the join under this continuous visual.
  // Skip for a text-to-video (no-element) render on Kling: it has no reference-to-video path to accept
  // a seam start frame, so each job renders independently (Seedance seeds the seam as its lone image).
  const textToVideoKling = capsFor(be).family === 'kling' && !(spec.kling.elements?.length);
  const chain = config.kling.chainFrames && !probe && toRender.length > 1 && !textToVideoKling;
  if (textToVideoKling && !probe && toRender.length > 1) log.info('Kling text-to-video render — seam-chaining disabled (no reference frame); jobs render independently.');
  // Explicit boundary pins bracket the RUN: the opening frame belongs to the first job it renders,
  // the closing frame to the last. Resolved up front so a bad path costs nothing.
  const openPin = firstFrameFrom ? await resolveBoundaryFrame(firstFrameFrom, { end: 'in', destDir: path.join(runDir, toRender[0].job_id) }) : null;
  const closePin = lastFrameFrom ? await resolveBoundaryFrame(lastFrameFrom, { end: 'out', destDir: path.join(runDir, toRender[toRender.length - 1].job_id) }) : null;

  const results = [];
  const takeId = path.basename(runDir); // the lineage's "which take did this frame come from?"
  let startFrame; // previous job clip's last frame; undefined for the first job (unchanged behavior)
  let prev = null; // the previous job's { jobId, clip } — the SOURCE the next seam records
  for (const [i, job] of toRender.entries()) {
    const seed = seedForJob(jobs.findIndex((j) => j.job_id === job.job_id), take ?? 0);
    const feedsNext = chain && i < toRender.length - 1;
    const startPin = i === 0 ? openPin : null;
    const endPin = i === toRender.length - 1 ? closePin : null;
    const openFrame = startPin ?? startFrame;
    // The lineage follows the frame the clip REALLY opened on: an explicit pin and an authored
    // job.first_frame both outrank the chained still, and a `from` recorded for a frame that was
    // never used is the same false continuation claim as no record at all.
    const usedChainedFrame = !startPin && !job.first_frame && startFrame;
    const seamInFrom = usedChainedFrame && prev ? { take: takeId, job: prev.jobId, clip: prev.clip } : null;
    const r = await RENDERERS[be].render({ job: jobWithPins(job, { startPin: !!startPin, endPin: !!endPin }), spec, runDir, seed, lowRes: probe, startFrame: openFrame, endFrame: endPin, feedsNext, seamInFrom, nonce: take ?? 0 })
      .catch((e) => { log.error(`[${job.job_id}] failed: ${e.message}`); return { jobId: job.job_id, error: e.message }; });
    results.push(r);
    // The previous job's sidecar was written before THIS clip existed: stamp where its closing frame
    // actually went, so the recorded chain names both ends of every joint. Only when this job REALLY
    // opened on that frame, though — chaining off, a text-to-video job, or a soft pin the reference
    // budget dropped all leave `seamIn.from` null, and a destination recorded for a frame nothing
    // consumed is the same false continuation claim from the other side.
    const openedOnPrev = Boolean(prev && r.seamIn?.from?.job === prev.jobId && r.seamIn.from.take === takeId);
    if (r.clip && openedOnPrev) {
      const to = { take: takeId, job: job.job_id, clip: r.clip };
      const p = results.find((x) => x.jobId === prev.jobId);
      if (p?.seamOut) p.seamOut.to = to;
      stampSeamOut(runDir, prev.jobId, { to });
    }
    startFrame = undefined;
    if (chain && r.clip) {
      const { frame, frameSource } = await closingFrameFor(r, runDir, job.job_id);
      startFrame = frame;
      if (r.seamOut) { r.seamOut.frame = frame ?? r.seamOut.frame; r.seamOut.frameSource = frameSource; }
      stampSeamOut(runDir, job.job_id, frame ? { frame, frameSource } : { frameSource });
      if (startFrame) log.info(`[${job.job_id}] seam frame -> ${startFrame} (${frameSource}; start of next job)`);
      else log.warn(`[${job.job_id}] could not extract last frame for seam continuity; the next job starts fresh.`);
    }
    prev = r.clip ? { jobId: job.job_id, clip: r.clip } : null;
  }
  // `chained` is the seam lineage the assembler needs: with it, adjacent clips share a boundary frame
  // and can be stitched seamlessly instead of hard-cut (src/lib/seamstitch.js readContinuity).
  await writeJson(path.join(runDir, 'render.json'), { project: spec.project.title, backend: be, jobs: results, chained: chain });

  if (probe) {
    const clip = results.find((r) => r.clip)?.clip ?? null;
    log.info(`\n✅ Probe done: ${results.map((r) => `${r.jobId}: ${r.clip ?? r.error}`).join(' | ')}`);
    log.info(`   Like this take? Finish it without re-rendering: npm run assemble -- --from ${runDir}`);
    return { runDir, probe: true, backend: be, jobs: results, clip };
  }

  return finishRender(spec, results, { runDir, upscale, backend: be, outName, chained: chain });
}

/**
 * Render ONE job of a spec into `runDir` (a new take), reusing the per-job renderer contract.
 * `seamFrom` (optional): a PRIOR render dir whose previous-job `last_frame.png` seeds this job's
 * opening frame, matching renderSpec's cross-job chaining. Returns the renderer result plus
 * `staleDownstream`: job ids whose seams were chained from the OLD take of this job — re-render
 * them too (cascade) for a continuous seam, or expect a visible cut.
 * @param {object} spec
 * @param {string} jobId
 * @param {{runDir:string, backend?:string, take?:number, feedback?:string, seamFrom?:string,
 *          lowRes?:boolean, firstFrameFrom?:string, lastFrameFrom?:string, promptOverrides?:string}} opts
 *   `firstFrameFrom`/`lastFrameFrom` pin this job's own boundaries and outrank both the authored
 *   `job.first_frame`/`job.last_frame` and the `seamFrom` chain (jobWithPins); `promptOverrides` is
 *   a sidecar file snapshotted into the take dir.
 * @returns {Promise<{jobId:string, clip:string, totalDuration:number, segments:number, backend:string, staleDownstream:string[]}>}
 */
export async function renderJob(spec, jobId, { runDir, backend, take = 0, feedback, seamFrom, lowRes = false, firstFrameFrom, lastFrameFrom, promptOverrides } = {}) {
  const be = resolveBackend(spec, backend);
  // Structural pass first, so an invalid spec fails with the full validation report rather than a
  // job-lookup error.
  const v = validateSpec(spec, { upTo: 7, backend: be });
  if (!v.ok) throw new Error(`Spec failed validation:\n - ${v.errors.join('\n - ')}`);
  const jobs = spec.kling.jobs;
  const idx = jobs.findIndex((j) => j?.job_id === jobId);
  if (idx === -1) throw new Error(`job "${jobId}" not found in spec.kling.jobs (${jobs.map((j) => j?.job_id).join(', ')})`);
  const job = jobs[idx];

  // Seam in: an explicit --first-frame-from wins, then an authored job.first_frame (both below),
  // and only then this — the previous job's last frame in a prior render dir, exactly like
  // renderSpec's in-sequence chaining.
  let startFrame = null;
  let seamInFrom = null;
  if (config.kling.chainFrames && idx > 0 && seamFrom) {
    const srcDir = resolvePath(seamFrom);
    const cand = path.join(srcDir, jobs[idx - 1].job_id, 'last_frame.png');
    if (fs.existsSync(cand)) {
      startFrame = cand;
      // WHICH take's clip this frame came off is the whole point: a cut that mixes take 2's K1 with
      // take 1's K2 is indistinguishable from an intact chain without it.
      seamInFrom = await seamSourceFor(srcDir, jobs[idx - 1].job_id);
    } else log.warn(`no seam frame at ${cand} — rendering ${jobId} without cross-job continuity`);
  }

  // No budget re-check here any more: a seam frame that has to ride as a reference is a soft pin,
  // and planSeamRefs gives it up before it gives up a paid identity reference.
  ensureDir(runDir);
  await writeJson(path.join(runDir, 'spec.json'), spec);
  snapshotPromptOverrides(promptOverrides, runDir);

  // An EXPLICIT pin beats the frame --seam-from would have derived: the user pointed at the clip
  // this segment must join, and that is a stronger statement than "whatever the last take ended on".
  const jobDir = path.join(runDir, job.job_id);
  if (firstFrameFrom) {
    startFrame = await resolveBoundaryFrame(firstFrameFrom, { end: 'in', destDir: jobDir });
    seamInFrom = null; // a hand-picked still has no take/job/clip of its own to point back at
  } else if (job.first_frame) {
    seamInFrom = null; // the authored frame is what the renderer will use — naming the chain's
                       // source here would claim a continuation this clip does not have
  }
  const endFrame = lastFrameFrom ? await resolveBoundaryFrame(lastFrameFrom, { end: 'out', destDir: jobDir }) : null;
  const effJob = jobWithPins(job, { startPin: !!firstFrameFrom, endPin: !!lastFrameFrom });

  const staleDownstream = downstreamJobs(spec, jobId);

  log.step(`Render job — ${jobId} — ${RENDERERS[be].label}${take ? ` [take ${take}]` : ''}`);
  const r = await RENDERERS[be].render({
    job: effJob, spec, runDir, seed: seedForJob(idx, take), lowRes, startFrame, endFrame, seamInFrom,
    feedsNext: config.kling.chainFrames && staleDownstream.length > 0, nonce: take, feedback,
  });

  // Seam out: refresh THIS job's last frame so downstream jobs can chain from the new take.
  // closingFrameFor never throws — a failed grab returns null, so check the value, not a catch.
  if (config.kling.chainFrames) {
    const { frame, frameSource } = await closingFrameFor(r, runDir, job.job_id);
    if (r.seamOut) { r.seamOut.frame = frame ?? r.seamOut.frame; r.seamOut.frameSource = frameSource; }
    stampSeamOut(runDir, job.job_id, frame ? { frame, frameSource } : { frameSource });
    if (!frame) log.warn(`could not extract ${jobId}'s last frame — downstream jobs will chain from the PREVIOUS take's seam.`);
  }

  if (staleDownstream.length) {
    log.warn(`Seam note: ${staleDownstream.join(', ')} chained from the previous ${jobId} take — re-render them too for a continuous seam.`);
  }

  // Merge into any render.json already in this dir (a cascade renders several jobs into ONE take
  // dir) — clobbering it would erase the earlier jobs' clip records from the take's history.
  const rjPath = path.join(runDir, 'render.json');
  const prior = await readJson(rjPath).catch(() => null);
  const merged = new Map((prior?.jobs ?? []).map((pj) => [pj.jobId, pj]));
  merged.set(r.jobId, r);
  const ordered = jobs.map((j) => merged.get(j.job_id)).filter(Boolean);
  await writeJson(rjPath, { project: spec.project.title, backend: be, take, jobs: ordered });
  return { ...r, backend: be, staleDownstream };
}

/** The provider a run rendered on ('fal' | 'segmind'), or null when the backend is unrecorded — an
 *  older manifest assembled long after the fact still upscales, it just can't follow its own run. */
function providerOf(backend) {
  try { return backend ? capsFor(backend).provider : null; } catch { return null; }
}

/**
 * Assembly tail shared by a full render and the `assemble` CLI: stitch the rendered job clips in
 * spec (job) order → optional Topaz upscale → cover frame, writing out/<project>.mp4. Re-renders
 * nothing; `results` is the per-job list ([{ jobId, clip, error }]).
 */
export async function finishRender(spec, results, { runDir, upscale = false, backend, outName, chained = false, continuity } = {}) {
  const jobs = spec.kling.jobs;
  // Ordered by the SPEC, never by however `results` arrived: the clips are stitched in job order, so
  // the seam lineage has to be read in that same order or joint j would describe a different pair.
  const clipResults = jobs.map((j) => results.find((r) => r.jobId === j.job_id)).filter((r) => r?.clip);
  let clipPaths = clipResults.map((r) => r.clip);
  if (!clipPaths.length) {
    // Name WHY each job failed (e.g. a content-policy flag) instead of a bare "nothing to assemble".
    const failed = results.filter((r) => r.error);
    const why = failed.length ? failed.map((r) => `${r.jobId}: ${r.error}`).join('; ') : 'no job produced a clip';
    throw new Error(`No rendered clips to assemble — every job failed (${why})`);
  }
  if (clipPaths.length < jobs.length) {
    log.warn(`Only ${clipPaths.length}/${jobs.length} job clip(s) present — assembling a partial video (the rest weren't rendered; a --probe run makes just the first job).`);
  }

  const outDir = resolvePath(config.paths.out);
  ensureDir(outDir);
  const name = slug(outName || spec.project.title || 'video');
  const nativeAudio = spec.kling.generate_audio !== undefined ? !!spec.kling.generate_audio : config.kling.nativeAudio;

  // Optional fal Topaz upscale runs PER CLIP, before the stitch: assembleVideo scales everything to
  // the delivery frame (config.video), so a sub-1080p source (a 480p/720p Seedance render, a probe
  // clip) must be lifted first — after assembly the master is nominally full-size and Topaz would
  // no-op. Clips already ≥1080p come back unchanged, so this costs nothing on a 1080p render.
  let canvasScale = null; // set by the upscale branch so the stitch follows what Topaz delivered
  if (upscale || config.upscale.enabled) {
    // …and it runs on the provider this run RENDERED on (UPSCALE_PROVIDER=auto): a Segmind-only
    // install has no fal key to fall back on, and a fal run should not round-trip its master
    // through a second vendor. An explicit UPSCALE_PROVIDER still wins inside upscaleVideoTopaz.
    const runProvider = providerOf(backend);
    const lifted = [];
    for (const clip of clipPaths) lifted.push(await upscaleVideoTopaz({ inPath: clip, outDir: path.dirname(clip), runProvider }));
    clipPaths = lifted;
    // The stitch canvas must FOLLOW what the upscale delivered: canvasFor caps at VIDEO_SHORT_SIDE
    // (1080 default), which would quietly stitch a paid 4K Topaz target back down to 1080p.
    try {
      const liftedShorts = [];
      for (const clip of clipPaths) { const d = await probeDims(clip); liftedShorts.push(Math.min(d.width, d.height)); }
      if (liftedShorts.length) canvasScale = Math.max(config.video.shortSide, Math.min(...liftedShorts));
    } catch { /* probe failure — the default canvas cap stands */ }
  }

  // Dialogue is spoken NATIVELY by the render backend: each spec.audio.voice.lines[] line is folded
  // into the shot prompt, voiced by the character's minted voice_id (Kling elements) or lip-synced
  // to its mint-time ref clip (Seedance @Audio refs) — so no separate post-dub pass is needed.
  // Seam lineage → a seamless stitch when the clips really do chain (assembleVideo falls back to a
  // hard-cut concat by itself if they don't, or if the stitcher is unavailable). Read from each
  // clip's OWN recorded seam, so a cut that mixes takes stitches the joints that survived and cuts
  // the one the re-render broke; the run-level `chained` flag is only the pre-lineage fallback.
  const seams = continuity !== undefined ? continuity : readContinuity({ chained, jobs: clipResults }, clipPaths.length);
  const master = uniqueOutPath(outDir, name); // repeat renders of one title get -2, -3, … (never overwrite)
  const stitch = await assembleVideo(clipPaths, master, { nativeAudio, aspect: spec.kling?.aspect_ratio ?? spec.project?.aspect_ratio ?? null, continuity: seams, canvasScale });

  const cover = await grabFrame(master, spec.project?.cover_frame_s ?? 2, path.join(runDir, 'cover.png'));
  // record the delivered size: the UI disables the paid upscale when the master is already ≥1080p
  // (fal's Kling outputs a fixed native resolution — no request knob exists)
  let masterShortSide = null;
  try { const d = await probeDims(master); masterShortSide = Math.min(d.width, d.height); } catch { /* estimate-only field */ }
  // `chained` must survive this rewrite of render.json, or re-finishing the run later (assembleRun)
  // would forget the seam lineage and silently downgrade to a hard-cut stitch.
  // The seam LINEAGE must survive this rewrite too — it is the only record of which clip each
  // segment really continues from, and re-deriving it later is exactly the guess P2 exists to end.
  const summary = { runDir, project: spec.project.title, backend: backend ?? null, master, cover, masterShortSide, chained, stitch, jobs: results.map((r) => ({ jobId: r.jobId, job: r.jobId, clip: r.clip, error: r.error, seamIn: r.seamIn ?? null, seamOut: r.seamOut ?? null })) };
  await writeJson(path.join(runDir, 'render.json'), summary);
  log.info(`\n✅ Master: ${master}  (${clipPaths.length} job clip(s), ${stitch.stitcher === 'seamless' ? `seamless stitch, ${stitch.matched}/${stitch.joints} joint(s) colour-matched` : 'hard-cut stitch'})`);
  return { runDir, master, cover, masterShortSide, stitch, jobs: results };
}

/**
 * Finish a PRIOR render run without re-rendering: read its spec.json + render.json and assemble the
 * clips already on disk (stitch → optional VO → optional upscale → cover). Accepts a `render`-CLI run
 * dir, or an engine run dir (descends into ./render). Use it to promote a --probe clip into out/.
 */
export async function assembleRun(runDir, { upscale = false, outName, continuity } = {}) {
  const base = resolvePath(runDir);
  const found = (await readRun(base)) ?? (await readRun(path.join(base, 'render')));
  if (!found) {
    throw new Error(`No render found under ${base} — expected spec.json + render.json (here or in ./render). Run a render or --probe first.`);
  }
  const { dir, spec, render } = found;
  // Re-derived by hand from render.json — every field finishRender writes back has to be carried
  // here, or a re-finish silently forgets it (the seam lineage most of all).
  const results = (render.jobs ?? []).map((j) => ({ jobId: j.jobId ?? j.job, clip: j.clip, error: j.error, seamIn: j.seamIn ?? null, seamOut: j.seamOut ?? null }));
  if (!results.some((r) => r.clip)) throw new Error(`No clip paths recorded in ${path.join(dir, 'render.json')} — nothing to assemble.`);
  log.step(`Assemble — "${spec.project?.title ?? 'video'}" from ${dir} (no re-render)`);
  return finishRender(spec, results, { runDir: dir, upscale, backend: render.backend ?? spec.render_backend ?? null, outName, chained: render.chained === true, continuity });
}

/** Read a run's spec.json + render.json from `dir`, or null if either is missing/unreadable. */
async function readRun(dir) {
  try {
    const [spec, render] = await Promise.all([
      readJson(path.join(dir, 'spec.json')),
      readJson(path.join(dir, 'render.json')),
    ]);
    return { dir, spec, render };
  } catch {
    return null;
  }
}

export default { renderSpec, renderJob, assembleRun, finishRender, resolveBackend, RENDERERS, seedForJob, downstreamJobs, uniqueOutPath };
