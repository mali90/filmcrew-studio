import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backend, RunDetail } from '../../../../../shared/api-types';
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

/** Re-point the run at a backend and give every job `count` cast references — the images the
 *  reference budget spends before it can afford a boundary pin (SEAM_PRIORITY drops the closing
 *  one first). Mirrors SegmentRerenderDialog.test's own fixture: the rule is the same rule. */
function withCast(run: RunDetail, backend: Backend, count: number): RunDetail {
  run.backend = backend;
  run.latestRender!.backend = backend;
  const elements = Array.from({ length: count }, (_, i) => ({ id: `cast${i}`, role: 'subject', image: `elements/references/cast${i}.png` }));
  run.spec!.kling.elements = elements;
  for (const j of run.spec!.kling.jobs) j.elements = elements.map((e) => e.id);
  return run;
}

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

  it('shows the re-render row once the plan is newer than the latest take', async () => {
    const run = withRevision('K1');
    renderReview(<ChangeRequestPanel run={run} />);

    expect(screen.getByText('The plan changed since this cut.')).toBeInTheDocument();
    // The plan moving is a consequence to act on, not a fourth choice — the three ways to change
    // something stay right where they were, under it (spec D30).
    expect(screen.getByRole('button', { name: /Tell the agents/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-render K1 only/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByLabelText('estimated cost $4.16').length).toBeGreaterThan(0));
  });

  // Both buttons here post `boundaries: 'auto'`, and Auto pins this ending: K2 is on record as
  // opening on K1's last frame, and Kling has a native closing anchor. The solo re-render therefore
  // lands on K2's opening frame and records the joint as intact — so the seam is not predicted, and
  // the cascade that would rebuild untouched downstream footage is not sold. Same rule, same
  // helper, as SegmentRerenderDialog (which owns the deeper matrix of this).
  it('states the join Auto keeps, and withholds the cascade that would repair nothing', async () => {
    const run = withRevision('K1');
    renderReview(<ChangeRequestPanel run={run} />);

    const note = screen.getByTestId('rail-seam-note');
    expect(note).toHaveTextContent(/keeps that join seamless/);
    expect(note).toHaveTextContent(/K2 and everything after it can stay exactly as they are/);
    expect(screen.queryByRole('button', { name: /Re-render K1 \+ downstream/ })).not.toBeInTheDocument();
    // …and the cascade nobody is offered is never priced either.
    await waitFor(() => expect(screen.getAllByLabelText('estimated cost $4.16')).toHaveLength(1));
  });

  it('a join that was never recorded is neither warned about nor cascaded', () => {
    const run = withRevision('K1');
    // Reconstructed, not observed: `resolveBoundaries` refuses to act on a derived verdict, so auto
    // pins no ending — and there is no recorded join to promise anything about either.
    run.continuity = (run.continuity ?? []).map((e) => (e.jobId === 'K2' ? { ...e, confidence: 'derived' as const } : e));
    renderReview(<ChangeRequestPanel run={run} />);

    expect(screen.queryByTestId('rail-seam-note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-render K1 \+ downstream/ })).not.toBeInTheDocument();
  });

  it('offers and posts the cascade when the reference budget drops that ending pin', async () => {
    markPaidConfirmed();
    // 9 cast references on a 9-image model: the closing pin has no slot left, so the join really
    // does break and re-rendering downstream is the only thing that repairs it.
    const run = withCast(withRevision('K1'), 'seedance-2.0@fal', 9);
    let body: unknown = null;
    server.use(
      http.post('/api/runs/:id/rerender-job', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: ['K1', 'K2'] });
      }),
    );

    renderReview(<ChangeRequestPanel run={run} />);
    expect(screen.getByTestId('rail-seam-note')).toHaveTextContent(/K2.s join will break/);
    // money buttons stay disabled until their price is stated — wait for the estimate first
    await waitFor(() => expect(screen.getAllByLabelText('estimated cost $4.16')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /Re-render K1 \+ downstream/ }));
    await waitFor(() => expect(body).toEqual({ jobId: 'K1', boundaries: 'auto', cascade: true }));
  });

  it('a plan-changed re-render on Segmind holds the clip\u2019s starting point \u2014 and says so', async () => {
    markPaidConfirmed();
    const run = withCast(withRevision('K1'), 'seedance-2.0@segmind', 1);
    let body: unknown = null;
    server.use(
      http.post('/api/runs/:id/rerender-job', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: [], boundaries: { mode: 'auto' }, seed: 70000 });
      }),
    );

    renderReview(<ChangeRequestPanel run={run} />);
    // The words moved, the picture holds: the post is an EXPLICIT fix. Omission would mean the
    // deterministic default \u2014 after a Fresh take that is neither this clip\u2019s seed nor a fresh
    // one, a third starting point nobody chose.
    expect(screen.getByTestId('plan-changed-fix-note')).toHaveTextContent(
      'Keeps K1\u2019s starting point \u2014 your new words on the same picture.');
    await waitFor(() => expect(screen.getAllByLabelText('estimated cost $4.16').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /Re-render K1 only/ }));
    await waitFor(() => expect(body).toEqual({ jobId: 'K1', boundaries: 'auto', seedMode: 'fix' }));
  });

  it('a cap-less backend gets no fix note and posts no seed field (the Kling body test above is the wire proof)', () => {
    renderReview(<ChangeRequestPanel run={withRevision('K1')} />);
    expect(screen.queryByTestId('plan-changed-fix-note')).not.toBeInTheDocument();
  });

  it('when the cascade button is offered, the fix note says downstream keeps its own starting points', async () => {
    // 9 cast references on the 9-image Segmind endpoint: the closing pin has no slot, the join
    // breaks, and the cascade button appears — so the caption under BOTH buttons must disclose
    // that the held starting point applies to the chosen segment alone (the dialog's cascade
    // note makes the identical disclosure; the two surfaces must read the same).
    const run = withCast(withRevision('K1'), 'seedance-2.0@segmind', 9);
    renderReview(<ChangeRequestPanel run={run} />);
    expect(screen.getByRole('button', { name: /Re-render K1 \+ downstream/ })).toBeInTheDocument();
    expect(screen.getByTestId('plan-changed-fix-note')).toHaveTextContent(
      'K2 and everything after it follow from their own starting points.');
  });

  it('row 3 opens the segment dialog, and that dialog is the only re-render implementation', async () => {
    markPaidConfirmed();
    const run = makeRun('review');
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/runs/:id/rerender-job', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: [], boundaries: { mode: 'both' } });
      }),
    );

    renderReview(<ChangeRequestPanel run={run} />);
    // Row 3 states its cost in words; the figure belongs to the dialog's PaidButton, so the rail
    // never carries a second, un-priced money button (spec D29).
    const row = screen.getByRole('button', { name: /Re-render one segment/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'K2' }));      // the segment picker
    fireEvent.click(screen.getByRole('button', { name: /^Re-render K2…$/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Re-render K2' });
    expect(within(dialog).getByTestId('boundary-plan-sentence')).toHaveTextContent("K2 will start from K1's last frame");
    await screen.findByLabelText('estimated cost $4.16');

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Re-render K2 estimated/ }));
    await waitFor(() => expect(bodies).toEqual([{ jobId: 'K2', boundaries: 'start' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('one row is open at a time, and the prompt row spends nothing', () => {
    renderReview(<ChangeRequestPanel run={makeRun('review')} />);
    expect(screen.getByRole('button', { name: /Tell the agents/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Edit a prompt/ }));
    expect(screen.getByRole('button', { name: /Tell the agents/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /Open K1's prompt/ })).toBeInTheDocument();
    // "free" is only ever said about something that really is: saving words is a local file write.
    expect(screen.getByText(/Saving is free — you pay only when you re-render/)).toBeInTheDocument();
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
