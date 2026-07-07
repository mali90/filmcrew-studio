// Application card: restart is one click when nothing renders, both actions confirm honestly
// when money is in flight, shutdown ends in the farewell state.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse, server } from '../../test/msw';
import type { GlobalLive } from '../../hooks/useGlobalEvents';
import { ToastProvider } from '../ui/Toast';
import { ApplicationCard } from './ApplicationCard';

const globalLive = vi.hoisted(() => ({
  state: { active: [], queued: [], lastRunStatus: null } as GlobalLive,
}));
vi.mock('../../hooks/useGlobalEvents', () => ({ useGlobalEvents: () => globalLive.state }));

const RENDERING: GlobalLive = {
  active: [{ id: 'q1', runId: 'web-1', lane: 'spend', kind: 'render', startedAt: 'now' }],
  queued: [],
  lastRunStatus: null,
};

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider><ApplicationCard /></ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  globalLive.state = { active: [], queued: [], lastRunStatus: null };
  server.use(
    http.get('/api/health', () => HttpResponse.json({ ok: true, bootId: 'boot-1', setupComplete: true })),
    http.post('/api/app/restart', () => HttpResponse.json({ ok: true, restart: true })),
    http.post('/api/app/quit', () => HttpResponse.json({ ok: true, quit: true })),
  );
});

describe('ApplicationCard', () => {
  it('restart with nothing rendering: NO confirm — straight to the reconnecting overlay', async () => {
    let restarted = false;
    server.use(http.post('/api/app/restart', () => {
      restarted = true;
      return HttpResponse.json({ ok: true, restart: true });
    }));
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('Restarting the studio…')).toBeInTheDocument();
    expect(restarted).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('restart during a render confirms honestly (charge stands, shot may be lost)', async () => {
    globalLive.state = RENDERING;
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restart during a render?' });
    expect(dialog).toHaveTextContent(/the fal\.ai charge\s+stands/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep rendering' }));
    expect(screen.queryByText('Restarting the studio…')).not.toBeInTheDocument();
  });

  it('shut down always confirms; confirming shows the farewell state', async () => {
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Shut down' }));
    const dialog = await screen.findByRole('dialog', { name: 'Shut down the studio?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));
    expect(await screen.findByText('The studio is off.')).toBeInTheDocument();
    expect(screen.getByText(/npm run web/)).toBeInTheDocument();
    expect(screen.getByText(/reconnect on its own/)).toBeInTheDocument();
  });

  it('shut down during a render leads with the money truth', async () => {
    globalLive.state = RENDERING;
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Shut down' }));
    const dialog = await screen.findByRole('dialog', { name: 'Shut down during a render?' });
    expect(dialog).toHaveTextContent(/finished video may never land/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep rendering' }));
    expect(screen.queryByText('The studio is off.')).not.toBeInTheDocument();
  });
});
