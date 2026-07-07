// The Library page: grid + status pills, intent filters with live counts, the pinned
// Needs-attention group (extracted, never duplicated), delete flow, and both empty states.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse, server } from '../test/msw';
import { makeRun } from '../test/fixtures';
import type { RunStatus } from '../../../shared/api-types';
import { ToastProvider } from '../components/ui/Toast';
import LibraryPage from './Library';

function renderLibrary(initialEntry = '/library') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/" element={<div>home page</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const sixStatuses = () => {
  const statuses: RunStatus[] = ['planning', 'plan-ready', 'rendering', 'attention', 'review', 'complete'];
  return statuses.map((s, i) => makeRun(s, { id: `run-${i}` }));
};

describe('Library — grid', () => {
  it('renders one card per run with the correct status pill text and the run count', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: sixStatuses() })));
    renderLibrary();
    const library = await screen.findByRole('region', { name: 'Run library' });
    for (const label of ['Planning', 'Plan ready', 'Rendering', 'Needs attention', 'Needs review', 'Complete']) {
      expect(within(library).getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
    expect(within(library).getAllByRole('link')).toHaveLength(6);
    expect(within(library).getByText('6 runs')).toBeInTheDocument();
  });

  it('attention runs are PINNED above the rest — extracted, never duplicated', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({
      runs: [makeRun('complete', { id: 'done-1' }), makeRun('attention', { id: 'broken-1' })],
    })));
    renderLibrary();
    await screen.findByRole('heading', { name: /Needs attention/ });
    expect(screen.getByRole('heading', { name: 'Everything else' })).toBeInTheDocument();
    // the attention card renders exactly once, with its one-line error hint as the caption
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByText('fal job failed: boom — open to resume.')).toBeInTheDocument();
  });

  it('no attention runs → no group headers at all (the clean flat grid)', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: [makeRun('complete')] })));
    renderLibrary();
    await screen.findByRole('region', { name: 'Run library' });
    expect(screen.queryByRole('heading', { name: /Needs attention/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Everything else' })).not.toBeInTheDocument();
  });
});

describe('Library — filters', () => {
  it('chips carry live counts; Waiting on you = plan-ready + review + attention only', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: sixStatuses() })));
    renderLibrary();
    const chips = await screen.findByRole('radiogroup', { name: 'Filter runs by status' });
    expect(within(chips).getByRole('radio', { name: /All\s*6/ })).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole('radio', { name: /Waiting on you\s*3/ }));
    expect(screen.getAllByRole('link')).toHaveLength(3); // plan-ready + review + attention
    await userEvent.click(within(chips).getByRole('radio', { name: /Complete\s*1/ }));
    expect(screen.getAllByRole('link')).toHaveLength(1);
    // under Complete the user asked for something narrower — no pinning
    expect(screen.queryByRole('heading', { name: /Needs attention/ })).not.toBeInTheDocument();
  });

  it('?filter=complete deep-link applies on load', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: sixStatuses() })));
    renderLibrary('/library?filter=complete');
    await screen.findByRole('region', { name: 'Run library' });
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Complete/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('filtered-empty shows the quiet line and Show all resets', async () => {
    // runs exist but none are complete; the zero-count chip is hidden, yet a deep link can still land here
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: [makeRun('planning')] })));
    renderLibrary('/library?filter=complete');
    await screen.findByText('No finished films yet.');
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('zero-count chips hide; with nothing to filter the whole control disappears', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: [makeRun('planning')] })));
    renderLibrary();
    await screen.findByRole('region', { name: 'Run library' });
    expect(screen.queryByRole('radiogroup', { name: 'Filter runs by status' })).not.toBeInTheDocument();
  });
});

describe('Library — delete', () => {
  it('confirm dialog → DELETE is called and a toast reports the freed bytes', async () => {
    let deletedId: string | undefined;
    server.use(
      http.get('/api/runs', () => HttpResponse.json({ runs: [makeRun('plan-ready')] })),
      http.delete('/api/runs/:id', ({ params }) => {
        deletedId = String(params.id);
        return HttpResponse.json({ deleted: true, bytes: 1048576 });
      }),
    );
    renderLibrary();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete run Ocean Lighthouse' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this run?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Deleted — 1.0 MB freed.');
    expect(deletedId).toBe('web-20260704100000-ab12');
  });

  it('a 409 delete (active run) shows the server hint as an error toast', async () => {
    server.use(
      http.get('/api/runs', () => HttpResponse.json({ runs: [makeRun('rendering')] })),
      http.delete('/api/runs/:id', () =>
        HttpResponse.json({ error: 'run is active', hint: 'Stop the active job before deleting this run.' }, { status: 409 })),
    );
    renderLibrary();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete run Ocean Lighthouse' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Stop the active job before deleting this run.');
  });
});

describe('Library — empty', () => {
  it('zero runs → EmptyState pointing back to Create, no filter chips', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: [] })));
    renderLibrary();
    await screen.findByText('Nothing here yet.');
    expect(screen.getByText(/Runs you start will collect here/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start your first video' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});
