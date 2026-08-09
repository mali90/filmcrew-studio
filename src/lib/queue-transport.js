// Provider-neutral plumbing for queue-style render APIs (submit → poll → download). fal.ai is the
// only provider today, but none of this is fal-specific: a second queue-based provider reuses the
// same result-shape reader, downloader and error classifiers. Config-free by construction — every
// caller passes what it needs, so this module can be imported from anywhere (including the web
// server, whose static-import chain must stay config-free).
//
// Extracted verbatim from fal.js, which imports and re-exports every symbol here so no downstream
// import ever changed.
import fs from 'node:fs/promises';
import path from 'node:path';
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

/** Pull every downloadable file URL out of a queue result ({ video:{url} } and common variants). */
export function resultFileUrls(result) {
  const urls = [];
  const push = (v) => { if (v?.url) urls.push(v.url); };
  push(result?.video);
  for (const v of result?.videos ?? []) push(v);
  // A provider that was asked for its own closing still (`return_last_frame`) returns it alongside
  // the video. It downloads to <job>/last_frame.png — the exact file every downstream seam reads —
  // so the generator's own pixels replace an ffmpeg re-encode of them.
  push(result?.last_frame);
  if (typeof result?.url === 'string') urls.push(result.url);
  return urls;
}

/** Download every file url in a completed queue result to destDir (shared by the video backends). */
export async function downloadResultFiles(result, destDir, label) {
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

export default { mimeFor, fileToDataUri, resultFileUrls, downloadResultFiles, isValidationError, isTransientError, isContentPolicyError, contentPolicyError };
