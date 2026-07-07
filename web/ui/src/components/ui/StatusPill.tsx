// Exactly five status semantics exist in the whole app — no other colored badges.
import clsx from 'clsx';
import type { RunStatus } from '../../../../shared/api-types';
import { statusLabel } from '../../lib/format';

type Semantic = 'pending' | 'active' | 'done' | 'failed' | 'warn';

const semanticOf: Record<RunStatus, Semantic> = {
  planning: 'active',
  'plan-ready': 'pending',
  rendering: 'active',
  attention: 'warn',
  review: 'warn',
  complete: 'done',
};

const classFor: Record<Semantic, string> = {
  pending: 'text-ink-muted bg-surface-2',
  active: 'text-status-active bg-[var(--accent-soft)]',
  done: 'text-status-done bg-[var(--status-done-soft)]',
  failed: 'text-status-failed bg-[var(--status-failed-soft)]',
  warn: 'text-status-warn bg-[var(--status-warn-soft)]',
};

export function StatusPill({ status, pulse = false, className }: { status: RunStatus; pulse?: boolean; className?: string }) {
  const semantic = semanticOf[status];
  return (
    <span className={clsx('inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-caption font-medium', classFor[semantic], className)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full bg-current', pulse && status === 'rendering' && 'pulse-dot')} aria-hidden />
      {statusLabel[status]}
    </span>
  );
}

/** The review flow's special case: "review" reads as warn (needs a human), "attention" as failed-ish. */
export function semanticFor(status: RunStatus): Semantic {
  return semanticOf[status];
}
