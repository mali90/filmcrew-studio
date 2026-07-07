// The run's spine: Plan · Render · Review · Deliver. Sticky under the shell header, it always
// answers "where are we?" — a done node is a shortcut back to its section, never a navigation.
import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import clsx from 'clsx';
import type { Phase, RunDetail } from '../../../../shared/api-types';
import type { AgentLive } from '../../api/run-events';
import { elapsed } from '../../lib/format';

const PHASES: { key: Phase; label: string }[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'render', label: 'Render' },
  { key: 'review', label: 'Review' },
  { key: 'deliver', label: 'Deliver' },
];

type NodeState = 'done' | 'active' | 'failed' | 'waiting';

export function PhaseStrip({ run, agents, activeKind }: {
  run: RunDetail;
  agents: AgentLive[];
  activeKind: string | null;
}) {
  const currentIdx = run.status === 'complete' ? PHASES.length : PHASES.findIndex((p) => p.key === run.phase);

  // ticking elapsed for the render phase (from the persisted active job)
  const startedAt = run.manifest?.activeJob?.startedAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || run.status !== 'rendering') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt, run.status]);

  const agentsDone = Math.max(run.agents?.done ?? 0, agents.filter((a) => a.state === 'done').length);
  const jobs = run.latestRender?.jobs ?? [];
  const jobsDone = jobs.filter((j) => j.clipExists).length;

  const stateOf = (i: number): NodeState => {
    if (i < currentIdx) return 'done';
    if (i === currentIdx) return run.status === 'attention' ? 'failed' : 'active';
    return 'waiting';
  };

  const subFor = (p: Phase): string | null => {
    if (p === 'plan') return `${agentsDone}/8`;
    if (p === 'render' && jobs.length) {
      const t = startedAt ? ` · ${elapsed(now - new Date(startedAt).getTime())}` : '';
      return `job ${jobsDone}/${jobs.length}${t}`;
    }
    return null;
  };

  return (
    <nav
      aria-label="Run phases"
      className="sticky top-14 z-30 -mx-6 h-12 border-b border-line bg-surface-0/90 px-6 backdrop-blur"
    >
      <div className="mx-auto flex h-full max-w-[1280px] items-center">
        {PHASES.map((p, i) => {
          const state = stateOf(i);
          const sub = state === 'active' ? subFor(p.key) : null;
          const node = (
            <>
              <span
                className={clsx(
                  'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full',
                  state === 'done' && 'bg-[var(--status-done-soft)] text-status-done',
                  state === 'active' && 'ring-2 ring-accent',
                  state === 'failed' && 'bg-[var(--status-failed-soft)] text-status-failed',
                  state === 'waiting' && 'border-2 border-line-strong',
                )}
                aria-hidden
              >
                {state === 'done' && <Check size={12} strokeWidth={3} />}
                {state === 'failed' && <X size={12} strokeWidth={3} />}
                {state === 'active' && (
                  <span className={clsx('h-2 w-2 rounded-full bg-accent', activeKind && 'pulse-dot')} />
                )}
              </span>
              <span className="ml-2 flex flex-col items-start leading-none">
                <span className={clsx('text-label', state === 'active' || state === 'failed' ? 'text-ink' : 'text-ink-muted')}>
                  {p.label}
                </span>
                {sub && <span className="tnum mt-0.5 text-caption text-ink-muted">{sub}</span>}
              </span>
            </>
          );
          return (
            <div key={p.key} className={clsx('flex items-center', i > 0 && 'flex-1')}>
              {i > 0 && (
                <span
                  aria-hidden
                  className={clsx('mx-3 h-0.5 min-w-6 flex-1 rounded-full', i <= currentIdx ? 'bg-accent-strong' : 'bg-line')}
                />
              )}
              {/* a done node is a shortcut ONLY when its section is actually in the current
                  layout — the page renders one stage at a time, so most shortcuts have no target */}
              {state === 'done' && document.getElementById(`section-${p.key}`) ? (
                <button
                  className="flex items-center rounded-r2 px-1 py-1 hover:bg-surface-2"
                  aria-label={`Scroll to the ${p.label} section`}
                  onClick={() => document.getElementById(`section-${p.key}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
                >
                  {node}
                </button>
              ) : (
                <div className="flex items-center px-1 py-1">{node}</div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
