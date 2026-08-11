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
  it('hides the control for a ladder-less model, trims across ladders, and posts the visible pick', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ runId: 'web-res-trim-1' });
    }));
    renderHome();

    // the default backend (Kling) has NO ladder — no Resolution control at all
    expect(screen.queryByRole('radiogroup', { name: 'Resolution' })).not.toBeInTheDocument();

    // a laddered model brings the control up at ITS saved tier (the fixture's 480p), silently —
    // nothing was lost crossing none→tier, so nothing is announced
    await userEvent.click(screen.getByRole('radio', { name: 'Seedance 2.0' }));
    const group = screen.getByRole('radiogroup', { name: 'Resolution' });
    expect(within(group).getByRole('radio', { name: '480p' })).toHaveAttribute('aria-checked', 'true');

    // 4k is on 2.0's ladder but not 2.5's: the pick trims to 2.5's saved default (720p) and says so
    await userEvent.click(within(group).getByRole('radio', { name: '4k' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Seedance 2.5' }));
    expect(within(group).queryByRole('radio', { name: '4k' })).not.toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: '720p' })).toHaveAttribute('aria-checked', 'true');
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('4k');
    expect(note).toHaveTextContent('Seedance 2.5');

    // back to Kling: the control disappears and the note says the pick no longer applies
    await userEvent.click(screen.getByRole('radio', { name: 'Kling' }));
    expect(screen.queryByRole('radiogroup', { name: 'Resolution' })).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('no longer applies');

    // and the POST carries nothing to pin — the server would 400 any tier for Kling
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a tall tale{Enter}');
    await screen.findByText('run page web-res-trim-1');
    expect(body).not.toHaveProperty('resolution');
  });

  it('an explicit tier pick rides the POST (the run pins what the user saw)', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ runId: 'web-res-pick-1' });
    }));
    renderHome();

    await userEvent.click(screen.getByRole('radio', { name: 'Seedance 2.0' }));
    const group = screen.getByRole('radiogroup', { name: 'Resolution' });
    await userEvent.click(within(group).getByRole('radio', { name: '4k' }));
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a wide vista{Enter}');
    await screen.findByText('run page web-res-pick-1');
    expect(body?.resolution).toBe('4k');
    expect(body?.backend).toBe('seedance-2.0@fal');
  });
});
