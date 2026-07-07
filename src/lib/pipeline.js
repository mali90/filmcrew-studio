// Render a Production Spec → a final mp4. Shared by the `engine --render` and `render` CLIs.
//   validate → render each kling.job on the selected backend (multi-job renders chain last→first
//   frames for a continuous seam) → stitch in job order (native audio, seam-faded) → optional
//   Topaz upscale → out/<project>.mp4
import path from 'node:path';
import fs from 'node:fs';
import config, { resolvePath } from '../../config.js';
import log from './logger.js';
import { ensureDir, writeJson, readJson, slug } from './util.js';
import { validateSpec, RENDER_BACKENDS } from './spec-schema.js';
import { renderKlingJobFal } from './fal-kling.js';
import { renderSeedanceJobFal } from './fal-seedance.js';
import { assembleVideo, grabFrame, lastFrameOf } from './assemble.js';
import { upscaleVideoTopaz, probeDims } from './upscale.js';

// Render backends — one entry per backend, all honoring the same per-job contract
// ({ job, spec, runDir, seed, lowRes, startFrame, nonce }) → { jobId, clip, totalDuration,
// segments }. Modeled on PROVIDERS in llm.js: adding a backend = one entry here (+ its renderer).
export const RENDERERS = {
  kling: { render: renderKlingJobFal, label: 'Kling 3.0 Omni (fal)' },
  seedance: { render: renderSeedanceJobFal, label: 'Seedance 2.0 (fal)' },
};

/** The effective render backend: CLI flag > spec.render_backend > config default. Throws on unknown. */
export function resolveBackend(spec, explicit) {
  const name = explicit || spec?.render_backend || config.render.backend;
  if (!RENDERERS[name]) throw new Error(`Unknown render backend "${name}" — use one of: ${RENDER_BACKENDS.join(', ')} (RENDER_BACKEND in .env, or --backend).`);
  return name;
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

/** First free `<dir>/<base>.mp4`, then `<base>-2.mp4`, `<base>-3.mp4`, … — masters are never overwritten. */
export function uniqueOutPath(dir, base) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}.mp4`);
    if (!fs.existsSync(p)) return p;
  }
}

/**
 * @param {object} spec  a render-ready Production Spec
 * @param {{runDir:string, probe?:boolean, upscale?:boolean, backend?:string, take?:number}} opts
 *   `backend` overrides the spec/config backend; `take` (Seedance) varies a regen without a seed.
 * @returns {Promise<{runDir:string, master?:string, cover?:string, probe?:boolean, jobs:object[]}>}
 */
export async function renderSpec(spec, { runDir, probe = false, upscale = false, backend, take, outName } = {}) {
  const be = resolveBackend(spec, backend);
  const v = validateSpec(spec, { upTo: 7, backend: be });
  if (!v.ok) throw new Error(`Spec failed validation:\n - ${v.errors.join('\n - ')}`);
  ensureDir(runDir);
  await writeJson(path.join(runDir, 'spec.json'), spec);

  const jobs = spec.kling.jobs;
  const toRender = probe ? jobs.slice(0, 1) : jobs;
  log.step(`Render — "${spec.project.title}" — ${RENDERERS[be].label} — ${toRender.length}/${jobs.length} job(s)${probe ? ' [PROBE]' : ''}`);

  // Seam continuity for a full multi-job (>15s) render: feed each clip's LAST frame to the NEXT job as
  // its start frame (start_image_url on fal / first_frame seed on cloud) so the cut is continuous
  // instead of the next job starting fresh from the reference Elements. Never on --probe (one job) or
  // when disabled; a spec-authored job.first_frame always wins over the chained seam (in the
  // renderers). The audio seam fade (assemble.js) smooths the join under this continuous visual.
  const chain = config.kling.chainFrames && !probe && toRender.length > 1;
  const results = [];
  let startFrame; // previous job clip's last frame; undefined for the first job (unchanged behavior)
  for (const job of toRender) {
    const seed = seedForJob(jobs.findIndex((j) => j.job_id === job.job_id), take ?? 0);
    const r = await RENDERERS[be].render({ job, spec, runDir, seed, lowRes: probe, startFrame, nonce: take ?? 0 })
      .catch((e) => { log.error(`[${job.job_id}] failed: ${e.message}`); return { jobId: job.job_id, error: e.message }; });
    results.push(r);
    startFrame = undefined;
    if (chain && r.clip) {
      const png = path.join(runDir, job.job_id, 'last_frame.png');
      startFrame = await lastFrameOf(r.clip, png);
      if (startFrame) log.info(`[${job.job_id}] seam frame -> ${startFrame} (start of next job)`);
      else log.warn(`[${job.job_id}] could not extract last frame for seam continuity; the next job starts fresh.`);
    }
  }
  await writeJson(path.join(runDir, 'render.json'), { project: spec.project.title, backend: be, jobs: results });

  if (probe) {
    const clip = results.find((r) => r.clip)?.clip ?? null;
    log.info(`\n✅ Probe done: ${results.map((r) => `${r.jobId}: ${r.clip ?? r.error}`).join(' | ')}`);
    log.info(`   Like this take? Finish it without re-rendering: npm run assemble -- --from ${runDir}`);
    return { runDir, probe: true, backend: be, jobs: results, clip };
  }

  return finishRender(spec, results, { runDir, upscale, backend: be, outName });
}

/**
 * Render ONE job of a spec into `runDir` (a new take), reusing the per-job renderer contract.
 * `seamFrom` (optional): a PRIOR render dir whose previous-job `last_frame.png` seeds this job's
 * opening frame, matching renderSpec's cross-job chaining. Returns the renderer result plus
 * `staleDownstream`: job ids whose seams were chained from the OLD take of this job — re-render
 * them too (cascade) for a continuous seam, or expect a visible cut.
 * @param {object} spec
 * @param {string} jobId
 * @param {{runDir:string, backend?:string, take?:number, feedback?:string, seamFrom?:string, lowRes?:boolean}} opts
 * @returns {Promise<{jobId:string, clip:string, totalDuration:number, segments:number, backend:string, staleDownstream:string[]}>}
 */
export async function renderJob(spec, jobId, { runDir, backend, take = 0, feedback, seamFrom, lowRes = false } = {}) {
  const be = resolveBackend(spec, backend);
  const v = validateSpec(spec, { upTo: 7, backend: be });
  if (!v.ok) throw new Error(`Spec failed validation:\n - ${v.errors.join('\n - ')}`);
  const jobs = spec.kling.jobs;
  const idx = jobs.findIndex((j) => j?.job_id === jobId);
  if (idx === -1) throw new Error(`job "${jobId}" not found in spec.kling.jobs (${jobs.map((j) => j.job_id).join(', ')})`);
  const job = jobs[idx];
  ensureDir(runDir);
  await writeJson(path.join(runDir, 'spec.json'), spec);

  // Seam in: an authored job.first_frame wins inside the renderer; else chain from the previous
  // job's last frame in a prior render dir, exactly like renderSpec's in-sequence chaining.
  let startFrame = null;
  if (config.kling.chainFrames && idx > 0 && seamFrom) {
    const cand = path.join(resolvePath(seamFrom), jobs[idx - 1].job_id, 'last_frame.png');
    if (fs.existsSync(cand)) startFrame = cand;
    else log.warn(`no seam frame at ${cand} — rendering ${jobId} without cross-job continuity`);
  }

  log.step(`Render job — ${jobId} — ${RENDERERS[be].label}${take ? ` [take ${take}]` : ''}`);
  const r = await RENDERERS[be].render({ job, spec, runDir, seed: seedForJob(idx, take), lowRes, startFrame, nonce: take, feedback });

  // Seam out: refresh THIS job's last frame so downstream jobs can chain from the new take.
  // lastFrameOf never throws — it returns null on failure, so check the value, not a catch.
  if (config.kling.chainFrames) {
    const seamPng = await lastFrameOf(r.clip, path.join(runDir, job.job_id, 'last_frame.png'));
    if (!seamPng) log.warn(`could not extract ${jobId}'s last frame — downstream jobs will chain from the PREVIOUS take's seam.`);
  }

  const staleDownstream = downstreamJobs(spec, jobId);
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

/**
 * Assembly tail shared by a full render and the `assemble` CLI: stitch the rendered job clips in
 * spec (job) order → optional Topaz upscale → cover frame, writing out/<project>.mp4. Re-renders
 * nothing; `results` is the per-job list ([{ jobId, clip, error }]).
 */
export async function finishRender(spec, results, { runDir, upscale = false, backend, outName } = {}) {
  const jobs = spec.kling.jobs;
  let clipPaths = jobs.map((j) => results.find((r) => r.jobId === j.job_id)?.clip).filter(Boolean);
  if (!clipPaths.length) throw new Error('No rendered clips found — nothing to assemble');
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
  if (upscale || config.upscale.enabled) {
    const lifted = [];
    for (const clip of clipPaths) lifted.push(await upscaleVideoTopaz({ inPath: clip, outDir: path.dirname(clip) }));
    clipPaths = lifted;
  }

  // Dialogue is spoken NATIVELY by the render backend: each spec.audio.voice.lines[] line is folded
  // into the shot prompt, voiced by the character's minted voice_id (Kling elements) or lip-synced
  // to its mint-time ref clip (Seedance @Audio refs) — so no separate post-dub pass is needed.
  const master = uniqueOutPath(outDir, name); // repeat renders of one title get -2, -3, … (never overwrite)
  await assembleVideo(clipPaths, master, { nativeAudio, aspect: spec.kling?.aspect_ratio ?? spec.project?.aspect_ratio ?? null });

  const cover = await grabFrame(master, spec.project?.cover_frame_s ?? 2, path.join(runDir, 'cover.png'));
  // record the delivered size: the UI disables the paid upscale when the master is already ≥1080p
  // (fal's Kling outputs a fixed native resolution — no request knob exists)
  let masterShortSide = null;
  try { const d = await probeDims(master); masterShortSide = Math.min(d.width, d.height); } catch { /* estimate-only field */ }
  const summary = { runDir, project: spec.project.title, backend: backend ?? null, master, cover, masterShortSide, jobs: results.map((r) => ({ job: r.jobId, clip: r.clip, error: r.error })) };
  await writeJson(path.join(runDir, 'render.json'), summary);
  log.info(`\n✅ Master: ${master}  (${clipPaths.length} job clip(s))`);
  return { runDir, master, cover, masterShortSide, jobs: results };
}

/**
 * Finish a PRIOR render run without re-rendering: read its spec.json + render.json and assemble the
 * clips already on disk (stitch → optional VO → optional upscale → cover). Accepts a `render`-CLI run
 * dir, or an engine run dir (descends into ./render). Use it to promote a --probe clip into out/.
 */
export async function assembleRun(runDir, { upscale = false, outName } = {}) {
  const base = resolvePath(runDir);
  const found = (await readRun(base)) ?? (await readRun(path.join(base, 'render')));
  if (!found) {
    throw new Error(`No render found under ${base} — expected spec.json + render.json (here or in ./render). Run a render or --probe first.`);
  }
  const { dir, spec, render } = found;
  const results = (render.jobs ?? []).map((j) => ({ jobId: j.jobId ?? j.job, clip: j.clip, error: j.error }));
  if (!results.some((r) => r.clip)) throw new Error(`No clip paths recorded in ${path.join(dir, 'render.json')} — nothing to assemble.`);
  log.step(`Assemble — "${spec.project?.title ?? 'video'}" from ${dir} (no re-render)`);
  return finishRender(spec, results, { runDir: dir, upscale, backend: render.backend ?? spec.render_backend ?? null, outName });
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
