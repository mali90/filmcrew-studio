// The one chip that answers "is this clip and the one before it a single piece of film?".
//
// It sits in the caption row, never over the thumb — a 9:16 thumb at the small size is 34px wide and
// cannot host a chip (spec D7). The word comes from `jointFor`, which refuses to say "joined" about
// a continuation that was reconstructed rather than recorded: a derived answer reads "join unknown".
import clsx from 'clsx';
import { Clock, HelpCircle, Link2, Scissors, Unlink, X } from 'lucide-react';
import type { ContinuityEntry } from '../../../../../shared/api-types';
import { PILL_CLASS } from '../JobCards';
import { jointFor, jointKindOf, type JointTone } from './lib';

/** What this segment's clip is doing right now — it outranks the join, which is not yet knowable.
 *  `queued` is the cascade's own state: several segments are replaced in one take, so the clips
 *  behind the one on the wire exist neither as the old footage nor as the new. */
export type SegmentClipState = 'done' | 'queued' | 'rendering' | 'failed';

const ICON = { Link2, Unlink, Scissors, HelpCircle };

// Three status semantics only: done = whole, warn = broken, pending = unknowable. "By design" and
// "we don't know" take --line-strong / --ink-faint instead of inventing a sixth colour (spec D5).
const TONE: Record<JointTone | 'active' | 'failed', string> = {
  done: 'bg-[var(--status-done-soft)] text-status-done',
  warn: 'bg-[var(--status-warn-soft)] text-status-warn',
  muted: 'bg-surface-2 text-ink-muted',
  faint: 'bg-surface-2 text-ink-faint',
  active: 'bg-[var(--accent-soft)] text-status-active',
  failed: 'bg-[var(--status-failed-soft)] text-status-failed',
};

export function ContinuityBadge({ entry, clipState = 'done' }: {
  /** The server's continuity fact for this segment; null when the run predates the wire field. */
  entry: ContinuityEntry | null;
  clipState?: SegmentClipState;
}) {
  if (clipState === 'rendering') {
    return (
      <span className={clsx(PILL_CLASS, 'gap-1.5', TONE.active)}>
        <span className="sweep h-[3px] w-6" role="presentation" />
        rendering
      </span>
    );
  }
  if (clipState === 'queued') {
    // No sweep: that belongs to the clip on the wire. The join is not described at all — the clip
    // this tile will hold has not been rendered yet, and the one it replaces is already spoken for.
    return (
      <span className={clsx(PILL_CLASS, 'gap-1', TONE.muted)}>
        <Clock size={11} aria-hidden />
        queued
      </span>
    );
  }
  if (clipState === 'failed') {
    return (
      <span className={clsx(PILL_CLASS, 'gap-1', TONE.failed)}>
        <X size={11} aria-hidden />
        failed
      </span>
    );
  }

  const kind = jointKindOf(entry);
  const { label, icon, tone } = jointFor({ kind, confidence: entry?.confidence ?? 'derived' });
  const Icon = ICON[icon];
  return (
    <span className={clsx(PILL_CLASS, 'gap-1', TONE[tone])}>
      <Icon size={11} aria-hidden />
      {label}
    </span>
  );
}
