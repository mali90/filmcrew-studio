import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server, http, HttpResponse } from '../../../test/msw';
import { makeRun, promptView, SPEC } from '../../../test/fixtures';
import { renderReview, markPaidConfirmed, clearPaidState } from './test-helpers';
import { ReviewStage } from './ReviewStage';

// cutId is owned by the parent (Run.tsx) so the approve bar can finalize the previewed cut; this
// wrapper holds it for standalone stage tests exactly as the page does.
function Stage({ run }: { run: ReturnType<typeof makeRun> }) {
  const [cutId, setCutId] = useState<string | null>(null);
  return <ReviewStage run={run} cutId={cutId} setCutId={setCutId} />;
}

// jsdom media elements have no seekable currentTime — record what the player is asked to do.
let seekedTo: number | null = null;
beforeEach(() => {
  seekedTo = null;
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get: () => seekedTo ?? 0,
    set: (v: number) => { seekedTo = v; },
  });
});
afterEach(() => {
  delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).currentTime;
  clearPaidState();
});

describe('ReviewStage', () => {
  it('renders the master video with the cover poster and remounts when the master url changes', () => {
    const run = makeRun('review');
    const { rerender } = renderReview(<Stage run={run} />);
    const video = screen.getByTestId('master-video');
    expect(video).toHaveAttribute('src', '/api/media/out/ocean.mp4');
    expect(video).toHaveAttribute('poster', '/api/media/runs/x/renders/t1/cover.png');
    expect(video).toHaveAttribute('controls');

    const restitched = makeRun('review');
    restitched.latestRender!.masterUrl = '/api/media/out/ocean-v2.mp4';
    rerender(<Stage run={restitched} />);
    expect(screen.getByTestId('master-video')).toHaveAttribute('src', '/api/media/out/ocean-v2.mp4');
  });

  it('lists cuts newest first and swaps the src to /api/media/out/<basename> for an older cut', () => {
    const run = makeRun('review');
    run.manifest!.cuts = [
      { id: 'c1', take: 't1', master: '/abs/out/ocean v1.mp4', createdAt: '2026-07-04T09:00:00.000Z' },
      { id: 'c2', take: 't2', master: '/abs/out/ocean.mp4', createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    renderReview(<Stage run={run} />);

    fireEvent.click(screen.getByRole('button', { name: 'Switch cut' }));
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('c2');
    expect(options[0]).toHaveTextContent('latest');
    expect(options[1]).toHaveTextContent('c1');

    fireEvent.click(options[1]);
    expect(screen.getByTestId('master-video')).toHaveAttribute('src', '/api/media/out/ocean%20v1.mp4');
  });

  it('seeks the master to the sum of preceding jobs when a clip card is clicked', () => {
    const run = makeRun('review');
    renderReview(<Stage run={run} />);
    // K1 = S1(5s) + S2(4s) = 9s of preceding footage before K2
    fireEvent.click(screen.getByRole('button', { name: 'Play from K2' }));
    expect(seekedTo).toBe(9);
    fireEvent.click(screen.getByRole('button', { name: 'Play from K1' }));
    expect(seekedTo).toBe(0);
  });

  it('shows the probe banner with a priced full-render button that starts the full render', async () => {
    markPaidConfirmed();
    const run = makeRun('review');
    run.manifest!.takes = [{ id: 't1', mode: 'probe', revision: null, createdAt: '2026-07-04T10:00:00.000Z', estUsd: 1.1 }];

    let renderBody: unknown = null;
    server.use(
      http.post('/api/runs/:id/render', async ({ request }) => {
        renderBody = await request.json();
        return HttpResponse.json({ takeId: 't2', estUsd: 4.16 });
      }),
    );

    renderReview(<Stage run={run} />);
    // U5: the lead names the one job the probe rendered; the trailing sentence says what the paid
    // button buys. Nothing in this banner may read "free" — it sits beside a $-tagged button.
    const banner = screen.getByText('Probe take — only K1 rendered.').closest('div')!;
    expect(within(banner).getByText(/Full render replaces this probe with all 2 clips, as a new take\./)).toBeInTheDocument();
    expect(banner.textContent).not.toMatch(/free/i);

    // the estimate arrives and prices the button
    await screen.findByLabelText('estimated cost $4.16');
    fireEvent.click(screen.getByRole('button', { name: /Full render/ }));
    await waitFor(() => expect(renderBody).toEqual({ mode: 'full' }));
  });

  it('take-count chips count every take that PRODUCED A CLIP — the full render included', () => {
    const run = makeRun('review');
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
      { id: 't3', mode: 'job', jobId: 'K2', revision: 'r1', createdAt: '2026-07-04T11:00:00.000Z' },
      { id: 't4', mode: 'job', jobId: 'K2', revision: 'r1', createdAt: '2026-07-04T12:00:00.000Z' },
    ];
    renderReview(<Stage run={run} />);
    // The 9:16 thumb is 47px wide, so the takes pill sits in the caption row in its compact form
    // and carries the words on its tooltip (spec D8).
    // K2 has THREE clips on disk: the full render's + two re-renders (it once said "2 takes")
    expect(screen.getByText('×3')).toHaveAttribute('title', '3 takes');
    // K1 has exactly one (the full render) — singular, quiet
    expect(screen.getByText('×1')).toHaveAttribute('title', '1 take');
  });

  it('a cascade take counts for the downstream jobs it re-rendered too', () => {
    const run = makeRun('review');
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
      { id: 't2', mode: 'job', jobId: 'K1', cascade: true, revision: null, createdAt: '2026-07-04T11:00:00.000Z' },
    ];
    renderReview(<Stage run={run} />);
    // K1 and K2 both got fresh clips from the cascade → 2 each
    expect(screen.getAllByText('×2')).toHaveLength(2);
  });

  // Spec D8/D22: an edited prompt is a fact about a segment, so it is visible ON the segment —
  // not only inside the sheet a user would have to open to find it.
  it('marks the tile of a segment whose prompt carries an edit', async () => {
    server.use(http.get('/api/runs/:id/prompts', ({ params }) => HttpResponse.json({
      runId: String(params.id),
      backend: 'kling-o3@fal',
      jobs: ['K1', 'K2'],
      prompts: [promptView('K1'), promptView('K2', { source: 'override', stale: true })],
      orphaned: [],
    })));
    renderReview(<Stage run={makeRun('review')} />);

    const k2 = screen.getByTestId('segment-tile-K2');
    expect(await within(k2).findByLabelText('prompt edited')).toBeInTheDocument();
    expect(within(k2).getByLabelText('prompt edit is stale')).toBeInTheDocument();
    // K1 is on the agents' words, so it wears nothing.
    expect(within(screen.getByTestId('segment-tile-K1')).queryByLabelText('prompt edited')).not.toBeInTheDocument();
  });

  // Spec D25 — a reopened run looks exactly like one that never left review, so the banner slot has
  // to say why the user is back and what is still on disk.
  it('a reopened run carries the re-entry notice in the banner slot, and never toasts it', () => {
    const run = makeRun('review');
    run.manifest!.approved = { cut: 'c1', final: '/abs/out/ocean-final.mp4', upscaled: false, at: '2026-07-04T10:05:00.000Z' };
    run.manifest!.reopenedAt = '2026-07-04T11:00:00.000Z';

    const { container } = renderReview(<Stage run={run} />);

    const notice = screen.getByTestId('reopened-notice');
    expect(notice).toHaveClass('border', 'border-line', 'bg-surface-1');
    const text = notice.textContent ?? '';
    expect(text).toMatch(/^Reopened for changes\./);
    expect(text).toMatch(/ocean-final\.mp4 is still on disk/);
    expect(text).toMatch(/approving again writes a new final and keeps the old one/);

    // the notice sits above the video, in the slot the probe banner uses — not over it
    expect(notice.compareDocumentPosition(screen.getByTestId('master-video')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Don't #11: this is standing state, not an event — a toast would expire exactly when needed
    expect(document.querySelector('[aria-live="polite"]')?.childElementCount ?? 0).toBe(0);
    expect(container.textContent).not.toMatch(/free/i);
  });

  it('a run that was delivered again since the reopen shows no notice', () => {
    const run = makeRun('review');
    run.manifest!.reopenedAt = '2026-07-04T11:00:00.000Z';
    run.manifest!.approved = { cut: 'c1', final: '/abs/out/ocean-final.mp4', upscaled: false, at: '2026-07-04T12:00:00.000Z' };
    renderReview(<Stage run={run} />);
    expect(screen.queryByTestId('reopened-notice')).not.toBeInTheDocument();
  });

  it('a run that was never delivered shows no notice', () => {
    renderReview(<Stage run={makeRun('review')} />);
    expect(screen.queryByTestId('reopened-notice')).not.toBeInTheDocument();
  });

  // U1 — the page keeps this stage mounted while a segment re-renders, so the stage itself must
  // keep playing (masterUrl is null mid-flight) and say what is happening in the banner slot.
  it('keeps playing the current cut and shows the in-flight banner while a segment re-renders', () => {
    const run = makeRun('review');
    run.status = 'rendering';
    run.manifest!.activeJob = { kind: 'render-job', pid: 7, startedAt: new Date(Date.now() - 42000).toISOString() };
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T09:00:00.000Z' },
      { id: 't2', mode: 'job', jobId: 'K2', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
    ];
    // a distinct basename proves the fallback: latestRender.masterUrl is gone, the cut's file is not
    run.manifest!.cuts = [{ id: 'c1', take: 't1', master: '/abs/out/ocean v1.mp4', createdAt: '2026-07-04T09:05:00.000Z' }];
    run.latestRender!.masterUrl = null;
    run.latestRender!.jobs = [
      { jobId: 'K1', clip: '/abs/clip1.mp4', clipExists: true, clipUrl: '/api/media/runs/x/renders/t2/K1/clip.mp4', error: null },
      { jobId: 'K2', clip: null, clipExists: false, clipUrl: null, error: null },
    ];
    renderReview(<Stage run={run} />);

    const notice = screen.getByTestId('rerender-inflight-notice');
    expect(notice.textContent).toContain(
      "Re-rendering K2 — you're watching the current cut; the new clip takes its place here when it lands.",
    );
    expect(notice.textContent).toMatch(/\d+:\d{2}/); // ticking elapsed from activeJob.startedAt
    // the stage falls back to the cut's own file while the latest master is rebuilt
    expect(screen.getByTestId('master-video')).toHaveAttribute('src', '/api/media/out/ocean%20v1.mp4');
  });

  // A cascade renders several segments into ONE take, so the take's render.json exists (and holds
  // only the finished children) from the first landing onward. The scan then stops synthesizing the
  // take's pending jobs, and the segment actually on the wire is in NO server-sent list.
  it('keeps naming the working segment, and the whole cut on the strip, mid-cascade', () => {
    const run = makeRun('review');
    run.status = 'rendering';
    run.spec = {
      ...SPEC,
      shots: [...SPEC.shots],
      kling: { ...SPEC.kling, jobs: [
        { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
        { job_id: 'K2', shots: ['S2'], elements: ['subject'] },
        { job_id: 'K3', shots: ['S3'], elements: ['subject'] },
      ] },
    };
    run.manifest!.activeJob = { kind: 'render-job', pid: 7, startedAt: new Date(Date.now() - 9000).toISOString() };
    // K2 was re-rendered with a cascade, so K2 and K3 are being replaced in take t2. K2 has landed
    // and written render.json; K3 is on the wire right now.
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
      { id: 't2', mode: 'job', jobId: 'K2', cascade: true, revision: null, createdAt: '2026-07-04T11:00:00.000Z' },
    ];
    run.manifest!.jobClips = { K1: '/abs/runs/x/renders/t1/K1/clip.mp4', K2: '/abs/runs/x/renders/t2/K2/clip.mp4' };
    run.latestRender!.masterUrl = null;
    run.latestRender!.jobs = [
      { jobId: 'K2', clip: '/abs/runs/x/renders/t2/K2/clip.mp4', clipExists: true, clipUrl: '/api/media/runs/x/renders/t2/K2/clip.mp4', error: null },
    ];

    renderReview(<Stage run={run} />);

    expect(screen.getByTestId('rerender-inflight-notice').textContent).toContain('Re-rendering K3 —');
    // …and the strip is the whole cut, not the one clip this partial take happens to hold
    for (const id of ['K1', 'K2', 'K3']) expect(screen.getByTestId(`segment-tile-${id}`)).toBeInTheDocument();
    // K1 was never in the cascade's path, so it is still a finished clip; K3 is the one rendering.
    expect(within(screen.getByTestId('segment-tile-K3')).getByText('rendering')).toBeInTheDocument();
    expect(within(screen.getByTestId('segment-tile-K1')).queryByText('rendering')).not.toBeInTheDocument();
  });

  it('does not second-guess the take the scan is still synthesizing', () => {
    // Before the cascade's FIRST child lands there is no render.json, so the scan already sends the
    // full plan with the targeted jobs blank — the server's list is used verbatim.
    const run = makeRun('review');
    run.status = 'rendering';
    run.manifest!.activeJob = { kind: 'render-job', pid: 7, startedAt: new Date().toISOString() };
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
      { id: 't2', mode: 'job', jobId: 'K1', cascade: true, revision: null, createdAt: '2026-07-04T11:00:00.000Z' },
    ];
    run.latestRender!.jobs = [
      { jobId: 'K1', clip: null, clipExists: false, clipUrl: null, error: null },
      { jobId: 'K2', clip: null, clipExists: false, clipUrl: null, error: null },
    ];
    renderReview(<Stage run={run} />);
    expect(screen.getByTestId('rerender-inflight-notice').textContent).toContain('Re-rendering K1 —');
  });

  // `activeJob` names only the MIDDLE of a re-render. Before the child spawns (the job waits behind
  // another run — the queue is global, only the spend lock is per run) there is no active job at
  // all, and the reserved take has no render.json, so the scan sends no render either. The take
  // record is what still names the interval.
  it('holds the stage while the re-render is only QUEUED — no active job, no take on disk yet', () => {
    const run = makeRun('review');
    run.status = 'rendering';
    run.manifest!.activeJob = null;
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
      { id: 't2', mode: 'job', jobId: 'K2', revision: null, createdAt: '2026-07-04T11:00:00.000Z' },
    ];
    run.manifest!.jobClips = { K1: '/abs/runs/x/renders/t1/K1/clip.mp4', K2: '/abs/runs/x/renders/t1/K2/clip.mp4' };
    run.latestRender = null; // a reserved take with no render.json — the server hands the UI nothing

    renderReview(<Stage run={run} />);

    expect(screen.getByTestId('rerender-inflight-notice').textContent).toContain('Re-rendering K2 —');
    // the strip is still the whole cut, with only the segment being replaced blank
    for (const id of ['K1', 'K2']) expect(screen.getByTestId(`segment-tile-${id}`)).toBeInTheDocument();
    expect(within(screen.getByTestId('segment-tile-K2')).getByText('rendering')).toBeInTheDocument();
    // no child, so no elapsed clock to quote — the sentence stands on its own
    expect(screen.getByTestId('rerender-inflight-notice').textContent).not.toMatch(/\d+:\d{2}/);
  });

  // …and the tail: the clips are all back, and the free stitch that rebuilds the master is what is
  // left. Naming a segment here would name one that is already finished.
  it('holds the stage through the free stitch, and says THAT is what is happening', () => {
    const run = makeRun('review');
    run.status = 'rendering';
    run.manifest!.activeJob = { kind: 'assemble', pid: 8, startedAt: new Date(Date.now() - 3000).toISOString() };
    run.manifest!.takes = [
      { id: 't1', mode: 'full', revision: null, createdAt: '2026-07-04T10:00:00.000Z' },
      { id: 't2', mode: 'job', jobId: 'K2', revision: null, createdAt: '2026-07-04T11:00:00.000Z' },
    ];
    run.latestRender!.masterUrl = null; // the master is being rebuilt right now

    renderReview(<Stage run={run} />);

    const notice = screen.getByTestId('rerender-inflight-notice');
    expect(notice.textContent).toContain(
      "Stitching the new cut — the clips are back; you're watching the current cut until the new master is ready.",
    );
    expect(notice.textContent).not.toContain('undefined');
    expect(screen.getByTestId('master-video')).toHaveAttribute('src', '/api/media/out/ocean.mp4');
  });

  it('shows no in-flight banner when nothing is rendering', () => {
    renderReview(<Stage run={makeRun('review')} />);
    expect(screen.queryByTestId('rerender-inflight-notice')).not.toBeInTheDocument();
  });

  // U14 — when the plan moved past the latest cut (same derivation as ChangeRequestPanel's
  // planChanged), the stage says the video below is the OLD cut and points at the rail.
  it('notes in the banner slot when the plan changed after the latest cut', () => {
    const run = makeRun('review');
    // take t1 is from 10:00; a revision at 11:00 outran the cut
    run.manifest!.revisions = [
      { id: 'r2', feedback: 'the keeper should look older', scope: 'K2', owners: [4], createdAt: '2026-07-04T11:00:00.000Z' },
    ];
    renderReview(<Stage run={run} />);
    const notice = screen.getByTestId('plan-outran-cut-notice');
    expect(notice.textContent).toMatch(/The plan changed after this cut \(r2\) — the video below is unchanged\./);
    expect(notice.textContent).toMatch(/Re-render options are in the rail\./);
  });

  it('shows no plan-changed notice when a take is newer than the last revision', () => {
    const run = makeRun('review');
    // revision at 09:00 predates take t1 (10:00) — the cut already carries this plan
    run.manifest!.revisions = [
      { id: 'r1', feedback: 'wider hook shot', scope: 'whole', owners: [1], createdAt: '2026-07-04T09:00:00.000Z' },
    ];
    renderReview(<Stage run={run} />);
    expect(screen.queryByTestId('plan-outran-cut-notice')).not.toBeInTheDocument();
  });
});
