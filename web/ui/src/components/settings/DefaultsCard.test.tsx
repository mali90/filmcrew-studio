// A saved default may be canonical ('seedance-2.0@fal') while the value on disk is a legacy one-word
// id (codex finding): without canonical mapping no option is selected, the radiogroup loses its tab
// stop, and saving would report a phantom backend change.
//
// The list itself is registry-derived: every (model, provider) pair the build can render is offerable
// as a default, because a default is just what the create page starts on — including the Segmind
// pairs, whose per-second rate nobody publishes.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse, server } from '../../test/msw';
import { ToastProvider } from '../ui/Toast';
import { DefaultsCard } from './DefaultsCard';
import { BACKEND_IDS } from '../../../../../src/lib/render-models.js';

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider><DefaultsCard /></ToastProvider>
    </QueryClientProvider>,
  );
}

const defaults = (backend: string, aspect = '9:16') =>
  http.get('/api/settings/defaults', () =>
    HttpResponse.json({ backend, aspect, resolution: '720p', seedanceResolution: '480p' }));

const backendGroup = () => screen.getByRole('radiogroup', { name: 'Default render backend' });

describe('DefaultsCard backend normalization', () => {
  beforeEach(() => server.use(defaults('seedance-2.0@fal')));

  it('maps a canonical saved default onto its option', async () => {
    renderCard();
    // The picker renders instantly with its pre-seed state, so WAIT for the seeded selection —
    // asserting on first paint would (vacuously) see the initial value.
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Seedance 2\.0 fal/ })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: /Kling/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('still takes the legacy one-word value as itself', async () => {
    // 'seedance', not 'kling': the initial state IS kling, so only a non-initial legacy value
    // proves the seed actually ran.
    server.use(defaults('seedance'));
    renderCard();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Seedance 2\.0 fal/ })).toHaveAttribute('aria-checked', 'true'));
  });
});

describe('DefaultsCard — every renderable pair is offerable as the default', () => {
  it('offers exactly the registry\'s backend ids, Segmind included', async () => {
    server.use(defaults('kling'));
    renderCard();
    await waitFor(() => expect(within(backendGroup()).getAllByRole('radio')).toHaveLength(BACKEND_IDS.length));
    expect(screen.getAllByText('Segmind').length).toBe(
      BACKEND_IDS.filter((id: string) => id.endsWith('@segmind')).length,
    );
  });

  it('hydrates a Segmind default and saves the compound id it was picked as', async () => {
    let body: unknown = null;
    server.use(
      defaults('seedance-2.5@segmind', '21:9'),
      http.post('/api/settings/defaults', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ written: ['RENDER_BACKEND'] });
      }),
    );
    renderCard();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Seedance 2\.5 Segmind/ })).toHaveAttribute('aria-checked', 'true'));
    // 21:9 is a Seedance 2.5 ratio — the seeded aspect survives because the model renders it
    expect(screen.getByRole('radio', { name: /21:9/ })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: /Seedance 2\.0 Segmind/ }));
    // 2.0 on Segmind renders 21:9 too, so only the backend changed
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(body).toEqual({ backend: 'seedance-2.0@segmind' }));
  });

  it('trims an aspect the newly chosen model cannot render', async () => {
    let body: unknown = null;
    server.use(
      defaults('seedance-2.5@segmind', '21:9'),
      http.post('/api/settings/defaults', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ written: ['RENDER_BACKEND', 'KLING_ASPECT'] });
      }),
    );
    renderCard();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Seedance 2\.5 Segmind/ })).toHaveAttribute('aria-checked', 'true'));

    await userEvent.click(screen.getByRole('radio', { name: /Kling/ }));
    expect(screen.queryByRole('radio', { name: /21:9/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    // a pair the create page would refuse is never what gets saved
    await waitFor(() => expect(body).toEqual({ backend: 'kling-o3@fal', aspect: '16:9' }));
  });
});
