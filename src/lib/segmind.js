// Segmind client for the async v2 queue API — the second render provider. Auth is
// `x-api-key: <SEGMIND_API_KEY>`, and a model is addressed by SLUG, not by a fal-style endpoint path:
//
//   POST {baseUrl}/v2/{slug}               -> { request_id, status_url, response_url }
//   GET  {baseUrl}/v2/requests/{id}/status -> { status: QUEUED|PROCESSING|COMPLETED|FAILED,
//                                               metrics: { cost, remaining_credits } }  (terminal only)
//   GET  {baseUrl}/v2/requests/{id}        -> the model output, e.g. { video: { url } }
//
// THE RETRY POLICY IS DELIBERATELY NOT fal's. fal's runFal resubmits the whole POST whenever anything
// transient goes wrong — harmless there, catastrophic here: a second POST to /v2/<slug> starts a
// SECOND BILLABLE JOB. So this module is asymmetric on purpose:
//
//   * A POST may be retried only when the answer PROVES nothing was queued — an HTTP status Segmind
//     itself sent back (5xx), or a transport failure that happened before the request could land
//     (DNS, refused connection, TLS). A resubmit there costs nothing.
//   * AFTER a successful submit  — nothing ever re-POSTs. Polls and the result GET retry freely;
//     a failure past that point is REPORTED, never re-bought.
//   * AMBIGUOUS in between — an abort from our own timeout, a reset socket, a body we could not read.
//     `fetch` fails identically whether the connection died before the request left or after Segmind
//     accepted it, so these are treated as POSSIBLY QUEUED AND BILLED: reported, never retried.
//
// Everything else is turning provider blobs into sentences a user can act on: HTTP 422 is a
// deterministic FAILED that carries `detail`, 406 is "out of credits", and a 404 on a poll means the
// request record aged out (Segmind keeps one for about an hour) rather than a bad URL. Content-policy
// rejections ride the shared queue-transport classifier so the `content_policy_violation` token the
// web banner keys off survives on both providers.
//
// Result urls are PUBLIC CDN links that expire with the record, so outputs are downloaded
// immediately and WITHOUT the api key attached (the CDN rejects it).
import fsSync from 'node:fs';
import config from '../../config.js';
import log from './logger.js';
import { fetchRetry, pollUntil, sleep, debugBody } from './util.js';
import {
  fileToDataUri, downloadResultFiles,
  isContentPolicyError, contentPolicyError,
} from './queue-transport.js';

const SG = config.segmind;

/** Where a human goes to fix a key or a balance — quoted in every auth/credit message. */
const CONSOLE_URL = 'https://www.segmind.com';

const queueUrl = (slug) => `${SG.baseUrl}/v2/${slug}`;

/**
 * The key in force RIGHT NOW. process.env wins over the config snapshot (config.js reads the
 * environment once, at import) so a key written by the setup wizard takes effect without a restart.
 */
function segmindApiKey() {
  return String(process.env.SEGMIND_API_KEY ?? SG.apiKey ?? '').trim();
}

/** Auth headers, or a loud, actionable throw BEFORE any request leaves the machine. */
export function segmindHeaders(extra = {}) {
  const key = segmindApiKey();
  if (!key) throw new Error(`SEGMIND_API_KEY not set (get one at ${CONSOLE_URL} — Console → API Keys — and put it in .env).`);
  return { 'x-api-key': key, ...extra };
}

/** One request, returned as data: a non-2xx is NOT thrown, because only the caller knows whether a
 *  given status is fatal (422 on a submit) or terminal state (422 on a poll). */
async function sgFetch(url, opts, retryOpts) {
  const res = await fetchRetry(url, opts, retryOpts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

/** The human-readable part of a Segmind error/status blob (FastAPI puts it under `detail`). */
function detailOf(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body.slice(0, 400);
  const d = body.detail ?? body.error ?? body.message ?? body;
  return typeof d === 'string' ? d.slice(0, 400) : debugBody(d, 400);
}

/** Mark an error as "asking again cannot help" — the submit loop must not retry it. */
const noRetry = (err) => Object.assign(err, { noRetry: true });

/** Classify a non-2xx answer to a SUBMIT. Nothing is queued yet, so only `noRetry` is at stake. */
function submitError(slug, { status, body }) {
  const detail = detailOf(body);
  if (status === 406) {
    return noRetry(new Error(`Segmind ${slug}: insufficient credits — add credits in the Segmind console (${CONSOLE_URL} → Console → Billing) and run this again. The job was not queued, so nothing was charged. [${detail}]`));
  }
  if (status === 401 || status === 403) {
    return noRetry(new Error(`Segmind ${slug}: HTTP ${status} — SEGMIND_API_KEY was rejected. Check the key at ${CONSOLE_URL} (Console → API Keys). [${detail}]`));
  }
  if (status === 404) {
    return noRetry(new Error(`Segmind ${slug}: HTTP 404 — no such model slug. Copy it verbatim from the model's page on ${CONSOLE_URL} (SEGMIND_SEEDANCE25_SLUG / SEGMIND_SEEDANCE20_SLUG / SEGMIND_TOPAZ_SLUG). [${detail}]`));
  }
  if (status === 400 || status === 422) {
    const err = new Error(`Segmind ${slug}: the request was rejected as invalid (HTTP ${status}): ${detail}`);
    // Moderation can bite at submit time too — keep the token so the web banner still lights up.
    return noRetry(isContentPolicyError(err) ? contentPolicyError(err, slug, 'Segmind') : err);
  }
  return new Error(`Segmind ${slug}: submit failed with HTTP ${status}: ${detail}`);
}

/**
 * Transport-level failures that PROVE the POST never reached Segmind: the host never resolved, the
 * connection was refused or unroutable, TLS never came up, or the CONNECT (not the response) timed
 * out. In every one of these the request body never left the machine, so nothing was queued and a
 * resubmit is free. Deliberately a small allow-list: anything not on it is ambiguous.
 */
const PRE_SEND_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Every `code`/`name` in an error's `cause` chain and any AggregateError members — undici buries the
 *  real reason two levels down under a bare `TypeError: fetch failed`. */
function errorCodes(err, seen = new Set()) {
  const out = [];
  let e = err;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    if (e.code) out.push(String(e.code));
    if (e.name) out.push(String(e.name));
    if (Array.isArray(e.errors)) for (const sub of e.errors) out.push(...errorCodes(sub, seen));
    e = e.cause;
  }
  return out;
}

/**
 * A submit that threw before any HTTP status came back. The only question worth asking is whether
 * Segmind could ALREADY have queued (and billed) the job, and `fetch` does not answer it: an
 * AbortError from our own timeout, or an ECONNRESET, can just as easily mean "the request landed and
 * the reply was lost" as "nothing happened". So only a provably pre-send failure stays retryable;
 * everything else stops here and says what it does not know, because a blind resubmit is how one
 * render becomes two charges.
 */
function transportSubmitError(slug, e) {
  if (errorCodes(e).some((c) => PRE_SEND_CODES.has(c))) {
    return new Error(`Segmind ${slug}: the request never reached Segmind — ${e.message}`);
  }
  return noRetry(new Error(
    `Segmind ${slug}: the submit did not complete (${e.message}) and we cannot tell whether the job was queued. `
    + `NOT retrying — a second POST would be a second paid render. Check ${CONSOLE_URL} (Console → Requests) for a job `
    + `created just now: if one is there, let it finish; if not, run this again.`,
  ));
}

/**
 * Queue ONE job. This is the only place a POST is ever retried, and it retries only what it can
 * prove is free to retry: an HTTP status from Segmind that means "nothing was queued", or a
 * transport failure from before the request could land. Deterministic rejections (bad args, bad key,
 * no credits) stop on the first answer; ambiguous ones (see transportSubmitError) stop too.
 * @returns {Promise<{slug:string, requestId:string, statusUrl:string, responseUrl:string}>}
 */
export async function submitSegmind(slug, args, { requestTimeoutMs = 120000 } = {}) {
  const headers = segmindHeaders({ 'Content-Type': 'application/json' }); // keyless fails here, pre-flight
  const url = queueUrl(slug);
  const body = JSON.stringify(args);
  const maxTries = Math.max(1, SG.maxRetries ?? 3);
  let lastErr;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    let err;
    try {
      // retries:0 — this loop is the ONE retry budget for a POST, so "how many jobs could this call
      // have started" is exactly `attempt`, never attempt × the transport's own retries.
      const r = await sgFetch(url, { method: 'POST', headers, body }, { retries: 0, timeoutMs: requestTimeoutMs });
      if (r.ok) {
        const requestId = r.body?.request_id;
        if (!requestId) throw noRetry(new Error(`Segmind ${slug}: submit returned no request_id: ${debugBody(r.body, 200)}`));
        const statusUrl = r.body?.status_url || `${SG.baseUrl}/v2/requests/${requestId}/status`;
        const responseUrl = r.body?.response_url || `${SG.baseUrl}/v2/requests/${requestId}`;
        log.info(`Queued Segmind job ${requestId} on ${slug}; polling status…`);
        return { slug, requestId, statusUrl, responseUrl };
      }
      err = submitError(slug, r);
    } catch (e) {
      err = e.noRetry ? e : transportSubmitError(slug, e);
    }
    lastErr = err;
    if (err.noRetry || attempt >= maxTries) throw err;
    const backoffMs = (SG.retryBackoffMs ?? 8000) * attempt;
    log.warn(`Segmind ${slug} submit attempt ${attempt}/${maxTries} failed (${err.message.slice(0, 160)}) — retrying in ${Math.round(backoffMs / 1000)}s…`);
    await sleep(backoffMs);
  }
  throw lastErr ?? new Error(`Segmind ${slug}: submit failed after ${maxTries} attempts`);
}

/** A record Segmind no longer has: the render may well have run, but its output is gone. */
const expiredError = (slug, requestId) => new Error(
  `Segmind job ${requestId} on ${slug}: the request record has expired (HTTP 404). Segmind keeps a request for about 1 hour — the render may have completed, but its output can no longer be fetched. Re-render to get a new one (that is a fresh charge).`,
);

/** A poll/result GET. These read state and start no work, so they may retry as often as they like. */
async function readJob(url, headers, slug, requestId) {
  const r = await sgFetch(url, { headers }, { retries: 2 });
  if (r.ok) return r.body;
  if (r.status === 404) throw expiredError(slug, requestId);
  // Segmind reports a deterministic model-side failure as a 422 whose body IS the terminal state.
  if (r.status === 422) {
    const base = r.body && typeof r.body === 'object' ? r.body : { detail: r.body };
    return { ...base, status: 'FAILED' };
  }
  if (r.status === 401 || r.status === 403) {
    throw new Error(`Segmind job ${requestId} on ${slug}: HTTP ${r.status} while polling — SEGMIND_API_KEY was rejected. The job may still be running; check it at ${CONSOLE_URL}. [${detailOf(r.body)}]`);
  }
  throw new Error(`Segmind job ${requestId} on ${slug}: HTTP ${r.status} while polling: ${detailOf(r.body)}`);
}

/** The credit ledger Segmind attaches to a terminal status — the receipt for a paid job. */
function readMetrics(status) {
  const m = status?.metrics ?? {};
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return { cost: num(m.cost), remainingCredits: num(m.remaining_credits ?? m.remainingCredits) };
}

const TERMINAL = ['COMPLETED', 'FAILED', 'ERROR', 'CANCELLED'];

/**
 * Poll an already-queued job to its end and fetch its output. NEVER submits anything — every path
 * out of here either returns the result or reports a failure, because the job is already paid for.
 * @returns {Promise<{requestId:string, slug:string, result:object,
 *                    metrics:{cost:number|null, remainingCredits:number|null},
 *                    statusUrl:string, responseUrl:string}>}
 */
export async function awaitSegmind(job, { timeoutMs, intervalMs } = {}) {
  const { slug = 'job', requestId, statusUrl, responseUrl } = job;
  const headers = segmindHeaders();

  const status = await pollUntil(
    () => readJob(statusUrl, headers, slug, requestId),
    (s) => TERMINAL.includes(String(s?.status).toUpperCase()),
    { intervalMs: intervalMs ?? 2500, timeoutMs: timeoutMs ?? 1200000, label: `Segmind job ${requestId}` },
  );

  const state = String(status?.status).toUpperCase();
  if (state !== 'COMPLETED') {
    const err = new Error(`Segmind job ${requestId} on ${slug} ${state}: ${detailOf(status)}`);
    // A moderation flag is never re-rolled automatically — a resubmit is a fresh paid generation.
    if (isContentPolicyError(err)) throw contentPolicyError(err, slug, 'Segmind');
    throw err;
  }

  const metrics = readMetrics(status);
  if (metrics.cost != null || metrics.remainingCredits != null) {
    log.info(`Segmind job ${requestId} completed — cost $${metrics.cost ?? '?'}, ${metrics.remainingCredits ?? '?'} credits remaining`);
  }
  const result = await readJob(responseUrl, headers, slug, requestId);
  return { requestId, slug, result, metrics, statusUrl, responseUrl };
}

/**
 * Submit ONCE, then wait. The whole money-safety story of this module in one line: `submitSegmind`
 * owns every retry that could start a job, `awaitSegmind` owns everything after, and nothing in
 * `awaitSegmind` can loop back into a POST.
 */
export async function runSegmind(slug, args, { timeoutMs, intervalMs } = {}) {
  const job = await submitSegmind(slug, args);
  return awaitSegmind(job, { timeoutMs, intervalMs });
}

/**
 * Run one Segmind generation and download its output(s) to destDir. `args` is the model's own
 * argument object, built by seedance-args.js from the registry caps (Segmind's key names:
 * `reference_images`, integer `duration`, …). `onMeta` receives the receipt — request id, what the
 * job cost, and the credits left — so the caller can record it in the run's sidecar.
 * Segmind's result urls are public CDN links that expire with the record (~1h), so they are fetched
 * immediately and with NO api key (downloadResultFiles sends no headers).
 */
export async function generateSegmind(args, { slug = SG.seedance25Slug, destDir, timeoutMs, onMeta } = {}) {
  const { requestId, result, metrics } = await runSegmind(slug, args, { timeoutMs: timeoutMs ?? 1200000 });
  onMeta?.({ requestId, cost: metrics.cost, remainingCredits: metrics.remainingCredits });
  return downloadResultFiles(result, destDir, `Segmind ${slug}`);
}

/**
 * Upscale one already-rendered clip with Segmind's Topaz (`topaz-video-upscale`) — the Segmind
 * sibling of fal.js's `topazUpscale`, and the last piece of a Segmind-only install: render here,
 * upscale here, no fal key anywhere. `args` is the model's own argument object ({ video,
 * target_resolution, target_fps }), built by upscale.js's pure `segmindTopazArgs` so the
 * frame-rate pin stays one testable function rather than a value assembled in the transport.
 *
 * A named wrapper rather than a bare generateSegmind call, for two reasons that both cost money:
 * generateSegmind's default slug is the RENDER model (upscaling through it would queue a wrong,
 * billed job), and Topaz on a long clip outlasts the render timeout.
 * @returns {Promise<string>} the local path of the single upscaled mp4
 */
export async function topazUpscaleSegmind(args, { destDir, slug = SG.topazSlug, timeoutMs, onMeta } = {}) {
  const outs = await generateSegmind(args, { slug, destDir, timeoutMs: timeoutMs ?? 1800000, onMeta });
  const mp4 = outs.find((p) => /\.mp4$/i.test(p)) ?? outs[0];
  if (!mp4) throw new Error(`Segmind ${slug}: the upscale produced no output file.`);
  return mp4;
}

/**
 * Resolve a local file to a value Segmind accepts in a url field.
 *   'data-uri'    — inline base64. No other service is involved, which is what makes a Segmind-only
 *                   install (no FAL_KEY anywhere) possible.
 *   'fal-storage' — upload to fal's CDN and reuse the cloud-refs cache, so a reference is uploaded
 *                   once per basename instead of on every render. Needs FAL_KEY. fal.js is imported
 *                   LAZILY so a data-uri graph never loads it (nor requires a key it doesn't have).
 * `cache:false` is the seam-frame escape hatch: every seam file is named last_frame.png, so caching
 * by basename would hand job 3 job 2's frame.
 */
export async function segmindAssetUrl(absPath, mode = SG.uploadMode, { cache = true } = {}) {
  if (!fsSync.existsSync(absPath)) throw new Error(`Segmind input file missing: ${absPath}`);
  if (mode === 'data-uri') return fileToDataUri(absPath);
  if (mode === 'fal-storage') {
    const { falRef, toFalInputAs } = await import('./fal.js');
    return cache ? falRef(absPath, 'storage') : toFalInputAs(absPath, 'storage');
  }
  throw new Error(`unknown upload mode '${mode}' (SEGMIND_UPLOAD_MODE) — use 'data-uri' (inline, needs no other key) or 'fal-storage' (fal CDN, needs FAL_KEY).`);
}

/**
 * Money-safe live check of a Segmind key. POSTs a DELIBERATELY EMPTY body to the RENDER slug (what a
 * render key is actually for — not the upscale model, which a Segmind-render user may never touch)
 * and reads the HTTP status. The answer we WANT is a 422: "the server understood us and rejected the
 * shape" is the one reply that proves the key, the slug AND the base url are all good with nothing
 * queued.
 *
 * The statuses are not flattened into a bare ok/not-ok, because two of them are traps:
 *   404 — a typo'd slug or a wrong SEGMIND_BASE_URL. Calling that a healthy key is how a setup looks
 *         fine right until the first paid render fails.
 *   2xx — the ONE outcome that means the probe queued something. Nothing in the API promises a model
 *         with all-optional params must reject `{}`, so it is surfaced as an anomaly carrying the
 *         request id, never as a quiet success.
 * Takes the key EXPLICITLY, exactly like validateFal: the setup wizard's freshly-typed key is not in
 * the config snapshot yet.
 * @returns {Promise<{ok:boolean, reason?:string, status?:number, detail?:string,
 *                    warning?:string, requestId?:string}>}
 */
export async function validateSegmind(apiKey, { slug = SG.seedance25Slug } = {}) {
  if (!apiKey) return { ok: false, reason: 'missing' };
  let res;
  let body = null;
  try {
    res = await fetchRetry(
      queueUrl(slug),
      { method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, body: '{}' },
      { retries: 0, timeoutMs: 20000 },
    );
    const text = await res.text().catch(() => '');
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  } catch (e) {
    return { ok: false, reason: 'network', detail: e.message };
  }
  const status = res.status;
  if (status === 401 || status === 403) return { ok: false, reason: 'auth', status };
  if (status === 404) {
    return {
      ok: false,
      reason: 'not_found',
      status,
      detail: `no model '${slug}' at ${SG.baseUrl} — check SEGMIND_BASE_URL and copy the slug verbatim from ${CONSOLE_URL}. [${detailOf(body)}]`,
    };
  }
  // The key authenticated and the account is simply empty — worth saying out loud, not a bad key.
  if (status === 406) {
    return { ok: true, status, warning: `the key works, but the account is out of credits — add some at ${CONSOLE_URL} (Console → Billing) before rendering.` };
  }
  if (status === 400 || status === 422) return { ok: true, status };
  if (res.ok) {
    const requestId = body?.request_id ? String(body.request_id) : undefined;
    const warning = `the key check was ACCEPTED (HTTP ${status})${requestId ? ` as job ${requestId}` : ''} instead of being rejected as an empty request`
      + ` — '${slug}' may have queued a billable job. Check ${CONSOLE_URL} (Console → Requests).`;
    log.warn(`Segmind key check: ${warning}`);
    return { ok: true, status, warning, ...(requestId ? { requestId } : {}) };
  }
  return { ok: false, reason: 'unexpected', status, detail: detailOf(body) };
}

export default {
  segmindHeaders, submitSegmind, awaitSegmind, runSegmind, generateSegmind, topazUpscaleSegmind,
  segmindAssetUrl, validateSegmind,
};
