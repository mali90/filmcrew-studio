import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server, http, HttpResponse } from '../../../test/msw';
import { makeRun, promptView } from '../../../test/fixtures';
import { renderReview, markPaidConfirmed, clearPaidState } from './test-helpers';
import { ReviewStage } from './ReviewStage';

// cutId is owned by the parent (Run.tsx) so the approve bar can finalize the previewed cut; this
// wrapper holds it for standalone stage tests exactly as the page does.
function Stage({ run }: { run: ReturnType<typeof makeRun> }) {
  const [cutId, setCutId] = useState<string | null>(null);
  return <ReviewStage run={run} cutId={cutId} setCutId={setCutId} />;
}

// jsdom media elements have no seekable currentTime — record what the player is asked to do.
let seekedTo: number | null = null;
beforeEach(() => {
  seekedTo = null;
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get: () => seekedTo ?? 0,
    set: (v: number) => { seekedTo = v; },
  });
});
afterEach(() => {
  delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).currentTime;
  clearPaidState();
});

describe('ReviewStage', () => {
  it('renders the master video with the cover poster and remounts when the master url changes', () => {
    const run = makeRun('review');
    const { rerender } = renderReview(<Stage run={run} />);
    const video = screen.getByTestId('master-video');
    expect(video).toHaveAttribute('src', '/api/media/out/ocean.mp4');
    expect(video).toHaveAttribute('poster', '/api/media/runs/x/renders/t1/cover.png');
    expect(video).toHaveAttribute('controls');

    const restitched = makeRun('review');
    restitched.latestRender!.masterUrl = '/api/media/out/ocean-v2.mp4';
    rerender(<Stage run={restitched} />);
    expect(screen.getByTestId('master-video')).toHaveAttribute('src', '/api/media/out/ocean-v2.mp4');
  });

  it('lists cuts newest first and swaps the src to /api/media/out/<basename> for an older cut', () => {
    const run = makeRun('review');
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/ocean v1.mp4', createdAt: '2026-07-04T09:00:00.000Z' },
      { id: 'c2', take: 't2', master: '/abs/out/ocean.mp4', createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    renderReview(<Stage run={run} />);

    fireEvent.click(screen.getByRole('button', { name: 'Switch cut' }));
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('c2');
    expect(options[0]).toHaveTextContent('latest');
    expect(options[1]).toHaveTextContent('c1');

    fireEvent.click(options[1]);
    expect(screen.getByTestId('master-video')).toHaveAttribute('src', '/api/media/out/ocean%20v1.mp4');
  });

  it('seeks the master to the sum of preceding jobs when a clip card is clicked', () => {
    const run = makeRun('review');
    renderReview(<Stage run={run} />);
    // K1 = S1(5s) + S2(4s) = 9s of preceding footage before K2
    fireEvent.click(screen.getByRole('button', { name: 'Play from K2' }));
    expect(seekedTo).toBe(9);
    fireEvent.click(screen.getByRole('button', { name: 'Play from K1' }));
    expect(seekedTo).toBe(0);
  });

  it('shows the probe banner with a priced full-render button that starts the full render', async () => {
    markPaidConfirmed();
    const run = makeRun('review');
    run.manifest!.takes = [{ id: 't1', mode: 'probe', revision: null, createdAt: '2026-07-04T10:00:00.000Z', estUsd: 1.1 }];

    let renderBody: unknown = null;
    server.use(
      http.post('/api/runs/:id/render', async ({ request }) => {
        renderBody = await request.json();
        return HttpResponse.json({ takeId: 't2', estUsd: 4.16 });
      }),
    );

    renderReview(<Stage run={run} />);
    expect(screen.getByText('Probe take — first job only, low cost.')).toBeInTheDocument();
    expect(screen.getByText(/Finishing is free — assembly already happened\./)).toBeInTheDocument();

    // the estimate arrives and prices the button
    await screen.findByLabelText('estimated cost $4.16');
    fireEvent.click(screen.getByRole('button', { name: /Full render/ }));
    await waitFor(() => expect(renderBody).toEqual({ mode: 'full' }));
  });

  it('take-count chips count every take that PRODUCED A CLIP — the full render included', () => {
    const run = makeRun('review');
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
      { id: 't3', mode: 'job', jobId: 'K2', revision: 'r1', createdAt: '2026-07-04T11:00:00.000Z' },
      { id: 't4', mode: 'job', jobId: 'K2', revision: 'r1', createdAt: '2026-07-04T12:00:00.000Z' },
    ];
    renderReview(<Stage run={run} />);
    // The 9:16 thumb is 47px wide, so the takes pill sits in the caption row in its compact form
    // and carries the words on its tooltip (spec D8).
    // K2 has THREE clips on disk: the full render's + two re-renders (it once said "2 takes")
    expect(screen.getByText('×3')).toHaveAttribute('title', '3 takes');
    // K1 has exactly one (the full render) — singular, quiet
    expect(screen.getByText('×1')).toHaveAttribute('title', '1 take');
  });

  it('a cascade take counts for the downstream jobs it re-rendered too', () => {
    const run = makeRun('review');
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
      { id: 't2', mode: 'job', jobId: 'K1', cascade: true, revision: null, createdAt: '2026-07-04T11:00:00.000Z' },
    ];
    renderReview(<Stage run={run} />);
    // K1 and K2 both got fresh clips from the cascade → 2 each
    expect(screen.getAllByText('×2')).toHaveLength(2);
  });

  // Spec D8/D22: an edited prompt is a fact about a segment, so it is visible ON the segment —
  // not only inside the sheet a user would have to open to find it.
  it('marks the tile of a segment whose prompt carries an edit', async () => {
    server.use(http.get('/api/runs/:id/prompts', ({ params }) => HttpResponse.json({
      runId: String(params.id),
      backend: 'kling-o3@fal',
      jobs: ['K1', 'K2'],
      prompts: [promptView('K1'), promptView('K2', { source: 'override', stale: true })],
      orphaned: [],
    })));
    renderReview(<Stage run={makeRun('review')} />);

    const k2 = screen.getByTestId('segment-tile-K2');
    expect(await within(k2).findByLabelText('prompt edited')).toBeInTheDocument();
    expect(within(k2).getByLabelText('prompt edit is stale')).toBeInTheDocument();
    // K1 is on the agents' words, so it wears nothing.
    expect(within(screen.getByTestId('segment-tile-K1')).queryByLabelText('prompt edited')).not.toBeInTheDocument();
  });

  // Spec D25 — a reopened run looks exactly like one that never left review, so the banner slot has
  // to say why the user is back and what is still on disk.
  it('a reopened run carries the re-entry notice in the banner slot, and never toasts it', () => {
    const run = makeRun('review');
    run.manifest!.approved = { cut: 'c1', final: '/abs/out/ocean-final.mp4', upscaled: false, at: '2026-07-04T10:05:00.000Z' };
    run.manifest!.reopenedAt = '2026-07-04T11:00:00.000Z';

    const { container } = renderReview(<Stage run={run} />);

    const notice = screen.getByTestId('reopened-notice');
    expect(notice).toHaveClass('border', 'border-line', 'bg-surface-1');
    const text = notice.textContent ?? '';
    expect(text).toMatch(/^Reopened for changes\./);
    expect(text).toMatch(/ocean-final\.mp4 is still on disk/);
    expect(text).toMatch(/approving again writes a new final and keeps the old one/);

    // the notice sits above the video, in the slot the probe banner uses — not over it
    expect(notice.compareDocumentPosition(screen.getByTestId('master-video')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Don't #11: this is standing state, not an event — a toast would expire exactly when needed
    expect(document.querySelector('[aria-live="polite"]')?.childElementCount ?? 0).toBe(0);
    expect(container.textContent).not.toMatch(/free/i);
  });

  it('a run that was delivered again since the reopen shows no notice', () => {
    const run = makeRun('review');
    run.manifest!.reopenedAt = '2026-07-04T11:00:00.000Z';
    run.manifest!.approved = { cut: 'c1', final: '/abs/out/ocean-final.mp4', upscaled: false, at: '2026-07-04T12:00:00.000Z' };
    renderReview(<Stage run={run} />);
    expect(screen.queryByTestId('reopened-notice')).not.toBeInTheDocument();
  });

  it('a run that was never delivered shows no notice', () => {
    renderReview(<Stage run={makeRun('review')} />);
    expect(screen.queryByTestId('reopened-notice')).not.toBeInTheDocument();
  });
});
