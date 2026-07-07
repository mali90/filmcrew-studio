import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server, http, HttpResponse } from '../../../test/msw';
import { makeRun } from '../../../test/fixtures';
import { renderReview, markPaidConfirmed, clearPaidState } from './test-helpers';
import { ChangeRequestPanel } from './ChangeRequestPanel';

afterEach(clearPaidState);

const withRevision = (scope: string) => {
  const run = makeRun('review');
  run.manifest!.revisions = [
    { id: 'r1', feedback: 'the keeper should look older', scope, owners: [2, 7], createdAt: '2026-07-04T11:00:00.000Z' },
  ];
  return run; // latest take createdAt is 10:00 — the revision is newer
};

describe('ChangeRequestPanel', () => {
  it('sends feedback to the engine with a job scope', async () => {
    const run = makeRun('review');
    let reviseBody: unknown = null;
    server.use(
      http.post('/api/runs/:id/revise', async ({ request }) => {
        reviseBody = await request.json();
        return HttpResponse.json({ revisionId: 'r1' });
      }),
    );

    renderReview(<ChangeRequestPanel run={run} />);
    const send = screen.getByRole('button', { name: /Send to the engine/ });
    expect(send).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'K2' }));
    fireEvent.change(screen.getByLabelText('Describe what should change'), {
      target: { value: 'the keeper should look older' },
    });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    await waitFor(() =>
      expect(reviseBody).toEqual({ feedback: 'the keeper should look older', scope: 'K2' }),
    );
    expect(await screen.findByText('Change request sent — the agents take it from here.')).toBeInTheDocument();
  });

  it('shows the re-render row with the seam warning once the plan is newer than the latest take', async () => {
    const run = withRevision('K1');
    renderReview(<ChangeRequestPanel run={run} />);

    expect(screen.getByText('The plan changed since this cut.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send to the engine/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-render K1 only/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-render K1 \+ downstream/ })).toBeInTheDocument();
    expect(
      screen.getByText(/K2 was chained from K1.s last frame — re-rendering K1 alone may show a visible seam\./),
    ).toBeInTheDocument();
    // both buttons carry the estimate price
    await waitFor(() => expect(screen.getAllByLabelText('estimated cost $4.16')).toHaveLength(2));
  });

  it('posts rerender-job with cascade from the downstream button', async () => {
    markPaidConfirmed();
    const run = withRevision('K1');
    let body: unknown = null;
    server.use(
      http.post('/api/runs/:id/rerender-job', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: ['K1', 'K2'] });
      }),
    );

    renderReview(<ChangeRequestPanel run={run} />);
    // money buttons stay disabled until their price is stated — wait for the estimate first
    await waitFor(() => expect(screen.getAllByLabelText('estimated cost $4.16').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /Re-render K1 \+ downstream/ }));
    await waitFor(() => expect(body).toEqual({ jobId: 'K1', cascade: true }));
  });

  it('offers a single full re-render when the revision scope was the whole video', async () => {
    markPaidConfirmed();
    const run = withRevision('whole');
    let body: unknown = null;
    server.use(
      http.post('/api/runs/:id/render', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ takeId: 't2', estUsd: 4.16 });
      }),
    );

    renderReview(<ChangeRequestPanel run={run} />);
    expect(screen.queryByText(/visible seam/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByLabelText('estimated cost $4.16').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /Re-render all/ }));
    await waitFor(() => expect(body).toEqual({ mode: 'full' }));
  });
});
