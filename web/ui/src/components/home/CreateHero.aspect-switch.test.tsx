// Switching to a model that cannot render the picked ratio must TRIM the pick — in the tiles, in the
// status line and in what is posted. Both models on offer today share one ratio list, so the only way
// to exercise the switch end to end is to widen one of them: the facade is stubbed so Seedance reports
// an extra ratio, and everything else (the trim rule, the note, the payload) is the real component.
// The pure rule itself is asserted against the real registry in CreateHero.caps.test.tsx (trimAspect)
// and CreateHero.registry.test.tsx.
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

vi.mock('../../../../shared/render-models', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/render-models')>();
  return {
    ...real,
    // as if Seedance's registry entry listed one wide ratio Kling has no answer for
    aspectsFor: (value: string) =>
      (real.modelIdFor(value) === 'seedance-2.0' ? [...real.aspectsFor(value), '21:9'] : real.aspectsFor(value)),
  };
});

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

describe('Home — an aspect the next model cannot render', () => {
  it('trims the pick on switch, says so, and posts the trimmed ratio', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ runId: 'web-aspect-trim-1' });
    }));
    renderHome();

    await userEvent.click(screen.getByRole('radio', { name: 'Seedance 2.0' }));
    const group = screen.getByRole('radiogroup', { name: 'Aspect ratio' });
    await userEvent.click(within(group).getByRole('radio', { name: '21:9' }));
    expect(within(group).getByRole('radio', { name: '21:9' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: 'Kling' }));
    expect(within(group).queryByRole('radio', { name: '21:9' })).not.toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: '16:9' })).toHaveAttribute('aria-checked', 'true');
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('21:9');
    expect(note).toHaveTextContent('Kling 3.0 Omni');

    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a wide shore{Enter}');
    await screen.findByText('run page web-aspect-trim-1');
    expect(body?.aspect).toBe('16:9');
  });
});
