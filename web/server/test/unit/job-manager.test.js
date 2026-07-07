// Queue semantics with a stubbed child spawner: FIFO within a lane, lane isolation, cancel of
// queued vs active work, and the event feed (log lines → parsed events → done with the JSON tail).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createJobManager } from '../../lib/job-manager.js';

/** A controllable fake child: push stderr/stdout, then exit(code). */
function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = Math.floor(Math.random() * 100000) + 1000;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
  return child;
}

function makeManager() {
  const spawned = [];
  const events = [];
  const mgr = createJobManager({
    spawnCli: (script, args, opts) => {
      const child = fakeChild();
      spawned.push({ script, args, opts, child });
      return child;
    },
    onEvent: (runId, evt) => events.push({ runId, ...evt }),
  });
  return { mgr, spawned, events };
}

test('FIFO within a lane: the second spend job waits for the first to exit', async () => {
  const { mgr, spawned } = makeManager();
  const a = mgr.enqueue({ runId: 'r1', lane: 'spend', kind: 'render', script: 's.js', args: [] });
  const b = mgr.enqueue({ runId: 'r2', lane: 'spend', kind: 'render', script: 's.js', args: [] });
  assert.equal(a.position, 0);
  assert.equal(b.position, 1);
  await sleep(10);
  assert.equal(spawned.length, 1, 'only the first job is running');
  spawned[0].child.stdout.emit('data', '{"ok":true}\n');
  spawned[0].child.emit('close', 0);
  await sleep(10);
  assert.equal(spawned.length, 2, 'second job started after the first finished');
  spawned[1].child.emit('close', 0);
});

test('lane isolation: a plan job runs concurrently with a spend job', async () => {
  const { mgr, spawned } = makeManager();
  mgr.enqueue({ runId: 'r1', lane: 'spend', kind: 'render', script: 's.js', args: [] });
  mgr.enqueue({ runId: 'r2', lane: 'plan', kind: 'plan', script: 'e.js', args: [] });
  await sleep(10);
  assert.equal(spawned.length, 2, 'both lanes active at once');
  for (const s of spawned) s.child.emit('close', 0);
});

test('events: stderr lines feed log + parsed events; exit 0 emits done with the stdout JSON tail', async () => {
  const { mgr, spawned, events } = makeManager();
  mgr.enqueue({ runId: 'r1', lane: 'plan', kind: 'plan', script: 'e.js', args: [] });
  await sleep(10);
  const { child } = spawned[0];
  child.stderr.emit('data', '▶ Engine — agent 0-showrunner.md\nplain chatter\n');
  child.stdout.emit('data', 'noise before\n{"passed":true}\n');
  child.emit('close', 0);
  await sleep(10);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('log'), 'raw lines stream as log events');
  assert.deepEqual(events.find((e) => e.type === 'agent'), { runId: 'r1', type: 'agent', idx: 0, state: 'started' });
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.kind, 'plan');
  assert.deepEqual(done.result, { passed: true });
});

test('non-zero exit emits error with the last log lines attached', async () => {
  const { mgr, spawned, events } = makeManager();
  mgr.enqueue({ runId: 'r1', lane: 'spend', kind: 'render', script: 's.js', args: [] });
  await sleep(10);
  spawned[0].child.stderr.emit('data', 'ERR something exploded\n');
  spawned[0].child.emit('close', 1);
  await sleep(10);
  const err = events.find((e) => e.type === 'error');
  assert.equal(err.kind, 'render');
  assert.match(err.message, /exit(ed)? 1/i);
  assert.ok(err.logTail.some((l) => l.includes('exploded')));
});

test('cancel: a queued job is removed; an active job is killed', async () => {
  const { mgr, spawned, events } = makeManager();
  const a = mgr.enqueue({ runId: 'r1', lane: 'spend', kind: 'render', script: 's.js', args: [] });
  const b = mgr.enqueue({ runId: 'r2', lane: 'spend', kind: 'render', script: 's.js', args: [] });
  await sleep(10);
  assert.equal(mgr.cancel(b.id), 'queued');
  assert.equal(mgr.cancel(a.id), 'active');
  await sleep(10);
  assert.equal(spawned[0].child.killed, true);
  assert.equal(spawned.length, 1, 'the cancelled queued job never spawned');
  assert.equal(mgr.cancel('nope'), false);
  const cancelled = events.filter((e) => e.type === 'error' && /cancelled/i.test(e.message));
  assert.equal(cancelled.length, 2, 'both cancellations notify their runs');
  assert.equal(cancelled.filter((e) => /while queued/.test(e.message)).length, 1);
});

test('queue snapshot lists active + queued in order', async () => {
  const { mgr, spawned } = makeManager();
  mgr.enqueue({ runId: 'r1', lane: 'spend', kind: 'render', script: 's.js', args: [] });
  mgr.enqueue({ runId: 'r2', lane: 'spend', kind: 'render', script: 's.js', args: [] });
  mgr.enqueue({ runId: 'r3', lane: 'spend', kind: 'upscale', script: 's.js', args: [] });
  await sleep(10);
  const q = mgr.snapshot();
  assert.equal(q.active.find((j) => j.lane === 'spend').runId, 'r1');
  assert.deepEqual(q.queued.map((j) => j.runId), ['r2', 'r3']);
  for (const s of spawned) s.child.emit('close', 0);
});
