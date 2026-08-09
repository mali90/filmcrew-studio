// WS2-P3a — the prompt READ endpoints.
//
// The UI's promise is "this is what we send". The only way that stays true is for the server to
// compose its preview with the SAME pure builder the renderer uses (src/lib/prompt-compose.js),
// from the same spec and the same settings. So the load-bearing test here is not a shape check —
// it composes the job DIRECTLY, from the .env the run will render under, and compares BUFFERS.
//
// The second thing pinned here is how those settings arrive: the run's .env is read as DATA
// (src/lib/env-file.js), never sourced. A server that loaded config.js would hand any request the
// power to reconfigure the process — and would silently override the demo's mock wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { startFalServer } = await import(path.join(HOST_ROOT, 'test/helpers/fal-server.js'));
const { hasFfmpeg, tinyMp4Bytes } = await import(path.join(HOST_ROOT, 'test/helpers/ffmpeg-clips.js'));
const { buildApp } = await import('../../app.js');
// The very modules the renderer composes with — imported here to re-derive the expected bytes.
const { capsFor, normalizeBackend, refLabel } = await import(path.join(HOST_ROOT, 'src/lib/render-models.js'));
const { composeSeedanceJobPrompt, composeKlingStoryboard } = await import(path.join(HOST_ROOT, 'src/lib/prompt-compose.js'));
const { seedancePromptSettings, klingPromptSettings } = await import(path.join(HOST_ROOT, 'src/lib/prompt-settings.js'));
const { characterGroups } = await import(path.join(HOST_ROOT, 'src/lib/cast-groups.js'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-prompt-read-'));
const runsDir = path.join(tmpRoot, 'runs');
const outDir = path.join(tmpRoot, 'out');
const envRoot = path.join(tmpRoot, 'envroot');
fs.mkdirSync(envRoot, { recursive: true });
// A NON-DEFAULT prompt budget that lives ONLY in the .env (not in childEnv): the preview must
// reflect it — proving the file was read — while the process must never gain the canary variable,
// proving it was read as data rather than sourced.
const PROMPT_MAX_BYTES = 4321;
fs.writeFileSync(
  path.join(envRoot, '.env'),
  `SEEDANCE_PROMPT_MAX_BYTES=${PROMPT_MAX_BYTES}\nKVA_PROMPT_READ_CANARY=must-not-be-sourced\n`,
);

const FF = await hasFfmpeg();
const fal = await startFalServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);
const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
};

const app = await buildApp({ root: HOST_ROOT, runsDir, outDir, childEnv, envRoot });
test.after(async () => { await app.close(); await fal.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });

async function waitForStatus(runId, statuses, timeoutMs = 90000) {
  const want = new Set([].concat(statuses));
  const t0 = Date.now();
  for (;;) {
    const run = (await get(`/api/runs/${runId}`)).json().run;
    if (want.has(run.status)) return run;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${[...want]} (last: ${run.status})`);
    await sleep(150);
  }
}

async function plannedRun() {
  const { runId } = (await post('/api/runs', { idea: 'a lighthouse keeper on his last night', backend: 'seedance', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  return runId;
}

const RUN_ID = await plannedRun();
const SPEC = JSON.parse(fs.readFileSync(path.join(runsDir, RUN_ID, 'spec.json'), 'utf8'));
const JOB_IDS = SPEC.kling.jobs.map((j) => j.job_id);

// ── read ────────────────────────────────────────────────────────────────────────────────────────

test('GET /prompt?job= composes one job from the plan, with the .env budget the render will use', async () => {
  const r = await get(`/api/runs/${RUN_ID}/prompt?job=${JOB_IDS[0]}`);
  assert.equal(r.statusCode, 200);
  const view = r.json();

  assert.equal(view.jobId, JOB_IDS[0]);
  assert.equal(view.source, 'plan');
  assert.ok(view.prompt.length > 0);
  assert.equal(view.bytes, Buffer.byteLength(view.prompt, 'utf8'), 'the meter counts UTF-8 BYTES, which is what the model caps');
  assert.equal(view.maxBytes, PROMPT_MAX_BYTES, "the run's own SEEDANCE_PROMPT_MAX_BYTES reached the preview");
  assert.ok(view.pinBytes > 0 && view.pinBytes < view.maxBytes, 'the byte meter needs a system-pin denominator');
  assert.ok(view.fingerprint, 'the staleness oracle travels with the prompt');
  assert.equal(view.stale, false);
  assert.ok(/fal/i.test(view.endpointLabel), `the provider is named in plain words (got "${view.endpointLabel}")`);
  assert.ok(!r.body.includes(runsDir), 'no host path in an API response');
});

test('GET /prompts returns every job of the current plan, in plan order', async () => {
  const r = await get(`/api/runs/${RUN_ID}/prompts`);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.runId, RUN_ID);
  assert.deepEqual(body.jobs, JOB_IDS);
  assert.deepEqual(body.prompts.map((p) => p.jobId), JOB_IDS);
  for (const p of body.prompts) {
    assert.equal(p.source, 'plan', 'nothing has been edited or sent yet');
    assert.equal(p.bytes, Buffer.byteLength(p.prompt, 'utf8'));
  }
  assert.deepEqual(body.orphaned, [], 'no override can be orphaned before any override exists');
  assert.ok(!r.body.includes(runsDir), 'no host path in an API response');
});

test('an unknown job is a miss that TELLS you what the plan has', async () => {
  const r = await get(`/api/runs/${RUN_ID}/prompt?job=NOPE`);
  assert.equal(r.statusCode, 404);
  const body = r.json();
  for (const id of JOB_IDS) assert.ok(body.hint.includes(id), `the hint lists ${id}`);
});

test('a run with no plan yet is 409, not an empty prompt', async () => {
  const bare = path.join(runsDir, 'web-00000000000000-bare');
  fs.mkdirSync(bare, { recursive: true });
  assert.equal((await get(`/api/runs/${path.basename(bare)}/prompts`)).statusCode, 409);
  assert.equal((await get(`/api/runs/${path.basename(bare)}/prompt?job=K1`)).statusCode, 409);
  assert.equal((await get('/api/runs/does-not-exist/prompt?job=K1')).statusCode, 404);
});

test('reading the .env for budgets must NOT source it into the server process', async () => {
  assert.equal((await get(`/api/runs/${RUN_ID}/prompts`)).statusCode, 200);
  assert.equal(process.env.KVA_PROMPT_READ_CANARY, undefined,
    'the prompt service read the .env as DATA; sourcing it would give a request the power to reconfigure the server');
});

// ── the gate: preview == what is sent ───────────────────────────────────────────────────────────

test('THE CONTRACT: the previewed prompt is the composer\'s own bytes, not a second implementation', async () => {
  const caps = capsFor(normalizeBackend('seedance').id);
  for (const job of SPEC.kling.jobs) {
    // Rebuild the renderer's inputs independently of the service: cast groups in prompt order, the
    // model's own ref-label style, and the settings this run's .env dictates.
    let n = 0;
    const refGroups = characterGroups(job, SPEC).map((g) => ({ name: g.name, refs: g.els.map(() => refLabel(caps, 'Image', ++n)) }));
    const settings = seedancePromptSettings(SPEC, caps, {
      generateAudio: true,          // SEEDANCE_GENERATE_AUDIO default
      promptMaxBytes: PROMPT_MAX_BYTES,
      defaultShotSeconds: 5,        // KLING_DEFAULT_SHOT_SECONDS default
      style: '', avoid: '', textRule: '',
      resolution: '480p', aspectRatio: '9:16',
      knobs: {},
    });
    const { prompt } = composeSeedanceJobPrompt(job, SPEC, settings, {
      refGroups,
      audioRefFor: () => null,      // this cast has no voice clip in the isolated test root
      startFrameRef: null, endFrameRef: null, feedback: '', nonce: 0,
      shotSyntax: caps.shotSyntax,
    });

    const view = (await get(`/api/runs/${RUN_ID}/prompt?job=${job.job_id}`)).json();
    assert.equal(
      Buffer.compare(Buffer.from(view.prompt, 'utf8'), Buffer.from(prompt, 'utf8')), 0,
      `job ${job.job_id}: the preview and the paid render must not differ by a single byte`,
    );
    assert.deepEqual(view.shotPrompts.length, job.shots.length, 'one raw block per shot, for the per-shot view');
    assert.deepEqual(view.refs.map((r) => r.ref), refGroups.flatMap((g) => g.refs), 'the legend cites the same refs the prompt does');
  }
});

// The single-job case above cannot see the hardest part of the promise: on a multi-job render the
// pipeline CHAINS each clip's closing still into the next job, and Seedance carries that frame as an
// extra reference plus a sentence in the prompt. A preview that ignored the chain would look right
// for K1 and be wrong for every job after it — silently, and only on the runs that cost the most.
test('a chained job\'s preview carries the same opening pin the render will send', { skip: FF ? false : 'needs ffmpeg (the seam frame is grabbed from the previous clip)' }, async () => {
  const { runId } = (await post('/api/runs', { idea: 'TWO-JOB a keeper and the fog', backend: 'seedance', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const jobs = (await get(`/api/runs/${runId}/prompts`)).json();
  assert.equal(jobs.jobs.length, 2, 'the TWO-JOB brief plans K1+K2');
  const [first, second] = jobs.prompts;
  assert.equal(first.seam.in, 'none', 'the opening job continues from nothing');
  assert.equal(second.seam.in, 'soft', 'fal has no frame anchor — the chained still rides as a reference + prompt pin');
  assert.ok(second.prompt.includes('literal first frame'), 'the pin sentence is previewed, not just implied');

  assert.equal((await post(`/api/runs/${runId}/render`, { mode: 'full' })).statusCode, 202);
  await waitForStatus(runId, ['review', 'attention'], 180000);
  const sidecar = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'renders', 't1', jobs.jobs[1], 'prompts.json'), 'utf8'));
  assert.equal(
    Buffer.compare(Buffer.from(second.prompt, 'utf8'), Buffer.from(sidecar.prompt, 'utf8')), 0,
    'the chained job was previewed exactly as it was sent',
  );
});

// Kling's budget is per STORYBOARD SEGMENT (fal rejects a 512-byte one), so its view is shaped
// differently — one entry per shot, each with its own meter — and it must be the renderer's bytes too.
test('a Kling run previews one metered segment per shot, byte-identical to the storyboard builder', async () => {
  const { runId } = (await post('/api/runs', { idea: 'a keeper counting the waves', backend: 'kling', aspect: '9:16', durationS: null })).json();
  await waitForStatus(runId, 'plan-ready');
  const spec = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'spec.json'), 'utf8'));
  const job = spec.kling.jobs[0];

  const view = (await get(`/api/runs/${runId}/prompt?job=${job.job_id}`)).json();
  assert.equal(view.segments.length, job.shots.length, 'one segment per shot');
  assert.equal(view.segmentMaxBytes, 500, 'the per-shot cap fal actually enforces');
  for (const s of view.segments) {
    assert.equal(s.bytes, Buffer.byteLength(s.prompt, 'utf8'));
    assert.ok(s.bytes <= s.maxBytes, `segment ${s.shotId} fits the cap it is shown against`);
    assert.ok(s.pinBytes > 0 && s.pinBytes < s.maxBytes, 'the framing/camera/dialogue the edit cannot spend');
  }

  const settings = klingPromptSettings(spec, {
    nativeAudio: true, segmentMaxBytes: 500, maxStoryboards: 6, maxJobSeconds: 15, defaultShotSeconds: 5,
  });
  const { segments } = composeKlingStoryboard(job, spec, settings, {
    lowercaseSpeech: true, leadRef: '@Element1', voiceTokenFor: () => '@Element1',
  });
  view.segments.forEach((s, i) => assert.equal(
    Buffer.compare(Buffer.from(s.prompt, 'utf8'), Buffer.from(segments[i].prompt, 'utf8')), 0,
    `segment ${i}: the preview and the storyboard fal is sent must not differ by a byte`,
  ));
});

// ── a past take is served AS SENT ───────────────────────────────────────────────────────────────

test('?take= serves that take\'s prompts.json verbatim — immutable, with its provider and time', async () => {
  const jobId = JOB_IDS[0];
  const takeDir = path.join(runsDir, RUN_ID, 'renders', 't1', jobId);
  fs.mkdirSync(takeDir, { recursive: true });
  const sent = 'The exact words this take was rendered with, kept forever.';
  fs.writeFileSync(path.join(takeDir, 'prompts.json'), JSON.stringify({
    job_id: jobId, schema: 2, backend: 'seedance-2.0@fal', endpoint: 'bytedance/seedance-2.0/reference-to-video',
    prompt: sent, shot_prompts: ['a shot'],
    image_refs: [{ ref: '@Image1', id: 'subject', character: 'subject' }],
    // Absolute host paths live in a real sidecar (a voice clip, a seam frame) — they must not travel.
    audio_refs: [{ ref: '@Audio1', speaker: 'keeper', clip: path.join(runsDir, RUN_ID, 'renders/t1/keeper_ref.mp3') }],
    seam_in: { mode: 'none', frame: null, from: null },
    seam_out: { mode: 'none', frame: path.join(runsDir, RUN_ID, 'renders/t1/K1/last_frame.png'), frameSource: null, to: null },
  }, null, 2));

  const r = await get(`/api/runs/${RUN_ID}/prompt?job=${jobId}&take=t1`);
  assert.equal(r.statusCode, 200);
  const view = r.json();
  assert.equal(view.source, 'take');
  assert.equal(view.take, 't1');
  assert.equal(view.prompt, sent, 'a past take is never recomposed — the settings may have moved');
  assert.equal(view.bytes, Buffer.byteLength(sent, 'utf8'));
  assert.ok(view.sentAt, 'the sheet can say WHEN these words were sent');
  assert.ok(/Seedance/i.test(view.endpointLabel), `the take names the provider it was sent to (got "${view.endpointLabel}")`);
  assert.equal(view.maxBytes, null, "a past take's budget is not on record — the meter must not invent one");
  assert.ok(!r.body.includes(runsDir), 'the sidecar\'s absolute paths never reach the client');

  assert.equal((await get(`/api/runs/${RUN_ID}/prompt?job=${jobId}&take=t9`)).statusCode, 404, 'a take that sent nothing for this job is a miss');
});
