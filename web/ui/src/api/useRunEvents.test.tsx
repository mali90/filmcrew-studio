// What the run stream INVALIDATES. The reducer's own folding is pinned in run-events.test.ts; this
// file pins the other half — the REST caches an event has to expire, because the reducer cannot.
//
// The prompt sheet is the one that bites: it stays mounted through a whole review, and everything it
// shows is server-composed (the version picker's take list, the plan's words, the stale banner). A
// re-render that finishes, or a revise that rewrites the spec, moves all three on disk while the
// cached view goes on claiming otherwise.
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import type { RunEvent } from '../../../shared/api-types';
import { MockEventSource } from '../test/mock-event-source';
import { useRunEvents } from './useRunEvents';

function Probe({ runId }: { runId: string }) {
  const { connected } = useRunEvents(runId);
  return <div data-testid="probe">{String(connected)}</div>;
}

/** Mount the hook and hand back a spy over the client's invalidations. */
async function mountStream(runId = 'r1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  // The stream opens and the snapshot query settles on microtasks, both of which set state.
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <Probe runId={runId} />
      </QueryClientProvider>,
    );
  });
  const keysAfter = (event: RunEvent) => {
    invalidate.mockClear();
    act(() => { MockEventSource.emit(`/api/runs/${runId}/events`, event); });
    return invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  };
  return { keysAfter };
}

describe('useRunEvents — cache invalidation', () => {
  it('a finished render expires the prompt views: the new take is a version you can open', async () => {
    const { keysAfter } = await mountStream();
    expect(keysAfter({ type: 'done', kind: 'render', result: null })).toContain('["prompts","r1"]');
  });

  it('a revise expires them too — the spec the CURRENT view is composed from was rewritten', async () => {
    const { keysAfter } = await mountStream();
    expect(keysAfter({ type: 'spec-block', file: 'spec-03.json' })).toContain('["prompts","r1"]');
    expect(keysAfter({ type: 'done', kind: 'revise', result: null })).toContain('["prompts","r1"]');
  });

  it('a prompt edit still expires them, and a log line still expires nothing', async () => {
    const { keysAfter } = await mountStream();
    expect(keysAfter({ type: 'prompt-override', jobId: 'K1', action: 'saved', source: 'override', stale: false }))
      .toContain('["prompts","r1"]');
    expect(keysAfter({ type: 'log', cursor: 1, line: 'rendering…' })).toEqual([]);
  });
});
