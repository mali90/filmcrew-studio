// What a paid button says when the RATE IS NOT ON FILE.
//
// Segmind publishes no prices for its Seedance or Topaz models, so the estimator answers
// `{ totalUsd: null, unknownPrice: { hint } }` for those backends. The UI has to hold two true
// things at once, and it is easy to get either one wrong:
//
//   1. WARN, DON'T BLOCK. `costUsd: null` already means "the estimate hasn't loaded yet" and
//      correctly disables a money button until it does. An unknown RATE is a different state: it
//      will never load, and disabling the button would strand a perfectly renderable backend behind
//      a spinner forever. The render must stay clickable.
//   2. NEVER INVENT A NUMBER. No "$0.00", no "free", no borrowed sibling rate. The copy has to say
//      the render costs money and that the per-second rate is not on file yet — an amber note, not
//      a green one, because unknown cost is a caution.
//
// TDD (red first): Estimate has no `unknownPrice`, and Button disables on a null cost.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse, server } from '../../test/msw';
import { makeRun } from '../../test/fixtures';
import { clearPaidState, markPaidConfirmed, renderRunPage } from './test-harness';

const UNKNOWN_PRICE = {
  perJob: [{ jobId: 'K1', seconds: 9, usd: null }, { jobId: 'K2', seconds: 4, usd: null }],
  totalUsd: null,
  currency: 'USD',
  label: 'estimate',
  unknownPrice: { provider: 'segmind', hint: "Segmind does not publish a per-second rate for this model — check segmind.com/models/seedance-2.5/pricing and fill it in." },
};

const serveUnknownPrice = () => server.use(http.get('/api/runs/:id/estimate', () => HttpResponse.json(UNKNOWN_PRICE)));

beforeEach(() => clearPaidState());

describe('PlanReview — an unpriced backend', () => {
  it('shows a "Price not set" note instead of a price, and quotes no figure', async () => {
    serveUnknownPrice();
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });

    const note = await screen.findByText(/price not set/i);
    expect(note).toBeInTheDocument();
    expect(note.textContent ?? '').not.toMatch(/\$\s?\d/);          // no invented number
    expect(screen.queryByText(/\bfree\b/i)).not.toBeInTheDocument(); // and rendering is NOT free

    const full = screen.getByRole('button', { name: /^Full render/ });
    expect(within(full).queryByText(/≈ \$/)).not.toBeInTheDocument();
  });

  it('WARNS but does not block — the render button still fires', async () => {
    serveUnknownPrice();
    markPaidConfirmed();
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs/:id/render', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ takeId: 't1', estUsd: null });
    }));
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });

    const full = await screen.findByRole('button', { name: /^Full render/ });
    expect(full).toBeEnabled();
    await userEvent.click(full);
    await vi.waitFor(() => expect(body).toEqual({ mode: 'full' }));
  });

  it('says plainly that the render still costs money, and where the rate would come from', async () => {
    serveUnknownPrice();
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });
    const note = await screen.findByText(/price not set/i);
    // honest wording: unknown ≠ free. The hint the server sent is what tells a user how to fix it.
    expect(note.parentElement?.textContent ?? '').toMatch(/costs money|will be billed|charges/i);
    expect(note.parentElement?.textContent ?? '').toMatch(/segmind\.com/i);
  });

  it('a PRICED backend is completely unchanged — the note never appears', async () => {
    renderRunPage(makeRun('plan-ready')); // default MSW estimate: totalUsd 4.16
    await screen.findByRole('region', { name: 'The plan is ready' });
    const full = await screen.findByRole('button', { name: /^Full render/ });
    expect(within(full).getByText('≈ $4.16')).toBeInTheDocument();
    expect(screen.queryByText(/price not set/i)).not.toBeInTheDocument();
  });

  it('a still-LOADING estimate is not the same state — that one keeps waiting', async () => {
    // costUsd===null while the request is in flight must keep its "≈ $…" placeholder and stay
    // disabled; only an explicit unknownPrice flips to the amber note.
    server.use(http.get('/api/runs/:id/estimate', async () => {
      await new Promise((r) => setTimeout(r, 10_000));
      return HttpResponse.json(UNKNOWN_PRICE);
    }));
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });
    const full = await screen.findByRole('button', { name: /^Full render/ });
    expect(within(full).getByText(/\$…/)).toBeInTheDocument();
    expect(full).toBeDisabled();
    expect(screen.queryByText(/price not set/i)).not.toBeInTheDocument();
  });
});
