// Job cards tell the truth about each render job: queued, sweeping+elapsed, done, or failed with
// a priced retry.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RenderView } from '../../../../shared/api-types';
import { http, HttpResponse, server } from '../../test/msw';
import { makeRun } from '../../test/fixtures';
import { renderWithProviders } from './test-harness';
import { JobCards } from './JobCards';

const renderView = (jobs: RenderView['jobs']): RenderView => ({
  dir: '/abs/runs/x/renders/t1',
  backend: 'kling',
  jobs,
  master: null,
  masterExists: false,
  masterUrl: null,
  cover: null,
  coverUrl: null,
});

describe('JobCards', () => {
  it('shows an indeterminate sweep for the active job and a queued pill for the next', () => {
    const run = makeRun('rendering');
    renderWithProviders(<JobCards run={run} />);
    const k1 = screen.getByLabelText('Job K1');
    expect(within(k1).getByText('Rendering')).toBeInTheDocument();
    expect(within(k1).getByTestId('sweep-K1')).toBeInTheDocument();
    expect(within(k1).getByText('typ. 3–6 min')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Job K2')).getByText('Queued')).toBeInTheDocument();
  });

  it('a finished job shows a done pill and a playable clip', () => {
    const run = makeRun('rendering', {
      latestRender: renderView([
        { jobId: 'K1', clip: '/abs/clip1.mp4', clipExists: true, clipUrl: '/api/media/x/K1.mp4', error: null },
        { jobId: 'K2', clip: null, clipExists: false, clipUrl: null, error: null },
      ]),
    });
    renderWithProviders(<JobCards run={run} />);
    const k1 = screen.getByLabelText('Job K1');
    expect(within(k1).getByText('Done')).toBeInTheDocument();
    expect(within(k1).getByLabelText('Clip for job K1')).toBeInTheDocument();
  });

  it('a failed job surfaces the error and its priced Retry posts /rerender-job', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs/:id/rerender-job', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: [] });
    }));
    const run = makeRun('attention', {
      latestRender: renderView([
        { jobId: 'K1', clip: '/abs/clip1.mp4', clipExists: true, clipUrl: '/api/media/x/K1.mp4', error: null },
        { jobId: 'K2', clip: null, clipExists: false, clipUrl: null, error: 'model exploded' },
      ]),
    });
    renderWithProviders(<JobCards run={run} />);
    const k2 = screen.getByLabelText('Job K2');
    expect(within(k2).getByText('Failed')).toBeInTheDocument();
    expect(within(k2).getByText('model exploded')).toBeInTheDocument();
    const retry = await within(k2).findByRole('button', { name: /^Retry K2/ });
    await within(k2).findByText('≈ $4.16'); // price arrives from /estimate?mode=job
    await userEvent.click(retry);
    await vi.waitFor(() => expect(body).toEqual({ jobId: 'K2' }));
  });

  it('Cancel render posts /cancel while the run is rendering', async () => {
    let cancelled: string | undefined;
    server.use(http.post('/api/runs/:id/cancel', ({ params }) => {
      cancelled = String(params.id);
      return HttpResponse.json({ cancelled: 'active' });
    }));
    renderWithProviders(<JobCards run={makeRun('rendering')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel render' }));
    await vi.waitFor(() => expect(cancelled).toBe('web-20260704100000-ab12'));
  });
});
