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
});
