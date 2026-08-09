// src/lib/segmind.js against the mock queue: the happy path, the credit ledger it surfaces, the
// keyless CDN download, the money-safe key check, and the two ways a local asset reaches Segmind.
//
// The asset story is what makes a SEGMIND-ONLY setup possible, and it is the reason this file exists
// as much as the transport:
//   * SEGMIND_UPLOAD_MODE=data-uri     — inline base64, NO fal key needed anywhere (the default when
//                                        FAL_KEY is unset)
//   * SEGMIND_UPLOAD_MODE=fal-storage  — reuse fal's CDN + the cloud-refs cache (needs FAL_KEY);
//                                        imported LAZILY so a data-uri graph never loads fal.js
//
// TDD (red first): src/lib/segmind.js and the config.segmind block do not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { ONE_PX_PNG } from '../helpers/fixtures.js';
import { startSegmindServer } from '../helpers/segmind-server.js';
import { startFalServer } from '../helpers/fal-server.js';

const sg = await startSegmindServer({ videoBytes: Buffer.from('FAKE-MP4') });
const fal = await startFalServer();

neutralizeDotenv();
const cache = mkTmp('segmind-cache');
Object.assign(process.env, {
  SEGMIND_BASE_URL: sg.baseUrl,
  SEGMIND_API_KEY: 'sk-test',
  SEGMIND_MAX_RETRIES: '1',
  SEGMIND_RETRY_BACKOFF_MS: '1',
  SEGMIND_UPLOAD_MODE: 'data-uri',
  // No fal key at import time: a Segmind-only install is the configuration under test here.
  FAL_KEY: '', FAL_API_KEY: '',
  FAL_BASE_URL: fal.baseUrl,
  FAL_STORAGE_INITIATE_URL: `${fal.baseUrl}/storage/upload/initiate`,
  LOG_LEVEL: 'error',
});
const config = (await import('../../config.js')).default;
config.paths.cache = cache.dir;
const { runSegmind, generateSegmind, segmindAssetUrl, validateSegmind } = await import('../../src/lib/segmind.js');

test.after(async () => { await sg.close(); await fal.close(); cache.cleanup(); });

// ── config defaults ─────────────────────────────────────────────────────────
test('config.segmind: slugs default to the live ones, uploadMode falls back to data-uri with no FAL_KEY', () => {
  assert.equal(config.segmind.apiKey, 'sk-test');
  assert.equal(config.segmind.baseUrl, sg.baseUrl);
  assert.equal(config.segmind.seedance25Slug, 'seedance-2.5');
  assert.equal(config.segmind.seedance20Slug, 'seedance-2.0');
  assert.equal(config.segmind.topazSlug, 'topaz-video-upscale');
  assert.equal(config.segmind.uploadMode, 'data-uri', 'explicitly set here; without a FAL_KEY it is also the DEFAULT');
});

test('the base url tolerates a trailing slash (what people actually paste into .env)', async () => {
  const { withEnv } = await import('../helpers/env.js');
  await withEnv({ SEGMIND_BASE_URL: 'https://api.segmind.com///' }, async () => {
    const fresh = (await import(`../../config.js?slash=${Date.now()}`)).default;
    assert.equal(fresh.segmind.baseUrl, 'https://api.segmind.com');
  });
});

// ── the happy path + the credit ledger ──────────────────────────────────────
test('a completed job returns the result AND the terminal metrics (cost + remaining credits)', async () => {
  sg.opts.cost = 0.63;
  sg.opts.remainingCredits = 981;
  const before = sg.requests.length;
  const r = await runSegmind('seedance-2.5', { prompt: 'p', duration: 5 }, { timeoutMs: 30000 });

  assert.ok(r.requestId, 'the request id is surfaced — it is the receipt for a paid job');
  assert.equal(r.metrics.cost, 0.63, 'what this render actually cost, straight from Segmind');
  assert.equal(r.metrics.remainingCredits, 981);
  assert.match(r.result.video.url, /\/dl\/out\.mp4$/);

  // the submit carried the key; the queue is addressed by SLUG, not a fal-style endpoint path
  const submit = sg.requests.slice(before).find((q) => q.method === 'POST');
  assert.equal(submit.path, '/v2/seedance-2.5');
  assert.equal(submit.apiKey, 'sk-test', 'auth is x-api-key, never Authorization: Key');
  assert.equal(submit.auth, undefined);
});

test('generateSegmind downloads the CDN output with NO api key, immediately (records expire ~1h)', async () => {
  const dest = mkTmp('segmind-dl');
  try {
    const meta = [];
    const before = sg.requests.length;
    const outs = await generateSegmind({ prompt: 'p', duration: 5 }, {
      slug: 'seedance-2.5', destDir: dest.dir, timeoutMs: 30000, onMeta: (m) => meta.push(m),
    });
    assert.equal(outs.length, 1);
    assert.ok(fs.existsSync(outs[0]), 'the clip is on disk before the record can expire');
    assert.match(outs[0], /\.mp4$/);

    const dl = sg.requests.slice(before).filter((q) => q.path.startsWith('/dl/'));
    assert.equal(dl.length, 1);
    assert.equal(dl[0].apiKey, undefined, 'the public CDN must NOT be sent the api key');

    assert.equal(meta.length, 1, 'onMeta fires once, so the caller can record the receipt');
    assert.ok(meta[0].requestId);
    assert.equal(typeof meta[0].cost, 'number');
    assert.equal(typeof meta[0].remainingCredits, 'number');
  } finally { dest.cleanup(); }
});

// ── validateSegmind: money-safe by construction ─────────────────────────────
test('validateSegmind reads a STATUS only — an empty body cannot queue a billable job', async () => {
  const queuedBefore = sg.queued.length;
  const before = sg.requests.length;

  assert.deepEqual(await validateSegmind('sk-test'), { ok: true, status: 422 }, 'a 422 is the answer we WANT: understood and rejected, nothing queued');
  const probe = sg.requests.slice(before).find((q) => q.method === 'POST');
  assert.equal(probe.path, `/v2/${config.segmind.seedance25Slug}`, 'a RENDER key is checked against the render slug, not the upscale model');

  sg.opts.authFail = true;
  const bad = await validateSegmind('sk-wrong');
  sg.opts.authFail = false;
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'auth');
  assert.equal(bad.status, 401);

  assert.deepEqual(await validateSegmind(''), { ok: false, reason: 'missing' });

  // THE assertion: two live probes, zero jobs queued. If this ever fails, "test your key" bills.
  assert.equal(sg.queued.length, queuedBefore, 'validateSegmind queued nothing — it can never cost money');
});

test('a 404 reads as a bad slug or base url, NOT as a healthy key', async () => {
  sg.opts.unknownSlug = true;
  const r = await validateSegmind('sk-test');
  sg.opts.unknownSlug = false;

  assert.equal(r.ok, false, 'the request never found the model — calling that "key valid" hides it until spend time');
  assert.equal(r.reason, 'not_found');
  assert.equal(r.status, 404);
  assert.match(r.detail, /SEGMIND_BASE_URL/, 'and it names the two settings that cause it');
});

test('a 2xx is surfaced as an anomaly — it is the one answer that means the probe queued something', async () => {
  // The whole money-safety story rests on "an empty body cannot be a valid request". This is the
  // model where that is false (all-optional params), so the probe really does buy a job.
  sg.opts.acceptsEmptyBody = true;
  const queuedBefore = sg.queued.length;
  const r = await validateSegmind('sk-test');
  sg.opts.acceptsEmptyBody = false;

  assert.equal(sg.queued.length - queuedBefore, 1, 'the probe DID queue a job here — that is the case under test');
  assert.equal(r.ok, true, 'the key itself authenticated');
  assert.match(r.warning, /may have queued a billable job/i, 'but the charge is reported, never folded into a quiet ok');
  assert.equal(r.requestId, sg.queued.at(-1).id, 'with the request id, so the job can actually be found');
});

// ── asset urls ──────────────────────────────────────────────────────────────
test("'data-uri' inlines the file with no fal key anywhere in the environment", async () => {
  const tmp = mkTmp('segmind-assets');
  try {
    assert.equal(config.fal.apiKey, '', 'this test runs on a Segmind-ONLY install');
    const png = path.join(tmp.dir, 'ref.png');
    fs.writeFileSync(png, ONE_PX_PNG);
    const url = await segmindAssetUrl(png, 'data-uri');
    assert.ok(url.startsWith('data:image/png;base64,'), url.slice(0, 40));
    assert.equal(Buffer.from(url.split(',')[1], 'base64').length, ONE_PX_PNG.length);
    assert.equal(fal.requests.length, 0, 'nothing touched fal');
  } finally { tmp.cleanup(); }
});

test("'fal-storage' reuses fal's CDN + the cloud-refs cache (one upload per basename)", async () => {
  const tmp = mkTmp('segmind-assets-fal');
  try {
    config.fal.apiKey = 'fake'; // the OTHER supported setup: Segmind renders, fal stores
    const png = path.join(tmp.dir, 'keeper.png');
    fs.writeFileSync(png, ONE_PX_PNG);

    const before = fal.requests.length;
    const first = await segmindAssetUrl(png, 'fal-storage');
    assert.match(first, /\/dl\/stored\.bin$/, 'the fal CDN url the mock hands back');

    const second = await segmindAssetUrl(png, 'fal-storage');
    assert.equal(second, first, 'the same basename resolves from the cloud-refs cache');
    const initiates = fal.requests.slice(before).filter((q) => q.path.endsWith('/storage/upload/initiate'));
    assert.equal(initiates.length, 1, 'the second call uploaded nothing');

    // cache: false is the seam-frame escape hatch (every seam file is named last_frame.png)
    const uncached = await segmindAssetUrl(png, 'fal-storage', { cache: false });
    assert.match(uncached, /\/dl\/stored\.bin$/);
  } finally { config.fal.apiKey = ''; tmp.cleanup(); }
});

test('an unknown upload mode fails loudly rather than silently inlining megabytes', async () => {
  const tmp = mkTmp('segmind-assets-bad');
  try {
    const png = path.join(tmp.dir, 'ref.png');
    fs.writeFileSync(png, ONE_PX_PNG);
    await assert.rejects(segmindAssetUrl(png, 'sftp'), /sftp|upload mode/i);
    await assert.rejects(segmindAssetUrl(path.join(tmp.dir, 'missing.png'), 'data-uri'), /missing/i);
  } finally { tmp.cleanup(); }
});
