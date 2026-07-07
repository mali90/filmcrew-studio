// PhaseStrip: the sticky spine. Subcaptions count real work (never percentages), and a done node
// is a scroll shortcut, not a navigation.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeRun } from '../../test/fixtures';
import { initialRunLive } from '../../api/run-events';
import { PhaseStrip } from './PhaseStrip';

const agents = () => initialRunLive().agents;

describe('PhaseStrip', () => {
  it('planning: the Plan node is active with an "{n}/8" subcaption', () => {
    render(<PhaseStrip run={makeRun('planning')} agents={agents()} activeKind="plan" />);
    expect(screen.getByRole('navigation', { name: 'Run phases' })).toBeInTheDocument();
    expect(screen.getByText('3/8')).toBeInTheDocument(); // agents.done = 3 while planning
    // nothing is done yet → no scroll shortcuts
    expect(screen.queryByRole('button', { name: /Scroll to/ })).not.toBeInTheDocument();
  });

  it('rendering: the Render node counts jobs and the Plan node becomes a scroll shortcut', async () => {
    const scrolled = vi.fn();
    const target = document.createElement('div');
    target.id = 'section-plan';
    target.scrollIntoView = scrolled;
    document.body.appendChild(target);

    render(<PhaseStrip run={makeRun('rendering')} agents={agents()} activeKind="render" />);
    expect(screen.getByText('job 0/2')).toBeInTheDocument(); // no clip finished yet
    await userEvent.click(screen.getByRole('button', { name: 'Scroll to the Plan section' }));
    expect(scrolled).toHaveBeenCalled();
    target.remove();
  });

  it('attention marks the current phase node failed', () => {
    render(<PhaseStrip run={makeRun('attention')} agents={agents()} activeKind={null} />);
    const nav = screen.getByRole('navigation', { name: 'Run phases' });
    // the attention fixture stopped in the plan phase — its node carries the failed soft treatment
    expect(nav.querySelector('.bg-\\[var\\(--status-failed-soft\\)\\]')).not.toBeNull();
  });
});
