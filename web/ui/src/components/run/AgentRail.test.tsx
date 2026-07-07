// AgentRail states driven the way the browser drives them: an SSE snapshot seeds the rail, then
// agent/qc/error events flip individual rows.
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse, server } from '../../test/msw';
import { makeRun, SPEC } from '../../test/fixtures';
import { MockEventSource } from '../../test/mock-event-source';
import { renderRunPage } from './test-harness';

const RUN_ID = 'web-20260704100000-ab12';
const emit = (data: unknown) => act(() => { MockEventSource.emit(`/runs/${RUN_ID}/events`, data); });

describe('AgentRail — silent-state banners', () => {
  it('a live revision names its re-running owners instead of a dead all-done rail', async () => {
    const run = makeRun('planning');
    run.agents = { done: 8, total: 8, qcCycles: 1 };
    run.revising = { id: 'r1', owners: [4, 5], scope: 'K3' };
    run.manifest = { ...run.manifest!, activeJob: { kind: 'revise', pid: 9, startedAt: 'x' } as never };
    renderRunPage(run);
    emit({ type: 'snapshot', run });
    expect(await screen.findByText('Revising — Casting, Sound')).toBeInTheDocument();
  });

  it('a plan queued behind other work says so, with its lane position', async () => {
    const run = makeRun('planning');
    run.manifest = { ...run.manifest!, activeJob: null };
    run.queue = { position: 1 };
    renderRunPage(run);
    emit({ type: 'snapshot', run });
    expect(await screen.findByText('Queued — position 1 in the planning lane')).toBeInTheDocument();
  });
});

describe('AgentRail — live states', () => {
  it('agent-started event: the thinking row shimmers its "doing" line and earlier rows show receipts', async () => {
    renderRunPage(makeRun('planning'));
    await screen.findByRole('region', { name: 'Production plan' });

    emit({ type: 'snapshot', run: makeRun('planning', { spec: SPEC }) });
    emit({ type: 'agent', idx: 3, state: 'started' });

    const doing = screen.getByText('Choosing framing and camera moves…');
    expect(doing).toHaveClass('shimmer');
    // agents 0–2 were already done on disk (agents.done = 3) — receipts from the spec
    expect(screen.getByText(/“Ocean Lighthouse” — On the last night/)).toBeInTheDocument();
    expect(screen.getByText('3 shots · ~13s')).toBeInTheDocument();
    expect(screen.getByText('prompts written for 3 shots')).toBeInTheDocument();
    // agents 4–7 still waiting on their future lines
    expect(screen.getByText('will pin reference elements')).toBeInTheDocument();
  });

  it('qc redo event: flagged owners flip to redo with a ×1 count', async () => {
    renderRunPage(makeRun('planning'));
    await screen.findByRole('region', { name: 'Production plan' });

    emit({ type: 'snapshot', run: makeRun('planning', { spec: SPEC }) });
    emit({ type: 'qc', state: 'redo', owners: [2] });

    expect(screen.getByText('×1')).toBeInTheDocument();
    expect(screen.getByText('reopened by QC — revising this block')).toBeInTheDocument();
  });

  it('done receipts read the spec: job packing, framing and QC approval lines', async () => {
    renderRunPage(makeRun('plan-ready'));
    const rail = await screen.findByRole('region', { name: 'Production plan' });
    // plan-ready collapses the rail — expand it to see the 8 receipts
    await userEvent.click(within(rail).getByRole('button', { name: 'Show the 8 agents' }));

    expect(screen.getByText('3 shots framed')).toBeInTheDocument();
    expect(screen.getByText('1 element(s) pinned')).toBeInTheDocument();
    expect(screen.getByText('1 voice line(s)')).toBeInTheDocument();
    expect(screen.getByText('2 job(s) · K1 9s · K2 4s')).toBeInTheDocument();
    expect(screen.getByText('Approved · pass 1')).toBeInTheDocument();
  });

  it('an engine error fails the thinking agent; Retry on an UNPLANNED run re-runs the engine (never a revise, which needs a spec)', async () => {
    let replanned = false;
    server.use(http.post('/api/runs/:id/plan', () => {
      replanned = true;
      return HttpResponse.json({ queued: { id: 1 } });
    }));
    renderRunPage(makeRun('planning'));
    await screen.findByRole('region', { name: 'Production plan' });

    emit({ type: 'snapshot', run: makeRun('planning') });
    emit({ type: 'agent', idx: 3, state: 'started' });
    emit({ type: 'error', kind: 'plan', message: 'the model crashed' });

    expect(screen.getByText('stopped before finishing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(replanned).toBe(true));
  });

  it('a retry that the server rejects surfaces the error instead of silently doing nothing', async () => {
    server.use(http.post('/api/runs/:id/plan', () =>
      HttpResponse.json({ error: 'planning is already running for this run' }, { status: 409 })));
    renderRunPage(makeRun('planning'));
    await screen.findByRole('region', { name: 'Production plan' });

    emit({ type: 'snapshot', run: makeRun('planning') });
    emit({ type: 'agent', idx: 3, state: 'started' });
    emit({ type: 'error', kind: 'plan', message: 'the model crashed' });

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/already running/);
  });
});
