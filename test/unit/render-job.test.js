import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
neutralizeDotenv();
const { seedForJob, downstreamJobs } = await import('../../src/lib/pipeline.js');

test('seedForJob: deterministic per job position, take variation offsets by 7', () => {
  assert.equal(seedForJob(0, 0), 70000);
  assert.equal(seedForJob(1, 0), 70100);
  assert.equal(seedForJob(0, 1), 70007);
  assert.equal(seedForJob(2, 3), 70221);
  assert.equal(seedForJob(1, undefined), 70100, 'missing take = base seed');
});

test('downstreamJobs: jobs after the given one, in stitch order (their seams go stale on re-render)', () => {
  const spec = loadGoldenSpec();
  spec.kling.jobs = [
    { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
    { job_id: 'K2', shots: ['S2'], elements: ['subject'] },
    { job_id: 'K3', shots: ['S3'], elements: ['subject'] },
  ];
  assert.deepEqual(downstreamJobs(spec, 'K1'), ['K2', 'K3']);
  assert.deepEqual(downstreamJobs(spec, 'K2'), ['K3']);
  assert.deepEqual(downstreamJobs(spec, 'K3'), []);
  assert.throws(() => downstreamJobs(spec, 'K9'), /not found/);
});
