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
import { spawn } from 'node:child_process';
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

// `on` names WHICH server answers — every test but the typo one at the bottom uses the harness app,
// which is why it is a default rather than an argument at each of the call sites.
const get = (url, on = app) => on.inject({ method: 'GET', url });
const post = (url, payload, on = app) => on.inject({ method: 'POST', url, payload });

async function waitForStatus(runId, statuses, { on = app, timeoutMs = 90000 } = {}) {
  const want = new Set([].concat(statuses));
  const t0 = Date.now();
  for (;;) {
    const run = (await get(`/api/runs/${runId}`, on)).json().run;
    if (want.has(run.status)) return run;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${[...want]} (last: ${run.status} err=${JSON.stringify(run.error)})`);
    await sleep(150);
  }
}
async function makePlannedRun(idea, on = app) {
  const { runId } = (await post('/api/runs', { idea, backend: 'kling', aspect: '9:16', durationS: null }, on)).json();
  await waitForStatus(runId, 'plan-ready', { on });
  return runId;
}
async function makeReviewedRun(idea, on = app) {
  const runId = await makePlannedRun(idea, on);
  await post(`/api/runs/${runId}/render`, { mode: 'full' }, on);
  return { runId, run: await waitForStatus(runId, 'review', { on }) };
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

// FAL_TOPAZ_MAX_FACTOR is the cap the render child binds into its factor plan, so it decides how
// far a clip is lifted and therefore which OUTPUT tier fal bills for it. The endpoint has to read
// the same file the child reads, or a configured cap moves the charge and not the quote. (The take
// is re-recorded at 256×256 first — this harness renders 128×128 clips, which no legal cap can lift
// past fal's cheapest tier, so nothing would be visible either way.)
test('the estimate honours a configured FAL_TOPAZ_MAX_FACTOR, not upscalePlan\'s default', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId, run } = await makeReviewedRun('cap my factor');
  const cut = run.manifest.cuts.at(-1);
  const rjPath = path.join(runsDir, runId, 'renders', cut.take, 'render.json');
  const rj = JSON.parse(fs.readFileSync(rjPath, 'utf8'));
  fs.writeFileSync(rjPath, JSON.stringify({ ...rj, jobs: rj.jobs.map((j) => (j.clip ? { ...j, width: 256, height: 256 } : j)) }, null, 2));

  const envFile = path.join(envRoot, '.env');
  const dotenv = fs.readFileSync(envFile, 'utf8');
  const quote = async () => (await get(`/api/runs/${runId}/estimate?mode=upscale&cut=${cut.id}&provider=fal`)).json();
  try {
    const uncapped = await quote();
    assert.equal(uncapped.tier, '1080p', '256 lifted by the default 4× is a 1024-tall output');

    fs.writeFileSync(envFile, `${dotenv}FAL_TOPAZ_MAX_FACTOR=2\n`);
    const capped = await quote();
    assert.equal(capped.tier, '720p', 'capped at 2× the same clips come back 512 tall — the cheapest tier');
    assert.ok(capped.totalUsd < uncapped.totalUsd, 'and the paid button follows the tier the child would really deliver');
  } finally { fs.writeFileSync(envFile, dotenv); }
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

// ── The vendor approve RESOLVED is the vendor the child bills ───────────────────────────────────
// A no-pick approve still decides the vendor ONCE, before it mutates anything: that decision gates
// the API-key check, prices the estimate and is written into the cost ledger. It has to travel to
// the finalize child too. While the child re-derived UPSCALE_PROVIDER for itself, the two readers
// could disagree — the server's forgives anything it does not recognise (it reads as 'auto', so the
// estimate never takes a run page down), the child's throws. The observable consequence is the worst
// kind: 202, a PRICED ledger row, and then a child that dies before a single Topaz submission.
//
// A typo'd value is the deterministic way to spell that gap; an .env edited between approve and
// spawn is the same bug with a race in front of it. The typo rides in childEnv, i.e. in the child's
// own process env, which is what makes this a test of the PIN: it can only pass if approve's
// resolved vendor overwrites the value the child would otherwise have read.
const typoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-approve-typo-'));
const typoApp = await buildApp({
  root: HOST_ROOT,
  runsDir: path.join(typoRoot, 'runs'),
  outDir: path.join(typoRoot, 'out'),
  childEnv: { ...childEnv, UPSCALE_PROVIDER: 'topaz-on-a-potato' },
  envRoot,
});
test.after(async () => { await typoApp.close(); fs.rmSync(typoRoot, { recursive: true, force: true }); });

test('a no-pick approve pins the RESOLVED vendor — a typo\'d UPSCALE_PROVIDER never reaches the child', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { runId } = await makeReviewedRun('pin what you priced', typoApp);
  const before = falTopazSubmits();

  const res = await post(`/api/runs/${runId}/approve`, { upscale: true }, typoApp);
  assert.equal(res.statusCode, 202, res.body);

  // 'auto' is what the server's reader makes of the typo, and this run rendered on fal — so fal is
  // the vendor it key-checked, quoted and recorded, and fal is the only vendor allowed to bill.
  const run = await waitForStatus(runId, ['complete', 'attention'], { on: typoApp });
  assert.equal(run.status, 'complete', `the finalize child ran on the resolved vendor (err=${JSON.stringify(run.error)})`);
  assert.ok(falTopazSubmits() > before, 'Topaz ran on fal — the vendor the ledger row names');
  assert.equal(run.manifest.costLedger.findLast((l) => l.action === 'upscale').provider, 'fal');
  assert.ok(fs.existsSync(run.manifest.approved.final), 'and the master the row was written for exists');
});

// ── …and so are the KNOBS that priced it ────────────────────────────────────────────────────────
// The vendor was never the whole decision. approve computes the figure in the cost-ledger row from
// the target resolution, the Topaz model and the factor cap it reads at approve time — and the
// child re-read UPSCALE_TARGET_RESOLUTION / FAL_TOPAZ_MODEL / FAL_TOPAZ_MAX_FACTOR out of its own
// environment at spawn, so an .env edited in between moved the charge away from the number the run
// recorded forever.
//
// The gap is made deterministic rather than raced: this app's spawnCli rewrites the .env in the one
// instant between the enqueue that PRICED the job and the exec that SPENDS the money. Nothing else
// about the run changes, so any difference in what the vendor is asked for is the gap itself.
const gapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-approve-gap-'));
const gapEnvRoot = path.join(gapRoot, 'envroot');
fs.mkdirSync(gapEnvRoot, { recursive: true });
const gapEnvFile = path.join(gapEnvRoot, '.env');
let editInTheGap = null; // the .env the finalize child is spawned into (null ⇒ leave the file alone)
const gapApp = await buildApp({
  root: HOST_ROOT,
  runsDir: path.join(gapRoot, 'runs'),
  outDir: path.join(gapRoot, 'out'),
  childEnv,
  envRoot: gapEnvRoot,
  spawnCli: (script, args, { env, cwd } = {}) => {
    if (editInTheGap !== null && args.includes('--upscale')) {
      fs.writeFileSync(gapEnvFile, editInTheGap);
      editInTheGap = null;
    }
    return spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  },
});
test.after(async () => { await gapApp.close(); fs.rmSync(gapRoot, { recursive: true, force: true }); });

const lastFalTopazArgs = () => JSON.parse(fal.requests.filter((r) => r.method === 'POST' && r.path.includes('topaz')).at(-1).body);
const lastSegmindTopazArgs = () => JSON.parse(sg.requests.filter((r) => r.method === 'POST' && r.path === '/v2/topaz-video-upscale').at(-1).body);

// fal's two price knobs, in one approve: the factor CAP decides how far each clip is lifted (and so
// which OUTPUT tier fal bills it at), and the MODEL decides the rate itself (fal charges half for
// Gaia 2 output). The take's clips are re-recorded at 256×256 so the cap actually moves the quoted
// tier — the harness renders 128×128, where every legal cap lands in the same cheapest rung.
test('fal bills at the factor cap and model approve PRICED, not the ones .env holds at spawn', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  fs.writeFileSync(gapEnvFile, 'FAL_TOPAZ_MAX_FACTOR=2\nFAL_TOPAZ_MODEL=Proteus\n');
  const { runId, run } = await makeReviewedRun('pin the knobs you quoted', gapApp);
  const cut = run.manifest.cuts.at(-1);
  const rjPath = path.join(gapRoot, 'runs', runId, 'renders', cut.take, 'render.json');
  const rj = JSON.parse(fs.readFileSync(rjPath, 'utf8'));
  fs.writeFileSync(rjPath, JSON.stringify({ ...rj, jobs: rj.jobs.map((j) => (j.clip ? { ...j, width: 256, height: 256 } : j)) }, null, 2));

  const quoted = (await get(`/api/runs/${runId}/estimate?mode=upscale&cut=${cut.id}&provider=fal`, gapApp)).json();
  assert.equal(quoted.tier, '720p', '256 lifted 2× is a 512-tall output — fal\'s cheapest rung');

  // …and the .env says something else entirely by the time the child starts.
  editInTheGap = 'FAL_TOPAZ_MAX_FACTOR=4\nFAL_TOPAZ_MODEL=Gaia 2\n';
  assert.equal((await post(`/api/runs/${runId}/approve`, { upscale: true, cut: cut.id, provider: 'fal' }, gapApp)).statusCode, 202);
  const done = await waitForStatus(runId, ['complete', 'attention'], { on: gapApp });
  assert.equal(done.status, 'complete', `the finalize child ran (err=${JSON.stringify(done.error)})`);

  assert.equal(editInTheGap, null, 'the edit really did land in the gap — otherwise this proves nothing');
  assert.match(fs.readFileSync(gapEnvFile, 'utf8'), /FAL_TOPAZ_MAX_FACTOR=4/, 'and the file on disk now says 4');

  const submitted = lastFalTopazArgs();
  assert.equal(submitted.upscale_factor, 2, 'Topaz was asked for the cap the ledger row was priced at, not the .env\'s 4');
  assert.equal(submitted.model, 'Proteus', 'and for the model that rate belongs to — Gaia 2 output is billed at half');
  assert.equal(done.manifest.costLedger.findLast((l) => l.action === 'upscale').estUsd, quoted.totalUsd,
    'so the one durable record of this spend still names the figure the button authorised');
});

// Segmind's Topaz takes no factor and no model at all — its knob is the target resolution, and 4k
// is four times the pixels and four times the bill. Same gap, the other vendor's half of it.
test('Segmind is asked for the target approve PRICED, not the one .env holds at spawn', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  fs.writeFileSync(gapEnvFile, 'UPSCALE_TARGET_RESOLUTION=720p\n');
  const { runId } = await makeReviewedRun('pin the target you quoted', gapApp);
  const before = segmindTopazSubmits();

  editInTheGap = 'UPSCALE_TARGET_RESOLUTION=4k\n';
  assert.equal((await post(`/api/runs/${runId}/approve`, { upscale: true, provider: 'segmind' }, gapApp)).statusCode, 202);
  const done = await waitForStatus(runId, ['complete', 'attention'], { on: gapApp });
  assert.equal(done.status, 'complete', `the finalize child ran (err=${JSON.stringify(done.error)})`);

  assert.equal(editInTheGap, null, 'the edit really did land in the gap');
  assert.ok(segmindTopazSubmits() > before, 'Segmind\'s Topaz billed this approve');
  assert.equal(lastSegmindTopazArgs().target_resolution, '720p', 'at the target the estimate quoted — a 4k lift is 4× the bill nobody approved');
  assert.equal(done.manifest.costLedger.findLast((l) => l.action === 'upscale').provider, 'segmind');
});

// ── …and the value pinned is the value priced, byte for byte ────────────────────────────────────
// Pinning the knobs made the quote and the bill one decision — but only if the two sides read the
// pin the same way. dotenv keeps padding INSIDE a quoted value, so `UPSCALE_TARGET_RESOLUTION=
// " 720p "` is a legal .env that priced as `720p` (the reader trims a value already present in the
// child's env) and pinned as ` 720p ` — which the child refuses by name in shortSideForTarget. The
// user was left with a PRICED ledger row, no upscale and a run in attention.
//
// Nothing is edited in the gap here: the padding alone is the whole test, and the run has to come
// out the far end DELIVERED. The estimate is asserted too, because a quote that reads the file one
// way while approve pins it another is the same divergence a step earlier.
test('a dotenv-quoted target is priced, pinned and consumed as ONE value', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  fs.writeFileSync(gapEnvFile, 'UPSCALE_TARGET_RESOLUTION=" 720p "\n');
  const { runId, run } = await makeReviewedRun('pad the target you quoted', gapApp);
  const cut = run.manifest.cuts.at(-1);
  const before = segmindTopazSubmits();

  const quoted = (await get(`/api/runs/${runId}/estimate?mode=upscale&cut=${cut.id}&provider=segmind`, gapApp)).json();
  assert.equal(quoted.targetShortSide, 720, 'the button quotes the target the child will really be handed');

  assert.equal((await post(`/api/runs/${runId}/approve`, { upscale: true, cut: cut.id, provider: 'segmind' }, gapApp)).statusCode, 202);
  const done = await waitForStatus(runId, ['complete', 'attention'], { on: gapApp });
  assert.equal(done.status, 'complete', `the finalize child ran on the padded target (err=${JSON.stringify(done.error)})`);

  assert.ok(segmindTopazSubmits() > before, 'the upscale the ledger row was written for actually ran');
  assert.equal(lastSegmindTopazArgs().target_resolution, '720p', 'Segmind was asked for exactly the string approve priced — padding included is a 400 from the vendor at best');
  assert.equal(done.manifest.costLedger.findLast((l) => l.action === 'upscale').estUsd, quoted.totalUsd);
  assert.ok(fs.existsSync(done.manifest.approved.final), 'and the master that row was written for exists');
});
