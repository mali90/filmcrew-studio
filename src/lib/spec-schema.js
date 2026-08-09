// Dependency-free, incremental validator for the Kling-native Production Spec.
// validateSpec(spec, { upTo }) checks only the blocks owned by agents 0..upTo, so it doubles as
// the engine's per-agent gate AND the renderer's precondition (upTo=7).
//
// Agent → block ownership:
//   0 Showrunner=project · 1 Storyboard=shots[] · 2 Scene Director=shots[].kling.content_prompt ·
//   3 Cinematographer=shots[].kling.{shot_size,perspective,camera_move} · 4 Casting=kling.elements ·
//   5 Sound=audio · 6 Job Planner=kling.jobs + top-level kling settings · 7 QC=qc
//
// Job-level caps come from the render-models registry (capsFor(backend)), NOT from constants here:
// each model states its own storyboard/second/reference window, so a spec is judged against the
// model that will actually render it. The constants below survive only as SHARED FALLBACKS for the
// caps a model leaves undeclared (Seedance names no segment caps, and the check must not vanish).
import { ALL_BACKENDS, BACKEND_IDS, capsFor, demotesOpeningFrame } from './render-models.js';

/**
 * The SUPERSET of aspect ratios any registered model can render — a shape check for
 * project.aspect_ratio / kling.aspect_ratio, nothing more. A spec planned for a six-ratio model is
 * a valid spec.json even when read back by a validator that was given no backend, so this list must
 * not narrow to the caller's model. Which ratios a PARTICULAR run may use is caps-driven and
 * enforced where the backend is actually known: engine buildCtx (CLI) and POST /api/runs (web),
 * both against capsFor(backend).aspects. 'adaptive'/'auto' stay out — canvasFor() needs a
 * deterministic ratio to shape the stitch canvas.
 */
export const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const KLING_MODELS = ['kling-v3-omni', 'kling-video-o1'];
const KLING_RES = ['4k', '1080p', '720p'];
const SHOT_SIZES = ['extreme_close_up', 'close_up', 'medium_close_up', 'medium', 'medium_wide', 'wide', 'extreme_wide'];
const QC_STATUS = ['pending', 'pass', 'fail'];
const MAX_STORYBOARDS = 6;   // fallback: no shipping endpoint takes more than 6 storyboard segments
const MAX_JOB_SECONDS = 15;  // also the per-SHOT duration_s bound, which is backend-independent
const MAX_SEG_CHARS = 512;   // fallback: the tightest per-segment prompt budget we have measured
const MAX_REF_IMAGES = 7;    // fallback only — Kling states 7 and Seedance 9 in the registry

const isStr = (v) => typeof v === 'string';
const nonEmpty = (v, n = 1) => isStr(v) && v.trim().length >= n;
const isArr = Array.isArray;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const oneOf = (v, list) => list.includes(v);

function validateProject(p, P) {
  if (!p || typeof p !== 'object') return P.push('project: missing');
  for (const k of ['title', 'logline', 'format', 'hook', 'payoff']) if (!nonEmpty(p[k], 2)) P.push(`project.${k} missing/too short`);
  if (!isNum(p.duration_target_s) || p.duration_target_s < 3 || p.duration_target_s > 120) P.push('project.duration_target_s must be 3–120');
  if (p.aspect_ratio !== undefined && !oneOf(p.aspect_ratio, ASPECTS)) P.push(`project.aspect_ratio "${p.aspect_ratio}" not in ${ASPECTS.join('|')}`);
  if (p.cast !== undefined && !isArr(p.cast)) P.push('project.cast must be an array when present');
}

// A shot can never be longer than one GENERATION of the model that will render it (a job holds at
// least one shot), so the per-shot ceiling is the model's own job window — 15s on Kling and Seedance
// 2.0, 30s on Seedance 2.5. With no backend named it is the superset's widest, so a spec planned for
// a long-window model still round-trips through a validator that was told nothing about the model.
function validateShotScript(s, i, P, caps) {
  const at = `shots[${i}]`;
  const maxSeconds = caps?.maxSeconds ?? MAX_JOB_SECONDS;
  if (!s || typeof s !== 'object') return P.push(`${at}: not an object`);
  if (!nonEmpty(s.shot_id)) P.push(`${at}.shot_id missing`);
  if (!nonEmpty(s.beat)) P.push(`${at}.beat missing`);
  if (!isNum(s.duration_s) || s.duration_s < 1 || s.duration_s > maxSeconds) P.push(`${at}.duration_s must be 1–${maxSeconds}`);
}

function validateContent(s, i, P) {
  const at = `shots[${i}].kling`;
  const k = s?.kling;
  if (!k || typeof k !== 'object') return P.push(`${at}: missing (Scene Director must fill kling.content_prompt)`);
  if (!nonEmpty(k.content_prompt, 5)) P.push(`${at}.content_prompt missing/too short`);
  else if (k.content_prompt.length > MAX_SEG_CHARS) P.push(`${at}.content_prompt exceeds ${MAX_SEG_CHARS} chars (${k.content_prompt.length})`);
}

function validateCamera(s, i, P) {
  const at = `shots[${i}].kling`;
  const k = s?.kling ?? {};
  if (!oneOf(k.shot_size, SHOT_SIZES)) P.push(`${at}.shot_size "${k.shot_size}" not in ${SHOT_SIZES.join('|')}`);
  if (!nonEmpty(k.perspective)) P.push(`${at}.perspective missing`);
  if (!nonEmpty(k.camera_move)) P.push(`${at}.camera_move missing`);
}

function validateElements(spec, P, elementIds) {
  const els = spec.kling?.elements;
  // An absent/empty elements array is a TEXT-TO-VIDEO render (no reference image — the video is
  // driven by the prompt alone). Only its SHAPE is validated here; when present, each element must
  // be well-formed. Casting (agent 4) returns [] when no available reference fits the idea.
  if (els === undefined || els === null) return;
  if (!isArr(els)) { P.push('kling.elements must be an array'); return; }
  els.forEach((e, i) => {
    if (!nonEmpty(e?.id)) P.push(`kling.elements[${i}].id missing`); else elementIds.add(e.id);
    if (!nonEmpty(e?.role)) P.push(`kling.elements[${i}].role missing`);
    if (!nonEmpty(e?.image)) P.push(`kling.elements[${i}].image missing`);
  });
}

function validateAudio(spec, P) {
  const a = spec.audio;
  if (a === undefined || a === null) return; // audio block is optional
  if (typeof a !== 'object') return P.push('audio: must be an object when present');
  if (a.generate_audio !== undefined && typeof a.generate_audio !== 'boolean') P.push('audio.generate_audio must be boolean');
  if (a.voice !== undefined) {
    if (typeof a.voice !== 'object') P.push('audio.voice must be an object');
    else if (a.voice.lines !== undefined) {
      if (!isArr(a.voice.lines)) P.push('audio.voice.lines must be an array');
      else a.voice.lines.forEach((l, i) => {
        if (!nonEmpty(l?.text)) P.push(`audio.voice.lines[${i}].text missing`);
        if (l?.shot_id === undefined && !isNum(l?.at_s)) P.push(`audio.voice.lines[${i}] needs a shot_id or numeric at_s`);
      });
    }
  }
}

function validateJobs(spec, P, elementIds, caps, enforceModelAspects = false, chainFrames = true) {
  // Every number below is the RENDERING MODEL's, with the shared fallback used when the registry
  // entry stays silent about a cap (never "no cap declared" → "no check").
  const maxSegments = caps.maxSegments ?? MAX_STORYBOARDS;
  const maxSegChars = caps.maxSegmentChars ?? MAX_SEG_CHARS;
  const maxSeconds = caps.maxSeconds ?? MAX_JOB_SECONDS;
  const minSeconds = caps.minSeconds ?? 1;
  const maxRefs = caps.maxImages ?? MAX_REF_IMAGES;

  const k = spec.kling;
  if (!k || typeof k !== 'object') { P.push('kling: missing'); return; }
  if (!oneOf(k.model_name, KLING_MODELS)) P.push(`kling.model_name "${k.model_name}" not in ${KLING_MODELS.join('|')}`);
  if (k.aspect_ratio !== undefined && !oneOf(k.aspect_ratio, ASPECTS)) P.push(`kling.aspect_ratio "${k.aspect_ratio}" not in ${ASPECTS.join('|')}`);
  if (k.resolution !== undefined && !oneOf(k.resolution, KLING_RES)) P.push(`kling.resolution "${k.resolution}" not in ${KLING_RES.join('|')}`);
  if (k.generate_audio !== undefined && typeof k.generate_audio !== 'boolean') P.push('kling.generate_audio must be boolean');
  // Caps gate ON TOP of the structural superset, applied only when the backend is known (explicit
  // or persisted): the widened ASPECTS accepts any registered model's ratio, so a kling-block ratio
  // the EFFECTIVE backend cannot render must still be rejected here. (project.aspect_ratio gets the
  // same gate at stage 0 in validateSpec — where its owning agent can be re-run for it.)
  if (enforceModelAspects) {
    const v = k.aspect_ratio;
    if (v !== undefined && oneOf(v, ASPECTS) && Array.isArray(caps.aspects) && !caps.aspects.includes(v)) {
      P.push(`kling.aspect_ratio "${v}" is not renderable on ${caps.label} (its ratios: ${caps.aspects.join('|')})`);
    }
  }

  const shots = isArr(spec.shots) ? spec.shots : [];
  const shotIds = new Set(shots.map((s) => s.shot_id));
  const shotById = Object.fromEntries(shots.map((s) => [s.shot_id, s]));
  if (!isArr(k.jobs) || k.jobs.length < 1) { P.push('kling.jobs must be a non-empty array'); return; }
  k.jobs.forEach((job, j) => {
    const at = `kling.jobs[${j}]`;
    if (!nonEmpty(job?.job_id)) P.push(`${at}.job_id missing`);
    if (!isArr(job?.shots) || job.shots.length < 1) { P.push(`${at}.shots must be a non-empty array`); return; }
    if (job.shots.length > maxSegments) P.push(`${at}: ${job.shots.length} shots exceeds the ${maxSegments}-storyboard cap`);
    let total = 0;
    job.shots.forEach((id) => {
      if (!shotIds.has(id)) { P.push(`${at}.shots: "${id}" is not a shot_id`); return; }
      const sk = shotById[id]?.kling;
      if (!sk || !nonEmpty(sk.content_prompt, 5)) P.push(`${at}: shot ${id} is missing kling.content_prompt`);
      else if (sk.content_prompt.length > maxSegChars) P.push(`${at}: shot ${id} content_prompt exceeds ${maxSegChars} chars`);
      total += Math.max(1, Math.round(Number(sk?.duration) || Number(shotById[id]?.duration_s) || 4));
    });
    // The cap is named after the (model, provider) pair that rejected the job — the same model
    // takes 15s/job on Segmind's 2.0 and 30s on its 2.5, so a bare "15s/job cap" leaves the planner
    // guessing which window it missed. The number stays first (long-standing wording), and the
    // backend-less SUPERSET reading carries no provider, so it names no pair.
    const capOwner = `${caps.label}${caps.providerLabel ? ` on ${caps.providerLabel}` : ''}`;
    if (total > maxSeconds) P.push(`${at}: total ${total}s exceeds the ${maxSeconds}s/job cap for ${capOwner} (move a shot to another job)`);
    // Naming the model matters here: the floor is 4s on Seedance 2.0 and 1s (i.e. never fires) on
    // Kling, so "under Seedance 2.0's 4s/job minimum" tells the planner which window it missed.
    if (total < minSeconds) P.push(`${at}: total ${total}s is under ${caps.label}'s ${minSeconds}s/job minimum (merge a shot into this job)`);
    const refs = job.elements ?? [];
    // The opening frame — an authored first_frame, or the seam frame every job after the first
    // receives on a chained multi-job render — rides one of the SAME image slots on models that
    // demote it to a reference (fal Seedance has no native slot; Segmind's native slot excludes
    // refs). Validating against the full cap would pass a max-ref job here and then silently drop
    // one paid identity reference at render time, so the slot is reserved up front.
    // An omitted/empty job.elements INHERITS the whole roster at render time (characterGroups()
    // expands it to every kling.elements entry), so the budget judges what will actually be sent —
    // a literal zero here with a nine-entry roster is nine paid uploads, not none.
    const effRefs = refs.length || elementIds.size;
    const holdsOpeningFrame = caps.family === 'seedance' && (nonEmpty(job.first_frame) || (j > 0 && chainFrames));
    const refBudget = maxRefs - (holdsOpeningFrame && demotesOpeningFrame(caps) ? 1 : 0);
    if (effRefs > refBudget) {
      const what = refs.length ? `${effRefs} elements` : `${effRefs} roster refs (job.elements omitted — the whole kling.elements roster rides along)`;
      P.push(refBudget < maxRefs
        ? `${at}: ${what} exceeds the ${refBudget}-reference budget (${caps.label} caps at ${maxRefs} images and 1 slot is reserved for this job's opening/seam frame)`
        : `${at}: ${what} exceeds the ${maxRefs}-reference cap`);
    }
    refs.forEach((id) => { if (!elementIds.has(id)) P.push(`${at}.elements: "${id}" not in kling.elements`); });
    if (job.first_frame !== undefined && !nonEmpty(job.first_frame)) P.push(`${at}.first_frame must be a non-empty path when present`);
    if (job.last_frame !== undefined && !nonEmpty(job.last_frame)) P.push(`${at}.last_frame must be a non-empty path when present`);
    if (job.last_frame && !job.first_frame) P.push(`${at}: last_frame requires first_frame (the Kling first/last node needs a first frame)`);
    // Where the native first/last mode EXCLUDES reference images (Segmind), an authored last_frame
    // can only be honored on a ref-less job — the renderer refuses the mix only after every upload
    // completed, so reject it here where the planner can still repair the spec for free. (An
    // omitted/empty job.elements inherits the whole roster, so count what will actually be sent.)
    const mixRefs = (job.elements ?? []).length || elementIds.size;
    if (nonEmpty(job.last_frame) && caps.firstFrameExcludesRefs && mixRefs > 0) {
      P.push(`${at}: last_frame needs ${caps.label}'s native first/last mode, and this job's ${mixRefs} reference image(s) occupy it — drop last_frame or the job's references`);
    }
  });
}

function validateQc(qc, P) {
  if (!qc || typeof qc !== 'object') return P.push('qc: missing');
  if (!oneOf(qc.status, QC_STATUS)) P.push(`qc.status "${qc.status}" not in ${QC_STATUS.join('|')}`);
  if (!isArr(qc.checks)) P.push('qc.checks must be an array');
}

/**
 * Validate a spec up to agent index `upTo` (0..7). Returns { ok, errors }.
 * upTo=7 (default) is a full validation suitable as the render precondition.
 * `backend` names the model that will render this spec (legacy alias or compound `<model>@<provider>`
 * id): its registry caps drive the job rules, so a job legal on Seedance 2.0's 9-reference endpoint
 * is judged against 9 rather than the old both-backends intersection. An unknown backend THROWS —
 * silently validating against nothing would hand a bad spec to the renderer.
 */
// The WIDEST structural window any registered model offers — the backend-less fallback for specs
// that carry no render_backend. Built from the registry, so a new model widens it automatically;
// family stays null (no model ⇒ no seam-slot reservation, no model-specific floors).
const SUPERSET_CAPS = (() => {
  const entries = BACKEND_IDS.map((id) => capsFor(id));
  const widest = (k, dflt, pick) => entries.reduce((m, c) => pick(m, c[k] ?? dflt), dflt);
  return {
    id: null, family: null, label: 'any registered model',
    maxImages: widest('maxImages', MAX_REF_IMAGES, Math.max),
    maxSeconds: widest('maxSeconds', MAX_JOB_SECONDS, Math.max),
    minSeconds: widest('minSeconds', 1, Math.min),
    maxSegments: widest('maxSegments', MAX_STORYBOARDS, Math.max),
    maxSegmentChars: widest('maxSegmentChars', MAX_SEG_CHARS, Math.max),
    aspects: [...ASPECTS],
  };
})();

export function validateSpec(spec, { upTo = 7, backend, chainFrames = true } = {}) {
  // Caps precedence: an EXPLICIT backend (every render/engine path passes the resolved one, and
  // only it turns on the model-aspect gate) > the spec's own persisted render_backend (a stored
  // 9-ref Seedance spec must not be judged by Kling's 7 just because a reader passed no options) >
  // the true structural SUPERSET (a spec naming no backend must round-trip anything any registered
  // model accepts). `chainFrames` mirrors config.kling.chainFrames (callers thread it; this module
  // stays config-free): with chaining OFF, later jobs receive no seam frame, so no slot is reserved.
  let enforceModelAspects = backend !== undefined;
  let caps = SUPERSET_CAPS;
  if (backend !== undefined) caps = capsFor(backend);
  else if (typeof spec?.render_backend === 'string') {
    // A successfully resolved PERSISTED backend enforces its aspect list too — a stored Kling spec
    // carrying 21:9 is broken however it is read. Only a spec with no backend at all gets the
    // superset reading.
    try { caps = capsFor(spec.render_backend); enforceModelAspects = true; } catch { /* unknown value — reported as a problem below */ }
  }
  const P = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec: not an object'] };
  if (spec.spec_version !== '1.0') P.push('spec_version must be "1.0"');
  // Legacy one-word ids stay in ALL_BACKENDS forever, so a spec.json written before compound ids
  // existed keeps validating with no migration on disk.
  if (spec.render_backend !== undefined && !ALL_BACKENDS.includes(spec.render_backend)) {
    P.push(`render_backend "${spec.render_backend}" is not one of: ${ALL_BACKENDS.join(', ')}`);
  }

  const shots = isArr(spec.shots) ? spec.shots : [];
  const elementIds = new Set();

  if (upTo >= 0) validateProject(spec.project, P);
  // The model-aspect gate for the PROJECT block fires at stage 0, where the field is authored: the
  // Showrunner owns project.aspect_ratio, and catching a ratio the model can't render only at the
  // jobs stage would let agents 1–5 spend before an error nobody downstream can fix.
  if (enforceModelAspects && upTo >= 0) {
    const pa = spec.project?.aspect_ratio;
    if (pa !== undefined && oneOf(pa, ASPECTS) && Array.isArray(caps.aspects) && !caps.aspects.includes(pa)) {
      P.push(`project.aspect_ratio "${pa}" is not renderable on ${caps.label} (its ratios: ${caps.aspects.join('|')})`);
    }
  }
  if (upTo >= 1) {
    if (!isArr(spec.shots) || spec.shots.length < 1) P.push('shots must be a non-empty array');
    shots.forEach((s, i) => validateShotScript(s, i, P, caps));
  }
  if (upTo >= 2) shots.forEach((s, i) => validateContent(s, i, P));
  if (upTo >= 3) shots.forEach((s, i) => validateCamera(s, i, P));
  if (upTo >= 4) validateElements(spec, P, elementIds);
  else if (upTo >= 6) validateElements(spec, P, elementIds); // jobs cross-ref needs element ids
  if (upTo >= 5) validateAudio(spec, P);
  if (upTo >= 6) validateJobs(spec, P, elementIds, caps, enforceModelAspects, chainFrames);
  if (upTo >= 7) validateQc(spec.qc, P);

  return { ok: P.length === 0, errors: P };
}

/** Which agent index owns each spec block — used by the engine to route QC failures. */
export const BLOCK_OWNER = { project: 0, shots: 1, content: 2, camera: 3, elements: 4, audio: 5, jobs: 6, qc: 7 };

// The two published caps bundles are DERIVED from the registry so there is one source of truth for
// every number; their shape is frozen because prompts and the web estimator read these key names.
const KLING_O3 = capsFor('kling-o3@fal');
const SEEDANCE_20 = capsFor('seedance-2.0@fal');

export const KLING_CAPS = {
  MAX_STORYBOARDS: KLING_O3.maxSegments,
  MAX_JOB_SECONDS: KLING_O3.maxSeconds,
  MAX_SEG_CHARS: KLING_O3.maxSegmentChars,
  MAX_REF_IMAGES: KLING_O3.maxImages,
};

/**
 * The render backends a spec/CLI may name (RENDERERS table in pipeline.js dispatches on these):
 * the canonical `<model>@<provider>` ids first, then the legacy one-word aliases.
 */
export const RENDER_BACKENDS = ALL_BACKENDS;

export const SEEDANCE_CAPS = {
  MIN_JOB_SECONDS: SEEDANCE_20.minSeconds,
  MAX_JOB_SECONDS: SEEDANCE_20.maxSeconds,
  MAX_IMAGE_REFS: SEEDANCE_20.maxImages,
  MAX_AUDIO_REFS: SEEDANCE_20.maxAudioRefs,
};

export default { validateSpec, BLOCK_OWNER, KLING_CAPS, SEEDANCE_CAPS, RENDER_BACKENDS };
