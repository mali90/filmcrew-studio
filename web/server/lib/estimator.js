// Pure cost estimator behind GET /api/runs/:id/estimate and every CostTag in the UI. Rates live
// in prices.json (editable ballparks — clearly labeled estimates, never billing). Job durations
// are derived from the spec exactly like the validator derives them.
//
// Some providers publish no rate at all (Segmind, for every model we drive). That is a KNOWN state,
// not an error: those runs render and bill exactly like any other, so the estimator answers
// `totalUsd: null` + an `unknownPrice` hint rather than throwing (a 500 would take a working run
// page down) or borrowing a sibling's rate (an invented number on a paid button is worse than
// none). An unregistered backend id is still a bug and still throws loudly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The registry is the ONE static import this server takes from the host src/ tree — zero imports,
// no env, so it can never drag config.js in. See the canary in test/integration/runs-caps.test.js.
import { normalizeBackend } from '../../../src/lib/render-models.js';

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
 * @returns {{perJob:{jobId:string,seconds:number,usd:number|null}[], totalUsd:number|null, currency:'USD', label:'estimate', unknownPrice?:{provider:string|null,hint:string}}}
 */
/** The rate row for a price key, following a single `{"$alias": "<key>"}` hop — the CLI records the
 *  CANONICAL compound backend id ('seedance-2.0@fal') in render.json, and prices.json redirects
 *  those to the legacy rate rows. Returns the RESOLVED key too, so rate rules keyed off the backend
 *  (kling's audio-off tier) survive the hop instead of silently overcharging. */
function tableFor(key) {
  const row = PRICES[key];
  return row?.$alias ? { key: row.$alias, rates: PRICES[row.$alias] } : { key, rates: row };
}

/** Per-second rate for a backend. Flat rates are numbers; resolution-scaled backends (Seedance —
 *  fal bills by tokens = h×w×seconds×24/1024, so price tracks pixel count) use a map keyed by
 *  resolution with a defaultResolution fallback. An explicit `null` rate is "this vendor publishes
 *  no price" and comes back as null; an unknown RESOLUTION on a priced row still throws. */
function rateFor(rates, resolution) {
  const r = rates.perSecondUsd;
  if (r === null) return null; // known unknown — the caller answers unknownPrice, never a guess
  if (typeof r === 'number') return r;
  const key = resolution ?? rates.defaultResolution;
  const usd = r[key]; // an unknown resolution must fail loudly, never silently quote the default
  if (usd == null) throw new Error(`no per-second rate for resolution "${key}" (have: ${Object.keys(r).join(', ')})`);
  return usd;
}

const PROVIDER_LABELS = { segmind: 'Segmind', fal: 'fal.ai' };
const SUBJECT_LABELS = { topaz: 'the Topaz upscale' };

/** The machine-readable "we don't know what this costs" payload. The hint is written for a human
 *  staring at a paid button: it says WHO doesn't publish a rate, that the job still costs money,
 *  and (from the row's own `_todo`) where to look the number up. */
function unknownPriceFor(priceKey, rates) {
  const [subject, provider] = String(priceKey).split('@');
  const who = PROVIDER_LABELS[provider] ?? provider ?? 'this provider';
  const what = SUBJECT_LABELS[subject] ?? subject;
  const where = String(rates?._todo ?? '').replace(/^PRICE CHECK REQUIRED\s*[—-]\s*/, '').trim();
  return {
    provider: provider ?? null,
    hint: `${who} does not publish a per-second rate for ${what} — rendering still costs money; the rate is not on file yet.`
      + (where ? ` Check ${where} and add it to web/server/lib/prices.json.` : ''),
  };
}

const sumUsd = (perJob) => round2(perJob.reduce((a, j) => a + j.usd, 0));

/** Shape a result from the per-second rate: `null` means unpriced, and then NOTHING is invented —
 *  the seconds are still real (the run page can say how much video it will make). */
function priced(perSecond, perJob, priceKey, rates) {
  if (perSecond === null) {
    return {
      perJob: perJob.map((j) => ({ ...j, usd: null })),
      totalUsd: null,
      currency: 'USD',
      label: 'estimate',
      unknownPrice: unknownPriceFor(priceKey, rates),
    };
  }
  const rows = perJob.map((j) => ({ ...j, usd: round2(j.seconds * perSecond) }));
  return { perJob: rows, totalUsd: sumUsd(rows), currency: 'USD', label: 'estimate' };
}

export function estimateRender(spec, { backend, mode = 'full', jobId, cascade = false, resolution, probeResolution } = {}) {
  const { key: priceKey, rates } = tableFor(backend);
  if (!rates) throw new Error(`no price table for backend "${backend}" (have: ${priceKeys().join(', ')})`);
  const jobs = spec?.kling?.jobs ?? [];
  if (!jobs.length) throw new Error('spec has no kling.jobs to estimate');

  let picked;
  let perSecond;
  if (mode === 'probe') {
    picked = jobs.slice(0, 1);
    // Probes ride the same tier at the probe resolution (first job only is where the saving is),
    // chosen BEFORE any full-render rate lookup — the CONFIGURED knob first. A spec still pinning
    // a resolution this model does not offer (a 1080p pin surviving a 2.0 → 2.5 switch) must not
    // throw when the probe itself rides a perfectly legal rate.
    perSecond = rates.probePerSecondUsd ?? rateFor(rates, probeResolution ?? rates.probeResolution ?? resolution);
  } else {
    // mirror the renderer's own precedence (seedanceConfigFor): an EXPLICIT spec.seedance.resolution
    // pin overrides the .env default — but never the kling block, which the agents fill with KLING
    // defaults and which would misprice (and mis-render) Seedance at 1080p
    perSecond = rateFor(rates, spec?.seedance?.resolution ?? resolution);
    // fal prices Kling FLAT across resolutions; the only price knob is native audio on/off
    if (priceKey === 'kling' && spec?.kling?.generate_audio === false && rates.audioOffPerSecondUsd) {
      perSecond = rates.audioOffPerSecondUsd;
    }
    if (mode === 'job') {
      const idx = jobs.findIndex((j) => j?.job_id === jobId);
      if (idx === -1) throw new Error(`job "${jobId}" not found in spec.kling.jobs`);
      picked = cascade ? jobs.slice(idx) : [jobs[idx]];
    } else {
      picked = jobs;
    }
  }

  return priced(perSecond, picked.map((j) => ({ jobId: j.job_id, seconds: jobSeconds(spec, j.job_id) })), priceKey, rates);
}

/** The price keys a human could reasonably have meant — rate rows and alias hops, unpriced included
 *  (a registered-but-unpriced backend is a known state, so it belongs in the "have:" list). */
const priceKeys = () => Object.keys(PRICES).filter((k) => PRICES[k] && typeof PRICES[k] === 'object' && ('perSecondUsd' in PRICES[k] || PRICES[k].$alias));

/** One value out of <envRoot>/.env, read as DATA (never sourced) — the settings page writes that
 *  file and the render child reads it, so it is what the estimate has to price. */
function readEnvVar(envRoot, key, fallbackEnv) {
  // The CHILD's precedence, mirrored exactly: a variable already present in the spawned process's
  // env (childEnv — even an explicit empty string) wins, because dotenv never overwrites an
  // existing variable. Reading .env first here would quote one provider while the render child
  // actually bills another.
  if (fallbackEnv && Object.hasOwn(fallbackEnv, key)) return String(fallbackEnv[key] ?? '').trim();
  try {
    const text = fs.readFileSync(path.join(envRoot, '.env'), 'utf8');
    // LINE-bounded whitespace ([^\S\n], never \s): `\s` crosses the newline, so a blank `FAL_KEY=`
    // line would swallow the NEXT assignment as its value and report a key that is not there.
    const m = text.match(new RegExp(`^[^\\S\\n]*${key}[^\\S\\n]*=[^\\S\\n]*("([^"]*)"|'([^']*)'|[^\\s#]+)`, 'm'));
    return (m?.[2] ?? m?.[3] ?? m?.[1] ?? '').trim();
  } catch { /* no .env yet */ }
  return '';
}

/** The render resolution the CHILD will use, per MODEL: Seedance 2.5 has its own knob and its own
 *  default (720p — 480p is only its probe tier), everything else rides SEEDANCE_RESOLUTION (480p,
 *  the cheap path; approve's Topaz upscale lifts the master to 1080p). Seedance is billed by
 *  pixel-seconds, so reading the wrong knob quietly misprices the button. */
export function readRenderResolution(envRoot, backend) {
  const is25 = typeof backend === 'string' && backend.includes('seedance-2.5');
  return readEnvVar(envRoot, is25 ? 'SEEDANCE25_RESOLUTION' : 'SEEDANCE_RESOLUTION') || (is25 ? '720p' : '480p');
}

/** The short side the approve-time upscale will actually DELIVER: Segmind takes an explicit
 *  target (UPSCALE_TARGET_RESOLUTION); fal's factor plan lifts toward ~1080p. The UI's
 *  "already HD" threshold and its label both ride on this — a 4k target must keep offering the
 *  upscale on a 1080p cut, and a 720p target must never advertise 1080. */
export function readUpscaleTargetShortSide(envRoot, backend, childEnv) {
  if (readUpscaleProvider(envRoot, backend, childEnv) !== 'segmind') return 1080;
  const target = readEnvVar(envRoot, 'UPSCALE_TARGET_RESOLUTION', childEnv).toLowerCase();
  return { '720p': 720, '1080p': 1080, '4k': 2160 }[target] ?? 1080;
}

/** The PROBE resolution the render child will use, per model — the same knob family as
 *  readRenderResolution. Estimates must read it too (see estimateRender's probe branch). */
export function readProbeResolution(envRoot, backend) {
  const is25 = typeof backend === 'string' && backend.includes('seedance-2.5');
  return readEnvVar(envRoot, is25 ? 'SEEDANCE25_PROBE_RESOLUTION' : 'SEEDANCE_PROBE_RESOLUTION') || '480p';
}

/** Back-compat wrapper: the pre-2.5 callers that only ever meant SEEDANCE_RESOLUTION. */
export const readSeedanceResolution = (envRoot) => readRenderResolution(envRoot, null);

/** Which vendor the approve-time upscale will actually bill — the same rule as the engine's
 *  resolveUpscaleProvider (src/lib/upscale.js), re-derived here from the .env/child env because
 *  this server may not import config.js. 'auto' upscales wherever the run RENDERED, else wherever
 *  a key exists, else fal (so a keyless install fails with the long-familiar FAL_KEY message).
 *  An unrecognised value falls back to 'auto' here rather than throwing: naming the bad setting is
 *  the engine's job, at spend time — an estimate must not take the run page down over it. */
export function readUpscaleProvider(envRoot, backend, childEnv) {
  const configured = readEnvVar(envRoot, 'UPSCALE_PROVIDER', childEnv).toLowerCase() || 'auto';
  if (configured === 'fal' || configured === 'segmind') return configured;
  let runProvider = null;
  try { runProvider = normalizeBackend(backend).provider; } catch { /* unknown/absent backend */ }
  const has = {
    // BOTH fal spellings: setup and the runtime config accept FAL_API_KEY too — judging only
    // FAL_KEY would route this estimate to Segmind (unpriced) while the engine bills fal.
    fal: Boolean(readEnvVar(envRoot, 'FAL_KEY', childEnv) || readEnvVar(envRoot, 'FAL_API_KEY', childEnv)),
    segmind: Boolean(readEnvVar(envRoot, 'SEGMIND_API_KEY', childEnv)),
  };
  if (runProvider && has[runProvider]) return runProvider;
  if (has.fal) return 'fal';
  if (has.segmind) return 'segmind';
  return 'fal';
}

/** Estimate a Topaz upscale over clip durations (one Topaz job per sub-1080p clip). Topaz runs on
 *  either provider now, and Segmind publishes no rate for it — so this answers per provider. */
export function estimateUpscale(clips, { provider = 'fal' } = {}) {
  const priceKey = provider === 'fal' ? 'topaz' : `topaz@${provider}`;
  const { key, rates } = tableFor(priceKey);
  if (!rates) throw new Error(`no price table for upscale provider "${provider}" (have: ${priceKeys().join(', ')})`);
  return priced(rateFor(rates), (clips ?? []).map((c) => ({ jobId: c.jobId, seconds: c.seconds })), key, rates);
}

export const VOICE_MINT_USD = PRICES.voiceMintUsd;

export default { estimateRender, estimateUpscale, jobSeconds, readRenderResolution, readSeedanceResolution, readUpscaleProvider, VOICE_MINT_USD };
