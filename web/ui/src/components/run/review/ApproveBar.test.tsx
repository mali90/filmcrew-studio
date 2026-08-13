import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server, http, HttpResponse } from '../../../test/msw';
import { makeRun, SETUP_COMPLETE } from '../../../test/fixtures';
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
    expect(screen.queryByText(/· \$/)).not.toBeInTheDocument();   // the provider options invent none either

    fireEvent.click(approve);
    // the pick still rides the payload — the spend is real even when the figure is not on file
    await waitFor(() => expect(captured.body).toEqual({ upscale: true, provider: 'fal' }));
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

  // U2d — the cut's ACTUAL resolution belongs beside the upscale decision; only a cut with no
  // dimension on record keeps the generic caption.
  it('states the cut\'s own resolution in the non-HD caption', () => {
    const run = makeRun('review');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/x.mp4', shortSide: 496, createdAt: 'now' }];
    renderReview(<ApproveBar run={run} />);
    expect(screen.getByText('This cut is 496p — one Topaz job per clip lifts it toward ~1080p.')).toBeInTheDocument();
  });

  it('keeps the generic caption when the cut\'s resolution is unknown', () => {
    renderReview(<ApproveBar run={makeRun('review')} />); // fixture cut records no shortSide
    expect(screen.getByText(/One Topaz job per clip — skip it if the render is already 1080p\./)).toBeInTheDocument();
  });

  // fal prices Topaz by the OUTPUT frame, so a cut lifted to a ~1080p SHORT side can still bill at
  // the above-1080p tier when the frame is portrait (1080×1920). The label promises the target and
  // the figure comes from the tier — without a word between them they read as two different answers.
  it('explains the tier when the price is not the one the ~1080p label implies', async () => {
    server.use(http.get('/api/runs/:id/estimate', () => HttpResponse.json({
      perJob: [{ jobId: 'K1', seconds: 15, usd: 1.2 }],
      totalUsd: 1.2, currency: 'USD', label: 'estimate', targetShortSide: 1080, tier: 'above1080p',
    })));
    const run = makeRun('review');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/x.mp4', shortSide: 480, createdAt: 'now' }];
    renderReview(<ApproveBar run={run} />);

    expect(await screen.findByText(/lifts it toward ~1080p\. fal\.ai bills the taller frame at its above-1080p rate\./)).toBeInTheDocument();
    await screen.findByText('≈ $1.20');
  });

  it('says nothing extra when the tier is the one the label implies', async () => {
    server.use(http.get('/api/runs/:id/estimate', () => HttpResponse.json({
      perJob: [{ jobId: 'K1', seconds: 15, usd: 0.3 }],
      totalUsd: 0.3, currency: 'USD', label: 'estimate', targetShortSide: 1080, tier: '1080p',
    })));
    const run = makeRun('review');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/x.mp4', shortSide: 480, createdAt: 'now' }];
    renderReview(<ApproveBar run={run} />);

    await screen.findByText('≈ $0.30');
    expect(screen.queryByText(/above-1080p rate/)).not.toBeInTheDocument();
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
    // fal is the default pick, and the payload says so out loud — the server must not re-derive
    await waitFor(() => expect(captured.body).toEqual({ upscale: true, provider: 'fal' }));
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

  // `approved.final` is the one path that deliberately reaches the browser unredacted, and it is
  // written by whatever OS the SERVER runs on. On Windows it arrives backslash-delimited, and the
  // caption still owes the reviewer a file name — a host path there is unreadable and promises
  // nothing.
  it('names the file even when the server hands over a Windows path', () => {
    const run = reopenedRun();
    run.manifest!.approved!.final = 'C:\\Users\\ali\\Videos\\out\\ocean-final.mp4';
    renderReview(<ApproveBar run={run} />);

    const caption = screen.getByText(/This writes a new final/).textContent ?? '';
    expect(caption).toMatch(/ocean-final\.mp4 stays on disk/);
    expect(caption).not.toMatch(/[\\/]Users[\\/]/);
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

  // ── The provider pick (fal.ai vs Segmind Topaz) ───────────────────────────────────────────────
  // The margin is thin (fal ≈$0.12/output-second vs Segmind's flat $0.125/input-second), so the
  // picker shows both REAL figures instead of asking anyone to trust the default — and a keyless
  // option can never be submitted, only explained.

  /** Both keys on file, and a per-provider quote so the two figures are tellable apart. */
  function bothProvidersKeyed({ segmindTarget = 1080 }: { segmindTarget?: number } = {}) {
    const searches: string[] = [];
    server.use(
      http.get('/api/setup/status', () => HttpResponse.json({ ...SETUP_COMPLETE, segmind: { hasKey: true } })),
      http.get('/api/runs/:id/estimate', ({ request }) => {
        const url = new URL(request.url);
        searches.push(url.search);
        const segmind = url.searchParams.get('provider') === 'segmind';
        return HttpResponse.json({
          perJob: [{ jobId: 'K1', seconds: 13, usd: segmind ? 4.33 : 4.16 }],
          totalUsd: segmind ? 4.33 : 4.16,
          currency: 'USD',
          label: 'estimate',
          targetShortSide: segmind ? segmindTarget : 1080,
        });
      }),
    );
    return searches;
  }

  it('the picker appears with the toggle, defaults to fal.ai, and shows BOTH real figures', async () => {
    bothProvidersKeyed();
    renderReview(<ApproveBar run={makeRun('review')} />);
    expect(screen.queryByRole('radiogroup', { name: 'Upscale provider' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /upscale/i }));
    const fal = await screen.findByRole('radio', { name: /fal\.ai · \$4\.16/ });
    expect(fal).toHaveAttribute('aria-checked', 'true'); // the default, stated with its price
    const segmind = await screen.findByRole('radio', { name: /Segmind · \$4\.33/ });
    expect(segmind).toHaveAttribute('aria-checked', 'false');
    expect(segmind).toBeEnabled();
  });

  it('switching provider re-quotes: the request names the pick and the paid button follows it', async () => {
    markPaidConfirmed();
    const searches = bothProvidersKeyed();
    const captured = captureApprove();
    renderReview(<ApproveBar run={makeRun('review')} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /upscale/i }));
    await screen.findByLabelText('estimated cost $4.16'); // fal's figure while fal is picked
    expect(searches.some((s) => s.includes('provider=fal'))).toBe(true);
    expect(searches.some((s) => s.includes('provider=segmind'))).toBe(true); // both quoted up front

    fireEvent.click(await screen.findByRole('radio', { name: /Segmind/ }));
    const approve = await screen.findByLabelText('estimated cost $4.33'); // re-quoted for the pick
    fireEvent.click(approve);
    await waitFor(() => expect(captured.body).toEqual({ upscale: true, provider: 'segmind' }));
  });

  it('the target label and already-HD gate follow the PICKED provider\'s delivered short side', async () => {
    bothProvidersKeyed({ segmindTarget: 2160 }); // e.g. UPSCALE_TARGET_RESOLUTION=4k
    const run = makeRun('review');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/x.mp4', shortSide: 496, createdAt: 'now' }];
    renderReview(<ApproveBar run={run} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /upscale/i }));
    await screen.findByText(/This cut is 496p — one Topaz job per clip lifts it toward ~1080p\./);

    fireEvent.click(await screen.findByRole('radio', { name: /Segmind/ }));
    // the label now promises what SEGMIND delivers, not fal's ~1080p
    await screen.findByText(/This cut is 496p — one Topaz job per clip lifts it toward ~4K\./);
    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  // The gate and the options each judge by THEIR OWN vendor's target. A 1080p cut is at fal's
  // ~1080p plan and nowhere near Segmind's 4k one — reading "already HD" off the picked vendor
  // disabled the toggle, and the picker that could have switched to the reachable 4K job renders
  // only while the toggle is on, so the valid upscale had no way in at all.
  it('offers the 4K upscale on a 1080p cut when Segmind targets it — fal being at target is fal’s fact', async () => {
    markPaidConfirmed();
    bothProvidersKeyed({ segmindTarget: 2160 }); // UPSCALE_TARGET_RESOLUTION=4k
    const captured = captureApprove();
    const run = makeRun('review');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/hd.mp4', shortSide: 1080, createdAt: 'now' }];
    renderReview(<ApproveBar run={run} />);

    const checkbox = screen.getByRole('checkbox');
    await waitFor(() => expect(checkbox).toBeEnabled());
    // and the vendor that can actually do the job is the one on offer
    await screen.findByText(/This cut is 1080p — one Topaz job per clip lifts it toward ~4K\./);

    fireEvent.click(checkbox);
    const segmind = await screen.findByRole('radio', { name: /Segmind/ });
    expect(segmind).toHaveAttribute('aria-checked', 'true');
    // fal has a key but nothing to add here, so it is the option that goes grey — with the reason
    const fal = screen.getByRole('radio', { name: /fal\.ai/ });
    expect(fal).toBeDisabled();
    expect(screen.getByText(/fal\.ai would deliver ~1080p — this cut is already 1080p\./)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /Approve & upscale/ }));
    await waitFor(() => expect(captured.body).toEqual({ upscale: true, provider: 'segmind' }));
  });

  it('still disables the toggle when EVERY reachable vendor is at its target', async () => {
    bothProvidersKeyed(); // both quote ~1080p
    const run = makeRun('review');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/hd.mp4', shortSide: 1080, createdAt: 'now' }];
    renderReview(<ApproveBar run={run} />);

    const checkbox = screen.getByRole('checkbox');
    await waitFor(() => expect(checkbox).toBeDisabled());
    expect(screen.getByText(/already 1080p — at or above the 1080p target/i)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Upscale provider' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled(); // the free finalize stays
  });

  it('a keyless provider renders disabled with the reason in plain words', async () => {
    // the default fixture is honest here already: fal has a key, Segmind does not
    renderReview(<ApproveBar run={makeRun('review')} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /upscale/i }));

    const segmind = await screen.findByRole('radio', { name: /Segmind/ });
    await waitFor(() => expect(segmind).toBeDisabled());
    expect(screen.getByText(/Segmind is unavailable — no SEGMIND_API_KEY on file/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /fal\.ai/ })).toBeEnabled();
  });

  it('when ONLY Segmind has a key it is the default — approval can never fail on a missing key', async () => {
    markPaidConfirmed();
    server.use(http.get('/api/setup/status', () => HttpResponse.json({
      ...SETUP_COMPLETE, fal: { hasKey: false }, segmind: { hasKey: true },
    })));
    const captured = captureApprove();
    renderReview(<ApproveBar run={makeRun('review')} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /upscale/i }));
    const segmind = await screen.findByRole('radio', { name: /Segmind/ });
    await waitFor(() => expect(segmind).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: /fal\.ai/ })).toBeDisabled();
    expect(screen.getByText(/fal\.ai is unavailable — no FAL_KEY on file/)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /Approve & upscale/ }));
    await waitFor(() => expect(captured.body).toEqual({ upscale: true, provider: 'segmind' }));
  });
});
