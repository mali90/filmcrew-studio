// Drift guard: every per-model number the create hero shows must BE the registry's, not a copy of it.
// These assertions read src/lib/render-models.js DIRECTLY — the same module the engine and the Fastify
// server read — so a hand-maintained cap table in CreateHero.tsx would fail here even if it happened to
// agree with the typed facade the component imports.
//
// The hydration case is the other half: a server-side default is data, so it is validated against the
// registry too (a compound `<model>@<provider>` id lights up its own segment; a ratio that model cannot
// render never reaches the payload).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { http, HttpResponse, server } from '../../test/msw';
import type { CharactersResponse } from '../../../../shared/api-types';
import type { GlobalLive } from '../../hooks/useGlobalEvents';
import { ToastProvider } from '../ui/Toast';
import HomePage from '../../pages/Home';
import { aspectsForBackend, castCapFor } from './CreateHero';
import { ALL_BACKENDS, RENDER_MODELS, aspectsFor, castLimitFor, normalizeBackend } from '../../../../../src/lib/render-models.js';

const globalLive = vi.hoisted(() => ({ state: { active: [], queued: [], lastRunStatus: null } as GlobalLive }));
vi.mock('../../hooks/useGlobalEvents', () => ({ useGlobalEvents: () => globalLive.state }));

const MODELS = RENDER_MODELS as Record<string, { label: string }>;
const labelOf = (backend: string) => MODELS[normalizeBackend(backend).model]!.label;

function RunProbe() {
  const { id } = useParams();
  return <div>run page {id}</div>;
}

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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

const CAST_ONE: CharactersResponse = {
  characters: [{ slug: 'keeper', name: 'The Keeper', description: '# Keeper', refs: [], voice: null }],
  unassigned: { references: [], voices: [] },
};

const capturePost = () => {
  const seen: { body?: Record<string, unknown> } = {};
  server.use(http.post('/api/runs', async ({ request }) => {
    seen.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ runId: 'web-registry-1' });
  }));
  return seen;
};

describe('CreateHero — the registry is the only cap table', () => {
  it('the exported helpers equal src/lib/render-models.js for every backend id', () => {
    expect(ALL_BACKENDS.length).toBeGreaterThan(0);
    for (const id of ALL_BACKENDS) {
      expect(castCapFor(id)).toBe(castLimitFor(id));
      expect(aspectsForBackend(id)).toEqual(aspectsFor(id));
    }
  });

  it('the rendered Starring caption states the registry cap for each model on offer', async () => {
    server.use(http.get('/api/cast/characters', () => HttpResponse.json(CAST_ONE)));
    renderHome();
    await screen.findByRole('group', { name: 'Starring' });
    for (const [segment, backend] of [['Kling', 'kling'], ['Seedance 2.0', 'seedance'], ['Seedance 2.5', 'seedance-2.5']] as const) {
      await userEvent.click(screen.getByRole('radio', { name: segment }));
      expect(screen.getByText(`Starring — up to ${castLimitFor(backend)} for ${labelOf(backend)}`)).toBeInTheDocument();
    }
  });
});

describe('CreateHero — server defaults are registry-validated', () => {
  it('hydrates a compound backend id and refuses a ratio that model cannot render', async () => {
    server.use(http.get('/api/settings/defaults', () => HttpResponse.json({
      backend: 'seedance-2.0@fal', aspect: '4:3', resolution: '1080p', seedanceResolution: '480p',
    })));
    const seen = capturePost();
    renderHome();
    await vi.waitFor(() => expect(screen.getByRole('radio', { name: 'Seedance' })).toHaveAttribute('aria-checked', 'true'));

    const group = screen.getByRole('radiogroup', { name: 'Aspect ratio' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(aspectsFor('seedance-2.0@fal'));
    expect(within(group).queryByRole('radio', { name: '4:3' })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a harbour at dawn{Enter}');
    await screen.findByText('run page web-registry-1');
    expect(seen.body?.backend).toBe('seedance-2.0@fal'); // the canonical id survives to the server
    expect(seen.body?.aspect).toBe('9:16');              // '4:3' is not on Seedance 2.0's list
  });
});
