// AttentionBanner: a permanent surface (role=alert) with the persisted error and the cheapest
// sensible recovery — free assembly when clips already exist, a priced restart when nothing does.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RenderView } from '../../../../shared/api-types';
import { http, HttpResponse, server } from '../../test/msw';
import { makeRun } from '../../test/fixtures';
import { renderWithProviders } from './test-harness';
import { AttentionBanner } from './AttentionBanner';

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

describe('AttentionBanner', () => {
  it('surfaces the persisted error with its log tail as a permanent alert', () => {
    renderWithProviders(<AttentionBanner run={makeRun('attention')} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The render step stopped.');
    expect(alert).toHaveTextContent('fal job failed: boom');
    expect(alert).toHaveTextContent('ERR boom');
  });

  it('clips exist but no master → the free assemble action POSTs /assemble', async () => {
    let posted: string | undefined;
    server.use(http.post('/api/runs/:id/assemble', ({ params }) => {
      posted = String(params.id);
      return HttpResponse.json({ ok: true });
    }));
    const run = makeRun('attention', {
      latestRender: renderView([
        { jobId: 'K1', clip: '/abs/c1.mp4', clipExists: true, clipUrl: '/api/media/c1.mp4', error: null },
        { jobId: 'K2', clip: null, clipExists: false, clipUrl: null, error: 'model exploded' },
      ]),
    });
    renderWithProviders(<AttentionBanner run={run} />);
    const alert = screen.getByRole('alert');
    // a failed job's retry lives on its card — the banner only points there
    expect(alert).toHaveTextContent(/its Retry button lives on the job card/);
    await userEvent.click(within(alert).getByRole('button', { name: 'Finish free (assemble)' }));
    await vi.waitFor(() => expect(posted).toBe('web-20260704100000-ab12'));
  });

  it('a fully interrupted render offers a priced resume and a discard', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs/:id/render', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ takeId: 't2', estUsd: 4.16 });
    }));
    renderWithProviders(<AttentionBanner run={makeRun('attention')} />); // no latestRender at all
    const alert = screen.getByRole('alert');
    const resume = within(alert).getByRole('button', { name: /^Resume: re-render/ });
    await within(alert).findByText('≈ $4.16'); // price arrives from /estimate?mode=full
    expect(within(alert).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    await userEvent.click(resume);
    await vi.waitFor(() => expect(body).toEqual({ mode: 'full' }));
  });

  it('a failed change on a run with a healthy master offers Dismiss — back to review (never a dead end)', async () => {
    let posted: string | undefined;
    server.use(http.post('/api/runs/:id/dismiss-error', ({ params }) => {
      posted = String(params.id);
      return HttpResponse.json({ dismissed: true });
    }));
    // review-shaped artifacts (master exists) + a persisted upscale error = the stranded case
    const run = makeRun('review', {
      status: 'attention',
      error: { ts: '2026-07-04T10:00:00.000Z', action: 'upscale', message: 'Topaz rejected the file', logTail: [] },
    });
    renderWithProviders(<AttentionBanner run={run} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/stitched video is intact/i);
    // no paid resume offered — the master is fine
    expect(within(alert).queryByRole('button', { name: /Resume/ })).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss — back to review' }));
    await vi.waitFor(() => expect(posted).toBe('web-20260704100000-ab12'));
  });

  it('a failed plan offers a Retry planning (not a paid re-render that cannot work)', async () => {
    let posted: string | undefined;
    server.use(http.post('/api/runs/:id/plan', ({ params }) => {
      posted = String(params.id);
      return HttpResponse.json({ queued: { id: 1 } });
    }));
    const run = makeRun('planning', {
      status: 'attention',
      error: { ts: '2026-07-04T10:00:00.000Z', action: 'plan', message: 'LLM died', logTail: [] },
    });
    renderWithProviders(<AttentionBanner run={run} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).queryByRole('button', { name: /Resume/ })).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry planning' }));
    await vi.waitFor(() => expect(posted).toBe('web-20260704100000-ab12'));
  });

  it('a failed revision on an unrendered plan offers Dismiss — back to the plan', async () => {
    server.use(http.post('/api/runs/:id/dismiss-error', () => HttpResponse.json({ dismissed: true })));
    const run = makeRun('plan-ready', {
      status: 'attention',
      error: { ts: '2026-07-04T10:00:00.000Z', action: 'revise', message: 'revise exited 1', logTail: [] },
    });
    renderWithProviders(<AttentionBanner run={run} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Dismiss — back to the plan' })).toBeInTheDocument();
    expect(within(alert).queryByRole('button', { name: /Resume/ })).not.toBeInTheDocument();
  });
});
