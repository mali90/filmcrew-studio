// The reviewer's upscale-provider pick, end to end: the approve payload names fal or Segmind, the
// finalize child is pinned to it via UPSCALE_PROVIDER (per run — never written anywhere), the
// ledger line records it, and the estimate endpoint quotes/targets the same pick.
//
// This harness differs from api-flows on purpose: BOTH vendors have keys and BOTH point at local
// mocks, so 'auto' would resolve to the run's own render provider (fal, every run here renders
// Kling on the fal mock) — which is exactly what makes a Segmind Topaz submit PROOF that the
// explicit pick reached the child, not an accident of key fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { startFalServer } = await import(path.join(HOST_ROOT, 'test/helpers/fal-server.js'));
const { startSegmindServer } = await import(path.join(HOST_ROOT, 'test/helpers/segmind-server.js'));
const { hasFfmpeg, tinyMp4Bytes } = await import(path.join(HOST_ROOT, 'test/helpers/ffmpeg-clips.js'));
const { buildApp } = await import('../../app.js');

const FF = await hasFfmpeg();
const clipBytes = FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4');
const fal = await startFalServer({ videoBytes: clipBytes });
const sg = await startSegmindServer({ videoBytes: clipBytes });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-approve-provider-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);

const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri',
  FAL_STORAGE_INITIATE_URL: `${fal.baseUrl}/storage/upload/initiate`,
  FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit', FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
  // Segmind is REAL here (unlike api-flows): keyed, mocked, and uploads pinned local — an
  // explicitly picked Segmind upscale must be able to SUCCEED, or the test proves nothing.
  SEGMIND_API_KEY: 'sk-test', SEGMIND_BASE_URL: sg.baseUrl,
  SEGMIND_UPLOAD_MODE: 'data-uri', SEGMIND_MAX_RETRIES: '1', SEGMIND_RETRY_BACKOFF_MS: '1',
  SEGMIND_TOPAZ_SLUG: 'topaz-video-upscale',
  // pinned so a developer's own .env can never re-route the children this file spawns
  UPSCALE_PROVIDER: 'auto',
};

const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '# isolated test env — the dev repo .env must never leak into assertions\n');
const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, childEnv, envRoot });

test.after(async () => { await app.close(); await fal.close(); await sg.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });

async function waitForStatus(runId, statuses, timeoutMs = 90000) {
  const want = new Set([].concat(statuses));
  const t0 = Date.now();
  for (;;) {
    const run = (await get(`/api/runs/${runId}`)).json().run;
    if (want.has(run.status)) return run;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${[...want]} (last: ${run.status} err=${JSON.stringify(run.error)})`);
    await sleep(150);
  }
}
async function makePlannedRun(idea) {
  const { runId } = (await post('/api/runs', { idea, backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  return runId;
}
async function makeReviewedRun(idea) {
  const runId = await makePlannedRun(idea);
  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  return { runId, run: await waitForStatus(runId, 'review') };
}

const segmindTopazSubmits = () => sg.requests.filter((r) => r.method === 'POST' && r.path === '/v2/topaz-video-upscale').length;
const falTopazSubmits = () => fal.requests.filter((r) => r.method === 'POST' && r.path.includes('topaz')).length;

test('estimate?provider=X prices X — the pick beats the derivation, junk is a 400', async () => {
  const runId = await makePlannedRun('price my pick');

  const onFal = (await get(`/api/runs/${runId}/estimate?mode=upscale&provider=fal`)).json();
  const onSegmind = (await get(`/api/runs/${runId}/estimate?mode=upscale&provider=segmind`)).json();
  assert.ok(onFal.totalUsd > 0 && !onFal.unknownPrice, 'fal Topaz is priced');
  assert.ok(onSegmind.totalUsd > onFal.totalUsd, `Segmind (flat $0.125/s) bills above fal's dearest tier ($0.08/s) — the pick must MOVE the figure (${onSegmind.totalUsd} vs ${onFal.totalUsd})`);

  // this harness derives fal (auto → the run rendered on fal), so ?provider=segmind above already
  // out-voted the derivation; the default answer must equal fal's to prove which side moved
  const derived = (await get(`/api/runs/${runId}/estimate?mode=upscale`)).json();
  assert.equal(derived.totalUsd, onFal.totalUsd, 'no pick = the derived provider (fal here)');

  const junk = await get(`/api/runs/${runId}/estimate?mode=upscale&provider=topaz-on-a-potato`);
  assert.equal(junk.statusCode, 400);
  assert.match(junk.json().hint, /fal or segmind/);
});

test('targetShortSide follows the PICKED provider — Segmind honors UPSCALE_TARGET_RESOLUTION, fal stays ~1080', async () => {
  const runId = await makePlannedRun('target my pick');
  const envFile = path.join(envRoot, '.env');
  const original = fs.readFileSync(envFile, 'utf8');
  try {
    fs.writeFileSync(envFile, `${original}UPSCALE_TARGET_RESOLUTION=4k\n`);
    assert.equal((await get(`/api/runs/${runId}/estimate?mode=upscale&provider=segmind`)).json().targetShortSide, 2160);
    assert.equal((await get(`/api/runs/${runId}/estimate?mode=upscale&provider=fal`)).json().targetShortSide, 1080, 'the 4k knob is Segmind\'s — fal\'s factor plan lifts toward ~1080p');
  } finally { fs.writeFileSync(envFile, original); }
});

test('approve rejects a junk provider with a 400 before any money moves', async () => {
  const runId = await makePlannedRun('reject junk');
  const res = await post(`/api/runs/${runId}/approve`, { upscale: true, provider: 'topaz-on-a-potato' });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().hint, /fal or segmind/);
  assert.equal(segmindTopazSubmits() + falTopazSubmits(), 0, 'nothing was submitted anywhere');
});

test('approve with provider=segmind pins the finalize child to Segmind Topaz and records it', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId } = await makeReviewedRun('upscale on segmind');
  const before = segmindTopazSubmits();

  const res = await post(`/api/runs/${runId}/approve`, { upscale: true, provider: 'segmind' });
  assert.equal(res.statusCode, 202, res.body);
  const run = await waitForStatus(runId, 'complete');

  // auto would have kept this fal-rendered run on fal — a Segmind submit IS the env override
  assert.ok(segmindTopazSubmits() > before, 'the child billed SEGMIND Topaz, as picked');
  assert.equal(falTopazSubmits(), 0, 'and never fal\'s');
  assert.equal(run.manifest.approved.upscaled, true);
  assert.ok(fs.existsSync(run.manifest.approved.final), 'the upscaled final exists on disk');

  const line = run.manifest.costLedger.findLast((l) => l.action === 'upscale');
  assert.equal(line.provider, 'segmind', 'the ledger names the vendor actually used');
  assert.ok(!line.unpriced, 'Segmind publishes a Topaz rate — the line is not flagged unpriced');
});

test('approve WITHOUT a pick keeps the derived provider — fal, where this run rendered', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId } = await makeReviewedRun('upscale on the default');
  const before = segmindTopazSubmits();

  const res = await post(`/api/runs/${runId}/approve`, { upscale: true });
  assert.equal(res.statusCode, 202, res.body);
  const run = await waitForStatus(runId, 'complete');

  assert.equal(segmindTopazSubmits(), before, 'no pick, no Segmind — auto stays home on fal');
  assert.ok(falTopazSubmits() > 0, 'the upscale ran on fal\'s Topaz');
  assert.equal(run.manifest.costLedger.findLast((l) => l.action === 'upscale').provider, 'fal', 'the ledger still records who billed');
});

// The quote the reviewer clicked and the row the run keeps forever have to be ONE number. They are
// computed in different files (routes/runs.js and run-service's approve), and fal's tiers mean the
// figure is no longer recoverable from seconds × a constant — so a drift here would leave the only
// durable record of a paid action disagreeing with the button that authorised it.
test('the ledger row records the SAME figure the estimate quoted', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId } = await makeReviewedRun('the ledger equals the quote');

  const quoted = (await get(`/api/runs/${runId}/estimate?mode=upscale&provider=segmind`)).json();
  assert.ok(quoted.totalUsd > 0, 'the take is priced before anything is approved');

  assert.equal((await post(`/api/runs/${runId}/approve`, { upscale: true, provider: 'segmind' })).statusCode, 202);
  const run = await waitForStatus(runId, 'complete');

  const line = run.manifest.costLedger.findLast((l) => l.action === 'upscale');
  assert.equal(line.estUsd, quoted.totalUsd, 'the ledger carries the quoted figure, not a null placeholder');
  assert.ok(!line.unpriced, 'a priced vendor is never flagged unpriced');
});

// fal tiers Topaz by the OUTPUT frame, so a quote is only honest if the clip dimensions reach the
// estimator at all — and it is the CLIPS that go to Topaz, one job at a time, not the stitched
// master. This harness's mock renders 128×128 clips, which the 4× factor cap lifts to a 512-tall
// frame: fal's CHEAPEST tier, whatever shape the run's master ends up. Before the take exists there
// is nothing to measure, and the same endpoint must round UP to the dearest tier instead of
// guessing cheap.
test('the fal quote rides the tier the OUTPUT lands in — and rounds up before a take exists', async () => {
  const runId = await makePlannedRun('tier my output');
  const unrendered = (await get(`/api/runs/${runId}/estimate?mode=upscale&provider=fal`)).json();
  assert.equal(unrendered.tier, 'above1080p', 'nothing measured yet — quote the tier this app\'s 9:16 default buys');

  await post(`/api/runs/${runId}/render`, { mode: 'full' });
  await waitForStatus(runId, 'review');
  const rendered = (await get(`/api/runs/${runId}/estimate?mode=upscale&provider=fal`)).json();
  assert.equal(rendered.tier, '720p', '128×128 clips lifted 4× are 512×512 — under 720 tall, so the cheapest tier');
  assert.ok(rendered.totalUsd < unrendered.totalUsd, 'a measured take is quoted cheaper than an unmeasurable one');
  assert.equal(rendered.targetShortSide, 1080, 'and the label the UI prints still describes fal\'s ~1080p target');
});

// The reopen → upscale-again case, priced. An approve-time upscale lifts the CLIPS, stitches them,
// and rewrites the take's render.json with the HD master it delivered — while `jobs[].clip` still
// names the original SD clips, which is exactly what a second upscale of that cut hands Topaz. The
// three lines below are that rewrite (the mock Topaz returns the same tiny clip, so a real run of
// it cannot move the recorded size). A quote read off the master would answer "already at target,
// nothing to pay" for a charge the user is then billed in full.
test('a cut whose master was already upscaled is still quoted for its own SD clips', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId, run } = await makeReviewedRun('an upscale that comes round twice');
  const cut = run.manifest.cuts.at(-1);
  const priced = (await get(`/api/runs/${runId}/estimate?mode=upscale&cut=${cut.id}&provider=fal`)).json();
  assert.ok(priced.totalUsd > 0, 'the take is priced to begin with');

  const rjPath = path.join(runsDir, runId, 'renders', cut.take, 'render.json');
  const rj = JSON.parse(fs.readFileSync(rjPath, 'utf8'));
  fs.writeFileSync(rjPath, JSON.stringify({ ...rj, master: rj.master.replace(/\.mp4$/, '-final.mp4'), masterShortSide: 1080 }, null, 2));

  const after = (await get(`/api/runs/${runId}/estimate?mode=upscale&cut=${cut.id}&provider=fal`)).json();
  assert.ok(after.totalUsd > 0, 'the clips Topaz would be handed are unchanged — so is the bill');
  assert.equal(after.totalUsd, priced.totalUsd, 'the master\'s size is not part of the quote at all');
});

// U2c — the deliver card quotes the size of the file it is showing, so the DELIVERY has to carry
// its own measured short side. Nothing else can answer for it: the approved cut records the
// PRE-upscale size (which is what a 1080p delivery used to be labelled 480p from), and after a
// second delivery the latest render is no longer this file.
test('a delivered final records the short side measured off the file that was written', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { probeDims } = await import(path.join(HOST_ROOT, 'src/lib/upscale.js'));

  // …on the free path, where the cut's own master is what gets delivered
  const plain = (await makeReviewedRun('a finalize measured on the way out')).runId;
  assert.equal((await post(`/api/runs/${plain}/approve`, { upscale: false })).statusCode, 200);
  const free = (await get(`/api/runs/${plain}`)).json().run.manifest;
  const dims = await probeDims(free.approved.final);
  assert.equal(free.approved.shortSide, Math.min(dims.width, dims.height), 'measured, not taken from the resolution pick');
  assert.equal(free.finals.at(-1).shortSide, free.approved.shortSide, 'the history carries it too');

  // …and on the paid path, where the delivered file is the UPSCALE's output, not the cut's master
  const lifted = (await makeReviewedRun('a finalize measured after topaz')).runId;
  assert.equal((await post(`/api/runs/${lifted}/approve`, { upscale: true })).statusCode, 202);
  const m = (await waitForStatus(lifted, 'complete')).manifest;
  const out = await probeDims(m.approved.final);
  assert.equal(m.approved.shortSide, Math.min(out.width, out.height), 'the DELIVERED file, after Topaz ran');
  assert.equal(m.finals.at(-1).shortSide, m.approved.shortSide);
  assert.notEqual(m.approved.final, m.cuts.at(-1).master, 'an upscale delivers a new file — the cut it came from is untouched');
});
