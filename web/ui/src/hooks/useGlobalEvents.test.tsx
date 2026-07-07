// The global stream is a shared, refcounted singleton: N subscribers must cost ONE connection
// (browsers cap ~6 per origin — the shell, queue strip, and notifications would eat three).
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { MockEventSource } from '../test/mock-event-source';
import { useGlobalEvents } from './useGlobalEvents';

function ActiveCount({ label }: { label: string }) {
  const { active } = useGlobalEvents();
  return <div data-testid={label}>{active.length}</div>;
}

function renderSubscribers() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ActiveCount label="a" />
      <ActiveCount label="b" />
      <ActiveCount label="c" />
    </QueryClientProvider>,
  );
}

describe('useGlobalEvents', () => {
  it('three subscribers share ONE /api/events connection and all fold the same events', () => {
    const { unmount } = renderSubscribers();
    expect(MockEventSource.openCount('/api/events')).toBe(1);

    act(() => {
      MockEventSource.emit('/api/events', {
        type: 'queue',
        active: [{ id: 1, runId: 'r1', lane: 'spend', kind: 'render', startedAt: 'now' }],
        queued: [],
      });
    });
    expect(screen.getByTestId('a')).toHaveTextContent('1');
    expect(screen.getByTestId('b')).toHaveTextContent('1');
    expect(screen.getByTestId('c')).toHaveTextContent('1');

    // last unsubscriber closes the stream (no leaked connections between pages)
    unmount();
    expect(MockEventSource.openCount('/api/events')).toBe(0);
  });
});
