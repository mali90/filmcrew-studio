// The stderr sentinel parser — the bridge from the CLIs' human log lines to typed run events.
// Fixture lines mirror src/lib/logger.js output exactly (ANSI codes, [ts] TAG prefixes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSentinel } from '../../lib/job-manager.js';

const CYAN = '\x1b[1m\x1b[36m';
const RESET = '\x1b[0m';
const ts = '[2026-07-04T12:00:00.000Z]';

test('engine agent + QC steps (ANSI-wrapped ▶ lines from log.step)', () => {
  assert.deepEqual(parseSentinel(`${CYAN}▶ Engine — agent 3-cinematographer.md${RESET}`),
    { type: 'agent', idx: 3, state: 'started' });
  assert.deepEqual(parseSentinel('▶ Engine — agent 0-showrunner.md'),
    { type: 'agent', idx: 0, state: 'started' });
  assert.deepEqual(parseSentinel('▶ Engine — revising agent 2-scene-director.md'),
    { type: 'agent', idx: 2, state: 'started', revision: true });
  assert.deepEqual(parseSentinel('▶ Engine — QC (cycle 2/3)'),
    { type: 'agent', idx: 7, state: 'started', cycle: 2 });
  assert.deepEqual(parseSentinel(`${ts} INF ✓ QC pass`), { type: 'qc', state: 'pass' });
  assert.deepEqual(parseSentinel(`${ts} WRN QC fail → re-running agents [1, 2]. Notes: [shots] weak`),
    { type: 'qc', state: 'redo', owners: [1, 2] });
});

test('render job lifecycle lines', () => {
  assert.deepEqual(parseSentinel(`${CYAN}▶ [K1] fal Kling reference-to-video — 3 shot(s), 13s, 1 element(s)${RESET}`),
    { type: 'job', jobId: 'K1', state: 'started' });
  assert.deepEqual(parseSentinel('▶ [K2] fal Seedance 2.0 reference-to-video [probe] — 2 shot(s)'),
    { type: 'job', jobId: 'K2', state: 'started' });
  assert.deepEqual(parseSentinel('▶ Render job — K2 — Seedance 2.0 (fal) [take 2]'),
    { type: 'job', jobId: 'K2', state: 'started' });
  assert.deepEqual(parseSentinel(`${ts} INF [K1] clip -> /runs/x/K1/out.mp4`),
    { type: 'job', jobId: 'K1', state: 'done', clip: '/runs/x/K1/out.mp4' });
  assert.deepEqual(parseSentinel(`${ts} ERR [K2] failed: fal job req_1 FAILED: boom`),
    { type: 'job', jobId: 'K2', state: 'failed', message: 'fal job req_1 FAILED: boom' });
});

test('assemble / master / upscale lines', () => {
  assert.deepEqual(parseSentinel('▶ Assemble — "Ocean Lighthouse" from runs/x (no re-render)'),
    { type: 'assemble', state: 'started' });
  assert.deepEqual(parseSentinel(`${ts} INF ✅ Master: /out/ocean-2.mp4  (2 job clip(s))`),
    { type: 'master', path: '/out/ocean-2.mp4' });
  assert.deepEqual(parseSentinel('▶ fal Topaz upscale 4× [Proteus] : clip.mp4'),
    { type: 'upscale', state: 'started' });
});

test('everything else is null (plain chatter never becomes an event)', () => {
  for (const line of ['', '   ', `${ts} INF downloading…`, 'random text', `${ts} WRN Agent 3 validation failed (attempt 1/3):`]) {
    assert.equal(parseSentinel(line), null, JSON.stringify(line));
  }
});
