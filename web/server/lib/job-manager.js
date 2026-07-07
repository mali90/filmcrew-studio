// Child-process job runner with three FIFO lanes:
//   plan   — engine/revise runs (LLM cost only)
//   spend  — render/probe/render-job/upscale/mint (fal cost; strictly one at a time)
//   free   — assemble/stitch (no cost, fast — never queues behind a paid render)
// Every unit of work is a spawned CLI (`node src/cli/….js`) — the host repo's config.js snapshots
// process.env at import, so a fresh child per job is the ONLY way .env edits apply (this mirrors
// how the init wizard runs doctor/render). Children report through two channels the manager fuses
// into typed events: stderr lines (parsed by parseSentinel) and the stdout JSON tail on exit.
import { spawn } from 'node:child_process';

const ANSI = /\x1b\[[0-9;]*m/g;
const PREFIX = /^\[[^\]]*\]\s+(?:DBG|INF|WRN|ERR)\s+/;

/**
 * One stderr line → a typed run event, or null. The patterns mirror src/lib/logger.js call sites
 * (engine steps, per-job render steps, clip/master lines) — see the fixtures in sentinels.test.js.
 */
export function parseSentinel(rawLine) {
  const line = String(rawLine ?? '').replace(ANSI, '').replace(PREFIX, '').trim();
  if (!line) return null;

  let m;
  if ((m = line.match(/^▶ Engine — agent (\d+)-/))) return { type: 'agent', idx: Number(m[1]), state: 'started' };
  if ((m = line.match(/^▶ Engine — revising agent (\d+)-/))) return { type: 'agent', idx: Number(m[1]), state: 'started', revision: true };
  if ((m = line.match(/^▶ Engine — QC \(cycle (\d+)\/\d+\)/))) return { type: 'agent', idx: 7, state: 'started', cycle: Number(m[1]) };
  if (/^✓ QC pass/.test(line)) return { type: 'qc', state: 'pass' };
  if ((m = line.match(/^QC fail → re-running agents \[([^\]]*)\]/))) {
    return { type: 'qc', state: 'redo', owners: m[1].split(',').map((s) => Number(s.trim())).filter(Number.isInteger) };
  }
  if ((m = line.match(/^▶ \[([^\]]+)\] fal /))) return { type: 'job', jobId: m[1], state: 'started' };
  if ((m = line.match(/^▶ Render job — (\S+)/))) return { type: 'job', jobId: m[1], state: 'started' };
  if ((m = line.match(/^\[([^\]]+)\] clip -> (.+)$/))) return { type: 'job', jobId: m[1], state: 'done', clip: m[2].trim() };
  if ((m = line.match(/^\[([^\]]+)\] failed: (.+)$/))) return { type: 'job', jobId: m[1], state: 'failed', message: m[2].trim() };
  if (/^▶ Assemble — /.test(line)) return { type: 'assemble', state: 'started' };
  if ((m = line.match(/^✅ Master: (\S+)/))) return { type: 'master', path: m[1] };
  if (/^▶ fal Topaz upscale /.test(line)) return { type: 'upscale', state: 'started' };
  return null;
}

/** The last parseable JSON object in a CLI's stdout (every CLI prints its result as the tail). */
export function jsonTail(stdout) {
  const lines = String(stdout ?? '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const start = lines.slice(i).join('\n').trim();
    if (!start.startsWith('{')) continue;
    try { return JSON.parse(start); } catch { /* keep scanning up */ }
  }
  return null;
}

/**
 * @param {{spawnCli?: Function, onEvent?: (runId:string, evt:object) => void}} deps
 *   `spawnCli(script, args, {env, cwd})` must return a child-process-like object; injectable for
 *   tests. `onEvent` receives every typed event: {type:'log'|'queue'|'start'|<parsed>|'done'|'error'}.
 */
export function createJobManager({ spawnCli, onEvent = () => {} } = {}) {
  const doSpawn = spawnCli ?? ((script, args, { env, cwd } = {}) =>
    spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }));

  let nextId = 1;
  const lanes = { plan: { active: null, queue: [] }, spend: { active: null, queue: [] }, free: { active: null, queue: [] } };

  const emitQueue = () => onEvent('*', { type: 'queue', ...snapshot() });

  function snapshot() {
    const publicJob = (j) => j && { id: j.id, runId: j.runId, lane: j.lane, kind: j.kind, startedAt: j.startedAt ?? null };
    return {
      active: Object.values(lanes).map((l) => publicJob(l.active)).filter(Boolean),
      queued: Object.values(lanes).flatMap((l) => l.queue.map(publicJob)),
    };
  }

  function pump(laneName) {
    const lane = lanes[laneName];
    if (lane.active || !lane.queue.length) return;
    const job = lane.queue.shift();
    lane.active = job;
    job.startedAt = new Date().toISOString();

    let child;
    try {
      child = doSpawn(job.script, job.args, { env: job.env, cwd: job.cwd });
    } catch (e) {
      lane.active = null;
      onEvent(job.runId, { type: 'error', kind: job.kind, jobIdRef: job.id, message: `could not start ${job.script}: ${e.message}`, logTail: [] });
      emitQueue();
      queueMicrotask(() => pump(laneName));
      return;
    }
    job.child = child;
    job.pid = child.pid;
    onEvent(job.runId, { type: 'start', kind: job.kind, jobIdRef: job.id, pid: child.pid });
    emitQueue();

    let stdout = '';
    const logTail = [];
    let stderrBuf = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => {
      stderrBuf += d;
      let nl;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line.trim()) continue;
        logTail.push(line);
        if (logTail.length > 60) logTail.shift();
        onEvent(job.runId, { type: 'log', line });
        const evt = parseSentinel(line);
        if (evt) onEvent(job.runId, evt);
      }
    });
    child.on('error', (e) => onEvent(job.runId, { type: 'log', line: `spawn error: ${e.message}` }));
    child.on('close', (code, signal) => {
      lane.active = null;
      if (job.cancelled || signal === 'SIGTERM') {
        onEvent(job.runId, { type: 'error', kind: job.kind, jobIdRef: job.id, message: `${job.kind} was cancelled`, logTail: [...logTail] });
      } else if (code === 0) {
        onEvent(job.runId, { type: 'done', kind: job.kind, jobIdRef: job.id, result: jsonTail(stdout) });
      } else {
        onEvent(job.runId, { type: 'error', kind: job.kind, jobIdRef: job.id, message: `${job.script} exited ${code}`, logTail: [...logTail] });
      }
      emitQueue();
      pump(laneName);
    });
  }

  return {
    /** Add work; returns {id, position} — position = jobs ahead in the lane (0 = runs immediately). */
    enqueue({ runId, lane, kind, script, args = [], env, cwd }) {
      if (!lanes[lane]) throw new Error(`unknown lane "${lane}" (use plan|spend|free)`);
      const job = { id: `j${nextId++}`, runId, lane, kind, script, args, env, cwd };
      const position = (lanes[lane].active ? 1 : 0) + lanes[lane].queue.length;
      lanes[lane].queue.push(job);
      emitQueue();
      queueMicrotask(() => pump(lane));
      return { id: job.id, position };
    },
    /** Cancel by job id or runId: 'queued' (removed), 'active' (killed), or false. */
    cancel(idOrRunId) {
      for (const lane of Object.values(lanes)) {
        const qi = lane.queue.findIndex((j) => j.id === idOrRunId || j.runId === idOrRunId);
        if (qi !== -1) {
          const [job] = lane.queue.splice(qi, 1);
          onEvent(job.runId, { type: 'error', kind: job.kind, jobIdRef: job.id, message: `${job.kind} was cancelled while queued`, logTail: [] });
          emitQueue();
          return 'queued';
        }
      }
      for (const lane of Object.values(lanes)) {
        const j = lane.active;
        if (j && (j.id === idOrRunId || j.runId === idOrRunId)) {
          j.cancelled = true;
          j.child?.kill('SIGTERM');
          return 'active';
        }
      }
      return false;
    },
    snapshot,
    /** SIGTERM every active child (graceful shutdown). */
    shutdown() {
      for (const lane of Object.values(lanes)) {
        lane.queue.length = 0;
        if (lane.active) { lane.active.cancelled = true; lane.active.child?.kill('SIGTERM'); }
      }
    },
  };
}

export default { createJobManager, parseSentinel, jsonTail };
