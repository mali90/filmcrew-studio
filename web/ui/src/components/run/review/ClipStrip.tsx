// The continuity strip: the cut, left to right, with the JOIN drawn between the clips.
//
// The join is the object here, not the tile — the tile says what a clip is, the connector says
// whether it and its neighbour are one piece of film (spec D1). That is why the strip never wraps
// (spec D2, Don't #5): a chain folded onto a second line lies about which clip follows which. It
// scrolls instead, and it needs no legend — the drawing carries the meaning (Don't #9).
//
// Read-only by design in WS2-P2: clicking a tile seeks the master, nothing here spends money.
import { Fragment, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import type { ContinuityEntry, JobView, RunDetail } from '../../../../../shared/api-types';
import { jobSeconds, jointKindOf, jointSentence, type JointKind } from './lib';
import { SegmentTile, THUMB_HEIGHT, type TileSize } from './SegmentTile';
import type { SegmentClipState } from './ContinuityBadge';

/** Connector column width per size (spec D1) — narrow enough that six 16:9 tiles still fit at `sm`. */
const CONNECTOR_WIDTH: Record<TileSize, number> = { md: 20, sm: 14 };

/** What the connector draws — the joint verdict, or the live state of the clips it sits between. */
type ConnectorKind = JointKind | 'pending';

/**
 * The join, drawn (spec D4). Arrowheads point at the clip that had to obey: a forward link means the
 * right-hand clip starts on the left-hand one's last frame. Purely decorative — every connector is
 * aria-hidden, and the same fact reaches assistive tech as each tile's description.
 */
function Connector({ kind, size }: { kind: ConnectorKind; size: TileSize }) {
  const width = CONNECTOR_WIDTH[size];
  // The rule is drawn at the vertical centre of the thumb well: tile border + padding + half a thumb.
  const paddingTop = 9 + THUMB_HEIGHT[size] / 2 - 1;

  const body = kind === 'isolated'
    // a cut by design: no rule at all, just a divider at full thumb height
    ? <span className="w-px bg-line-strong" style={{ height: THUMB_HEIGHT[size], marginTop: -(THUMB_HEIGHT[size] / 2 - 1) }} />
    : kind === 'broken'
      // two stubs that do not meet, the right one nudged off the line — the misalignment IS the message
      ? (
        <span className="flex items-center">
          <span className="h-[2px] w-1.5 bg-status-warn" />
          <span className="w-1.5" />
          <span className="h-[2px] w-1.5 translate-y-[3px] bg-status-warn" />
        </span>
      )
      : kind === 'linked'
        ? (
          <span className="flex items-center">
            <span className="h-[2px] bg-status-done" style={{ width: width - 8 }} />
            <ChevronRight size={10} className="-ml-0.5 text-status-done" />
          </span>
        )
        : (
          // unknown (reconstructed) and pending (a neighbour still rendering) promise nothing
          <span
            className={clsx('w-full border-t-2', kind === 'pending' ? 'border-dotted border-status-pending' : 'border-dashed border-ink-faint')}
          />
        );

  return (
    <span
      aria-hidden
      data-testid={`clip-joint-${kind}`}
      className="flex shrink-0 items-start justify-center"
      style={{ width, paddingTop }}
    >
      {body}
    </span>
  );
}

const clipStateOf = (job: JobView, run: RunDetail): SegmentClipState =>
  (job.error ? 'failed' : !job.clipExists && run.status === 'rendering' ? 'rendering' : 'done');

export function ClipStrip({ run, jobs, takeCountFor, onSeek }: {
  run: RunDetail;
  jobs: JobView[];
  takeCountFor: (jobId: string) => number;
  onSeek: (index: number) => void;
}) {
  // The shared explanation line mirrors whichever tile is hovered or focused (spec D9) — one line
  // for the whole strip, so nothing pops up over the clips and nothing jumps as it changes.
  const [active, setActive] = useState<number | null>(null);

  const size: TileSize = jobs.length >= 5 ? 'sm' : 'md';
  const aspect = run.aspect ?? '9:16';

  // `continuity` is aligned 1:1 with the render's jobs, but a server that sent a shorter list (or
  // none) must not shift the facts onto the wrong clips — match by job id whenever ids are present.
  const entries = run.continuity ?? [];
  const byJobId = new Map(entries.filter((e) => e.jobId).map((e) => [e.jobId, e] as const));
  const entryFor = (job: JobView, i: number): ContinuityEntry | null =>
    (byJobId.size ? byJobId.get(job.jobId) ?? null : entries[i] ?? null);

  const states = jobs.map((job) => clipStateOf(job, run));
  const kinds = jobs.map((job, i) => (i === 0 ? null : jointKindOf(entryFor(job, i))));

  /** The sentence for one tile: how it joins backwards, and how the next clip joins to it. */
  const sentenceFor = (i: number) => {
    const parts: string[] = [];
    parts.push(i === 0
      ? `${jobs[0].jobId} opens the cut.`
      : jointSentence(jobs[i - 1].jobId, jobs[i].jobId, kinds[i]!));
    if (i < jobs.length - 1) parts.push(jointSentence(jobs[i].jobId, jobs[i + 1].jobId, kinds[i + 1]!));
    return parts.join(' ');
  };

  /** With nothing hovered, the line states the strip's own truth rather than sitting empty. */
  const restingLine = () => {
    if (jobs.length <= 1) return 'One segment — nothing to join.';
    const joints = kinds.slice(1) as JointKind[];
    if (joints.every((k) => k === 'unknown')) {
      return 'This run predates join tracking — the joins were read back from the files, so they may be wrong.';
    }
    const firstDoubt = joints.findIndex((k) => k !== 'linked');
    return firstDoubt === -1
      ? 'Every clip starts on the last frame of the one before it.'
      : jointSentence(jobs[firstDoubt].jobId, jobs[firstDoubt + 1].jobId, joints[firstDoubt]);
  };

  return (
    <div className="mt-5" aria-label="Clips in this cut">
      <div className="well flex justify-center overflow-x-auto" data-testid="clip-strip">
        <div className="flex min-w-min items-start">
          {jobs.map((job, i) => (
            <Fragment key={job.jobId}>
              {i > 0 && (
                <Connector
                  size={size}
                  kind={states[i] === 'done' && states[i - 1] === 'done' ? kinds[i]! : 'pending'}
                />
              )}
              <SegmentTile
                job={job}
                aspect={aspect}
                size={size}
                isHead={i === 0}
                seconds={jobSeconds(run.spec, job.jobId)}
                takeCount={takeCountFor(job.jobId)}
                entry={entryFor(job, i)}
                clipState={states[i]}
                capStart={kinds[i] === 'linked'}
                capEnd={i < jobs.length - 1 && kinds[i + 1] === 'linked'}
                description={sentenceFor(i)}
                onSeek={() => onSeek(i)}
                onHighlight={(on) => setActive(on ? i : (cur) => (cur === i ? null : cur))}
              />
            </Fragment>
          ))}
        </div>
      </div>
      {/* Fixed height: the line changes with the pointer, the layout beneath it never moves. */}
      <p className="mt-2 flex h-4 items-center justify-center text-caption text-ink-muted" data-testid="clip-strip-explanation">
        {active === null ? restingLine() : sentenceFor(active)}
      </p>
    </div>
  );
}
