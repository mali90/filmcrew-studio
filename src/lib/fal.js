// fal.ai client for the OFFICIAL queue HTTP API — the render backend. Auth is
// `Authorization: Key <FAL_KEY>`. A job is:
//   POST {baseUrl}/{endpoint}                      -> { request_id, status_url, response_url }
//   GET  status_url   (poll until status COMPLETED)
//   GET  response_url (the model output, e.g. { video: { url } })
// Endpoint ids live in config.fal and MUST be copied verbatim from each model's fal.ai "API" tab.
// The reproducibility primitive here is a persistent voice_id minted by mintVoice().
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import log from './logger.js';
import { fetchJson, fetchRetry, pollUntil, writeBuffer, ensureDir, sleep } from './util.js';
import { getCloudRef, setCloudRef } from './cloud-refs.js';

const FAL = config.fal;

function falHeaders(extra = {}) {
  if (!FAL.apiKey) throw new Error('FAL_KEY not set (get one at https://fal.ai/dashboard/keys and put it in .env).');
  return { Authorization: `Key ${FAL.apiKey}`, ...extra };
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/** Inline a local file as a base64 data URI (fal url-fields accept these — no extra round-trip). */
export async function fileToDataUri(filePath) {
  const buf = await fs.readFile(filePath);
  return `data:${mimeFor(filePath)};base64,${buf.toString('base64')}`;
}

/** Upload a local file to fal's CDN and return its public URL (used when FAL_UPLOAD_MODE=storage).
 *  Two-step initiate+PUT flow; verify the endpoint against fal docs if it ever 4xxs. */
export async function uploadToStorage(filePath) {
  const buf = await fs.readFile(filePath);
  const init = await fetchJson(
    FAL.storageInitiateUrl,
    { method: 'POST', headers: falHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content_type: mimeFor(filePath), file_name: path.basename(filePath) }) },
  );
  if (!init?.upload_url || !init?.file_url) throw new Error(`fal storage initiate returned no upload/file url: ${JSON.stringify(init).slice(0, 200)}`);
  const put = await fetchRetry(init.upload_url, { method: 'PUT', headers: { 'Content-Type': mimeFor(filePath) }, body: buf }, { retries: 2 });
  if (!put.ok) throw new Error(`fal storage PUT failed for ${path.basename(filePath)}: HTTP ${put.status}`);
  return init.file_url;
}

/**
 * Resolve a local file to a fal input value with an EXPLICIT mode ('storage' | 'data-uri') —
 * Seedance carries its own upload-mode setting (config.seedance.uploadMode), independent of
 * FAL_UPLOAD_MODE, so the mode can't always come from the config snapshot.
 */
export async function toFalInputAs(filePath, mode) {
  if (!fsSync.existsSync(filePath)) throw new Error(`fal input file missing: ${filePath}`);
  return mode === 'storage' ? uploadToStorage(filePath) : fileToDataUri(filePath);
}

/** Resolve a local file to a fal input value (data URI or CDN URL per config.fal.uploadMode). */
export async function toFalInput(filePath) {
  return toFalInputAs(filePath, FAL.uploadMode);
}

/**
 * A local file as a fal input, cached across runs in storage mode: the CDN URL is remembered under
 * a `fal:`-prefixed cloud-refs key (invalidated when the local file changes). Data-URI mode is
 * recomputed each call — inlining is cheap and needs no round-trip.
 */
export async function falRef(absPath, mode = FAL.uploadMode) {
  if (mode !== 'storage') return toFalInputAs(absPath, mode);
  if (!fsSync.existsSync(absPath)) throw new Error(`fal input file missing: ${absPath}`);
  const key = `fal:${path.basename(absPath)}`;
  return getCloudRef(key, absPath) ?? setCloudRef(key, await uploadToStorage(absPath), absPath);
}

// A deterministic fal rejection (bad args / validation) — surface immediately, never retry.
const VALIDATION = /validation|unprocessable|invalid|must be|required|not (a )?valid|bad request|exceeds|unsupported/i;
export function isValidationError(err) {
  const m = String(err?.message ?? '');
  return /HTTP 4(00|22)\b/.test(m) || VALIDATION.test(m);
}

// fal ALSO returns a 4xx (seen as HTTP 422 "…is not valid: timeout while fetching resource") when its
// worker transiently fails to fetch a reference URL we just uploaded — a CDN/propagation race, NOT a
// bad argument. Those must stay retryable despite matching VALIDATION above; a resubmit after backoff
// normally clears it. Keep this narrow to fetch/download timeouts so real bad-arg 422s still fail fast.
const TRANSIENT_FETCH = /timeout while fetching|fetching (the )?resource|failed to (fetch|download)|could not (fetch|download|retrieve)|unable to (fetch|download|access)|timed out fetching/i;
export function isTransientFalError(err) {
  return TRANSIENT_FETCH.test(String(err?.message ?? ''));
}

// A content-policy rejection: the model's moderation flagged the GENERATED video (or, rarely, an
// input) as sensitive — a false positive on a benign prompt is common. It is NOT retried: a resubmit
// is a fresh PAID generation, and the user's constraint is "don't add cost" on this 422. We only
// swap the raw fal blob for a clear, actionable message. Detected across both surfaces fal uses: an
// HTTP-4xx response body (fetchJson at line ~115) and a FAILED status blob (line ~113).
const CONTENT_POLICY = /content_policy_violation|sensitive content|partner_validation_failed|content policy/i;
export function isContentPolicyError(err) {
  return CONTENT_POLICY.test(String(err?.message ?? ''));
}
// Keep the `content_policy_violation` token in the message so the web banner can key off it.
function contentPolicyError(err, endpoint) {
  return new Error(`fal ${endpoint}: the generated video was flagged by content moderation as sensitive (content_policy_violation) — usually a false positive on a benign prompt. Revise the plan to rephrase it (LLM only, no render spend), or retry to re-roll. [${String(err?.message ?? '').slice(0, 160)}]`);
}

/** Submit one queued job and resolve its result object (polls status_url → response_url). */
async function submitAndWait(endpoint, args, { timeoutMs } = {}) {
  const submit = await fetchJson(
    `${FAL.baseUrl}/${endpoint}`,
    { method: 'POST', headers: falHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(args) },
    { retries: 2 },
  );
  const requestId = submit?.request_id;
  const statusUrl = submit?.status_url || `${FAL.baseUrl}/${endpoint}/requests/${requestId}/status`;
  const responseUrl = submit?.response_url || `${FAL.baseUrl}/${endpoint}/requests/${requestId}`;
  if (!requestId) throw new Error(`fal ${endpoint}: submit returned no request_id: ${JSON.stringify(submit).slice(0, 200)}`);
  log.info(`Queued fal job ${requestId} on ${endpoint}; polling status…`);

  const status = await pollUntil(
    () => fetchJson(statusUrl, { headers: falHeaders() }, { retries: 2 }),
    (s) => ['COMPLETED', 'ERROR', 'FAILED'].includes(String(s?.status).toUpperCase()),
    { intervalMs: 2500, timeoutMs: timeoutMs ?? 1200000, label: `fal job ${requestId}` },
  );
  if (String(status.status).toUpperCase() !== 'COMPLETED') {
    throw new Error(`fal job ${requestId} ${status.status}: ${JSON.stringify(status).slice(0, 300)}`);
  }
  return fetchJson(responseUrl, { headers: falHeaders() }, { retries: 2 });
}

/** Submit with a small resubmit loop for transient (non-validation) failures. */
async function runFal(endpoint, args, { timeoutMs } = {}) {
  const maxTries = Math.max(1, FAL.maxRetries ?? 3);
  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await submitAndWait(endpoint, args, { timeoutMs });
    } catch (e) {
      lastErr = e;
      // A content-policy flag never auto-retries (a resubmit is a fresh paid generation) — surface a
      // clear, actionable message and stop.
      if (isContentPolicyError(e)) throw contentPolicyError(e, endpoint);
      // Give up on genuine validation errors (but NOT a transient fetch race, which is retryable
      // despite its 422) and once we're out of tries; otherwise resubmit after a growing backoff.
      if ((isValidationError(e) && !isTransientFalError(e)) || attempt >= maxTries) throw e;
      const backoffMs = (FAL.retryBackoffMs ?? 8000) * attempt;
      log.warn(`fal ${endpoint} attempt ${attempt}/${maxTries} failed (${e.message.slice(0, 160)}) — retrying in ${Math.round(backoffMs / 1000)}s…`);
      await sleep(backoffMs);
    }
  }
  throw lastErr ?? new Error(`fal ${endpoint} failed after retries`);
}

/**
 * Mint a persistent Kling voice_id from a clean reference clip (5–30s, single speaker). One-time per
 * character; the id is then replayed on every generation for identical timbre (fal create-voice).
 * Returns the voice_id string.
 */
export async function mintVoice(clipPath) {
  const voiceUrl = await toFalInput(clipPath);
  const result = await runFal(FAL.createVoiceEndpoint, { voice_url: voiceUrl }, { timeoutMs: 300000 });
  const voiceId = result?.voice_id ?? result?.data?.voice_id;
  if (!voiceId) throw new Error(`create-voice returned no voice_id: ${JSON.stringify(result).slice(0, 300)}`);
  return String(voiceId);
}

/**
 * Money-safe live check of a FAL_KEY. Sends a DELIBERATELY INVALID create-voice request (empty body
 * → missing required voice_url) and reads only the HTTP status — no job is ever queued, nothing is
 * billed. 401/403 → bad key; other statuses (400/422 validation, or 200) → the key authenticated.
 * Takes the key EXPLICITLY (config.fal.apiKey is a frozen snapshot; the wizard's fresh key isn't in it).
 * @returns {Promise<{ok:boolean, reason?:string, status?:number, detail?:string}>}
 */
export async function validateFal(apiKey) {
  if (!apiKey) return { ok: false, reason: 'missing' };
  let res;
  try {
    res = await fetchRetry(
      `${FAL.baseUrl}/${FAL.createVoiceEndpoint}`,
      { method: 'POST', headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' }, body: '{}' },
      { retries: 0, timeoutMs: 20000 },
    );
  } catch (e) {
    return { ok: false, reason: 'network', detail: e.message };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', status: res.status };
  return { ok: true, status: res.status };
}

/** Pull every downloadable file URL out of a fal Kling result ({ video:{url} } and common variants). */
function resultFileUrls(result) {
  const urls = [];
  const push = (v) => { if (v?.url) urls.push(v.url); };
  push(result?.video);
  for (const v of result?.videos ?? []) push(v);
  if (typeof result?.url === 'string') urls.push(result.url);
  return urls;
}

/**
 * Run one Kling generation on fal and download its output(s) to destDir. `args` is the endpoint's
 * arguments object (prompt|multi_prompt, elements[{frontal_image_url, reference_image_urls, voice_id}],
 * aspect_ratio, generate_audio, duration, …) — built by fal-kling.js and verified against the
 * endpoint's fal "API" tab. fal result URLs EXPIRE, so we download immediately. Returns local paths.
 */
export async function generateKling(args, { endpoint = FAL.klingEndpoint, destDir, timeoutMs } = {}) {
  const result = await runFal(endpoint, args, { timeoutMs: timeoutMs ?? 1200000 });
  return downloadResultFiles(result, destDir, 'fal Kling');
}

/**
 * Run one Seedance 2.0 generation on fal and download its output(s) to destDir. `args` is the
 * endpoint's arguments object ({ prompt, image_urls, audio_urls?, aspect_ratio, resolution,
 * duration, generate_audio }) — built by fal-seedance.js and verified against the endpoint's fal
 * "API" tab. It must NEVER carry `seed` or `negative_prompt`: both are HTTP 422 on this endpoint
 * (and 422s are deterministic, so runFal surfaces them without retrying). `endpoint` switches
 * between the standard and mini (probe) tiers. fal result URLs EXPIRE → downloaded immediately.
 */
export async function generateSeedance(args, { endpoint = FAL.seedanceEndpoint, destDir, timeoutMs } = {}) {
  const result = await runFal(endpoint, args, { timeoutMs: timeoutMs ?? 1200000 });
  return downloadResultFiles(result, destDir, 'fal Seedance');
}

/** Download every file url in a completed fal result to destDir (shared by the video backends). */
async function downloadResultFiles(result, destDir, label) {
  const urls = resultFileUrls(result);
  if (!urls.length) throw new Error(`${label} job produced no video url: ${JSON.stringify(result).slice(0, 400)}`);
  ensureDir(destDir);
  const paths = [];
  for (const [i, url] of urls.entries()) {
    const res = await fetchRetry(url, {}, { retries: 3 });
    if (!res.ok) throw new Error(`${label} output download failed (${url.slice(0, 80)}): HTTP ${res.status}`);
    const base = (() => { try { return path.basename(new URL(url).pathname) || `out_${i + 1}.mp4`; } catch { return `out_${i + 1}.mp4`; } })();
    paths.push(await writeBuffer(path.join(destDir, base.replace(/[/\\]/g, '_')), Buffer.from(await res.arrayBuffer())));
  }
  return paths;
}

/** Build the fal Topaz video-upscale args object. Pure (unit-tested). */
export function topazArgs(videoUrl, { upscaleFactor = 2, model } = {}) {
  const args = { video_url: videoUrl, upscale_factor: upscaleFactor };
  if (model) args.model = model;
  return args;
}

/**
 * Upscale a local video via fal Topaz (fal-ai/topaz/upscale/video) and download the result to destDir.
 * Uploads the source to fal storage, submits { video_url, upscale_factor, model }, polls, and downloads
 * the { video:{url} } output (handled by resultFileUrls). Mirrors generateKling. Returns the local path.
 */
export async function topazUpscale(videoPath, { destDir, upscaleFactor = 2, model = FAL.topazModel, endpoint = FAL.topazEndpoint, timeoutMs } = {}) {
  const videoUrl = await uploadToStorage(videoPath);
  const result = await runFal(endpoint, topazArgs(videoUrl, { upscaleFactor, model }), { timeoutMs: timeoutMs ?? 1800000 });
  const urls = resultFileUrls(result);
  if (!urls.length) throw new Error(`fal Topaz job produced no video url: ${JSON.stringify(result).slice(0, 400)}`);
  ensureDir(destDir);
  const url = urls[0];
  const res = await fetchRetry(url, {}, { retries: 3 });
  if (!res.ok) throw new Error(`fal Topaz output download failed (${url.slice(0, 80)}): HTTP ${res.status}`);
  const base = (() => { try { return path.basename(new URL(url).pathname) || 'upscaled.mp4'; } catch { return 'upscaled.mp4'; } })();
  return writeBuffer(path.join(destDir, base.replace(/[/\\]/g, '_')), Buffer.from(await res.arrayBuffer()));
}

export default { fileToDataUri, uploadToStorage, toFalInput, toFalInputAs, falRef, mintVoice, generateKling, generateSeedance, topazUpscale, topazArgs, validateFal, isValidationError, isTransientFalError, isContentPolicyError };
