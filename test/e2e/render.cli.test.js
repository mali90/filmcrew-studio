import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, jsonTail } from '../helpers/cli.js';
import { startFalServer } from '../helpers/fal-server.js';
import { mkTmp } from '../helpers/tmp.js';
import { ROOT, ONE_PX_PNG } from '../helpers/fixtures.js';
import { hasFfmpeg, tinyMp4Bytes } from '../helpers/ffmpeg-clips.js';

const fal = await startFalServer({ videoBytes: Buffer.from('MP4') });
// A FULL (non-probe) run stitches what the mock returns, so the boundary tests need clips ffmpeg
// can actually read — a second mock, since the probe tests above are happy with garbage bytes.
const FF = await hasFfmpeg();
const realFal = await startFalServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('MP4') });
test.after(async () => { await fal.close(); await realFal.close(); });

const sidecarOf = (runDir, jobId) => JSON.parse(fs.readFileSync(path.join(runDir, jobId, 'prompts.json'), 'utf8'));

// --probe exists only for multi-job specs (it renders the first job); the golden example is a
// single job, so probe tests split it into K1+K2 first.
function twoJobSpecFile(dir) {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/ocean-lighthouse/spec.json'), 'utf8'));
  const [job] = spec.kling.jobs;
  spec.kling.jobs = [
    { ...job, job_id: 'K1', shots: job.shots.slice(0, -1) },
    { ...job, job_id: 'K2', shots: job.shots.slice(-1) },
  ];
  const p = path.join(dir, 'two-job-spec.json');
  fs.writeFileSync(p, JSON.stringify(spec));
  return p;
}

test('render --probe against the mock renders ONLY the first job', async () => {
  const { dir, cleanup } = mkTmp('render-cli-fal');
  try {
    const { code, stdout } = await runCli('src/cli/render.js',
      ['--spec', twoJobSpecFile(dir), '--probe', '--out', dir],
      { env: { FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_KLING_ENDPOINT: 'submit', FAL_MAX_RETRIES: '1' } });
    assert.equal(code, 0, stdout);
    const r = jsonTail(stdout);
    assert.equal(r.probe, true);
    assert.equal(r.jobs.length, 1, 'only K1 rendered');
    assert.ok(r.clip && fs.existsSync(r.clip));
  } finally { cleanup(); }
});

test('render --probe --backend seedance against the mock', async () => {
  const { dir, cleanup } = mkTmp('render-cli-seedance');
  try {
    const { code, stdout } = await runCli('src/cli/render.js',
      ['--spec', twoJobSpecFile(dir), '--probe', '--backend', 'seedance', '--out', dir],
      { env: { FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', SEEDANCE_UPLOAD_MODE: 'data-uri',
               FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-submit', FAL_MAX_RETRIES: '1' } });
    assert.equal(code, 0, stdout);
    const r = jsonTail(stdout);
    assert.equal(r.probe, true);
    assert.equal(r.backend, 'seedance-2.0@fal'); // --backend seedance still works; the RECORD is canonical
    assert.ok(r.clip && fs.existsSync(r.clip));
  } finally { cleanup(); }
});

test('render --probe on a single-job spec is refused before any spend', async () => {
  const { dir, cleanup } = mkTmp('render-cli-noprobe');
  const requestsBefore = fal.requests.length;
  try {
    const { code, stdout, stderr } = await runCli('src/cli/render.js',
      ['--spec', 'examples/ocean-lighthouse/spec.json', '--probe', '--out', dir],
      { env: { FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_KLING_ENDPOINT: 'submit', FAL_MAX_RETRIES: '1' } });
    assert.equal(code, 1);
    assert.match(stderr + stdout, /--probe needs a multi-job spec/);
    assert.equal(fal.requests.length, requestsBefore, 'nothing reached fal');
  } finally { cleanup(); }
});

// ── WS2-P1: the two boundary pins bracket the RUN, they do not repeat per job ───────────────────

test('render CLI: --first-frame-from pins the FIRST job and --last-frame-from the LAST', FF ? {} : { skip: 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('render-cli-pins');
  try {
    const open = path.join(dir, 'open.png');
    const close = path.join(dir, 'close.png');
    for (const f of [open, close]) fs.writeFileSync(f, ONE_PX_PNG);
    const runDir = path.join(dir, 'run');
    const before = realFal.requests.length;
    const { code, stdout, stderr } = await runCli('src/cli/render.js',
      ['--spec', twoJobSpecFile(dir), '--out', runDir, '--first-frame-from', open, '--last-frame-from', close],
      { env: { FAL_BASE_URL: realFal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_KLING_ENDPOINT: 'submit', FAL_MAX_RETRIES: '1',
               OUT_DIR: dir, RUNS_DIR: dir, CACHE_DIR: dir, VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false' } });
    assert.equal(code, 0, stderr || stdout);

    const submits = realFal.requests.slice(before).filter((q) => q.method === 'POST').map((q) => JSON.parse(q.body));
    assert.equal(submits.length, 2, 'both jobs rendered');
    assert.ok(submits[0].start_image_url, 'the opening pin rides job 1');
    assert.ok(!submits[0].end_image_url, 'job 1 does not close the run, so it takes no closing pin');
    assert.ok(submits[1].end_image_url, 'the closing pin rides the LAST job only');

    const k1 = sidecarOf(runDir, 'K1');
    const k2 = sidecarOf(runDir, 'K2');
    assert.equal(k1.seam_in.frame, open);
    assert.equal(k1.seam_in.from, null, 'an explicit pin continues no clip of this run');
    assert.equal(k1.seam_out.mode, 'none', 'nothing pinned K1\'s close');
    assert.equal(k2.seam_in.frame, path.join(runDir, 'K1', 'last_frame.png'), 'K2 keeps the chained seam — the pin was for the run, not every job');
    assert.equal(k2.seam_in.from?.job, 'K1');
    assert.equal(k2.seam_out.mode, 'native');
  } finally { cleanup(); }
});

test('render CLI: --prompt-overrides pointing at nothing is refused before any spend', async () => {
  const { dir, cleanup } = mkTmp('render-cli-overrides');
  const before = fal.requests.length;
  try {
    const never = path.join(dir, 'never');
    const { code, stderr } = await runCli('src/cli/render.js',
      ['--spec', twoJobSpecFile(dir), '--out', never, '--prompt-overrides', path.join(dir, 'nope.json')],
      { env: { FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_KLING_ENDPOINT: 'submit', FAL_MAX_RETRIES: '1' } });
    assert.equal(code, 1);
    assert.match(stderr, /--prompt-overrides/);
    assert.match(stderr, /nope\.json/);
    assert.equal(fal.requests.length, before, 'nothing reached fal');
    assert.ok(!fs.existsSync(never), 'and no run dir was created');
  } finally { cleanup(); }
});
