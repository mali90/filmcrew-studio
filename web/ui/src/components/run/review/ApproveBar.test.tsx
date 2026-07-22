import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server, http, HttpResponse } from '../../../test/msw';
import { makeRun } from '../../../test/fixtures';
import { renderReview, markPaidConfirmed, clearPaidState } from './test-helpers';
import { ApproveBar } from './ApproveBar';

afterEach(clearPaidState);

function captureApprove() {
  const captured: { body: unknown } = { body: null };
  server.use(
    http.post('/api/runs/:id/approve', async ({ request }) => {
      captured.body = await request.json();
      return HttpResponse.json({ final: '/abs/out/ocean-final.mp4' });
    }),
  );
  return captured;
}

describe('ApproveBar', () => {
  it('an already-1080p master disables the paid upscale with the reason stated', async () => {
    const run = makeRun('review');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/x.mp4', shortSide: 1080, createdAt: 'now' }];
    renderReview(<ApproveBar run={run} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/already 1080p — there's nothing to upscale/i)).toBeInTheDocument();
    // no price is advertised for a no-op
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    // approve itself stays available (it is free)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('approves without upscale — free, no cost tag on the button', async () => {
    const captured = captureApprove();
    renderReview(<ApproveBar run={makeRun('review')} />);

    const approve = screen.getByRole('button', { name: /^Approve$/ });
    expect(approve).toBeInTheDocument();
    expect(screen.queryByLabelText(/estimated cost/)).not.toBeInTheDocument();
    expect(screen.getByText(/Approving is free\./)).toBeInTheDocument();

    fireEvent.click(approve);
    await waitFor(() => expect(captured.body).toEqual({ upscale: false }));
  });

  it('approves with upscale on — button reads Approve & upscale and carries the Topaz price', async () => {
    markPaidConfirmed();
    const captured = captureApprove();
    renderReview(<ApproveBar run={makeRun('review')} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /Upscale to ~1080p with Topaz/ }));
    const approve = await screen.findByRole('button', { name: /Approve & upscale/ });
    await screen.findByLabelText('estimated cost $4.16');

    fireEvent.click(approve);
    await waitFor(() => expect(captured.body).toEqual({ upscale: true }));
  });

  it('finalizes the SELECTED cut — the previewed cut id rides the approve payload', async () => {
    const captured = captureApprove();
    const run = makeRun('review');
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/ocean-t1.mp4', shortSide: 496, createdAt: '2026-07-04T09:00:00.000Z' },
      { id: 'c2', take: 't2', master: '/abs/out/ocean.mp4', shortSide: 496, createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    renderReview(<ApproveBar run={run} cutId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(captured.body).toEqual({ upscale: false, cut: 'c1' }));
  });

  it('the already-HD guard follows the SELECTED cut, not just the latest', () => {
    const run = makeRun('review');
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/ocean-t1.mp4', shortSide: 496, createdAt: '2026-07-04T09:00:00.000Z' },
      { id: 'c2', take: 't2', master: '/abs/out/ocean.mp4', shortSide: 1080, createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    // selecting the SD cut c1 must re-enable the upscale even though the latest cut c2 is already HD
    renderReview(<ApproveBar run={run} cutId="c1" />);
    expect(screen.getByRole('checkbox')).toBeEnabled();
    expect(screen.queryByText(/nothing to upscale/i)).not.toBeInTheDocument();
  });

  it('switching to an already-HD cut cancels a staged upscale — no paid "& upscale"', async () => {
    const captured = captureApprove();
    const run = makeRun('review');
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/sd.mp4', shortSide: 496, createdAt: '2026-07-04T09:00:00.000Z' },
      { id: 'c2', take: 't2', master: '/abs/out/hd.mp4', shortSide: 1080, createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    const { rerender } = renderReview(<ApproveBar run={run} cutId="c1" />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Upscale to ~1080p with Topaz/ })); // stage upscale on the SD cut

    rerender(<ApproveBar run={run} cutId="c2" />); // switch preview to the already-HD cut
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ })); // plain, free Approve — not "& upscale"
    await waitFor(() => expect(captured.body).toEqual({ upscale: false, cut: 'c2' }));
  });

  it('prices the SELECTED cut — the estimate request carries its cut id', async () => {
    let estimateSearch = '';
    server.use(
      http.get('/api/runs/:id/estimate', ({ request }) => {
        estimateSearch = new URL(request.url).search;
        return HttpResponse.json({ perJob: [], totalUsd: 1.5, currency: 'USD', label: 'estimate' });
      }),
    );
    const run = makeRun('review');
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/a.mp4', shortSide: 496, createdAt: '2026-07-04T09:00:00.000Z' },
      { id: 'c2', take: 't2', master: '/abs/out/b.mp4', shortSide: 496, createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    renderReview(<ApproveBar run={run} cutId="c1" />);
    await waitFor(() => expect(estimateSearch).toContain('cut=c1'));
  });
});
