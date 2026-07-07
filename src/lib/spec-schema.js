// Dependency-free, incremental validator for the Kling-native Production Spec.
// validateSpec(spec, { upTo }) checks only the blocks owned by agents 0..upTo, so it doubles as
// the engine's per-agent gate AND the renderer's precondition (upTo=7).
//
// Agent → block ownership:
//   0 Showrunner=project · 1 Storyboard=shots[] · 2 Scene Director=shots[].kling.content_prompt ·
//   3 Cinematographer=shots[].kling.{shot_size,perspective,camera_move} · 4 Casting=kling.elements ·
//   5 Sound=audio · 6 Job Planner=kling.jobs + top-level kling settings · 7 QC=qc
//
// Kling 3.0 Omni HARD caps (object_info-verified): ≤6 storyboard segments/job, ≤15s/job,
// ≤512 chars/segment, ≤7 reference images/job.

export const ASPECTS = ['16:9', '9:16', '1:1'];
const KLING_MODELS = ['kling-v3-omni', 'kling-video-o1'];
const KLING_RES = ['4k', '1080p', '720p'];
const SHOT_SIZES = ['extreme_close_up', 'close_up', 'medium_close_up', 'medium', 'medium_wide', 'wide', 'extreme_wide'];
const QC_STATUS = ['pending', 'pass', 'fail'];
const MAX_STORYBOARDS = 6;
const MAX_JOB_SECONDS = 15;
const MAX_SEG_CHARS = 512;
const MAX_REF_IMAGES = 7; // the Kling cap — kept for BOTH backends (safe intersection; Seedance takes ≤9, leaving room for the seam frame)
const BACKENDS = ['kling', 'seedance'];
const SEEDANCE_MIN_JOB_SECONDS = 4; // Seedance hard floor: duration '4'..'15'

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

function validateShotScript(s, i, P) {
  const at = `shots[${i}]`;
  if (!s || typeof s !== 'object') return P.push(`${at}: not an object`);
  if (!nonEmpty(s.shot_id)) P.push(`${at}.shot_id missing`);
  if (!nonEmpty(s.beat)) P.push(`${at}.beat missing`);
  if (!isNum(s.duration_s) || s.duration_s < 1 || s.duration_s > MAX_JOB_SECONDS) P.push(`${at}.duration_s must be 1–${MAX_JOB_SECONDS}`);
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
  if (!isArr(els) || els.length < 1) { P.push('kling.elements must be a non-empty array'); return; }
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

function validateJobs(spec, P, elementIds, backend) {
  const k = spec.kling;
  if (!k || typeof k !== 'object') { P.push('kling: missing'); return; }
  if (!oneOf(k.model_name, KLING_MODELS)) P.push(`kling.model_name "${k.model_name}" not in ${KLING_MODELS.join('|')}`);
  if (k.aspect_ratio !== undefined && !oneOf(k.aspect_ratio, ASPECTS)) P.push(`kling.aspect_ratio "${k.aspect_ratio}" not in ${ASPECTS.join('|')}`);
  if (k.resolution !== undefined && !oneOf(k.resolution, KLING_RES)) P.push(`kling.resolution "${k.resolution}" not in ${KLING_RES.join('|')}`);
  if (k.generate_audio !== undefined && typeof k.generate_audio !== 'boolean') P.push('kling.generate_audio must be boolean');

  const shots = isArr(spec.shots) ? spec.shots : [];
  const shotIds = new Set(shots.map((s) => s.shot_id));
  const shotById = Object.fromEntries(shots.map((s) => [s.shot_id, s]));
  if (!isArr(k.jobs) || k.jobs.length < 1) { P.push('kling.jobs must be a non-empty array'); return; }
  k.jobs.forEach((job, j) => {
    const at = `kling.jobs[${j}]`;
    if (!nonEmpty(job?.job_id)) P.push(`${at}.job_id missing`);
    if (!isArr(job?.shots) || job.shots.length < 1) { P.push(`${at}.shots must be a non-empty array`); return; }
    if (job.shots.length > MAX_STORYBOARDS) P.push(`${at}: ${job.shots.length} shots exceeds the ${MAX_STORYBOARDS}-storyboard cap`);
    let total = 0;
    job.shots.forEach((id) => {
      if (!shotIds.has(id)) { P.push(`${at}.shots: "${id}" is not a shot_id`); return; }
      const sk = shotById[id]?.kling;
      if (!sk || !nonEmpty(sk.content_prompt, 5)) P.push(`${at}: shot ${id} is missing kling.content_prompt`);
      else if (sk.content_prompt.length > MAX_SEG_CHARS) P.push(`${at}: shot ${id} content_prompt exceeds ${MAX_SEG_CHARS} chars`);
      total += Math.max(1, Math.round(Number(sk?.duration) || Number(shotById[id]?.duration_s) || 4));
    });
    if (total > MAX_JOB_SECONDS) P.push(`${at}: total ${total}s exceeds the ${MAX_JOB_SECONDS}s/job cap (move a shot to another job)`);
    if (backend === 'seedance' && total < SEEDANCE_MIN_JOB_SECONDS) P.push(`${at}: total ${total}s is under Seedance's ${SEEDANCE_MIN_JOB_SECONDS}s/job minimum (merge a shot into this job)`);
    const refs = job.elements ?? [];
    if (refs.length > MAX_REF_IMAGES) P.push(`${at}: ${refs.length} elements exceeds the ${MAX_REF_IMAGES}-reference cap`);
    refs.forEach((id) => { if (!elementIds.has(id)) P.push(`${at}.elements: "${id}" not in kling.elements`); });
    if (job.first_frame !== undefined && !nonEmpty(job.first_frame)) P.push(`${at}.first_frame must be a non-empty path when present`);
    if (job.last_frame !== undefined && !nonEmpty(job.last_frame)) P.push(`${at}.last_frame must be a non-empty path when present`);
    if (job.last_frame && !job.first_frame) P.push(`${at}: last_frame requires first_frame (the Kling first/last node needs a first frame)`);
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
 * `backend` adds the render backend's own job rules (today: Seedance's 4s/job floor); the shared
 * caps are the safe intersection of both backends, so a valid spec renders on either.
 */
export function validateSpec(spec, { upTo = 7, backend = 'kling' } = {}) {
  const P = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec: not an object'] };
  if (spec.spec_version !== '1.0') P.push('spec_version must be "1.0"');
  if (spec.render_backend !== undefined && !BACKENDS.includes(spec.render_backend)) {
    P.push(`render_backend "${spec.render_backend}" is not one of: ${BACKENDS.join(', ')}`);
  }

  const shots = isArr(spec.shots) ? spec.shots : [];
  const elementIds = new Set();

  if (upTo >= 0) validateProject(spec.project, P);
  if (upTo >= 1) {
    if (!isArr(spec.shots) || spec.shots.length < 1) P.push('shots must be a non-empty array');
    shots.forEach((s, i) => validateShotScript(s, i, P));
  }
  if (upTo >= 2) shots.forEach((s, i) => validateContent(s, i, P));
  if (upTo >= 3) shots.forEach((s, i) => validateCamera(s, i, P));
  if (upTo >= 4) validateElements(spec, P, elementIds);
  else if (upTo >= 6) validateElements(spec, P, elementIds); // jobs cross-ref needs element ids
  if (upTo >= 5) validateAudio(spec, P);
  if (upTo >= 6) validateJobs(spec, P, elementIds, backend);
  if (upTo >= 7) validateQc(spec.qc, P);

  return { ok: P.length === 0, errors: P };
}

/** Which agent index owns each spec block — used by the engine to route QC failures. */
export const BLOCK_OWNER = { project: 0, shots: 1, content: 2, camera: 3, elements: 4, audio: 5, jobs: 6, qc: 7 };

export const KLING_CAPS = { MAX_STORYBOARDS, MAX_JOB_SECONDS, MAX_SEG_CHARS, MAX_REF_IMAGES };

/** The render backends a spec/CLI may name (RENDERERS table in pipeline.js dispatches on these). */
export const RENDER_BACKENDS = BACKENDS;

export const SEEDANCE_CAPS = { MIN_JOB_SECONDS: SEEDANCE_MIN_JOB_SECONDS, MAX_JOB_SECONDS, MAX_IMAGE_REFS: 9, MAX_AUDIO_REFS: 3 };

export default { validateSpec, BLOCK_OWNER, KLING_CAPS, SEEDANCE_CAPS, RENDER_BACKENDS };
