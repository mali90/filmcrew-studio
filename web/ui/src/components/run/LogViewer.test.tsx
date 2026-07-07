// LogViewer: collapsed by default, forced open on attention, follows the tail until the user
// scrolls back — then a quiet pill offers the way home.
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeRun } from '../../test/fixtures';
import { renderWithProviders } from './test-harness';
import { LogViewer } from './LogViewer';

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ cursor: i, line: `line ${i}` }));
const quietLive = { log: lines(0), activeKind: null, lastError: null };

describe('LogViewer', () => {
  it('starts collapsed and opens from the header row', async () => {
    renderWithProviders(<LogViewer run={makeRun('rendering')} live={{ ...quietLive, log: lines(3) }} />);
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Log/ }));
    expect(screen.getByRole('log')).toBeInTheDocument();
    expect(screen.getByText('line 2')).toBeInTheDocument();
  });

  it('auto-expands when the run needs attention and colors error lines', () => {
    renderWithProviders(
      <LogViewer
        run={makeRun('attention')}
        live={{ ...quietLive, log: [...lines(2), { cursor: 2, line: 'ERR fal job failed' }], lastError: 'boom' }}
      />,
    );
    const well = screen.getByRole('log'); // expanded without any click
    expect(well).toBeInTheDocument();
    expect(screen.getByText('ERR fal job failed')).toHaveClass('text-status-failed');
  });

  it('scrolling up pauses following and the pill jumps back to the latest line', async () => {
    renderWithProviders(
      <LogViewer run={makeRun('rendering')} live={{ ...quietLive, log: lines(50), activeKind: 'render' }} defaultExpanded />,
    );
    const well = screen.getByRole('log');
    Object.defineProperty(well, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(well, 'clientHeight', { configurable: true, value: 300 });

    // user drags the scrollbar up → far from the bottom → following pauses
    well.scrollTop = 100;
    fireEvent.scroll(well);
    const pill = await screen.findByRole('button', { name: 'Following paused — Jump to latest' });

    await userEvent.click(pill);
    expect(screen.queryByRole('button', { name: 'Following paused — Jump to latest' })).not.toBeInTheDocument();
    expect(well.scrollTop).toBe(1000); // pinned back to the tail
  });
});
