import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server, http, HttpResponse } from '../../../test/msw';
import { makeRun } from '../../../test/fixtures';
import { renderReview, markPaidConfirmed, clearPaidState } from './test-helpers';
import { ApproveBar } from './ApproveBar';

afterEach(clearPaidState);

/** A delivered run the user reopened: `approved` and its file survive, `reopenedAt` is newer. */
function reopenedRun() {
  const run = makeRun('review');
  run.manifest!.approved = { cut: 'c1', final: '/abs/out/ocean-final.mp4', upscaled: false, at: '2026-07-04T10:05:00.000Z' };
  run.manifest!.reopenedAt = '2026-07-04T11:00:00.000Z';
  run.manifest!.finals = [{ id: 'final-1', cut: 'c1', final: '/abs/out/ocean-final.mp4', upscaled: false, at: '2026-07-04T10:05:00.000Z' }];
  return run;
}

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
  // ── Topaz on a provider that publishes no rate ────────────────────────────
  // The upscale runs wherever the run rendered. Both providers we ship price it, so this drives the
  // no-rate path from a SYNTHETIC vendor rather than naming a real one — the component's job is to
  // react to the SHAPE of an unpriced estimate, not to any vendor's pricing page. Approving with
  // upscale must still be possible — with the caution in prose instead of a fabricated figure.
  it('an unpriced upscale stays approvable and says so in words, never in dollars', async () => {
    const captured = captureApprove();
    server.use(http.get('/api/runs/:id/estimate', () => HttpResponse.json({
      perJob: [{ jobId: 'K1', seconds: 9, usd: null }],
      totalUsd: null,
      currency: 'USD',
      label: 'estimate',
      unknownPrice: { provider: 'examplevendor', hint: 'examplevendor does not publish a per-second rate — check examplevendor.invalid/models/topaz/pricing.' },
    })));
    markPaidConfirmed();
    renderReview(<ApproveBar run={makeRun('review')} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /upscale/i }));
    const approve = await screen.findByRole('button', { name: /Approve & upscale/ });
    await waitFor(() => expect(approve).toBeEnabled());

    const note = await screen.findByText(/price not set/i);
    expect(note.parentElement?.textContent ?? '').toMatch(/costs money/i);
    expect(note.parentElement?.textContent ?? '').toMatch(/examplevendor\.invalid/i);
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();   // no figure anywhere on the card
    expect(screen.queryByText(/≈—/)).not.toBeInTheDocument();     // and no em-dash masquerading as one

    fireEvent.click(approve);
    await waitFor(() => expect(captured.body).toEqual({ upscale: true }));
  });

  it('an already-1080p master disables the paid upscale with the reason stated', async () => {
    const run = makeRun('review');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/x.mp4', shortSide: 1080, createdAt: 'now' }];
    renderReview(<ApproveBar run={run} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeDisabled();
    // The threshold and label follow the estimate's delivered target (default ~1080p when the
    // endpoint reports none) — a 4k target would keep this same cut upscalable.
    expect(screen.getByText(/already 1080p — at or above the 1080p target/i)).toBeInTheDocument();
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

    rerender(<ApproveBar run={run} cutId="c2" />); // switch preview to the already-HD cut (the latest)
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ })); // plain, free Approve — not "& upscale"
    // c2 is the latest cut ⇒ the implicit target (no cut id), matching what the stage previews
    await waitFor(() => expect(captured.body).toEqual({ upscale: false }));
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

  it('selecting the LATEST cut submits the implicit target — matches what the stage previews', async () => {
    const captured = captureApprove();
    const run = makeRun('review');
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/a.mp4', shortSide: 496, createdAt: '2026-07-04T09:00:00.000Z' },
      { id: 'c2', take: 't2', master: '/abs/out/b.mp4', shortSide: 496, createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    renderReview(<ApproveBar run={run} cutId="c2" />); // the newest cut, which ReviewStage previews as latestRender
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(captured.body).toEqual({ upscale: false })); // no cut id — the implicit latest, not { cut: 'c2' }
  });

  it('an older cut without its own shortSide does not inherit the latest render’s HD dimension', () => {
    const run = makeRun('review');
    run.latestRender!.masterShortSide = 1080; // the LATEST render is already HD
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/old.mp4', createdAt: '2026-07-04T09:00:00.000Z' }, // no shortSide recorded
      { id: 'c2', take: 't2', master: '/abs/out/new.mp4', shortSide: 1080, createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    // selecting the older c1 (unknown resolution) must still OFFER the upscale, not borrow c2/latest HD
    renderReview(<ApproveBar run={run} cutId="c1" />);
    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  it('a recovery run with an HD master but no cut record still disables the paid upscale', () => {
    const run = makeRun('review');
    run.manifest!.cuts = []; // master exists on latestRender, but afterDone never appended a cut
    run.latestRender!.masterShortSide = 1080;
    // no explicit cut ⇒ "latest render" selection, so the HD render metadata still guards against a paid no-op
    renderReview(<ApproveBar run={run} />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  // ── After a reopen (WS2-P6, spec D26) ─────────────────────────────────────
  // The same button now delivers a SECOND time. "Replace" is only an honest word because replacing
  // costs nothing and deletes nothing, so the caption has to carry both halves of that.
  it('reads "Replace final" once the run has been reopened, and names the file that stays', () => {
    renderReview(<ApproveBar run={reopenedRun()} />);

    expect(screen.getByRole('button', { name: /^Replace final$/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Approve$/ })).not.toBeInTheDocument();

    const caption = screen.getByText(/This writes a new final/).textContent ?? '';
    expect(caption).toMatch(/Approving is free\./);          // true: a manifest write, no provider call
    expect(caption).toMatch(/ocean-final\.mp4 stays on disk/); // and nothing is deleted
  });

  it('the plain replace is not a paid button; only the "& upscale" variant is', async () => {
    markPaidConfirmed();
    const { rerender } = renderReview(<ApproveBar run={reopenedRun()} />);

    // plain: no CostTag, no price, nothing that reads as a charge
    expect(screen.queryByLabelText(/estimated cost/)).not.toBeInTheDocument();
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /Upscale to ~1080p with Topaz/ }));
    expect(await screen.findByRole('button', { name: /Replace final & upscale/ })).toBeInTheDocument();
    // the Topaz tail is real spend and says its price on the button
    await screen.findByLabelText('estimated cost $4.16');
    // and the free claim is dropped the moment money is involved
    const caption = screen.getByText(/This writes a new final/).textContent ?? '';
    expect(caption).not.toMatch(/free/i);
    expect(caption).toMatch(/ocean-final\.mp4 stays on disk/);

    // a run delivered again since the reopen is no longer "replacing" anything
    const delivered = reopenedRun();
    delivered.manifest!.approved!.at = '2026-07-04T12:00:00.000Z'; // newer than reopenedAt
    rerender(<ApproveBar run={delivered} />);
    expect(screen.getByRole('button', { name: /^Approve & upscale/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replace final/ })).not.toBeInTheDocument();
  });

  it('replacing the final submits the same approve payload as a first approval', async () => {
    const captured = captureApprove();
    renderReview(<ApproveBar run={reopenedRun()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Replace final$/ }));
    await waitFor(() => expect(captured.body).toEqual({ upscale: false }));
  });
});
