import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server, http, HttpResponse } from '../../../test/msw';
import { makeRun } from '../../../test/fixtures';
import { renderReview } from './test-helpers';
import { FinalCard } from './FinalCard';

/** Two deliveries: final-1 was replaced by final-2, and BOTH files are still on disk. */
function twiceDelivered() {
  const run = makeRun('complete');
  run.manifest!.finals = [
    { id: 'final-1', cut: 'c1', final: '/abs/out/ocean-first.mp4', upscaled: false, at: '2026-07-04T10:00:00.000Z', replacedBy: 'final-2' },
    { id: 'final-2', cut: 'c2', final: '/abs/out/ocean-final.mp4', upscaled: true, at: '2026-07-04T12:00:00.000Z' },
  ];
  return run;
}

describe('FinalCard', () => {
  it('shows the finished video with the facts and a Download link to the final file', () => {
    const run = makeRun('complete');
    run.manifest!.costLedger = [
      { ts: '2026-07-04T10:00:00.000Z', action: 'render', estUsd: 4.16, note: 'full render' },
      { ts: '2026-07-04T10:30:00.000Z', action: 'upscale', estUsd: 0.84, note: 'topaz' },
      { ts: '2026-07-04T10:31:00.000Z', action: 'assemble', estUsd: null, note: 'free' },
    ];

    renderReview(<FinalCard run={run} />);
    expect(screen.getByText('Ocean Lighthouse is done')).toBeInTheDocument();
    expect(screen.getByTestId('final-video')).toHaveAttribute('src', '/api/media/out/ocean-final.mp4');
    expect(screen.getByText('13s')).toBeInTheDocument(); // duration target
    expect(screen.getByText('9:16')).toBeInTheDocument();
    expect(screen.getByText('yes')).toBeInTheDocument(); // upscaled
    expect(screen.getByText('$5.00')).toBeInTheDocument(); // summed ledger

    // ONE exit for the file: a plain same-origin download anchor (no reveal, no copy-path)
    const dl = screen.getByRole('link', { name: /download/i });
    expect(dl).toHaveAttribute('href', '/api/media/out/ocean-final.mp4');
    expect(dl).toHaveAttribute('download', 'ocean-final.mp4'); // saved under the on-disk name
    expect(screen.queryByRole('button', { name: /reveal|copy path/i })).not.toBeInTheDocument();
  });

  // U2c — the facts grid states what resolution was DELIVERED: the approved cut's own record
  // first, the latest render's dimension next, and only then the run's pick as a stand-in.
  it('states the delivered resolution from the approved cut\'s record', () => {
    const run = makeRun('complete');
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/ocean.mp4', shortSide: 1080, createdAt: '2026-07-04T10:00:00.000Z' }];
    renderReview(<FinalCard run={run} />);
    expect(screen.getByText('Resolution')).toBeInTheDocument();
    expect(screen.getByText('1080p')).toBeInTheDocument();
  });

  it('falls back to the run\'s resolution pick when no dimension was recorded', () => {
    const run = makeRun('complete'); // fixture cut carries no shortSide
    run.manifest!.resolution = '720p';
    renderReview(<FinalCard run={run} />);
    expect(screen.getByText('720p')).toBeInTheDocument();
  });

  it('shows an em dash when neither a dimension nor a pick is on record', () => {
    renderReview(<FinalCard run={makeRun('complete')} />);
    const dt = screen.getByText('Resolution');
    expect(dt.parentElement?.textContent).toBe('Resolution—');
  });

  // estUsd:null means two different things in a ledger, and only one of them is "free": an assemble
  // really costs nothing, while a Segmind render spent money at a rate nobody publishes. Summing
  // them together would print a confident "$0.00" over a real bill.
  it('a ledger with unpriced work never totals to a confident figure', () => {
    const run = makeRun('complete');
    run.manifest!.costLedger = [
      { ts: '2026-07-04T10:00:00.000Z', action: 'full', estUsd: null, unpriced: true, note: 'estimate unavailable' },
      { ts: '2026-07-04T10:31:00.000Z', action: 'assemble', estUsd: null, note: 'free' },
    ];
    renderReview(<FinalCard run={run} />);
    expect(screen.getByText('not on file')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('a partly-unpriced ledger states the known spend as a floor', () => {
    const run = makeRun('complete');
    run.manifest!.costLedger = [
      { ts: '2026-07-04T10:00:00.000Z', action: 'full', estUsd: 4.16, note: 'estimate' },
      { ts: '2026-07-04T10:30:00.000Z', action: 'upscale', estUsd: null, unpriced: true, note: 'topaz per-clip' },
    ];
    renderReview(<FinalCard run={run} />);
    expect(screen.getByText('$4.16 + unpriced work')).toBeInTheDocument();
  });

  // ── The way back in (WS2-P6, spec D23/D24) ────────────────────────────────
  // A run that came out almost right is the common case. Hiding the way back behind an overflow
  // menu makes people re-run the whole film instead, so the affordance is in the card — and the
  // question it asks is entirely about what does NOT happen to the file they already have.
  it('offers "Make changes" in the card itself, never behind a menu', () => {
    renderReview(<FinalCard run={makeRun('complete')} />);
    expect(screen.getByRole('button', { name: /Make changes/ })).toBeVisible();
    // no menu button standing between the user and it
    expect(screen.queryByRole('button', { name: /more|options|⋯|…/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // the footer sentence carries the reassurance before the click, not only after it
    expect(screen.getByText(/your final file stays on disk either way/i)).toBeInTheDocument();
  });

  it('asks once before reopening, and the question says the existing final stays on disk', async () => {
    let reopened = 0;
    server.use(http.post('/api/runs/:id/reopen', () => {
      reopened += 1;
      return HttpResponse.json({ reopenedAt: '2026-07-04T13:00:00.000Z', final: '/abs/out/ocean-final.mp4' });
    }));
    renderReview(<FinalCard run={makeRun('complete')} />);

    fireEvent.click(screen.getByRole('button', { name: /Make changes/ }));
    expect(reopened).toBe(0); // the first click asks — it does not act

    // The body's whole job: nothing is lost, and the file is named so "reopen" can't read as "undo"
    expect(screen.getByText(/Reopen this run to make changes\?/)).toBeInTheDocument();
    const body = screen.getByText(/Nothing is lost/).textContent ?? '';
    expect(body).toMatch(/stays on disk/);
    expect(body).toMatch(/ocean-final\.mp4/);
    expect(body).toMatch(/writes a new final beside it/);

    fireEvent.click(screen.getByRole('button', { name: /Make changes/ }));
    await waitFor(() => expect(reopened).toBe(1));
  });

  it('backing out of the question reopens nothing', () => {
    let reopened = 0;
    server.use(http.post('/api/runs/:id/reopen', () => {
      reopened += 1;
      return HttpResponse.json({ reopenedAt: 'now', final: '/abs/out/ocean-final.mp4' });
    }));
    renderReview(<FinalCard run={makeRun('complete')} />);

    fireEvent.click(screen.getByRole('button', { name: /Make changes/ }));
    fireEvent.click(screen.getByRole('button', { name: /Keep it as is/ }));
    expect(screen.queryByText(/Nothing is lost/)).not.toBeInTheDocument();
    expect(reopened).toBe(0);
  });

  // Spec D24 — a replaced final is never deleted, so the card must be able to prove it.
  it('a second delivery names what it replaced and keeps the earlier file downloadable', () => {
    renderReview(<FinalCard run={twiceDelivered()} />);

    expect(screen.getByTestId('finals-lineage')).toHaveTextContent('final-2 · replaced final-1');

    // the earlier finals are a disclosure, closed by default — one delivery is the common case
    const disclosure = screen.getByRole('button', { name: /Earlier finals/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /final-1/ })).not.toBeInTheDocument();

    fireEvent.click(disclosure);
    const earlier = screen.getByRole('link', { name: /final-1/ });
    expect(earlier).toHaveAttribute('href', '/api/media/out/ocean-first.mp4');
    expect(earlier).toHaveAttribute('download', 'ocean-first.mp4');
    // the superseded one is listed; the one on screen is not listed twice
    expect(screen.queryByRole('link', { name: /final-2/ })).not.toBeInTheDocument();
  });

  it('a single delivery says nothing about replacements — there is nothing to explain', () => {
    renderReview(<FinalCard run={makeRun('complete')} />);
    expect(screen.queryByTestId('finals-lineage')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Earlier finals/ })).not.toBeInTheDocument();
  });

  // Honest cost wording: reopening and downloading really are free (a timestamp and a file read),
  // but nothing in this card may extend that word to the work a reopened run goes on to do.
  it('never calls rendering or planning free', () => {
    const { container } = renderReview(<FinalCard run={twiceDelivered()} />);
    fireEvent.click(screen.getByRole('button', { name: /Make changes/ }));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/free/i);
    expect(within(container).queryByText(/no cost|costs nothing/i)).not.toBeInTheDocument();
  });
});
