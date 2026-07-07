// The pure event reducer — the honesty layer between SSE and the AgentRail/monitor UI.
import { describe, expect, it } from 'vitest';
import { initialRunLive, reduceRunEvents, type RunLive } from './run-events';
import { makeRun } from '../test/fixtures';
import type { RunEvent } from '../../../shared/api-types';

const fold = (events: RunEvent[], t0 = 1000) => {
  let s: RunLive = initialRunLive();
  let now = t0;
  for (const e of events) { s = reduceRunEvents(s, e, now); now += 1000; }
  return s;
};

describe('reduceRunEvents', () => {
  it('snapshot seeds agents from disk-derived progress', () => {
    const s = fold([{ type: 'snapshot', run: makeRun('planning') }]);
    expect(s.run?.id).toBeTruthy();
    expect(s.agents.filter((a) => a.state === 'done')).toHaveLength(3); // agents.done = 3 in the fixture
    expect(s.agents[7].state).toBe('waiting');
  });

  it('reopening a page mid-plan resumes on the CURRENT step: the in-flight agent seeds as thinking', () => {
    const live = makeRun('planning');
    live.manifest = { ...live.manifest!, activeJob: { kind: 'plan', pid: 123, startedAt: 'now' } as never };
    const s = fold([{ type: 'snapshot', run: live }]);
    expect(s.agents[3].state).toBe('thinking'); // agents.done = 3 → agent 3 is running right now
    expect(s.agents[3].startedAt).toBeNull();   // unknown start — no made-up timer
    // without a live child (queued/interrupted) nothing is falsely thinking
    const cold = fold([{ type: 'snapshot', run: makeRun('planning') }]);
    expect(cold.agents.every((a) => a.state !== 'thinking')).toBe(true);
  });

  it('a live revision seeds its owners as redo — never a dead all-done rail', () => {
    const run = makeRun('planning');
    run.agents = { done: 8, total: 8, qcCycles: 1 };
    run.revising = { id: 'r1', owners: [4, 5], scope: 'K3' };
    run.manifest = { ...run.manifest!, activeJob: { kind: 'revise', pid: 9, startedAt: 'x' } as never };
    const s = fold([{ type: 'snapshot', run }]);
    expect(s.agents[4].state).toBe('redo');
    expect(s.agents[5].state).toBe('redo');
    expect(s.agents[0].state).toBe('done');
  });

  it('log-backlog merges ring history under live lines, deduped by cursor and sorted', () => {
    const s = fold([
      { type: 'snapshot', run: makeRun('planning') },
      { type: 'log', cursor: 5, line: 'live-5' },
      { type: 'log-backlog', lines: [{ cursor: 3, line: 'old-3' }, { cursor: 5, line: 'stale-5' }, { cursor: 4, line: 'old-4' }] } as never,
    ]);
    expect(s.log.map((l) => `${l.cursor}:${l.line}`)).toEqual(['3:old-3', '4:old-4', '5:live-5']);
  });

  it('agent start marks the previous thinker done with a frozen elapsed', () => {
    const s = fold([
      { type: 'snapshot', run: makeRun('planning') },
      { type: 'agent', idx: 3, state: 'started' },
      { type: 'agent', idx: 4, state: 'started' },
    ]);
    expect(s.agents[3].state).toBe('done');
    expect(s.agents[3].elapsedMs).toBe(1000);
    expect(s.agents[4].state).toBe('thinking');
    expect(s.agents[4].startedAt).not.toBeNull();
  });

  it('QC redo flips the flagged owners to redo and QC pass ends the plan', () => {
    const s = fold([
      { type: 'snapshot', run: makeRun('planning') },
      { type: 'agent', idx: 7, state: 'started', cycle: 1 },
      { type: 'qc', state: 'redo', owners: [1, 2] },
    ]);
    expect(s.agents[1].state).toBe('redo');
    expect(s.agents[2].state).toBe('redo');
    expect(s.agents[7].state).toBe('done');
    const passed = fold([
      { type: 'snapshot', run: makeRun('planning') },
      { type: 'agent', idx: 7, state: 'started', cycle: 1 },
      { type: 'qc', state: 'pass' },
    ]);
    expect(passed.qcPassed).toBe(true);
  });

  it('a full redo cycle: owners think again while re-running, and QC pass leaves nobody in redo', () => {
    const s = fold([
      { type: 'snapshot', run: makeRun('planning') },
      { type: 'agent', idx: 7, state: 'started', cycle: 1 },
      { type: 'qc', state: 'redo', owners: [1, 2] },
      // the engine logs "revising agent N-…" for each re-run — owners flip redo → thinking
      { type: 'agent', idx: 1, state: 'started', revision: true },
      { type: 'agent', idx: 2, state: 'started', revision: true },
      { type: 'agent', idx: 7, state: 'started', cycle: 2 },
      { type: 'qc', state: 'pass' },
    ]);
    // redo was counted once by the qc event, not again by the revising start
    expect(s.agents[1].redoCount).toBe(1);
    expect(s.agents[2].redoCount).toBe(1);
    // and a pass closes every thread — no agent may stay 'redo' or 'thinking' after sign-off
    expect(s.agents.every((a) => a.state === 'done' || a.state === 'waiting')).toBe(true);
    expect(s.qcPassed).toBe(true);
  });

  it('QC pass resolves owners even when no revising sentinel ever arrived (older logs)', () => {
    const s = fold([
      { type: 'snapshot', run: makeRun('planning') },
      { type: 'agent', idx: 7, state: 'started', cycle: 1 },
      { type: 'qc', state: 'redo', owners: [4] },
      { type: 'qc', state: 'pass' },
    ]);
    expect(s.agents[4].state).toBe('done');
    expect(s.qcPassed).toBe(true);
  });

  it('log lines accumulate with cursors and are bounded', () => {
    const events: RunEvent[] = [{ type: 'snapshot', run: makeRun('planning') }];
    for (let i = 1; i <= 600; i++) events.push({ type: 'log', cursor: i, line: `l${i}` });
    const s = fold(events);
    expect(s.log).toHaveLength(500);
    expect(s.log[0].cursor).toBe(101);
  });

  it('job events patch the latest render jobs; error freezes the thinker as failed', () => {
    const s = fold([
      { type: 'snapshot', run: makeRun('rendering') },
      { type: 'job', jobId: 'K1', state: 'done', clip: '/x.mp4' },
      { type: 'job', jobId: 'K2', state: 'failed', message: 'boom' },
    ]);
    expect(s.run?.latestRender?.jobs.find((j) => j.jobId === 'K1')?.clipExists).toBe(true);
    expect(s.run?.latestRender?.jobs.find((j) => j.jobId === 'K2')?.error).toBe('boom');

    const err = fold([
      { type: 'snapshot', run: makeRun('planning') },
      { type: 'agent', idx: 2, state: 'started' },
      { type: 'error', kind: 'plan', message: 'LLM died' },
    ]);
    expect(err.agents[2].state).toBe('failed');
    expect(err.lastError).toBe('LLM died');
  });

  it('run-refresh: replaces run/manifest, preserves live agent texture, seeds agents on a cold page', () => {
    // cold page (no snapshot yet): refresh seeds agent states from disk-derived progress
    const cold = fold([{ type: 'run-refresh', run: makeRun('plan-ready') } as never]);
    expect(cold.run?.status).toBe('plan-ready');
    expect(cold.agents.every((a) => a.state === 'done')).toBe(true); // agents.done = 8 in the fixture

    // live page: the manifest updates but the thinking agent's timer survives
    let s = fold([
      { type: 'snapshot', run: makeRun('planning') },
      { type: 'agent', idx: 4, state: 'started' },
    ]);
    const fresher = makeRun('planning');
    fresher.manifest!.revisions.push({ id: 'r1', feedback: 'x', scope: 'whole', owners: [2], createdAt: 'now' });
    s = reduceRunEvents(s, { type: 'run-refresh', run: fresher }, 5000);
    expect(s.run?.manifest?.revisions).toHaveLength(1);
    expect(s.agents[4].state).toBe('thinking');
    expect(s.agents[4].startedAt).not.toBeNull();
  });

  it('status events update the run without inventing anything else', () => {
    const s = fold([
      { type: 'snapshot', run: makeRun('plan-ready') },
      { type: 'status', status: 'rendering', phase: 'render' },
    ]);
    expect(s.run?.status).toBe('rendering');
    expect(s.run?.phase).toBe('render');
  });
});
