// Provider-neutral plumbing for queue-style render APIs (submit → poll → download). fal.ai is the
// only provider today, but none of this is fal-specific: a second queue-based provider reuses the
// same result-shape reader, downloader and error classifiers. It takes NO configuration of its own —
// every caller passes what it needs, so nothing here reads config.js or a provider's env. (It is not
// in web/server's static graph, and must not be put there without checking the note on the logger
// import below.)
//
// Extracted verbatim from fal.js, which imports and re-exports every symbol here so no downstream
// import ever changed.
import fs from 'node:fs/promises';
import path from 'node:path';
// logger.js reads LOG_LEVEL off process.env, so it is not itself config-free; queue-transport is in
// neither web/server's nor prompt-compose's static graph, which is why that is fine HERE and not a
// licence to import it from either. (util.js pulls it in too — that is exactly why the pure text
// helpers had to move to src/lib/text.js.)
import log from './logger.js';
import { fetchRetry, writeBuffer, ensureDir } from './util.js';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
/** Content type for a local asset, by extension (both providers' url fields are content-typed). */
export const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/** Inline a local file as a base64 data URI — every queue provider's url fields accept these, so
 *  this is the upload mode that needs no storage service (and therefore no second API key). */
export async function fileToDataUri(filePath) {
  const buf = await fs.readFile(filePath);
  return `data:${mimeFor(filePath)};base64,${buf.toString('base64')}`;
}

// A deterministic rejection (bad args / validation) — surface immediately, never retry.
const VALIDATION = /validation|unprocessable|invalid|must be|required|not (a )?valid|bad request|exceeds|unsupported/i;
export function isValidationError(err) {
  const m = String(err?.message ?? '');
  return /HTTP 4(00|22)\b/.test(m) || VALIDATION.test(m);
}

// The provider ALSO returns a 4xx (seen as HTTP 422 "…is not valid: timeout while fetching resource")
// when its worker transiently fails to fetch a reference URL we just uploaded — a CDN/propagation
// race, NOT a bad argument. Those must stay retryable despite matching VALIDATION above; a resubmit
// after backoff normally clears it. Keep this narrow to fetch/download timeouts so real bad-arg 422s
// still fail fast.
const TRANSIENT_FETCH = /timeout while fetching|fetching (the )?resource|failed to (fetch|download)|could not (fetch|download|retrieve)|unable to (fetch|download|access)|timed out fetching/i;
export function isTransientError(err) {
  return TRANSIENT_FETCH.test(String(err?.message ?? ''));
}

// A content-policy rejection: the model's moderation flagged the GENERATED video (or, rarely, an
// input) as sensitive — a false positive on a benign prompt is common. It is NOT retried: a resubmit
// is a fresh PAID generation, and the user's constraint is "don't add cost" on this 422. We only
// swap the raw provider blob for a clear, actionable message. Detected across both surfaces the
// provider uses: an HTTP-4xx response body and a FAILED status blob.
const CONTENT_POLICY = /content_policy_violation|sensitive content|partner_validation_failed|content policy/i;
export function isContentPolicyError(err) {
  return CONTENT_POLICY.test(String(err?.message ?? ''));
}
// Keep the `content_policy_violation` token in the message so the web banner can key off it.
// `provider` only names who flagged it — the wording (and the token) is identical everywhere.
export function contentPolicyError(err, endpoint, provider = 'fal') {
  return new Error(`${provider} ${endpoint}: the generated video was flagged by content moderation as sensitive (content_policy_violation) — usually a false positive on a benign prompt. Revise the plan to rephrase it (LLM only, no render spend), or retry to re-roll. [${String(err?.message ?? '').slice(0, 160)}]`);
}

/** The name the provider's own closing still is always saved under (see `saveAs` below) — the ROLE
 *  marker every consumer tells the courtesy artifact from the paid clip by. */
export const LAST_FRAME_FILE = 'last_frame.png';

/**
 * Every downloadable file in a queue result, tagged with whether the JOB depends on it and — where
 * the destination name MATTERS — what to save it as.
 * `optional: true` marks a courtesy artifact: something the provider threw in that we would like but
 * that is reproducible locally, so failing to fetch it must never discard the paid render.
 * REQUIRED first, courtesy last, always: what the job billed for has to be `[0]` for the callers
 * that take the first output, and a CDN is free to serve a video from an extensionless url, so no
 * consumer can find it back by filename.
 */
function resultFiles(result) {
  const files = [];
  const push = (v, optional = false, saveAs = null) => { if (v?.url) files.push({ url: v.url, optional, saveAs }); };
  push(result?.video);
  for (const v of result?.videos ?? []) push(v);
  if (typeof result?.url === 'string') files.push({ url: result.url, optional: false, saveAs: null });
  // A provider that was asked for its own closing still (`return_last_frame`) returns it alongside
  // the video. `saveAs` is what makes it usable: a result URL is content-hashed (…/<hash>.png) on
  // both real CDNs, so keying on the URL's basename would land the frame under an arbitrary name and
  // every downstream seam would silently fall back to an ffmpeg grab of pixels we already paid for.
  // It lands at <job>/last_frame.png — the exact file every downstream seam reads. OPTIONAL by
  // construction: the same frame can always be grabbed off the finished clip with ffmpeg (see
  // pipeline.closingFrameFor), and the video is what was paid for.
  push(result?.last_frame, true, LAST_FRAME_FILE);
  return files;
}

/** Pull every downloadable file URL out of a queue result ({ video:{url} } and common variants). */
export function resultFileUrls(result) {
  return resultFiles(result).map((f) => f.url);
}

/**
 * The paid render among a download's outputs, picked by ROLE: the closing still is the only courtesy
 * artifact this transport fetches and it always lands under LAST_FRAME_FILE, so everything else is
 * video the job was billed for. Never by extension — `…/videos/9f3ac` with no suffix is a perfectly
 * ordinary CDN url, and reading the still as the clip would stitch a PNG into the cut.
 */
export const paidClipOf = (outs) => (outs ?? []).find((p) => path.basename(p) !== LAST_FRAME_FILE) ?? outs?.[0] ?? null;

/**
 * Download every file url in a completed queue result to destDir (shared by the video backends).
 * A required file that will not download is a hard error; an OPTIONAL one is skipped with a warning
 * on stderr — the clip is already generated and billed, and throwing it away over a missing courtesy
 * still would cost the user a whole re-render to recover something ffmpeg can produce for free.
 * Ordered as resultFiles orders it: the paid video(s) first, the courtesy still last.
 */
export async function downloadResultFiles(result, destDir, label) {
  const files = resultFiles(result);
  if (!files.some((f) => !f.optional)) {
    throw new Error(`${label} job produced no video url: ${JSON.stringify(result).slice(0, 400)}`);
  }
  ensureDir(destDir);
  const paths = [];
  for (const [i, { url, optional, saveAs }] of files.entries()) {
    const base = saveAs ?? (() => { try { return path.basename(new URL(url).pathname) || `out_${i + 1}.mp4`; } catch { return `out_${i + 1}.mp4`; } })();
    try {
      const res = await fetchRetry(url, {}, { retries: 3 });
      if (!res.ok) throw new Error(`${label} output download failed (${url.slice(0, 80)}): HTTP ${res.status}`);
      paths.push(await writeBuffer(path.join(destDir, base.replace(/[/\\]/g, '_')), Buffer.from(await res.arrayBuffer())));
    } catch (e) {
      if (!optional) throw e;
      log.warn(`${label}: could not download the optional ${base} (${String(e?.message ?? e).slice(0, 120)}) — falling back to a local frame grab.`);
    }
  }
  return paths;
}

export default { mimeFor, fileToDataUri, resultFileUrls, downloadResultFiles, paidClipOf, LAST_FRAME_FILE, isValidationError, isTransientError, isContentPolicyError, contentPolicyError };
