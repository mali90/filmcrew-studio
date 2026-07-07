// Pure cost estimator behind GET /api/runs/:id/estimate and every CostTag in the UI. Rates live
// in prices.json (editable ballparks — clearly labeled estimates, never billing). Job durations
// are derived from the spec exactly like the validator derives them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRICES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'prices.json'), 'utf8'));
const DEFAULT_SHOT_SECONDS = 5; // mirrors config.kling.defaultShotSeconds

const round2 = (n) => Math.round(n * 100) / 100;

/** A job's planned duration in seconds: the sum of its shots' durations (validator's derivation). */
export function jobSeconds(spec, jobId) {
  const job = (spec?.kling?.jobs ?? []).find((j) => j?.job_id === jobId);
  if (!job) throw new Error(`job "${jobId}" not found in spec.kling.jobs`);
  const byId = Object.fromEntries((spec.shots ?? []).map((s) => [s.shot_id, s]));
  return job.shots.reduce((a, id) => {
    const shot = byId[id];
    return a + Math.max(1, Math.round(Number(shot?.kling?.duration) || Number(shot?.duration_s) || DEFAULT_SHOT_SECONDS));
  }, 0);
}

/**
 * Estimate a render's cost. mode: 'full' (all jobs), 'probe' (first job only, at the probe
 * resolution — same standard tier), 'job' (one job; `cascade` adds its stale-seam downstream jobs).
 * @returns {{perJob:{jobId:string,seconds:number,usd:number}[], totalUsd:number, currency:'USD', label:'estimate'}}
 */
/** Per-second rate for a backend. Flat rates are numbers; resolution-scaled backends (Seedance —
 *  fal bills by tokens = h×w×seconds×24/1024, so price tracks pixel count) use a map keyed by
 *  resolution with a defaultResolution fallback. */
function rateFor(rates, resolution) {
  const r = rates.perSecondUsd;
  if (typeof r === 'number') return r;
  const key = resolution ?? rates.defaultResolution;
  const usd = r[key]; // an unknown resolution must fail loudly, never silently quote the default
  if (usd == null) throw new Error(`no per-second rate for resolution "${key}" (have: ${Object.keys(r).join(', ')})`);
  return usd;
}

export function estimateRender(spec, { backend, mode = 'full', jobId, cascade = false, resolution } = {}) {
  const rates = PRICES[backend];
  if (!rates) throw new Error(`no price table for backend "${backend}" (have: ${Object.keys(PRICES).filter((k) => PRICES[k]?.perSecondUsd).join(', ')})`);
  const jobs = spec?.kling?.jobs ?? [];
  if (!jobs.length) throw new Error('spec has no kling.jobs to estimate');

  let picked;
  // mirror the renderer's own precedence (seedanceConfigFor): an EXPLICIT spec.seedance.resolution
  // pin overrides the .env default — but never the kling block, which the agents fill with KLING
  // defaults and which would misprice (and mis-render) Seedance at 1080p
  let perSecond = rateFor(rates, spec?.seedance?.resolution ?? resolution);
  // fal prices Kling FLAT across resolutions; the only price knob is native audio on/off
  if (backend === 'kling' && spec?.kling?.generate_audio === false && rates.audioOffPerSecondUsd) {
    perSecond = rates.audioOffPerSecondUsd;
  }
  if (mode === 'probe') {
    picked = jobs.slice(0, 1);
    // probes ride the same tier at the probe resolution (first job only is where the saving is)
    perSecond = rates.probePerSecondUsd ?? rateFor(rates, rates.probeResolution ?? resolution);
  } else if (mode === 'job') {
    const idx = jobs.findIndex((j) => j?.job_id === jobId);
    if (idx === -1) throw new Error(`job "${jobId}" not found in spec.kling.jobs`);
    picked = cascade ? jobs.slice(idx) : [jobs[idx]];
  } else {
    picked = jobs;
  }

  const perJob = picked.map((j) => {
    const seconds = jobSeconds(spec, j.job_id);
    return { jobId: j.job_id, seconds, usd: round2(seconds * perSecond) };
  });
  return { perJob, totalUsd: round2(perJob.reduce((a, j) => a + j.usd, 0)), currency: 'USD', label: 'estimate' };
}

/** The Seedance render resolution the CHILD will use: <envRoot>/.env SEEDANCE_RESOLUTION, else the
 *  config default (480p — the cheap path; approve's Topaz upscale lifts the master to 1080p). */
export function readSeedanceResolution(envRoot) {
  try {
    const text = fs.readFileSync(path.join(envRoot, '.env'), 'utf8');
    const m = text.match(/^\s*SEEDANCE_RESOLUTION\s*=\s*("([^"]*)"|'([^']*)'|[^\s#]+)/m);
    const v = (m?.[2] ?? m?.[3] ?? m?.[1] ?? '').trim();
    return v || '480p';
  } catch { return '480p'; }
}

/** Estimate a Topaz upscale over clip durations (one Topaz job per sub-1080p clip). */
export function estimateUpscale(clips) {
  const perJob = (clips ?? []).map((c) => ({ jobId: c.jobId, seconds: c.seconds, usd: round2(c.seconds * PRICES.topaz.perSecondUsd) }));
  return { perJob, totalUsd: round2(perJob.reduce((a, j) => a + j.usd, 0)), currency: 'USD', label: 'estimate' };
}

export const VOICE_MINT_USD = PRICES.voiceMintUsd;

export default { estimateRender, estimateUpscale, jobSeconds, readSeedanceResolution, VOICE_MINT_USD };
