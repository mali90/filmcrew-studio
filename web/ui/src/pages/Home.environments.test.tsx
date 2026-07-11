// Home — the "Set in" environment picker in the create hero (immediately AFTER "Starring", BEFORE
// the Backend/Aspect/Duration row). Single-select radiogroup: clicking a chip selects it; clicking
// the selected chip again clears it. The chosen slug rides the payload as `environment`. Hidden
// entirely when no environments exist. When BOTH a cast member and an environment are selected, a
// precedence hint replaces the plain caption.
//
// TDD (red first): the "Set in" section in CreateHero.tsx and CreateRunBody.environment do not exist yet.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { http, HttpResponse, server } from '../test/msw';
import type { CharactersResponse, EnvironmentsResponse } from '../../../shared/api-types';
import type { GlobalLive } from '../hooks/useGlobalEvents';
import { ToastProvider } from '../components/ui/Toast';
import HomePage from './Home';

// The queue strip reads useGlobalEvents — stub it so the hero renders in isolation.
const globalLive = vi.hoisted(() => ({ state: { active: [], queued: [], lastRunStatus: null } as GlobalLive }));
vi.mock('../hooks/useGlobalEvents', () => ({ useGlobalEvents: () => globalLive.state }));

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

const ENVS: EnvironmentsResponse = {
  environments: [
    { slug: 'neon-city', name: 'Neon City', description: '# Neon City\n\nRain-slicked neon streets.' },
    { slug: 'harbor', name: 'Harbor', description: '# Harbor' },
  ],
};
const CAST_ONE: CharactersResponse = {
  characters: [{ slug: 'runner', name: 'Runner', description: '# Runner\n\nA courier.', refs: [], voice: null }],
  unassigned: { references: [], voices: [] },
};

describe('Home — "Set in" environment picker', () => {
  it('zero environments → no "Set in" row, no radiogroup', async () => {
    renderHome(); // default handler answers with zero environments
    await screen.findByLabelText('Your idea, in one line');
    expect(screen.queryByText('Set in')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Set in' })).not.toBeInTheDocument();
  });

  it('is single-select: a chip selects, clicking it again clears, and only the chosen slug reaches the payload', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/environments', () => HttpResponse.json(ENVS)),
      http.post('/api/runs', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ runId: 'web-env-1' });
      }),
    );
    renderHome();

    const group = await screen.findByRole('radiogroup', { name: 'Set in' });
    const neon = within(group).getByRole('radio', { name: /Neon City/i });
    const harbor = within(group).getByRole('radio', { name: /Harbor/i });
    expect(neon).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(neon);
    expect(neon).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/mood, light/i)).toBeInTheDocument(); // selected caption names the anchor

    // single-select: choosing Harbor deselects Neon City
    await userEvent.click(harbor);
    expect(neon).toHaveAttribute('aria-checked', 'false');
    expect(harbor).toHaveAttribute('aria-checked', 'true');

    // clicking the selected chip again clears the whole selection
    await userEvent.click(harbor);
    expect(harbor).toHaveAttribute('aria-checked', 'false');

    // re-select and submit — the slug rides the payload as `environment`
    await userEvent.click(neon);
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a courier at midnight{Enter}');
    await screen.findByText('run page web-env-1');
    expect(body?.environment).toBe('neon-city');
  });

  it('environments present but none selected → the payload has no environment key', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/environments', () => HttpResponse.json(ENVS)),
      http.post('/api/runs', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ runId: 'web-env-2' });
      }),
    );
    renderHome();
    await screen.findByRole('radiogroup', { name: 'Set in' });
    expect(screen.getByText(/Optional — pick an environment/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'no anchor tonight{Enter}');
    await screen.findByText('run page web-env-2');
    expect(body).not.toHaveProperty('environment');
  });

  it('when BOTH a cast member and an environment are selected, an informational precedence hint appears', async () => {
    server.use(
      http.get('/api/environments', () => HttpResponse.json(ENVS)),
      http.get('/api/cast/characters', () => HttpResponse.json(CAST_ONE)),
    );
    renderHome();

    await userEvent.click(within(await screen.findByRole('group', { name: 'Starring' })).getByRole('button', { name: 'Runner' }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Set in' })).getByRole('radio', { name: /Neon City/i }));

    // precedence: the environment steers the world; the character's own world notes take a back seat
    expect(screen.getByText(/back seat/i)).toBeInTheDocument();
    expect(screen.getByText(/steers the world/i)).toBeInTheDocument();
  });
});
