// A saved default may be canonical ('seedance-2.0@fal') while the backend picker is keyed by the
// legacy one-word ids (codex finding): without model-level mapping no segment is selected, the
// radiogroup loses its tab stop, and saving would report a phantom backend change.
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse, server } from '../../test/msw';
import { ToastProvider } from '../ui/Toast';
import { DefaultsCard } from './DefaultsCard';

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider><DefaultsCard /></ToastProvider>
    </QueryClientProvider>,
  );
}

const defaults = (backend: string) =>
  http.get('/api/settings/defaults', () =>
    HttpResponse.json({ backend, aspect: '9:16', resolution: '720p', seedanceResolution: '480p' }));

describe('DefaultsCard backend normalization', () => {
  beforeEach(() => server.use(defaults('seedance-2.0@fal')));

  it('maps a canonical saved default onto its model segment', async () => {
    renderCard();
    // The picker renders instantly with its pre-seed state, so WAIT for the seeded selection —
    // asserting on first paint would (vacuously) see the initial value.
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /seedance/i })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: /kling/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('still takes the legacy one-word value as itself', async () => {
    // 'seedance', not 'kling': the initial state IS kling, so only a non-initial legacy value
    // proves the seed actually ran.
    server.use(defaults('seedance'));
    renderCard();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /seedance/i })).toHaveAttribute('aria-checked', 'true'));
  });
});
