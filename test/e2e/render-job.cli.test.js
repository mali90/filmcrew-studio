import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, jsonTail } from '../helpers/cli.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
import { startFalServer } from '../helpers/fal-server.js';

const fal = await startFalServer({ videoBytes: Buffer.from('FAKE-MP4') });
test.after(async () => { await fal.close(); });

const FAL_ENV = {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit',
};

test('render-job CLI: re-renders one job of a multi-job spec into --out', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli');
  try {
    const spec = loadGoldenSpec();
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
      { job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'] },
    ];
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const out = path.join(dir, 't2');
    const { code, stdout } = await runCli('src/cli/render-job.js',
      ['--spec', specPath, '--job', 'K2', '--out', out],
      { env: FAL_ENV });
    assert.equal(code, 0, stdout);
    const r = jsonTail(stdout);
    assert.equal(r.jobId, 'K2');
    assert.deepEqual(r.staleDownstream, []);
    assert.ok(fs.existsSync(r.clip));
    assert.ok(fs.existsSync(path.join(out, 'render.json')));
  } finally { cleanup(); }
});

test('render-job CLI: bad --take and missing --job are usage errors', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-usage');
  try {
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(loadGoldenSpec()));
    const noJob = await runCli('src/cli/render-job.js', ['--spec', specPath], { env: FAL_ENV });
    assert.equal(noJob.code, 1);
    assert.match(noJob.stderr, /--job/);
    const badTake = await runCli('src/cli/render-job.js', ['--spec', specPath, '--job', 'K1', '--take', 'two'], { env: FAL_ENV });
    assert.equal(badTake.code, 1);
    assert.match(badTake.stderr, /--take/);
  } finally { cleanup(); }
});
