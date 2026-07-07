// Live run state = snapshot ⊕ events, folded by a PURE reducer (unit-tested without any DOM).
// The server's derived status is authoritative — the client never invents state transitions; it
// only tracks the ephemeral live texture (which agent is thinking, elapsed, log lines) that disk
// scans can't show between snapshots.
import type { RunDetail, RunEvent } from '../../../shared/api-types';

export type AgentUiState = 'waiting' | 'thinking' | 'done' | 'redo' | 'failed';
export interface AgentLive {
  idx: number;
  state: AgentUiState;
  startedAt: number | null;  // epoch ms (client clock) while thinking
  elapsedMs: number | null;  // frozen when done
  cycle?: number;            // QC pass number
  redoCount: number;
}
export interface RunLive {
  run: RunDetail | null;
  agents: AgentLive[];       // always 8 entries, idx 0..7
  log: { cursor: number; line: string }[];
  qcPassed: boolean;
  lastError: string | null;
  activeKind: string | null; // which action is currently running (plan/render/…)
}

const MAX_LOG = 500;

export const initialRunLive = (): RunLive => ({
  run: null,
  agents: Array.from({ length: 8 }, (_, idx) => ({ idx, state: 'waiting', startedAt: null, elapsedMs: null, redoCount: 0 })),
  log: [],
  qcPassed: false,
  lastError: null,
  activeKind: null,
});

/** Seed agent states from a snapshot: agents.done counts finished artifacts on disk. */
function seedAgents(run: RunDetail): AgentLive[] {
  const done = run.agents?.done ?? 0;
  const agents = Array.from({ length: 8 }, (_, idx) => ({
    idx,
    state: idx < Math.min(done, 7) ? 'done' : done === 8 ? 'done' : 'waiting',
    startedAt: null,
    elapsedMs: null,
    redoCount: 0,
  })) as AgentLive[];
  // a LIVE plan child means the next agent is thinking RIGHT NOW — reopening the page mid-plan
  // must resume on the current step, not show a dead rail until the next sentinel arrives.
  // (startedAt stays null: we don't know when this agent started, so no made-up timer.)
  const liveKind = run.manifest?.activeJob?.kind;
  if (done < 8 && run.status === 'planning' && (liveKind === 'plan' || liveKind === 'revise')) {
    agents[Math.min(done, 7)].state = 'thinking';
  }
  // a LIVE revision over a completed plan: the owner agents are re-running right now — a cold
  // page must not show a dead all-done rail (live sentinels upgrade redo → thinking as they land)
  if (run.status === 'planning' && run.revising) {
    for (const idx of run.revising.owners) if (agents[idx]) agents[idx].state = 'redo';
  }
  return agents;
}

/** Client-side synthetic events: REST refreshes and the runId-change reset. */
export type ClientRunEvent = RunEvent | { type: 'run-refresh'; run: RunDetail } | { type: 'run-reset' } | { type: 'log-backlog'; lines: { cursor: number; line: string }[] };

/** A first render has no render.json yet — give live job events a shell derived from the plan. */
function renderShell(run: RunDetail) {
  return {
    dir: '', backend: run.backend ?? null,
    jobs: (run.spec?.kling?.jobs ?? []).map((j) => ({ jobId: j.job_id, clip: null, clipExists: false, clipUrl: null, error: null })),
    master: null, masterExists: false, masterUrl: null, cover: null, coverUrl: null,
  };
}

export function reduceRunEvents(state: RunLive, event: ClientRunEvent, nowMs = Date.now()): RunLive {
  switch (event.type) {
    case 'snapshot': {
      const run = event.run;
      // a snapshot resets everything derivable; live texture restarts from disk truth
      return { ...initialRunLive(), run, agents: seedAgents(run), activeKind: run.manifest?.activeJob?.kind ?? null };
    }
    case 'run-reset':
      // navigating run A → run B without an unmount must not show A's state under B's URL
      return initialRunLive();
    case 'run-refresh': {
      // a query refetch (fired on done/error/status edges) — newer disk truth for run/manifest.
      // In-flight agent timers/log stay as they are; but when there is NO live texture yet (page
      // opened without an SSE snapshot), seed the agent states from the disk-derived progress.
      const hasLiveTexture = state.agents.some((a) => a.state !== 'waiting') || state.run !== null;
      // disk has no render.json until the render finishes — don't let a refetch wipe live job ticks
      const latestRender = event.run.latestRender ?? state.run?.latestRender ?? null;
      const run = latestRender === event.run.latestRender ? event.run : { ...event.run, latestRender };
      return { ...state, run, agents: hasLiveTexture ? state.agents : seedAgents(event.run) };
    }
    case 'status': {
      if (!state.run) return state;
      return { ...state, run: { ...state.run, status: event.status, phase: event.phase } };
    }
    case 'action-start':
      return { ...state, activeKind: event.kind, lastError: null };
    case 'agent': {
      const agents = state.agents.map((a) => ({ ...a }));
      const target = agents[event.idx];
      if (!target) return state;
      // starting agent N marks every earlier thinking agent done (sequential pipeline)
      for (const a of agents) {
        if (a.state === 'thinking' && a.idx !== event.idx) {
          a.state = 'done';
          a.elapsedMs = a.startedAt ? nowMs - a.startedAt : a.elapsedMs;
          a.startedAt = null;
        }
      }
      // a QC-flagged owner was already counted by the 'qc' redo event — don't double-count
      if (event.revision && target.state !== 'redo') target.redoCount += 1;
      target.state = 'thinking';
      target.startedAt = nowMs;
      if (event.cycle) target.cycle = event.cycle;
      return { ...state, agents };
    }
    case 'qc': {
      const agents = state.agents.map((a) => ({ ...a }));
      const qc = agents[7];
      if (event.state === 'pass') {
        qc.state = 'done';
        qc.elapsedMs = qc.startedAt ? nowMs - qc.startedAt : qc.elapsedMs;
        qc.startedAt = null;
        // a pass closes every reopened thread — no owner may stay 'redo' after QC signs off
        for (const a of agents) {
          if (a.state === 'redo' || a.state === 'thinking') {
            a.state = 'done';
            a.elapsedMs = a.startedAt ? nowMs - a.startedAt : a.elapsedMs;
            a.startedAt = null;
          }
        }
        return { ...state, agents, qcPassed: true };
      }
      // redo: QC flags owners — they flip to redo and will re-run
      qc.state = 'done';
      qc.elapsedMs = qc.startedAt ? nowMs - qc.startedAt : qc.elapsedMs;
      qc.startedAt = null;
      for (const idx of event.owners ?? []) {
        if (agents[idx]) { agents[idx].state = 'redo'; agents[idx].redoCount += 1; }
      }
      return { ...state, agents };
    }
    case 'log': {
      const log = [...state.log, { cursor: event.cursor, line: event.line }];
      if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
      return { ...state, log };
    }
    case 'log-backlog': {
      // ring-buffer history fetched on page open — LLM steps are minutes apart, so without the
      // backlog a mid-plan page shows an empty log and reads as stuck
      const byCursor = new Map(event.lines.map((l) => [l.cursor, l]));
      for (const l of state.log) byCursor.set(l.cursor, l); // live lines win on collision
      const log = [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
      if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
      return { ...state, log };
    }
    case 'job': {
      if (!state.run) return state;
      // no render.json on disk yet (first render still going) — synthesize the job list from the
      // plan so live done/failed ticks are never dropped on the floor
      const lr = state.run.latestRender ?? renderShell(state.run);
      const jobs = lr.jobs.map((j) =>
        j.jobId === event.jobId
          ? { ...j, error: event.state === 'failed' ? event.message ?? 'failed' : null, clipExists: event.state === 'done' ? true : j.clipExists }
          : j);
      return { ...state, run: { ...state.run, latestRender: { ...lr, jobs } } };
    }
    case 'done':
      return { ...state, activeKind: null };
    case 'error': {
      const agents = state.agents.map((a) => (a.state === 'thinking' ? { ...a, state: 'failed' as AgentUiState, startedAt: null } : a));
      return { ...state, agents, activeKind: null, lastError: event.message };
    }
    default:
      return state;
  }
}
