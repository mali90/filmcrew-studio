// The hint beside the create controls quotes MONEY, and the run is now pinned to the tier the
// Resolution control shows — so the two have to be the same pick. Seedance is billed by
// pixel-seconds, which makes this the widest gap on the page: fal's Seedance 2.0 is $0.135/s at
// 480p and $1.5552/s at 4k, so a hint that keeps quoting the model's DEFAULT tier beside a control
// set to 4k under-quotes the spend by more than eleven times, on the very control that decides it.
//
// What this pins:
//   * the figure follows the SELECTED tier, not the backend's default
//   * it comes from the estimator's own table (web/server/lib/prices.json), so the create page and
//     the run page's estimate cannot quote different money for the same pick
//   * the tier-dependent CLAIMS follow it too — the hint never says "480p" while 4k is picked, and
//     never offers the approve-time lift to 1080p on a cut that already exceeds it
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import type { GlobalLive } from '../../hooks/useGlobalEvents';
import { ToastProvider } from '../ui/Toast';
import HomePage from '../../pages/Home';
import { MODEL_IDS, backendIdFor, modelSegmentLabelFor, providersFor, resolutionsFor } from '../../../../shared/render-models';
import { perSecondUsdFor } from '../../../../shared/render-rates';
import { usd } from '../../lib/format';

const globalLive = vi.hoisted(() => ({ state: { active: [], queued: [], lastRunStatus: null } as GlobalLive }));
vi.mock('../../hooks/useGlobalEvents', () => ({ useGlobalEvents: () => globalLive.state }));

function RunProbe() {
  const { id } = useParams();
  return <div>run page {id}</div>;
}

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/runs/:id" element={<RunProbe />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const hint = () => screen.getByTestId('backend-hint');
const pickModel = (name: string) => userEvent.click(screen.getByRole('radio', { name }));
const pickProvider = (name: string) =>
  userEvent.click(within(screen.getByRole('radiogroup', { name: 'Provider' })).getByRole('radio', { name }));
const pickTier = (tier: string) =>
  userEvent.click(within(screen.getByRole('radiogroup', { name: 'Resolution' })).getByRole('radio', { name: tier }));

describe('CreateHero — the price hint follows the picked tier', () => {
  it('quotes 4k money when 4k is picked, not the model\'s default-tier rate', async () => {
    renderHome();
    await pickModel('Seedance 2.0');
    expect(hint()).toHaveTextContent(/\$0\.14/); // 480p, the fixture's saved default

    await pickTier('4k');
    // $1.5552/s is what the run will be billed at, and what the run page's estimate will say.
    expect(hint()).toHaveTextContent(/\$1\.56/);
    expect(hint()).not.toHaveTextContent(/\$0\.14/);
    // …and no claim that outlived the tier it was written for
    expect(hint()).not.toHaveTextContent(/480p/);
    expect(hint()).not.toHaveTextContent(/upscale/i); // a 4k master is already past the 1080p lift
  });

  it('moves with the PROVIDER at the picked tier — the pair is priced, not the model', async () => {
    renderHome();
    await pickModel('Seedance 2.0');
    await pickTier('4k');
    expect(hint()).toHaveTextContent(/\$1\.56/);

    await pickProvider('Segmind');
    expect(hint()).toHaveTextContent(/\$1\.37/); // Segmind's own published 4k rate
    expect(hint()).not.toHaveTextContent(/\$1\.56/);
  });

  it('still offers the approve-time lift while the tier is under 1080p', async () => {
    renderHome();
    await pickModel('Seedance 2.0');
    await pickTier('720p');
    expect(hint()).toHaveTextContent(/\$0\.30/);
    expect(hint()).toHaveTextContent(/720p/);
    expect(hint()).toHaveTextContent(/upscale/i);
  });

  // The drift guard. Every figure on this page has to be the estimator's, at the tier on screen —
  // a hand-copied rate is wrong the day a vendor moves a price, and nothing here would notice.
  it('quotes prices.json\'s rate for EVERY pair at EVERY tier it renders', async () => {
    renderHome();
    for (const model of MODEL_IDS.filter((id) => providersFor(id).length > 0)) {
      await pickModel(modelSegmentLabelFor(model));
      for (const provider of providersFor(model)) {
        const backend = backendIdFor(model, provider.id);
        if (providersFor(model).length > 1) await pickProvider(provider.label);
        const tiers = resolutionsFor(backend);
        for (const tier of tiers.length ? tiers : [null]) {
          if (tier) await pickTier(tier);
          const rate = perSecondUsdFor(backend, tier);
          expect(rate, `${backend} at ${tier ?? 'its endpoint output'} must be priced`).not.toBeNull();
          expect(hint().textContent ?? '', `${backend} at ${tier ?? 'its endpoint output'}`)
            .toContain(usd(rate as number));
        }
      }
    }
  });
});
