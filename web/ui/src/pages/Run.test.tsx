// The Run page morphs with run.status — one test per phase asserts the right sections mount.
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeRun } from '../test/fixtures';
import { renderRunPage, markPaidConfirmed } from '../components/run/test-harness';

describe('Run page — phase morphing', () => {
  it('planning: agent rail is the hero and the spec inspector rides the rail', async () => {
    renderRunPage(makeRun('planning'));
    expect(await screen.findByRole('region', { name: 'Production plan' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Production spec' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'The plan is ready' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Run phases' })).toBeInTheDocument();
  });

  it('plan-ready: collapsed rail summary + plan review with both priced buttons', async () => {
    markPaidConfirmed();
    renderRunPage(makeRun('plan-ready'));
    expect(await screen.findByRole('region', { name: 'The plan is ready' })).toBeInTheDocument();
    expect(screen.getByText('All 8 agents have finished — the plan was approved on pass 1.')).toBeInTheDocument();
    expect(await screen.findAllByText('≈ $4.16')).toHaveLength(2);
    expect(screen.getByText('estimates — fal bills per second')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Production spec' })).toBeInTheDocument();
  });

  it('planning shows the log, already expanded — engine activity is never hidden mid-plan', async () => {
    renderRunPage(makeRun('planning'));
    const log = await screen.findByRole('region', { name: 'Log' });
    // defaultExpanded: the terminal voice is visible WITHOUT a click while agents work
    expect(within(log).getByRole('log')).toBeInTheDocument();
  });

  it('post-approve upscaling reads as DELIVER: no job cards, an honest upscaling surface', async () => {
    // approve+upscale runs in the spend lane → status stays 'rendering' (cancellable spend) but
    // phase is 'deliver' — bouncing the page back to the render step read as a regression
    renderRunPage(makeRun('rendering', { phase: 'deliver' }));
    expect(await screen.findByText('Approved — upscaling to 1080p')).toBeInTheDocument();
    expect(screen.getByText(/Topaz is lifting the stitched master/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Render jobs' })).not.toBeInTheDocument();
  });

  it('rendering: job cards + log in the main column, run facts + history on the rail', async () => {
    renderRunPage(makeRun('rendering'));
    const jobs = await screen.findByRole('region', { name: 'Render jobs' });
    expect(within(jobs).getByText('K1')).toBeInTheDocument();
    expect(within(jobs).getByText('K2')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Log' })).toBeInTheDocument();
    const facts = screen.getByRole('region', { name: 'Run facts' });
    expect(within(facts).getByText('backend')).toBeInTheDocument();
    // the idea moved out of the fact sheet into the pinned "Idea" strip under the progress bar
    expect(screen.getByText('a lighthouse keeper at dusk')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
  });

  it('attention: the banner sits on top, the log auto-expands, and the reached stage stays visible', async () => {
    renderRunPage(makeRun('attention'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('fal job failed: boom');
    expect(alert).toHaveTextContent('ERR boom');
    // no render artifacts yet → the agent rail is the underlying stage
    expect(screen.getByRole('region', { name: 'Production plan' })).toBeInTheDocument();
    // the log is force-expanded so the answer is on screen
    expect(screen.getByRole('log')).toBeInTheDocument();
  });

  it('review: the review stage + collapsed log in main; change requests, history and approve on the rail', async () => {
    renderRunPage(makeRun('review'));
    expect(await screen.findByTestId('master-video')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Log' })).toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument(); // collapsed
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('complete: the final card is the whole story, history on the rail', async () => {
    renderRunPage(makeRun('complete'));
    expect(await screen.findByTestId('final-video')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Render jobs' })).not.toBeInTheDocument();
  });
});
