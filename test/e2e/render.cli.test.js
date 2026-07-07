import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, jsonTail } from '../helpers/cli.js';
import { startFalServer } from '../helpers/fal-server.js';
import { mkTmp } from '../helpers/tmp.js';
import { ROOT } from '../helpers/fixtures.js';

const fal = await startFalServer({ videoBytes: Buffer.from('MP4') });
test.after(async () => { await fal.close(); });

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
    assert.equal(r.backend, 'seedance');
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
