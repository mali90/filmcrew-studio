// One clip in the strip: a thumbnail well, a caption row, and the join chip beneath it.
//
// Sizing extends JobCards' THUMB_WIDTH convention — the HEIGHT is fixed and the width follows the
// run's aspect, so all six ratios work off one `aspectRatio` style with no new classes (spec D3).
// The consequence is that a 9:16 thumb at the small size is 34px wide, which cannot host a chip, so
// the overlays move down into the caption row whenever the thumb is narrower than OVERLAY_MIN_THUMB
// (spec D8) and the takes pill collapses to `×3`.
import { useId } from 'react';
import clsx from 'clsx';
import { AlertTriangle, PenLine } from 'lucide-react';
import type { Aspect, ContinuityEntry, JobView } from '../../../../../shared/api-types';
import { ContinuityBadge, type SegmentClipState } from './ContinuityBadge';

export type TileSize = 'md' | 'sm';

/** Thumb height per size: `md` at ≤4 segments, `sm` from 5 up (spec D3). */
export const THUMB_HEIGHT: Record<TileSize, number> = { md: 84, sm: 60 };

const ASPECT_RATIO: Record<Aspect, number> = {
  '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1,
  '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9,
};

/** Below this thumb width an overlay chip would cover the picture — it goes in the caption instead. */
export const OVERLAY_MIN_THUMB = 60;

/** The thumb's rendered width, in px: fixed height × the run's ratio. */
export const thumbWidth = (aspect: Aspect, size: TileSize) =>
  Math.round(THUMB_HEIGHT[size] * (ASPECT_RATIO[aspect] ?? ASPECT_RATIO['9:16']));

function Overlays({ compact, takeCount, promptEdited, promptStale }: {
  compact: boolean; takeCount: number; promptEdited: boolean; promptStale: boolean;
}) {
  const takeWords = `${takeCount} ${takeCount === 1 ? 'take' : 'takes'}`;
  return (
    <>
      {(promptEdited || promptStale) && (
        <span
          className={clsx('inline-flex h-4 items-center gap-0.5 rounded-full px-1', compact ? 'bg-surface-2' : 'bg-surface-3/90')}
          data-testid="tile-prompt-overlay"
        >
          {promptEdited && <PenLine size={10} className="text-accent" aria-label="prompt edited" />}
          {promptStale && <AlertTriangle size={10} className="text-status-warn" aria-label="prompt edit is stale" />}
        </span>
      )}
      {takeCount > 0 && (
        <span className="tnum rounded-full bg-surface-2 px-1.5 text-caption text-ink-muted" title={takeWords}>
          {compact ? `×${takeCount}` : takeWords}
        </span>
      )}
    </>
  );
}

export function SegmentTile({
  job, aspect, size, seconds, takeCount, entry, clipState = 'done', isHead = false,
  promptEdited = false, promptStale = false, capStart = false, capEnd = false, selected = false,
  description, onSeek, onHighlight,
}: {
  job: JobView;
  aspect: Aspect;
  size: TileSize;
  seconds: number;
  takeCount: number;
  /** This segment's continuity fact, or null when the server had none to give. */
  entry: ContinuityEntry | null;
  clipState?: SegmentClipState;
  isHead?: boolean;         // the first clip of the cut: it has no join to describe
  promptEdited?: boolean;   // this segment's prompt carries a saved edit (P4's overrides)
  promptStale?: boolean;
  capStart?: boolean;       // 3px cap on the thumb edge: this clip's start/end is pinned (spec D6)
  capEnd?: boolean;
  /** Picked in the strip — selection is what reveals this segment's actions, in DOM order (spec D11). */
  selected?: boolean;
  /** The join sentence(s) this tile is about — mirrored by the strip's shared line (spec D9). */
  description: string;
  onSeek: () => void;
  onHighlight: (on: boolean) => void;
}) {
  const descId = useId();
  const width = thumbWidth(aspect, size);
  const compact = width < OVERLAY_MIN_THUMB;
  const height = THUMB_HEIGHT[size];
  // Nothing joins to the head of the cut, so it wears no join chip — but a clip that is rendering or
  // failed says so wherever it sits.
  const showBadge = clipState !== 'done' || (!isHead && entry?.reason !== 'no-prev');

  return (
    <button
      type="button"
      // The accessible NAME stays the plain action; the join sentence is the description, so a
      // screen reader hears what the tile does before it hears how it joins.
      aria-label={`Play from ${job.jobId}`}
      aria-describedby={descId}
      onClick={onSeek}
      onMouseEnter={() => onHighlight(true)}
      onMouseLeave={() => onHighlight(false)}
      onFocus={() => onHighlight(true)}
      onBlur={() => onHighlight(false)}
      className={clsx(
        'flex min-w-[64px] shrink-0 flex-col items-center gap-1.5 rounded-r2 border p-2',
        selected ? 'border-accent bg-[var(--accent-soft)]' : 'border-line bg-surface-1 hover:border-line-strong',
      )}
      data-selected={selected || undefined}
      data-testid={`segment-tile-${job.jobId}`}
    >
      <span
        className="relative block overflow-hidden rounded-r1 bg-black"
        style={{ height, aspectRatio: aspect.replace(':', ' / ') }}
        data-testid={`segment-thumb-${job.jobId}`}
      >
        <video
          preload="metadata"
          muted
          src={job.clipUrl ?? undefined}
          className={clsx('h-full w-full object-cover', clipState === 'rendering' && 'shimmer bg-surface-2')}
          aria-hidden
        />
        {capStart && <span className="absolute inset-y-0 left-0 w-[3px] bg-status-done" aria-hidden />}
        {capEnd && <span className="absolute inset-y-0 right-0 w-[3px] bg-status-done" aria-hidden />}
        {!compact && (
          <span className="absolute right-1 top-1 flex items-center gap-1">
            <Overlays compact={false} takeCount={takeCount} promptEdited={promptEdited} promptStale={promptStale} />
          </span>
        )}
      </span>

      <span className="flex items-center gap-1.5">
        <span className="font-mono text-caption text-ink-secondary">{job.jobId}</span>
        <span className="tnum text-caption text-ink-muted">{seconds}s</span>
        {compact && <Overlays compact takeCount={takeCount} promptEdited={promptEdited} promptStale={promptStale} />}
      </span>

      {showBadge && <ContinuityBadge entry={entry} clipState={clipState} />}
      <span id={descId} className="sr-only">{description}</span>
    </button>
  );
}
