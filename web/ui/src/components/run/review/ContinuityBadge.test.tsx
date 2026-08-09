import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ContinuityEntry } from '../../../../../shared/api-types';
import { ContinuityBadge } from './ContinuityBadge';

const entry = (over: Partial<ContinuityEntry> = {}): ContinuityEntry => ({
  jobId: 'K2',
  index: 1,
  take: 't1',
  continuesFromPrev: true,
  confidence: 'recorded',
  from: { take: 't1', job: 'K1' },
  reason: 'source-matches',
  ...over,
});

describe('ContinuityBadge', () => {
  it('says "joined" only for a continuation the renderer actually recorded', () => {
    render(<ContinuityBadge entry={entry()} />);
    expect(screen.getByText('joined')).toBeInTheDocument();
  });

  it('says "join broken" when the clip its opening frame came off is no longer in the cut', () => {
    render(<ContinuityBadge entry={entry({ continuesFromPrev: false, reason: 'source-replaced' })} />);
    expect(screen.getByText('join broken')).toBeInTheDocument();
    expect(screen.queryByText('joined')).not.toBeInTheDocument();
  });

  it('says "scene cut" when no boundary was applied at all — that is a design, not a fault', () => {
    render(<ContinuityBadge entry={entry({ continuesFromPrev: false, reason: 'mode-none', from: null })} />);
    expect(screen.getByText('scene cut')).toBeInTheDocument();
  });

  it('says "join unknown" when the segment or its neighbour is not in the run', () => {
    render(<ContinuityBadge entry={entry({ continuesFromPrev: false, confidence: 'derived', reason: 'unknown-segment', from: null })} />);
    expect(screen.getByText('join unknown')).toBeInTheDocument();
  });

  // The honesty rule: a DERIVED answer was reconstructed from take history, not observed. It may
  // look like a continuation and still be wrong, so it never gets the confident word or the tone.
  it('a derived continuation reads "join unknown", never "joined"', () => {
    render(<ContinuityBadge entry={entry({ confidence: 'derived', reason: 'source-matches' })} />);
    expect(screen.getByText('join unknown')).toBeInTheDocument();
    expect(screen.queryByText('joined')).not.toBeInTheDocument();
    expect(screen.getByText('join unknown').className).not.toContain('status-done');
  });

  it('a missing continuity fact degrades to "join unknown" rather than an empty chip', () => {
    render(<ContinuityBadge entry={null} />);
    expect(screen.getByText('join unknown')).toBeInTheDocument();
  });

  it('a rendering clip shows the indeterminate sweep, never a percentage', () => {
    const { container } = render(<ContinuityBadge entry={null} clipState="rendering" />);
    expect(screen.getByText('rendering')).toBeInTheDocument();
    expect(container.querySelector('.sweep')).not.toBeNull();
    expect(screen.queryByText('join unknown')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('a failed clip says so instead of guessing at its join', () => {
    render(<ContinuityBadge entry={entry()} clipState="failed" />);
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.queryByText('joined')).not.toBeInTheDocument();
  });

  it('reuses the shared pill shape so a join chip and a job chip are the same object', () => {
    render(<ContinuityBadge entry={entry()} />);
    expect(screen.getByText('joined').className).toContain('inline-flex h-5 items-center rounded-full px-2 text-caption font-medium');
  });
});
