// PlanReview: the money moment. Estimates on the buttons, the one-time paid confirm, LLM-cost revise.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse, server } from '../../test/msw';
import { makeRun } from '../../test/fixtures';
import { clearPaidState, markPaidConfirmed, renderRunPage } from './test-harness';

beforeEach(() => clearPaidState());

describe('PlanReview', () => {
  it('both render buttons carry their estimated price from /estimate', async () => {
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });
    const probe = await screen.findByRole('button', { name: /^Probe/ });
    const full = screen.getByRole('button', { name: /^Full render/ });
    expect(within(probe).getByText('≈ $4.16')).toBeInTheDocument();
    expect(within(full).getByText('≈ $4.16')).toBeInTheDocument();
    // probe-first guidance: no takes yet → Probe is the primary action
    expect(probe.className).toContain('bg-accent');
  });

  it('a single-job plan offers only the full render — a probe would be the same render at the same price', async () => {
    const run = structuredClone(makeRun('plan-ready')); // never mutate the shared fixture spec
    run.spec!.kling.jobs = run.spec!.kling.jobs.slice(0, 1);
    renderRunPage(run);
    await screen.findByRole('region', { name: 'The plan is ready' });
    const full = await screen.findByRole('button', { name: /^Full render/ });
    expect(screen.queryByRole('button', { name: /^Probe/ })).not.toBeInTheDocument();
    expect(full.className).toContain('bg-accent'); // the only paid path is the primary action
    expect(within(full).getByText('≈ $4.16')).toBeInTheDocument();
  });

  it('the first paid click asks once, then POSTs the probe render', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs/:id/render', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ takeId: 't1', estUsd: 4.16 });
    }));
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });

    await userEvent.click(await screen.findByRole('button', { name: /^Probe/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Before your first paid action' });
    expect(dialog).toHaveTextContent('This calls fal.ai');
    expect(body).toBeUndefined(); // nothing charged before the confirm
    await userEvent.click(within(dialog).getByRole('button', { name: /^Start probe/ }));
    await vi.waitFor(() => expect(body).toEqual({ mode: 'probe' }));

    // once confirmed, the next paid click goes straight through
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a confirmed browser renders without the dialog', async () => {
    markPaidConfirmed();
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs/:id/render', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ takeId: 't1', estUsd: 4.16 });
    }));
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });
    await userEvent.click(await screen.findByRole('button', { name: /^Full render/ }));
    await vi.waitFor(() => expect(body).toEqual({ mode: 'full' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Revise the plan opens an inline textarea and posts whole-scope feedback (LLM-only cost)', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs/:id/revise', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ revisionId: 'rev-1' });
    }));
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });

    await userEvent.click(screen.getByRole('button', { name: 'Revise the plan' }));
    await userEvent.type(
      screen.getByLabelText('What should change? Revising re-runs the planning agents — LLM usage only, no render cost.'),
      'Make the opening slower.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback (no render cost)' }));
    await vi.waitFor(() => expect(body).toEqual({ feedback: 'Make the opening slower.', scope: 'whole' }));
  });

  it('Discard asks for confirmation, deletes the run and returns home', async () => {
    let deleted: string | undefined;
    server.use(http.delete('/api/runs/:id', ({ params }) => {
      deleted = String(params.id);
      return HttpResponse.json({ deleted: true, bytes: 42 });
    }));
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard this run?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard run' }));
    await screen.findByText('home page');
    expect(deleted).toBe('web-20260704100000-ab12');
  });
});
