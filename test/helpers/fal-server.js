// Mock of the fal.ai queue API on 127.0.0.1:0. Tests point config.fal.baseUrl here via FAL_BASE_URL
// and set FAL_KLING_ENDPOINT=submit / FAL_CREATE_VOICE_ENDPOINT=create-voice. `opts` is a mutable
// object a test can flip between assertions (authFail, validationFail, failStatusOnce). `requests`
// records every hit for assertions. Never serves anything unless a client connects.
import http from 'node:http';

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

export async function startFalServer({ videoBytes = Buffer.from('FAKE-MP4'), opts = {} } = {}) {
  let statusHits = 0;
  let videoHits = 0;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : '';
    requests.push({ method: req.method, path: u.pathname, body, auth: req.headers.authorization });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

    // create-voice: validateFal sends body '{}' (read status only); mintVoice sends {voice_url}.
    if (req.method === 'POST' && u.pathname.endsWith('/create-voice')) {
      if (opts.authFail) return json(401, { error: 'unauthorized' });
      if (body.trim() === '{}') return json(422, { detail: 'voice_url required' });
      return json(200, { request_id: 'req_v', status_url: `${base}/st/req_v`, response_url: `${base}/rs/voice` });
    }
    // CDN storage handshake (FAL_STORAGE_INITIATE_URL points here): initiate → PUT → stable url.
    if (req.method === 'POST' && u.pathname.endsWith('/storage/upload/initiate')) {
      return json(200, { upload_url: `${base}/storage/put/f1`, file_url: `${base}/dl/stored.bin` });
    }
    if (req.method === 'PUT' && u.pathname.startsWith('/storage/put/')) return json(200, {});
    // generic queue submit (any model endpoint)
    if (req.method === 'POST') {
      if (opts.validationFail) return json(400, { detail: 'invalid: prompt required' });
      return json(200, { request_id: 'req_1', status_url: `${base}/st/req_1`, response_url: `${base}/rs/video` });
    }
    if (u.pathname.startsWith('/st/')) {
      if (opts.failStatusOnce && statusHits++ === 0) { res.writeHead(500); return res.end('transient'); }
      return json(200, { status: 'COMPLETED' });
    }
    if (u.pathname === '/rs/voice') return json(200, { voice_id: 'voice_abc' });
    if (u.pathname === '/rs/video') {
      // The model's moderation flags the GENERATED video as sensitive (content_policy_violation) —
      // deterministic here; exercises the fail-fast + clear-message path (never auto-retried).
      if (opts.contentPolicy) {
        return json(422, { detail: [{ loc: ['body', 'generated_video'], msg: 'Output video has sensitive content.', type: 'content_policy_violation', ctx: { extra_info: { reason: 'partner_validation_failed' } } }] });
      }
      // Transient fal-side fetch race on the FIRST poll (422 "timeout while fetching resource"),
      // then success — exercises runFal's retry of a transient (non-validation) 4xx.
      if (opts.fetchTimeoutOnce && videoHits++ === 0) {
        return json(422, { detail: [{ loc: ['body'], msg: 'The parameter `content[1].image_url` specified in the request is not valid: timeout while fetching resource. Request id: test', type: 'invalid_request' }] });
      }
      return json(200, { video: { url: `${base}/dl/out.mp4` } });
    }
    if (u.pathname.startsWith('/dl/')) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(videoBytes); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, opts, close: () => new Promise((r) => server.close(r)) };
}
