// Cast page — the Environments section (placed AFTER the character grid, BEFORE Unassigned assets).
// Owns its own useQuery(['environments']). Empty state, cards, and the dashed "New environment"
// tile. The page keeps its h1 "Cast"; the environments live under an h2.
//
// TDD (red first): the Environments section on Cast.tsx does not exist yet. (This co-located file
// keeps the existing Cast.test.tsx untouched — both render CastPage.)
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HttpResponse, http, server } from '../test/msw';
import type { EnvironmentView } from '../../../shared/api-types';
import { ToastProvider } from '../components/ui/Toast';
import CastPage from './Cast';

function renderCast() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/cast']}>
          <Routes>
            <Route path="/cast" element={<CastPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const NEON: EnvironmentView = { slug: 'neon-city', name: 'Neon City', description: '# Neon City\n\nRain-slicked neon streets.' };

describe('Cast — Environments section', () => {
  it('shows an Environments heading and, with none present, an empty state that links to /environments/new', async () => {
    // default handlers: zero characters, zero environments
    renderCast();

    expect(await screen.findByRole('heading', { name: 'Environments', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Cast' })).toBeInTheDocument(); // the page h1 is unchanged
    expect(screen.getByRole('heading', { name: /No environments yet/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New environment/i })).toHaveAttribute('href', '/environments/new');
  });

  it('lists an environment card and the dashed "New environment" tile once environments exist', async () => {
    server.use(http.get('/api/environments', () => HttpResponse.json({ environments: [NEON] })));
    renderCast();

    const card = (await screen.findByRole('link', { name: /Neon City/i })).closest('article')!;
    expect(within(card).getByText('Neon City')).toBeInTheDocument();
    // the dashed tile is always present alongside the cards (both link to the new-environment route)
    const newLinks = screen.getAllByRole('link', { name: /New environment/i });
    expect(newLinks.some((l) => l.getAttribute('href') === '/environments/new')).toBe(true);
  });
});
