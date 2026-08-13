// Pure cost estimator behind GET /api/runs/:id/estimate and every CostTag in the UI. Rates live
// in prices.json (editable ballparks — clearly labeled estimates, never billing). Job durations
// are derived from the spec exactly like the validator derives them.
//
// A provider may publish no rate at all. That is a KNOWN state, not an error: those runs
// render and bill exactly like any other, so the estimator answers
// `totalUsd: null` + an `unknownPrice` hint rather than throwing (a 500 would take a working run
// page down) or borrowing a sibling's rate (an invented number on a paid button is worse than
// none). An unregistered backend id is still a bug and still throws loudly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Static imports from the host src/ tree, all config-free — no env of their own and nothing in their
// graphs reaches config.js. See the canary in test/integration/runs-caps.test.js, which walks them.
// Static rather than lazy because this module is SYNCHRONOUS: readEnvVar answers inside an estimate.
import { capsFor, normalizeBackend } from '../../../src/lib/render-models.js';
// …and the render child's OWN resolution rule, imported rather than re-stated: a price quoted for a
// tier the renderer would not use is exactly the bug a mirrored copy of it caused.
import { seedanceResolution } from '../../../src/lib/prompt-settings.js';
// …and the upscaler's OWN sizing rule, for the same reason: fal tiers Topaz by the OUTPUT frame, so
// the quote has to be built from the factor the upscale will really apply, not a copy of it.
import { upscalePlan } from '../../../src/lib/upscale-plan.js';
// …and dotenv's OWN grammar for the .env, for exactly the same reason (see readEnvVar). It is a
// re-implementation of dotenv's line parser, NOT dotenv — nothing here ever sources a file.
import { dotenvValues } from '../../../src/lib/env-file.js';

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

export function estimateRender(spec, { backend, mode = 'full', jobId, cascade = false, pick, resolution, probeResolution } = {}) {
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
    // The renderer's own rule, RUN rather than mirrored (seedanceResolution, the function the render
    // child resolves its tier with): the run's per-run pick first, then an explicit
    // spec.seedance.resolution pin, then the .env knob — and never the kling block, which the agents
    // fill with KLING defaults and which would misprice (and mis-render) Seedance at 1080p.
    perSecond = rateFor(rates, seedanceResolution({ pick, spec, shared: resolution }));
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
 *  file and the render child reads it, so it is what the estimate has to price. Exported because
 *  the same reader answers the non-price knobs a run's boundary budget depends on (run-service's
 *  voice-reference demand); a second .env parser in this server would be one too many, which is
 *  why this one and the prompt preview's now share dotenvValues — ONE rule for every knob. */
export function readEnvVar(envRoot, key, fallbackEnv) {
  // The CHILD's precedence, mirrored exactly: a variable already present in the spawned process's
  // env (childEnv — even an explicit empty string) wins, because dotenv never overwrites an
  // existing variable. Reading .env first here would quote one provider while the render child
  // actually bills another.
  if (fallbackEnv && Object.hasOwn(fallbackEnv, key)) return String(fallbackEnv[key] ?? '').trim();
  try {
    // dotenv's grammar, through the ONE implementation of it this repo has (src/lib/env-file.js,
    // where it is pinned against dotenv's own parser). A regex of our own answered three of its
    // rules differently — it took the FIRST assignment where dotenv keeps the LAST, ignored an
    // `export ` prefix, and ended a value at the first space rather than at a trailing `# comment`
    // — so an ordinary .env had this server pricing a tier, choosing a vendor and budgeting a
    // voice reference the render child never saw. Missing stays '' (not undefined): every caller
    // below reads the answer as a string.
    return dotenvValues(fs.readFileSync(path.join(envRoot, '.env'), 'utf8'))[key] ?? '';
  } catch { /* no .env yet */ }
  return '';
}

/** The render resolution the CHILD will use, per MODEL — the registry names the knob each model
 *  reads (caps.resolutionEnv: KLING_RESOLUTION / SEEDANCE_RESOLUTION / SEEDANCE25_RESOLUTION) and
 *  its default. Seedance is billed by pixel-seconds, so reading the wrong knob quietly misprices
 *  the button; an unknown/absent backend keeps the legacy Seedance answer. */
export function readRenderResolution(envRoot, backend, childEnv) {
  let caps = null;
  try { caps = capsFor(normalizeBackend(backend).id); } catch { /* unknown/absent backend */ }
  // A model with NO selectable ladder (Kling: the endpoint renders its own output) has no knob to
  // read and nothing resolution-priced — null, never a sibling model's env var.
  if (caps && !caps.resolutions?.length) return null;
  const key = caps?.resolutionEnv ?? 'SEEDANCE_RESOLUTION';
  return readEnvVar(envRoot, key, childEnv) || caps?.defaultResolution || '480p';
}

/** The short side the approve-time upscale will actually DELIVER: Segmind takes an explicit
 *  target (UPSCALE_TARGET_RESOLUTION); fal's factor plan lifts toward ~1080p. The UI's
 *  "already HD" threshold and its label both ride on this — a 4k target must keep offering the
 *  upscale on a 1080p cut, and a 720p target must never advertise 1080. An explicit `provider`
 *  (the ApproveBar's pick, pinned into the finalize child's env) beats the env derivation —
 *  the gate must judge the vendor that will actually run, not the configured default. */
export function readUpscaleTargetShortSide(envRoot, backend, childEnv, provider = null) {
  if ((provider ?? readUpscaleProvider(envRoot, backend, childEnv)) !== 'segmind') return 1080;
  const target = readEnvVar(envRoot, 'UPSCALE_TARGET_RESOLUTION', childEnv).toLowerCase();
  return { '720p': 720, '1080p': 1080, '4k': 2160 }[target] ?? 1080;
}

/** The PROBE resolution the render child will use, per model — the same knob family as
 *  readRenderResolution. Estimates must read it too (see estimateRender's probe branch). */
export function readProbeResolution(envRoot, backend, childEnv) {
  const is25 = typeof backend === 'string' && backend.includes('seedance-2.5');
  return readEnvVar(envRoot, is25 ? 'SEEDANCE25_PROBE_RESOLUTION' : 'SEEDANCE_PROBE_RESOLUTION', childEnv) || '480p';
}

/** Back-compat wrapper: the pre-2.5 callers that only ever meant SEEDANCE_RESOLUTION. */
export const readSeedanceResolution = (envRoot, childEnv) => readRenderResolution(envRoot, null, childEnv);

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
    // FAL_KEY would price this estimate at Segmind's Topaz rate while the engine bills fal's.
    fal: Boolean(readEnvVar(envRoot, 'FAL_KEY', childEnv) || readEnvVar(envRoot, 'FAL_API_KEY', childEnv)),
    segmind: Boolean(readEnvVar(envRoot, 'SEGMIND_API_KEY', childEnv)),
  };
  if (runProvider && has[runProvider]) return runProvider;
  if (has.fal) return 'fal';
  if (has.segmind) return 'segmind';
  return 'fal';
}

/** The Topaz MODEL the fal upscale will ask for (FAL_TOPAZ_MODEL) — a PRICE knob, because fal
 *  charges half for Gaia 2 output. Empty means the config default ('Proteus'), which is not Gaia. */
export function readUpscaleModel(envRoot, childEnv) {
  return readEnvVar(envRoot, 'FAL_TOPAZ_MODEL', childEnv);
}

/** The Topaz factor CAP the fal upscale is bound by (FAL_TOPAZ_MAX_FACTOR → config.fal.topazMaxFactor
 *  → upscalePlan) — also a price knob: it decides how far a small clip is lifted, and so which
 *  OUTPUT tier fal bills for it. Unset is `undefined`, which leaves upscalePlan's own default rather
 *  than restating 4 here. Anything unparseable stays NaN, exactly as config.js keeps it — an
 *  unusable cap must price like any other unknown (the dearest tier), never like a cheap one. */
export function readUpscaleMaxFactor(envRoot, childEnv) {
  const raw = readEnvVar(envRoot, 'FAL_TOPAZ_MAX_FACTOR', childEnv);
  return raw === '' ? undefined : Number(raw);
}

/** OUTPUT frame height → the row's tier key. fal tiers Topaz by the output, and this app's 9:16
 *  default makes that a portrait 1080×1920 frame — which fal bills as ABOVE 1080p (see the row's
 *  _source: inferred from a real invoice, not documented). A row with no ladder is flat (Segmind),
 *  and an output taller than every rung falls through to defaultResolution — the top tier. */
function tierOf(rates, outputHeight) {
  const ladder = rates.tierMaxOutputHeight;
  if (!ladder) return undefined; // flat vendor row — rateFor ignores the tier entirely
  return Object.entries(ladder).sort((a, b) => a[1] - b[1]).find(([, max]) => outputHeight <= max)?.[0];
}

/** What one clip rides: the tier its OUTPUT lands in, or `skipped` when the source is already at or
 *  above the target — both engines return that input untouched (src/lib/upscale.js), so there is no
 *  job and no bill. Unknown dimensions are NEITHER: the tier stays undefined so rateFor falls to the
 *  row's defaultResolution, which is deliberately the dearest one. `maxFactor` is the CONFIGURED cap
 *  the render child binds; undefined leaves the planner's own default. */
function clipTier(rates, clip, targetShort, maxFactor) {
  const width = Number(clip?.width) || 0;
  const height = Number(clip?.height) || 0;
  if (!width || !height) return { tier: undefined, skipped: false };
  const plan = upscalePlan(width, height, { targetShort, maxFactor });
  if (!plan.needsUpscale) return { tier: undefined, skipped: true };
  return { tier: tierOf(rates, Math.round(height * plan.upscaleFactor)), skipped: false };
}

/** fal's "for Gaia 2 output costs half of the prices", applied ONLY to an unambiguous Gaia 2 pick.
 *  Any other model — including a bare 'Gaia' — pays full: halving a rate on a guess under-quotes a
 *  paid button, and that is the one direction this file will not err in. */
function modelMultiplier(rates, model) {
  const half = rates.gaia2Multiplier;
  if (!half) return 1;
  return /^gaia[\s._-]*2$/i.test(String(model ?? '').trim()) ? half : 1;
}

/**
 * Estimate a Topaz upscale over a take's clips (one Topaz job per clip below the target). The two
 * providers bill on completely different shapes and neither may be quoted with the other's number:
 * Segmind is flat per INPUT second, while fal tiers by the OUTPUT frame — so each clip carries the
 * dimensions its tier is chosen from, and a clip already at the target costs nothing.
 * `maxFactor` is fal's configured factor cap; Segmind takes an explicit target and no factor at all,
 * so its flat row simply ignores it.
 * @param {{jobId:string, seconds:number, width?:number, height?:number}[]} clips
 * @param {{provider?:string, targetShortSide?:number, model?:string|null, maxFactor?:number}} opts
 * @returns {{perJob:{jobId:string,seconds:number,usd:number|null}[], totalUsd:number|null, currency:'USD', label:'estimate', tier?:string, unknownPrice?:object}}
 */
export function estimateUpscale(clips, { provider = 'fal', targetShortSide = 1080, model = null, maxFactor } = {}) {
  const priceKey = provider === 'fal' ? 'topaz' : `topaz@${provider}`;
  const { key, rates } = tableFor(priceKey);
  if (!rates) throw new Error(`no price table for upscale provider "${provider}" (have: ${priceKeys().join(', ')})`);
  const list = clips ?? [];
  // "Publishes no rate" is a fact about the ROW, not about any one clip — ask it once, before any
  // per-clip arithmetic can invent a figure underneath it.
  if (rates.perSecondUsd === null) return priced(null, list.map((c) => ({ jobId: c.jobId, seconds: c.seconds })), key, rates);

  const multiplier = modelMultiplier(rates, model);
  let dearest = null; // the tier that explains the quote — the UI labels the price with it
  const rows = list.map((clip) => {
    const job = { jobId: clip.jobId, seconds: clip.seconds };
    const { tier, skipped } = clipTier(rates, clip, targetShortSide, maxFactor);
    if (skipped) return { ...job, usd: 0 };
    const perSecond = rateFor(rates, tier) * multiplier;
    if (!dearest || perSecond > dearest.perSecond) dearest = { perSecond, tier: tier ?? rates.defaultResolution };
    return { ...job, usd: round2(job.seconds * perSecond) };
  });
  return {
    perJob: rows, totalUsd: sumUsd(rows), currency: 'USD', label: 'estimate',
    ...(dearest?.tier ? { tier: dearest.tier } : {}),
  };
}

/**
 * The clips ONE take hands Topaz, read from that take's own records — the estimate endpoint and
 * approve's ledger line share it so a quote and the ledger row it becomes cannot drift apart.
 *   - the take's saved spec, because a pre-revision take may rename jobs or change durations;
 *   - only the jobs that produced a clip: finishRender upscales exactly those paths;
 *   - each clip's OWN frame, measured off that file at assembly time (finishRender). The MASTER's
 *     size may not stand in for it: an approve-time upscale lifts the clips into new files and
 *     rewrites this render.json with the HD master it delivered, leaving `jobs[].clip` pointing at
 *     the originals — so a master-derived quote calls a real second charge a free no-op. A take
 *     rendered before that record existed carries no dimensions at all, and prices UP for it
 *     (clipTier), which over-quotes a no-op but can never under-quote a charge.
 * @param {string|null} takeDir
 * @param {{spec?:object|null}} p the run's spec, for a take that saved none of its own
 */
export function takeUpscaleClips(takeDir, { spec = null } = {}) {
  if (!takeDir) return [];
  const readTakeJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(takeDir, name), 'utf8')); } catch { return null; }
  };
  const takeSpec = readTakeJson('spec.json') ?? spec; // the spec the take was rendered from
  const render = readTakeJson('render.json');
  return ((render?.jobs) ?? [])
    .filter((j) => j.clip) // only jobs Topaz will actually process
    .map((j) => {
      const jobId = j.jobId ?? j.job;
      const [width, height] = [Number(j.width) || 0, Number(j.height) || 0];
      return { jobId, seconds: jobSeconds(takeSpec, jobId), ...(width && height ? { width, height } : {}) };
    });
}

export const VOICE_MINT_USD = PRICES.voiceMintUsd;

export default { estimateRender, estimateUpscale, takeUpscaleClips, jobSeconds, readRenderResolution, readSeedanceResolution, readUpscaleProvider, readUpscaleModel, readUpscaleMaxFactor, VOICE_MINT_USD };
