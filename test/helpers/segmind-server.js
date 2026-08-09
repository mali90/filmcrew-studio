// Mock of the Segmind async v2 queue API on 127.0.0.1:0 — the Segmind sibling of fal-server.js, with
// the SAME ergonomics: a mutable `opts` object a test flips between assertions, a `requests[]` log of
// every hit, and a download route. Tests point config.segmind.baseUrl here via SEGMIND_BASE_URL.
//
// The real shape this mirrors (verified 2026-08-08, plan "Research facts"):
//   POST {base}/v2/<slug>              → { request_id, status_url, response_url }   (x-api-key auth)
//   GET  {base}/v2/requests/{id}/status→ { status: QUEUED|PROCESSING|COMPLETED|FAILED,
//                                          metrics: { cost, remaining_credits } }   (terminal only)
//   GET  {base}/v2/requests/{id}       → { video: { url } }  — a PUBLIC CDN url, no auth to download
//   422 = deterministic FAILED (carries `detail`)   406 = insufficient credits   404 = record expired
//
// TWO properties of this mock are load-bearing and deliberate:
//   1. `queued[]` records only jobs that were ACTUALLY accepted — an empty/`{}` POST answers 422
//      WITHOUT queuing anything, which is what makes the validateSegmind money-safety assertion
//      ("zero billable jobs") real rather than a tautology.
//   2. `/dl/*` requires NO auth and records the `x-api-key` header it received (normally undefined),
//      so a test can prove the result download never carries the key — Segmind's CDN rejects it.
import http from 'node:http';

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

/**
 * @param {{videoBytes?:Buffer, opts?:object}} p
 *   opts (all optional, all mutable at runtime):
 *     authFail          — every authenticated route answers 401
 *     validationFail    — POST /v2/:slug answers 422 (deterministic bad args; never retried)
 *     insufficientCredits — POST answers 406 (never retried; actionable message)
 *     rateLimitTimes    — the next N POSTs answer 429 (a REJECTION — nothing queued; resubmit is safe)
 *     submitFailTimes   — the next N POSTs answer 500 (AMBIGUOUS: the job may have been queued and
 *                         billed before the server fell over — the client must stop, never re-POST)
 *     submitHang        — POSTs are accepted and queued but NEVER answered (the client aborts; it
 *                         cannot know the job exists, so it must not re-POST)
 *     unknownSlug       — POST /v2/:slug answers 404 (bad slug or wrong base url)
 *     acceptsEmptyBody  — an empty `{}` POST is ACCEPTED and queued instead of 422'd
 *     statusFailOnce    — the FIRST status poll answers 500 (transient; only GETs may retry)
 *     processingHits    — the first N status polls answer PROCESSING before COMPLETED
 *     failed            — the status poll answers HTTP 422 { status:'FAILED', detail }
 *     contentPolicy     — the status poll answers a FAILED blob carrying content_policy_violation
 *     expired           — status/result answer 404 (the ~1h record expiry)
 *     cost / remainingCredits — the terminal body's metrics
 *     upscaledBytes     — the bytes the Topaz download serves (default: videoBytes), so a test can
 *                         hand back an audio-less clip and prove the source audio is re-muxed on
 *     omitLastFrame     — a job that ASKED for return_last_frame gets no `last_frame` back at all
 *     lastFrameBytes    — the bytes the closing-still download serves (default: 'PROVIDER-PNG')
 *     lastFrameFail     — the `last_frame` url is advertised but answers 404 (expired CDN record):
 *                         the paid clip must still land, with the frame grabbed locally instead
 * @returns {Promise<{baseUrl:string, requests:object[], queued:object[], opts:object, close:()=>Promise<void>}>}
 */
/** Where the mock serves the generator's closing still — content-hashed, like the real CDN. */
const LAST_FRAME_PATH = '/dl/2f9c1ab7e40d.png';

export async function startSegmindServer({ videoBytes = Buffer.from('FAKE-MP4'), opts = {} } = {}) {
  let statusHits = 0;
  let nextId = 1;
  const requests = [];
  const queued = [];

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : '';
    const apiKey = req.headers['x-api-key'];
    requests.push({ method: req.method, path: u.pathname, body, apiKey, auth: req.headers.authorization });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

    // The public CDN: no auth, ever. Checked FIRST so an authFail run can still download.
    // `opts.upscaledBytes` answers the Topaz download with a DIFFERENT file — that is how a test
    // reproduces Topaz handing back a clip whose audio track it dropped.
    if (u.pathname.startsWith('/dl/')) {
      // Content-HASHED, exactly as Segmind's real CDN serves a result file. A renderer that found
      // the closing still by the url's basename would pass here under a friendly name and then
      // never find it in production, so the name is deliberately opaque: the transport has to be
      // the thing that lands it at <job>/last_frame.png.
      if (u.pathname === LAST_FRAME_PATH) {
        // `lastFrameFail` is the provider that ADVERTISED its closing still and then cannot serve it
        // (an expired CDN record is the common one). The clip is already generated and billed, so
        // this must degrade to an ffmpeg grab — never fail the render.
        if (opts.lastFrameFail) { res.writeHead(404); return res.end('gone'); }
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(opts.lastFrameBytes ?? Buffer.from('PROVIDER-PNG'));
      }
      const bytes = (u.pathname.endsWith('upscaled.mp4') && opts.upscaledBytes) || videoBytes;
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end(bytes);
    }

    if (opts.authFail || !apiKey) return json(401, { detail: 'unauthorized' });

    // ── submit ────────────────────────────────────────────────────────────
    if (req.method === 'POST' && u.pathname.startsWith('/v2/')) {
      const slug = u.pathname.slice('/v2/'.length);
      // A wrong slug, or a SEGMIND_BASE_URL pointing at the wrong host: everything 404s.
      if (opts.unknownSlug) return json(404, { detail: 'Not Found' });
      // A deliberately empty probe (validateSegmind) is rejected on shape alone — and QUEUES NOTHING.
      // `acceptsEmptyBody` models the model that does NOT reject it (all-optional params, or a change
      // in validation order): `{}` is a valid request, so the probe queues a real, billable job. That
      // is the case validateSegmind must surface rather than report as a clean bill of health.
      if ((!body.trim() || body.trim() === '{}') && !opts.acceptsEmptyBody) {
        return json(422, { detail: [{ loc: ['body', 'prompt'], msg: 'field required', type: 'missing' }] });
      }
      if (opts.rateLimitTimes > 0) { opts.rateLimitTimes -= 1; return json(429, { detail: 'rate limited' }); }
      if (opts.submitFailTimes > 0) { opts.submitFailTimes -= 1; res.writeHead(500); return res.end('transient'); }
      // The POST is received and RECORDED (and Segmind-side, queued and billed) but never answered,
      // so the client's own timeout aborts a request the vendor already accepted — the ambiguous
      // failure that must never be re-POSTed.
      if (opts.submitHang) {
        let args; try { args = JSON.parse(body); } catch { args = null; }
        queued.push({ id: `sg_${nextId++}`, slug, args });
        return; // no response, ever
      }
      if (opts.insufficientCredits) return json(406, { detail: 'Insufficient credits to run this model.' });
      if (opts.validationFail) return json(422, { detail: [{ loc: ['body', 'duration'], msg: 'duration must be between 4 and 30', type: 'value_error' }] });
      const id = `sg_${nextId++}`;
      let args;
      try { args = JSON.parse(body); } catch { args = null; }
      queued.push({ id, slug, args });
      return json(200, { request_id: id, status_url: `${base}/v2/requests/${id}/status`, response_url: `${base}/v2/requests/${id}` });
    }

    // ── poll ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && /^\/v2\/requests\/[^/]+\/status$/.test(u.pathname)) {
      if (opts.expired) return json(404, { detail: 'Request not found' });
      if (opts.statusFailOnce && statusHits++ === 0) { res.writeHead(500); return res.end('transient'); }
      if (opts.processingHits > 0) { opts.processingHits -= 1; return json(200, { status: 'PROCESSING' }); }
      if (opts.contentPolicy) {
        return json(200, {
          status: 'FAILED',
          detail: [{ loc: ['body', 'generated_video'], msg: 'Output video has sensitive content.', type: 'content_policy_violation' }],
        });
      }
      if (opts.failed) return json(422, { status: 'FAILED', detail: 'the model rejected the job: reference audio shorter than 2s' });
      return json(200, {
        status: 'COMPLETED',
        metrics: { cost: opts.cost ?? 0.42, remaining_credits: opts.remainingCredits ?? 1234 },
      });
    }

    // ── result ────────────────────────────────────────────────────────────
    // Topaz (`topaz-video-upscale`) rides the SAME queue shape as a render — the only difference is
    // the file it hands back, which is named apart from the render's so an upscale landing in the
    // job's own directory can never overwrite the take it was made from.
    if (req.method === 'GET' && /^\/v2\/requests\/[^/]+$/.test(u.pathname)) {
      if (opts.expired) return json(404, { detail: 'Request not found' });
      const job = queued.find((q) => q.id === u.pathname.split('/').pop());
      const name = /topaz/i.test(job?.slug ?? '') ? 'upscaled.mp4' : 'out.mp4';
      const out = { video: { url: `${base}/dl/${name}` }, seed: 70000 };
      // A job that ASKED for `return_last_frame` gets the generator's own closing still back — the
      // exact pixels the next segment should open on. `opts.omitLastFrame` reproduces a provider
      // that accepted the flag and sent nothing, which must fall back to an ffmpeg frame grab.
      if (job?.args?.return_last_frame && !opts.omitLastFrame) out.last_frame = { url: `${base}${LAST_FRAME_PATH}` };
      return json(200, out);
    }

    res.writeHead(404); res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    queued,
    opts,
    // closeAllConnections first: a `submitHang` socket is still open by design, and close() alone
    // only stops NEW connections — it would wait on that one forever.
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
