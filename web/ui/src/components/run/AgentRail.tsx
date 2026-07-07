// The 8-agent pipeline as a quiet rail: one row per agent, each row narrating what it will do,
// is deciding right now (shimmer + live elapsed), or has delivered (a concrete receipt read from
// the spec). QC redos draw a warn thread from row 7 back up to the reopened block.
import { useEffect, useRef, useState } from 'react';
import {
  Aperture, AudioLines, BadgeCheck, Check, ChevronDown, ChevronUp, Clapperboard,
  ClipboardList, Film, PenLine, RotateCcw, Users, X,
} from 'lucide-react';
import clsx from 'clsx';
import { AGENTS, type RunDetail } from '../../../../shared/api-types';
import type { AgentLive, RunLive } from '../../api/run-events';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';
import { api } from '../../api/client';
import { elapsed } from '../../lib/format';
import { jobSeconds, totalShotSeconds, truncate } from './SpecInspector';

const ICONS = [Clapperboard, Film, PenLine, Aperture, Users, AudioLines, ClipboardList, BadgeCheck];

const FUTURE = [
  'will shape the idea into a title and logline',
  'will break the story into timed shots',
  'will write what happens in each shot',
  'will choose framing and camera moves',
  'will pin reference elements',
  'will decide voice lines and sound',
  'will pack shots into render jobs',
  'will check the plan end to end',
];

/** Merge live SSE agent state with the REST snapshot: before the stream's snapshot arrives, the
 *  run's persisted agents.done count is the truth. */
export function agentStatesFor(run: RunDetail, live: Pick<RunLive, 'run' | 'agents'>): AgentLive[] {
  if (live.run) return live.agents;
  const done = run.agents?.done ?? 0;
  return Array.from({ length: 8 }, (_, idx) => ({
    idx,
    state: done === 8 || idx < Math.min(done, 7) ? ('done' as const) : ('waiting' as const),
    startedAt: null,
    elapsedMs: null,
    redoCount: 0,
  }));
}

/** The receipt line a finished agent leaves behind, read from the spec it wrote. */
export function receiptFor(idx: number, run: RunDetail): string {
  const spec = run.spec;
  if (!spec) return `${AGENTS[idx].block} block written`;
  switch (idx) {
    case 0:
      return `“${spec.project.title}”${spec.project.logline ? ` — ${truncate(spec.project.logline, 64)}` : ''}`;
    case 1:
      return `${spec.shots?.length ?? 0} shots · ~${totalShotSeconds(spec)}s`;
    case 2:
      return `prompts written for ${(spec.shots ?? []).filter((s) => s.kling?.content_prompt).length} shots`;
    case 3:
      return `${(spec.shots ?? []).filter((s) => s.kling?.shot_size || s.kling?.camera_move).length} shots framed`;
    case 4:
      return `${spec.kling?.elements?.length ?? 0} element(s) pinned`;
    case 5:
      return `${spec.audio?.voice?.lines?.length ?? 0} voice line(s)`;
    case 6: {
      const jobs = spec.kling?.jobs ?? [];
      const parts = jobs.map((j) => `${j.job_id} ${jobSeconds(spec, j.job_id)}s`).join(' · ');
      return `${jobs.length} job(s)${parts ? ` · ${parts}` : ''}`;
    }
    case 7:
      return `Approved · pass ${run.agents?.qcCycles || 1}`;
    default:
      return '';
  }
}

function StateDot({ state }: { state: AgentLive['state'] }) {
  if (state === 'thinking') {
    return <span className="pulse-dot block h-4 w-4 rounded-full border-2 border-transparent bg-[var(--accent-soft)] p-0.5"><span className="block h-full w-full rounded-full bg-status-active" /></span>;
  }
  if (state === 'done') {
    return (
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--status-done-soft)] text-status-done">
        <Check size={10} strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (state === 'redo') {
    return (
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--status-warn-soft)] text-status-warn">
        <RotateCcw size={10} strokeWidth={2.5} aria-hidden />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--status-failed-soft)] text-status-failed">
        <X size={10} strokeWidth={3} aria-hidden />
      </span>
    );
  }
  return <span className="block h-4 w-4 rounded-full border-2 border-line-strong" />;
}

export function AgentRail({ run, live, collapsed = false }: {
  run: RunDetail;
  live: Pick<RunLive, 'run' | 'agents'>;
  collapsed?: boolean;
}) {
  const agents = agentStatesFor(run, live);
  const [open, setOpen] = useState(!collapsed);
  const { toast } = useToast();
  // retrying a failed PLAN re-runs the engine; a spec-in-hand failure re-enters via a revision.
  // Failures surface — a retry button that silently does nothing is worse than none.
  const retryAgent = async () => {
    try {
      if (run.planned) await api.revise(run.id, { feedback: 'retry from this agent' });
      else await api.replan(run.id);
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The retry could not start.' });
    }
  };

  // live elapsed tick while any agent is thinking
  const anyThinking = agents.some((a) => a.state === 'thinking');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyThinking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyThinking]);

  // sr-only announcement when an agent finishes
  const prevStates = useRef<string[]>(agents.map((a) => a.state));
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    agents.forEach((a, i) => {
      if (a.state === 'done' && prevStates.current[i] === 'thinking') {
        setAnnouncement(`${AGENTS[i].name} has finished.`);
      }
    });
    prevStates.current = agents.map((a) => a.state);
  });

  const maxCycle = Math.max(1, run.agents?.qcCycles ?? 0, ...agents.map((a) => a.cycle ?? 0));
  const redoIdxs = agents.filter((a) => a.state === 'redo' || a.redoCount > 0).map((a) => a.idx);
  const threadFrom = redoIdxs.length ? Math.min(...redoIdxs) : null;

  // honest banner lines for the two silent-looking states: a live revision (owners re-running,
  // minutes apart on slow LLMs) and a plan queued behind other work in the serial plan lane
  const revising = run.status === 'planning' && run.revising;
  const queued = run.status === 'planning' && !run.manifest?.activeJob && (run.queue?.position ?? 0) > 0;

  return (
    <section aria-label="Production plan" className="rounded-r3 border border-line bg-surface-1 p-4">
      <span aria-live="polite" className="sr-only">{announcement}</span>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-heading text-ink">Production plan</h3>
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'tnum inline-flex h-5 items-center rounded-full px-2 text-caption font-medium',
              maxCycle > 1 ? 'bg-[var(--status-warn-soft)] text-status-warn' : 'bg-surface-2 text-ink-muted',
            )}
          >
            Pass {maxCycle}
          </span>
          {revising && (
            <span className="inline-flex h-5 items-center rounded-full bg-[var(--accent-soft)] px-2 text-caption font-medium text-status-active">
              Revising — {revising.owners.map((i) => AGENTS[i]?.name ?? i).join(', ')}
            </span>
          )}
          {queued && (
            <span className="tnum inline-flex h-5 items-center rounded-full bg-surface-2 px-2 text-caption font-medium text-ink-muted">
              Queued — position {run.queue!.position} in the planning lane
            </span>
          )}
          {collapsed && (
            <button
              aria-label={open ? 'Collapse the agent list' : 'Show the 8 agents'}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="flex h-7 w-7 items-center justify-center rounded-r2 text-ink-muted hover:bg-surface-2"
            >
              {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </div>
      </div>

      {collapsed && !open ? (
        <p className="mt-2 text-dense text-ink-secondary">
          All 8 agents have finished — the plan was approved on pass {maxCycle}.
        </p>
      ) : (
        <div className="mt-3">
          {agents.map((a) => {
            const meta = AGENTS[a.idx];
            const Icon = ICONS[a.idx];
            const thinking = a.state === 'thinking';
            const liveElapsed = thinking && a.startedAt ? now - a.startedAt : a.elapsedMs;
            const inThread = threadFrom != null && a.idx >= threadFrom;
            return (
              <div
                key={a.idx}
                className={clsx('relative flex gap-3 px-1', thinking ? 'h-[72px] items-start pt-3' : 'h-11 items-center')}
              >
                {/* redo thread: 1px warn line in the gutter from QC (row 7) up to the reopened row */}
                {inThread && <span aria-hidden className="absolute bottom-0 left-[8.5px] top-0 w-px bg-status-warn opacity-50" />}
                <span className="relative z-10 shrink-0 bg-surface-1"><StateDot state={a.state} /></span>
                <span className="tnum w-3 shrink-0 font-mono text-caption text-ink-faint">{a.idx + 1}</span>
                <Icon size={16} className={clsx('shrink-0', a.state === 'waiting' ? 'text-ink-faint' : 'text-ink-muted')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className={clsx('shrink-0 text-label', a.state === 'waiting' ? 'text-ink-muted' : 'text-ink')}>{meta.name}</span>
                    {!thinking && (
                      <span className={clsx('min-w-0 truncate text-dense', a.state === 'waiting' ? 'text-ink-faint' : 'text-ink-secondary')}>
                        {a.state === 'waiting' && FUTURE[a.idx]}
                        {a.state === 'done' && receiptFor(a.idx, run)}
                        {a.state === 'redo' && 'reopened by QC — revising this block'}
                        {a.state === 'failed' && 'stopped before finishing'}
                      </span>
                    )}
                  </div>
                  {thinking && <p className="shimmer mt-1 truncate text-dense">{meta.doing}</p>}
                </div>
                {a.state === 'redo' && a.redoCount > 0 && (
                  <span className="tnum shrink-0 text-caption text-status-warn">×{a.redoCount}</span>
                )}
                {a.state === 'failed' && (
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => void retryAgent()}
                  >
                    Retry
                  </Button>
                )}
                {liveElapsed != null && a.state !== 'failed' && (
                  <span className={clsx('tnum shrink-0 text-caption text-ink-muted', thinking && 'pt-0.5')}>{elapsed(liveElapsed)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
