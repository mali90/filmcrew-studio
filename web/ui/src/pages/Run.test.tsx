// The Run page morphs with run.status — one test per phase asserts the right sections mount.
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ProductionSpec } from '../../../shared/api-types';
import { http, HttpResponse, server } from '../test/msw';
import { ESTIMATE, makeRun } from '../test/fixtures';
import { MockEventSource } from '../test/mock-event-source';
import { renderRunPage, renderRunPages, markPaidConfirmed } from '../components/run/test-harness';

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
    // U3/U4: multi-job plan → the merged probe-explaining caption, provider-true (fixture is kling@fal)
    expect(screen.getByText('A probe renders only K1 — a cheap look before the full spend. Estimates — fal bills per rendered second.')).toBeInTheDocument();
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
    const run = makeRun('rendering', { phase: 'deliver' });
    run.manifest!.activeJob = { kind: 'upscale', pid: 9, startedAt: new Date(Date.now() - 65000).toISOString() };
    renderRunPage(run);
    // U7: no hardcoded "1080p" — the target comes from the SAME estimate ApproveBar fetched
    // (the default MSW estimate carries no targetShortSide, so the derived label is ~1080p)
    expect(await screen.findByText('Approved — upscaling with Topaz')).toBeInTheDocument();
    expect(await screen.findByText(/Topaz is lifting the stitched master toward ~1080p\./)).toBeInTheDocument();
    expect(screen.getByText(/The final file lands here when it finishes\./)).toBeInTheDocument();
    // an elapsed line under the sweep, from the persisted active job — never a fake progress bar
    expect(screen.getByText(/^1:0\d$/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Render jobs' })).not.toBeInTheDocument();
  });

  it('the upscale interstitial names the provider\'s REAL target — 4K when the estimate says so (U7)', async () => {
    server.use(http.get('/api/runs/:id/estimate', () => HttpResponse.json({ ...ESTIMATE, targetShortSide: 2160 })));
    renderRunPage(makeRun('rendering', { phase: 'deliver' }));
    expect(await screen.findByText(/Topaz is lifting the stitched master toward ~4K\./)).toBeInTheDocument();
    expect(screen.queryByText(/1080p/)).not.toBeInTheDocument();
  });

  it('rendering: job cards + log in the main column, run facts + history on the rail', async () => {
    renderRunPage(makeRun('rendering'));
    const jobs = await screen.findByRole('region', { name: 'Render jobs' });
    expect(within(jobs).getByText('K1')).toBeInTheDocument();
    expect(within(jobs).getByText('K2')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Log' })).toBeInTheDocument();
    const facts = screen.getByRole('region', { name: 'Run facts' });
    expect(within(facts).getByText('backend')).toBeInTheDocument();
    // U2a: the run's resolution pick (none here → the model's default) and its cast are facts
    expect(within(facts).getByText('resolution')).toBeInTheDocument();
    expect(within(facts).getByText('model default')).toBeInTheDocument();
    expect(within(facts).getByText('cast')).toBeInTheDocument();
    expect(within(facts).getByText('subject (1 ref)')).toBeInTheDocument(); // fixture's lone element
    // the idea moved out of the fact sheet into the pinned "Idea" strip under the progress bar
    expect(screen.getByText('a lighthouse keeper at dusk')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
  });

  it('RunFacts states the picked resolution and the cast grouped per character (U2a)', async () => {
    const run = makeRun('rendering');
    run.manifest!.resolution = '720p';
    const spec = structuredClone(run.spec) as ProductionSpec;
    spec.kling.elements = [
      { id: 'e1', image: 'a.png', character: 'marie' },
      { id: 'e2', image: 'b.png', character: 'marie' },
      { id: 'e3', image: 'c.png', character: 'marie' },
      { id: 'e4', image: 'd.png', character: 'jack' },
      { id: 'e5', image: 'e.png', character: 'jack' },
    ];
    run.spec = spec;
    renderRunPage(run);
    const facts = await screen.findByRole('region', { name: 'Run facts' });
    expect(within(facts).getByText('720p')).toBeInTheDocument();
    expect(within(facts).getByText('marie (3 refs) · jack (2 refs)')).toBeInTheDocument();
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
    const approve = screen.getByRole('button', { name: /approve/i });
    expect(approve).toBeInTheDocument();
    // U6: the free, happy-path exit sits on TOP of the rail — Approve → Change something → History
    const change = screen.getByText('Change something');
    const history = screen.getByText('History');
    expect(approve.compareDocumentPosition(change) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(change.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('complete: the final card is the whole story, history on the rail', async () => {
    renderRunPage(makeRun('complete'));
    expect(await screen.findByTestId('final-video')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Render jobs' })).not.toBeInTheDocument();
  });

  // ── U1: a segment re-render must not tear down the review room ─────────────────────────────────
  /** A rendering-status run mid job-mode re-render: one cut on disk, K2's new clip not landed.
   *  The t2 JOB take is what the server records before it enqueues anything, and it is what names
   *  the whole interval — `activeJob` is only its middle. */
  function segmentRerenderRun() {
    const run = makeRun('rendering');
    run.manifest!.activeJob = { kind: 'render-job', pid: 7, startedAt: '2026-07-04T10:00:00.000Z' };
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T09:00:00.000Z', estUsd: 4.2 },
      { id: 't2', mode: 'job', jobId: 'K2', revision: null, createdAt: '2026-07-04T10:00:00.000Z', estUsd: 1.4 },
    ];
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/ocean.mp4', createdAt: '2026-07-04T09:05:00.000Z' }];
    run.latestRender = {
      dir: '/abs/runs/x/renders/t2', backend: 'kling',
      jobs: [
        { jobId: 'K1', clip: '/abs/clip1.mp4', clipExists: true, clipUrl: '/api/media/runs/x/renders/t2/K1/clip.mp4', error: null },
        { jobId: 'K2', clip: null, clipExists: false, clipUrl: null, error: null },
      ],
      master: null, masterExists: false, masterUrl: null, cover: null, coverUrl: null,
    };
    return run;
  }

  it('a job-mode re-render keeps the review room mounted — no job-card teardown (U1)', async () => {
    renderRunPage(segmentRerenderRun());
    // the stage stays: video + clip strip, with the in-flight banner naming the working segment
    expect(await screen.findByTestId('master-video')).toBeInTheDocument();
    expect(screen.getByTestId('rerender-inflight-notice')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Render jobs' })).not.toBeInTheDocument();
    // rail: facts + history, but NOTHING approvable mid-render
    expect(screen.getByRole('region', { name: 'Run facts' })).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  // The re-render is one interval and `activeJob` names only its middle: it is empty while the job
  // waits behind another run's child, and it reads `assemble` while the free stitch rebuilds the
  // master. Keyed on it, the review room was torn down and rebuilt on both sides of the model
  // process — the reviewer lost the video they had just paid to improve, twice per re-render.
  it('keeps the review room through the QUEUE WAIT, before any child exists (U1)', async () => {
    const run = segmentRerenderRun();
    run.manifest!.activeJob = null;
    run.latestRender = null; // reserved take, no render.json — the server hands the UI no render
    renderRunPage(run);
    expect(await screen.findByTestId('master-video')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Render jobs' })).not.toBeInTheDocument();
  });

  it('keeps the review room through the free STITCH that follows the clip (U1)', async () => {
    const run = segmentRerenderRun();
    run.manifest!.activeJob = { kind: 'assemble', pid: 8, startedAt: '2026-07-04T10:02:00.000Z' };
    renderRunPage(run);
    expect(await screen.findByTestId('master-video')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Render jobs' })).not.toBeInTheDocument();
  });

  it('a FULL render keeps the job-card teardown even when cuts exist — everything IS being replaced', async () => {
    const run = segmentRerenderRun();
    run.manifest!.activeJob = { kind: 'render', pid: 7, startedAt: '2026-07-04T10:00:00.000Z' };
    // a full render reserves a take of its own, and THAT is what the page reads
    run.manifest!.takes = [...run.manifest!.takes!.slice(0, 1), { id: 't3', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z', estUsd: 4.2 }];
    renderRunPage(run);
    expect(await screen.findByRole('region', { name: 'Render jobs' })).toBeInTheDocument();
    expect(screen.queryByTestId('master-video')).not.toBeInTheDocument();
  });

  // ── U8: a dropped live stream must say so ──────────────────────────────────────────────────────
  it('a dropped live stream says so while money is in flight, and clears on reconnect (U8)', async () => {
    const run = makeRun('rendering');
    renderRunPage(run);
    await screen.findByRole('region', { name: 'Render jobs' });
    // the initial connect is not a drop — no banner
    expect(screen.queryByText(/Live updates dropped/)).not.toBeInTheDocument();

    const [es] = MockEventSource.instances.get(`/api/runs/${run.id}/events`) ?? [];
    // we HAD a live snapshot; THEN the stream errors — that is a real drop
    act(() => { MockEventSource.emit(run.id, { type: 'snapshot', run }); });
    act(() => { es.onerror?.(); });
    expect(screen.getByText(/Live updates dropped — reconnecting\. The run keeps going on the server/)).toBeInTheDocument();

    // EventSource retries by itself; a reopened stream clears the notice
    act(() => { es.onopen?.(); });
    expect(screen.queryByText(/Live updates dropped/)).not.toBeInTheDocument();
  });

  // ── Run-scoped page state must not cross a /runs/A → /runs/B navigation ────────────────────────
  it('the prompt sheet left open on one run does not open the next run with it (Router reuse)', async () => {
    const a = makeRun('review');
    const b = makeRun('review', { id: 'web-20260704110000-cd34', idea: 'a second run' });
    // Open B first, so returning to it later reads its detail straight from the React Query cache —
    // the ordinary case of a reviewer moving between two runs. With that cache warm the page never
    // goes through a null render on the way in, so nothing accidentally unmounts what A left behind.
    renderRunPages([b, a]);
    expect(await screen.findByText('a second run')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId(`goto-${a.id}`));
    await screen.findByRole('region', { name: 'Review stage' });
    await userEvent.click(await screen.findByRole('button', { name: 'Play from K2' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Prompt for K2' }));
    expect(await screen.findByTestId('prompt-sheet')).toBeInTheDocument();

    // an ordinary re-render of the SAME run must leave the sheet (and any edit in it) alone
    act(() => { MockEventSource.emit(a.id, { type: 'log', cursor: 1, line: 'stitching…' }); });
    expect(screen.getByTestId('prompt-sheet')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId(`goto-${b.id}`));
    expect(await screen.findByText('a second run')).toBeInTheDocument();
    // B's K2 is not A's K2: an inherited target would query B's prompt API with A's selection
    expect(screen.queryByTestId('prompt-sheet')).not.toBeInTheDocument();
  });

  // ── U9: revising from review must say the takes are safe ──────────────────────────────────────
  it('revising a run that has takes says the clips, takes and cut are untouched (U9)', async () => {
    const run = makeRun('planning');
    run.manifest!.takes = [{ id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T09:00:00.000Z', estUsd: 4.2 }];
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/ocean.mp4', createdAt: '2026-07-04T09:05:00.000Z' }];
    renderRunPage(run);
    const notice = await screen.findByTestId('revise-in-review-notice');
    expect(notice).toHaveTextContent(
      'Revising the plan — your clips, takes and cut are untouched. Review returns when the agents finish, and nothing re-renders until you choose.',
    );
  });

  it('a FIRST plan shows no revise notice — there is nothing rendered to reassure about', async () => {
    renderRunPage(makeRun('planning'));
    await screen.findByRole('region', { name: 'Production plan' });
    expect(screen.queryByTestId('revise-in-review-notice')).not.toBeInTheDocument();
  });
});
