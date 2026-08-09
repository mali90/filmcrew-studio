import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ContinuityEntry, JobView } from '../../../../../shared/api-types';
import { SegmentTile, thumbWidth, OVERLAY_MIN_THUMB } from './SegmentTile';

const JOB: JobView = {
  jobId: 'K2', clip: '/abs/clip2.mp4', clipExists: true,
  clipUrl: '/api/media/runs/x/renders/t1/K2/clip.mp4', error: null,
};

const ENTRY: ContinuityEntry = {
  jobId: 'K2', index: 1, take: 't1', continuesFromPrev: true,
  confidence: 'recorded', from: { take: 't1', job: 'K1' }, reason: 'source-matches',
};

function renderTile(over: Partial<Parameters<typeof SegmentTile>[0]> = {}) {
  const props = {
    job: JOB, aspect: '16:9' as const, size: 'md' as const, seconds: 4, takeCount: 3,
    entry: ENTRY, description: "K2 starts on K1's last frame.",
    onSeek: vi.fn(), onHighlight: vi.fn(),
    ...over,
  };
  return { ...render(<SegmentTile {...props} />), props };
}

describe('SegmentTile', () => {
  it('keeps the plain action as its accessible name and the join as its description', () => {
    renderTile();
    const tile = screen.getByRole('button', { name: 'Play from K2' });
    const describedBy = tile.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("K2 starts on K1's last frame.");
  });

  it('seeks on click and mirrors hover/focus back to the strip', () => {
    const { props } = renderTile();
    const tile = screen.getByRole('button', { name: 'Play from K2' });
    fireEvent.click(tile);
    expect(props.onSeek).toHaveBeenCalledTimes(1);
    fireEvent.mouseEnter(tile);
    expect(props.onHighlight).toHaveBeenLastCalledWith(true);
    fireEvent.mouseLeave(tile);
    expect(props.onHighlight).toHaveBeenLastCalledWith(false);
  });

  // Fixed height, aspect-derived width — the whole reason the six ratios need no new classes.
  it('derives the thumb from the run aspect: fixed height, ratio width', () => {
    expect(thumbWidth('16:9', 'md')).toBe(149);
    expect(thumbWidth('1:1', 'md')).toBe(84);
    expect(thumbWidth('9:16', 'md')).toBe(47);
    expect(thumbWidth('9:16', 'sm')).toBe(34);
    expect(thumbWidth('21:9', 'sm')).toBe(140);
    renderTile({ aspect: '21:9' });
    const thumb = screen.getByTestId('segment-thumb-K2');
    expect(thumb.style.height).toBe('84px');
    expect(thumb.style.aspectRatio).toBe('21 / 9');
  });

  it('overlays sit inside the thumb when there is room for them (md, 16:9 = 149px)', () => {
    renderTile({ promptEdited: true, promptStale: true });
    const thumb = screen.getByTestId('segment-thumb-K2');
    expect(thumb).toContainElement(screen.getByTestId('tile-prompt-overlay'));
    // wide enough for the words, so the takes count is not abbreviated
    expect(thumb).toContainElement(screen.getByText('3 takes'));
    expect(screen.queryByText('×3')).not.toBeInTheDocument();
  });

  it('moves the overlays into the caption row on a thumb too narrow to host them (sm, 9:16 = 34px)', () => {
    expect(thumbWidth('9:16', 'sm')).toBeLessThan(OVERLAY_MIN_THUMB);
    renderTile({ aspect: '9:16', size: 'sm', promptEdited: true, promptStale: true });
    const thumb = screen.getByTestId('segment-thumb-K2');
    const overlay = screen.getByTestId('tile-prompt-overlay');
    expect(thumb).not.toContainElement(overlay);
    expect(screen.getByTestId('segment-tile-K2')).toContainElement(overlay);
    // and the takes pill collapses, keeping the words on its tooltip
    const takes = screen.getByText('×3');
    expect(thumb).not.toContainElement(takes);
    expect(takes).toHaveAttribute('title', '3 takes');
  });

  it('the pen and the warning are separate marks — an unedited prompt shows neither', () => {
    const { unmount } = renderTile({ promptEdited: false, promptStale: false });
    expect(screen.queryByTestId('tile-prompt-overlay')).not.toBeInTheDocument();
    unmount();

    renderTile({ promptEdited: true });
    expect(screen.getByLabelText('prompt edited')).toBeInTheDocument();
    expect(screen.queryByLabelText('prompt edit is stale')).not.toBeInTheDocument();
  });

  it('the head of the cut wears no join chip — there is nothing before it to join to', () => {
    renderTile({ isHead: true, entry: { ...ENTRY, jobId: 'K1', index: 0, continuesFromPrev: false, from: null, reason: 'no-prev' } });
    expect(screen.queryByText('joined')).not.toBeInTheDocument();
    expect(screen.queryByText('join broken')).not.toBeInTheDocument();
    expect(screen.queryByText('join unknown')).not.toBeInTheDocument();
  });

  it('but a head clip that is still rendering says so', () => {
    renderTile({ isHead: true, entry: null, clipState: 'rendering' });
    expect(screen.getByText('rendering')).toBeInTheDocument();
  });
});
