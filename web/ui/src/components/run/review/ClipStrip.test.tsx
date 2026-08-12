import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ContinuityEntry, JobView, ProductionSpec, RunDetail } from '../../../../../shared/api-types';
import { makeRun } from '../../../test/fixtures';
import { renderReview } from './test-helpers';
import { ClipStrip } from './ClipStrip';

const clip = (jobId: string): JobView => ({
  jobId, clip: `/abs/${jobId}.mp4`, clipExists: true,
  clipUrl: `/api/media/runs/x/renders/t1/${jobId}/clip.mp4`, error: null,
});

const entry = (jobId: string, index: number, over: Partial<ContinuityEntry> = {}): ContinuityEntry => ({
  jobId, index, take: 't1', continuesFromPrev: true, confidence: 'recorded',
  from: { take: 't1', job: `K${index}` }, reason: 'source-matches', ...over,
});

/** A three-segment cut: the fixture ships K1+K2, so K3 (and a shot for it) is added here. */
function threeSegmentRun(over: Partial<RunDetail> = {}): RunDetail {
  const run = makeRun('review');
  const spec = JSON.parse(JSON.stringify(run.spec)) as ProductionSpec;
  spec.shots.push({ shot_id: 'S4', beat: 'payoff', duration_s: 3, kling: { content_prompt: 'The door closes.' } });
  spec.kling.jobs.push({ job_id: 'K3', shots: ['S4'], elements: ['subject'] });
  run.spec = spec;
  run.latestRender!.jobs = [clip('K1'), clip('K2'), clip('K3')];
  return { ...run, ...over };
}

function renderStrip(run: RunDetail, onSeek = vi.fn()) {
  const jobs = run.latestRender!.jobs;
  const view = render(<ClipStrip run={run} jobs={jobs} takeCountFor={() => 1} isLatestCut onSeek={onSeek} />);
  return { ...view, onSeek };
}

describe('ClipStrip', () => {
  it('draws one badge per join: a recorded continuation joined, a replaced source broken', () => {
    const run = threeSegmentRun({
      // K2 continues from the K1 in this cut; K3 was joined to a K2 that has since been replaced.
      continuity: [
        entry('K2', 1),
        entry('K3', 2, { continuesFromPrev: false, reason: 'source-replaced' }),
      ],
    });
    renderStrip(run);

    expect(screen.getAllByText('joined')).toHaveLength(1);
    expect(screen.getAllByText('join broken')).toHaveLength(1);
    // three tiles, two joins — the head of the cut has nothing to join to
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('never wraps: the strip is one scrolling row, because a folded chain lies about the order', () => {
    renderStrip(threeSegmentRun({ continuity: [entry('K2', 1), entry('K3', 2)] }));
    const strip = screen.getByTestId('clip-strip');
    expect(strip.className).toContain('overflow-x-auto');
    expect(strip.className).not.toContain('flex-wrap');
    expect(strip.firstElementChild?.className).toContain('min-w-min');
    expect(strip.innerHTML).not.toContain('flex-wrap');
  });

  it('has exactly one shared explanation line, at a fixed height so nothing jumps', () => {
    renderStrip(threeSegmentRun({ continuity: [entry('K2', 1), entry('K3', 2)] }));
    const lines = screen.getAllByTestId('clip-strip-explanation');
    expect(lines).toHaveLength(1);
    expect(lines[0].className).toContain('h-4');
  });

  it('the shared line mirrors the hovered tile — both of its joins, in plain words', () => {
    renderStrip(threeSegmentRun({
      continuity: [entry('K2', 1), entry('K3', 2, { continuesFromPrev: false, reason: 'source-replaced' })],
    }));
    const line = screen.getByTestId('clip-strip-explanation');

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Play from K2' }));
    expect(line.textContent).toBe(
      "K2 starts on K1's last frame. K3 does not start on this cut's K2 — the clip it was joined to was replaced.",
    );

    fireEvent.mouseLeave(screen.getByRole('button', { name: 'Play from K2' }));
    // at rest it states the strip's own truth: the first join that is not whole
    expect(line.textContent).toContain('K3 does not start on this cut');
  });

  it('says so plainly when every join holds', () => {
    renderStrip(threeSegmentRun({ continuity: [entry('K2', 1), entry('K3', 2)] }));
    expect(screen.getByTestId('clip-strip-explanation')).toHaveTextContent(
      'Every clip starts on the last frame of the one before it.',
    );
  });

  it('a reconstructed run says the joins may be wrong, and never claims one is joined', () => {
    renderStrip(threeSegmentRun({
      continuity: [
        entry('K2', 1, { confidence: 'derived' }),
        entry('K3', 2, { confidence: 'derived' }),
      ],
    }));
    expect(screen.getByTestId('clip-strip-explanation')).toHaveTextContent('This run predates join tracking');
    expect(screen.getAllByText('join unknown')).toHaveLength(2);
    expect(screen.queryByText('joined')).not.toBeInTheDocument();
  });

  it('one segment has nothing to join', () => {
    const run = makeRun('review');
    run.latestRender!.jobs = [clip('K1')];
    run.continuity = [entry('K1', 0, { continuesFromPrev: false, from: null, reason: 'no-prev' })];
    renderStrip(run);
    expect(screen.getByTestId('clip-strip-explanation')).toHaveTextContent('One segment — nothing to join.');
    expect(screen.queryByText('join broken')).not.toBeInTheDocument();
  });

  it('clicking a tile seeks the master to that segment', () => {
    const { onSeek } = renderStrip(threeSegmentRun({ continuity: [entry('K2', 1), entry('K3', 2)] }));
    fireEvent.click(screen.getByRole('button', { name: 'Play from K3' }));
    expect(onSeek).toHaveBeenCalledWith(2);
  });

  it('drops to the small size from five segments on, so six clips still fit the column', () => {
    const run = threeSegmentRun();
    run.latestRender!.jobs = [clip('K1'), clip('K2'), clip('K3'), clip('K4'), clip('K5')];
    run.continuity = [entry('K2', 1), entry('K3', 2), entry('K4', 3), entry('K5', 4)];
    renderStrip(run);
    expect(screen.getByTestId('segment-thumb-K1').style.height).toBe('60px');
  });

  it('draws a connector per join and hides every one of them from assistive tech', () => {
    const { container } = renderStrip(threeSegmentRun({
      continuity: [entry('K2', 1), entry('K3', 2, { continuesFromPrev: false, reason: 'mode-none', from: null })],
    }));
    expect(container.querySelectorAll('[data-testid^="clip-joint-"]')).toHaveLength(2);
    expect(screen.getAllByTestId('clip-joint-linked')).toHaveLength(1);
    expect(screen.getAllByTestId('clip-joint-isolated')).toHaveLength(1);
    for (const c of container.querySelectorAll('[data-testid^="clip-joint-"]')) {
      expect(c).toHaveAttribute('aria-hidden');
    }
  });

  it('a join whose clips are still rendering promises nothing either way', () => {
    const run = threeSegmentRun({ status: 'rendering', continuity: null });
    run.latestRender!.jobs = [clip('K1'), { ...clip('K2'), clip: null, clipExists: false, clipUrl: null }, clip('K3')];
    renderStrip(run);
    expect(screen.getAllByText('rendering')).toHaveLength(1);
    expect(screen.getAllByTestId('clip-joint-pending')).toHaveLength(2);
    expect(screen.queryByText('joined')).not.toBeInTheDocument();
  });

  it('picking a segment reveals its actions, and Re-render opens the one paid dialog', async () => {
    const run = threeSegmentRun({ continuity: [entry('K2', 1), entry('K3', 2)] });
    renderReview(
      <ClipStrip run={run} jobs={run.latestRender!.jobs} takeCountFor={() => 1} isLatestCut onSeek={vi.fn()} />,
    );
    // Nothing is selected: no money affordance is on screen at all (spec D11).
    expect(screen.queryByRole('button', { name: /Re-render/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Play from K2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-render K2' }));
    // The price and the one-time paid confirm live on the dialog's PaidButton — the strip states none.
    expect(await screen.findByRole('dialog', { name: 'Re-render K2' })).toBeInTheDocument();
  });

  // U1 — one render at a time: while a render is in flight the strip keeps the prompt readable but
  // refuses to queue a second spend, and the disabled button itself says why.
  it('disables Re-render while the run is rendering, with the one-at-a-time reason', () => {
    const run = threeSegmentRun({ status: 'rendering', continuity: null });
    run.latestRender!.jobs = [clip('K1'), { ...clip('K2'), clip: null, clipExists: false, clipUrl: null }, clip('K3')];
    renderReview(
      <ClipStrip run={run} jobs={run.latestRender!.jobs} takeCountFor={() => 1} isLatestCut onSeek={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play from K1' }));
    const rerender = screen.getByRole('button', { name: 'Re-render K1' });
    expect(rerender).toBeDisabled();
    expect(rerender).toHaveAttribute('title', 'One render at a time — wait for the current one to finish.');
    // the free affordance stays live
    expect(screen.getByRole('button', { name: 'Prompt for K1' })).toBeEnabled();
  });

  // The re-render endpoint takes a job id and nothing else: it resolves both neighbours and the
  // composition it writes from the manifest's CURRENT clips, which are the latest cut's. Offered on
  // an older cut, confirming it would spend on rebuilding a composition that is not the master
  // playing above — so the strip withholds it and the button says which cut it would have changed.
  it('withholds Re-render while an older cut is on the stage, and says why', () => {
    const run = threeSegmentRun({ continuity: [entry('K2', 1), entry('K3', 2)] });
    renderReview(
      <ClipStrip run={run} jobs={run.latestRender!.jobs} takeCountFor={() => 1} isLatestCut={false} onSeek={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play from K2' }));
    const rerender = screen.getByRole('button', { name: 'Re-render K2' });
    expect(rerender).toBeDisabled();
    expect(rerender).toHaveAttribute(
      'title',
      'You’re watching an older cut. A re-render always rebuilds the latest one, so switch back to it first.',
    );
    // and no paid dialog can be reached from here
    fireEvent.click(rerender);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // reading stays free, exactly as it does mid-render
    expect(screen.getByRole('button', { name: 'Prompt for K2' })).toBeEnabled();
  });

  // No legend: the strip explains itself with the drawing and one sentence (Don't #9).
  it('carries no legend', () => {
    const { container } = renderStrip(threeSegmentRun({ continuity: [entry('K2', 1), entry('K3', 2)] }));
    expect(container.textContent).not.toMatch(/legend|key:/i);
  });
});
