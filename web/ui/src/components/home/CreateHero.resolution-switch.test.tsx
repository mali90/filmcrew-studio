// Switching to a model that cannot render the picked TIER must trim the pick — in the control, in
// the status line and in what is posted. Unlike the aspect twin (CreateHero.aspect-switch.test.tsx),
// no facade stubbing is needed: the real registry ladders already diverge (Kling 720p/1080p/4k,
// Seedance 2.5 480p/720p), so the switch is exercised end to end against the real rules. The trim
// falls to the MODEL's default tier (the saved one from GET /settings/defaults when known), never a
// neighbouring tier — and the posted body carries the pick, which is the whole point: a run's
// resolution must be the one the user SAW, not whatever .env said.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { http, HttpResponse, server } from '../../test/msw';
import type { GlobalLive } from '../../hooks/useGlobalEvents';
import { ToastProvider } from '../ui/Toast';
import HomePage from '../../pages/Home';

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

describe('CreateHero resolution trim on model switch', () => {
  it('trims an off-ladder tier to the new model’s default, says so, and posts the visible pick', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ runId: 'web-res-trim-1' });
    }));
    renderHome();

    const group = screen.getByRole('radiogroup', { name: 'Resolution' });
    // the default backend (Kling) hydrates its saved tier from /settings/defaults
    expect(within(group).getByRole('radio', { name: '1080p' })).toHaveAttribute('aria-checked', 'true');

    // Seedance 2.5's ladder has no 1080p: the pick trims to ITS saved default (720p) and says so
    await userEvent.click(screen.getByRole('radio', { name: 'Seedance 2.5' }));
    expect(within(group).queryByRole('radio', { name: '1080p' })).not.toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: '720p' })).toHaveAttribute('aria-checked', 'true');
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('1080p');
    expect(note).toHaveTextContent('Seedance 2.5');

    // pick 480p, switch back to Kling: 480p is off Kling's ladder → back to its saved 1080p
    await userEvent.click(within(group).getByRole('radio', { name: '480p' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Kling' }));
    expect(within(group).queryByRole('radio', { name: '480p' })).not.toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: '1080p' })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByRole('status')).toHaveTextContent('480p');

    // what is posted is what is on screen — the server would 400 anything the trim let through
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a tall tale{Enter}');
    await screen.findByText('run page web-res-trim-1');
    expect(body?.resolution).toBe('1080p');
  });

  it('an explicit tier pick rides the POST (the run pins what the user saw)', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ runId: 'web-res-pick-1' });
    }));
    renderHome();

    const group = screen.getByRole('radiogroup', { name: 'Resolution' });
    await userEvent.click(within(group).getByRole('radio', { name: '4k' }));
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a wide vista{Enter}');
    await screen.findByText('run page web-res-pick-1');
    expect(body?.resolution).toBe('4k');
    expect(body?.backend).toBe('kling-o3@fal');
  });
});
