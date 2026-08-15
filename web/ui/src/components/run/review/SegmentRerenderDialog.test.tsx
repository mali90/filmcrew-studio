// The paid segment re-render, and the promise it makes before the money moves.
//
// Two things are load-bearing here and neither is cosmetic:
//
//   1. HONESTY OF THE SEAM. "Seamless" may only ever be said about a native first/last-frame anchor.
//      A fal boundary frame — and a Segmind one on a segment that carries cast references — rides as
//      an extra reference image plus a prompt pin: close, not frame-exact. Those must read
//      "near-seamless (reference-guided)". The dialog takes the strength from `pinStrengthFor`,
//      which the parity block below pins against the renderer's own `chooseSeamMode`, so the two can
//      never drift apart into a sentence the render will not honour.
//   2. ONE SCRIM, ONE PRICE. Inside an open dialog the first-paid confirmation renders INLINE
//      (spec D13b) — a second modal over the first reads as two decisions when there is one — and
//      every figure on screen comes from PaidButton, including the "rate not on file" case.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backend, ContinuityEntry, JobView, ProductionSpec, RunDetail } from '../../../../../shared/api-types';
import { ALL_BACKENDS, capsFor, pinStrengthFor, pinStrengthsFor } from '../../../../../shared/render-models';
import { chooseSeamMode } from '../../../../../../src/lib/prompt-compose.js';
import { server, http, HttpResponse } from '../../../test/msw';
import { ESTIMATE, makeRun, promptView } from '../../../test/fixtures';
import { renderReview, markPaidConfirmed, clearPaidState } from './test-helpers';
import { SegmentRerenderDialog } from './SegmentRerenderDialog';
import { Dialog } from '../../ui/Dialog';

afterEach(clearPaidState);

const clip = (jobId: string): JobView => ({
  jobId, clip: `/abs/${jobId}.mp4`, clipExists: true,
  clipUrl: `/api/media/runs/x/renders/t1/${jobId}/clip.mp4`, error: null,
});

const entry = (jobId: string, index: number, over: Partial<ContinuityEntry> = {}): ContinuityEntry => ({
  jobId, index, take: 't1', continuesFromPrev: true, confidence: 'recorded',
  from: { take: 't1', job: `K${index}` }, reason: 'source-matches', ...over,
});

const head = entry('K1', 0, { continuesFromPrev: false, from: null, reason: 'no-prev' });

/** K1 → K2 → K3, every join whole and recorded (the fixture ships K1+K2). */
function threeSegmentRun(over: Partial<RunDetail> = {}): RunDetail {
  const run = makeRun('review');
  const spec = JSON.parse(JSON.stringify(run.spec)) as ProductionSpec;
  spec.shots.push({ shot_id: 'S4', beat: 'payoff', duration_s: 3, kling: { content_prompt: 'The door closes.' } });
  spec.kling.jobs.push({ job_id: 'K3', shots: ['S4'], elements: ['subject'] });
  run.spec = spec;
  run.latestRender!.jobs = [clip('K1'), clip('K2'), clip('K3')];
  run.continuity = [head, entry('K2', 1), entry('K3', 2)];
  return { ...run, ...over };
}

/** Re-point a run at a backend — and optionally strip its cast, which is what lets Segmind pin
 *  natively (its frame slots are mutually exclusive with reference images). */
function onBackend(run: RunDetail, backend: Backend, { castLess = false } = {}): RunDetail {
  run.backend = backend;
  run.latestRender!.backend = backend;
  if (castLess) {
    run.spec!.kling.elements = [];
    for (const j of run.spec!.kling.jobs) j.elements = [];
  }
  return run;
}

/** Give every segment `count` cast references — the input the reference budget has to spend before
 *  it can afford a boundary pin (castRefCountFor counts a job's own elements first). */
function withCast(run: RunDetail, count: number): RunDetail {
  const elements = Array.from({ length: count }, (_, i) => ({ id: `cast${i}`, role: 'subject', image: `elements/references/cast${i}.png` }));
  run.spec!.kling.elements = elements;
  for (const j of run.spec!.kling.jobs) j.elements = elements.map((e) => e.id);
  return run;
}

/** An in-memory localStorage for the one test that needs the first-paid confirm to be reachable. */
function withLocalStorage() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: stub });
  return () => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
}

const open = (run: RunDetail, jobId = 'K2') =>
  renderReview(<SegmentRerenderDialog run={run} jobId={jobId} open onClose={() => {}} />);

const sentence = () => screen.getByTestId('boundary-plan-sentence').textContent ?? '';
/** "near-seamless" contains "seamless" — this asks whether the bare promise was made. */
const promisesSeamless = (text: string) => /\bseamless\b/.test(text.replace(/near-seamless/g, 'NEAR'));

describe('SegmentRerenderDialog — the boundary plan, in plain words (D14/D15)', () => {
  it('both ends native: names both neighbours and may say seamless', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind', { castLess: true }));
    const s = sentence();
    expect(s).toContain('K1');
    expect(s).toContain('K3');
    expect(s).toContain("K2 will start from K1's last frame and end on K3's opening frame");
    expect(promisesSeamless(s)).toBe(true);
    expect(s).not.toContain('near-seamless');
  });

  it('both ends soft-pinned: the same plan, and never the word seamless on its own', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    const s = sentence();
    expect(s).toContain("K2 will aim to start on K1's last frame and end on K3's opening frame");
    expect(s).toContain('near-seamless (reference-guided)');
    expect(promisesSeamless(s)).toBe(false);
  });

  it('Segmind WITH cast references is soft too — identity wins, so the promise softens', () => {
    // Same provider, same native slots, one difference: this segment carries a cast reference, and
    // Segmind cannot have both. The copy must follow the renderer, not the provider's brochure.
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    expect(sentence()).toContain('near-seamless (reference-guided)');
    expect(promisesSeamless(sentence())).toBe(false);
  });

  it('start only: says plainly that the cut into the next segment stays a scene cut', () => {
    const run = threeSegmentRun();
    run.continuity = [head, entry('K2', 1), entry('K3', 2, { continuesFromPrev: false, reason: 'source-replaced' })];
    open(onBackend(run, 'seedance-2.0@fal'));
    const s = sentence();
    expect(s).toContain("K2 will aim to start on K1's last frame");
    expect(s).toContain('the cut into K3 stays a scene cut');
  });

  it('the first segment has no start to pin, and says so without jargon', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'), 'K1');
    const s = sentence();
    expect(s).toContain('K1 opens the cut, so nothing pins its start');
    expect(s).toContain("K2's opening frame");
  });

  it('a lone segment is told there is nothing to join to — and no neighbour is invented', () => {
    const run = threeSegmentRun();
    run.spec!.kling.jobs = [run.spec!.kling.jobs[0]];   // the spec here is a per-test clone
    run.latestRender!.jobs = [clip('K1')];
    run.continuity = [head];
    open(run, 'K1');
    const s = sentence();
    expect(s).toBe("K1 is the only segment in this cut — there's nothing to join.");
    expect(s).not.toContain('K2');
  });

  it('both joins already broken: auto keeps them broken and promises nothing', () => {
    const run = threeSegmentRun();
    run.continuity = [
      head,
      entry('K2', 1, { continuesFromPrev: false, reason: 'source-replaced' }),
      entry('K3', 2, { continuesFromPrev: false, reason: 'source-replaced' }),
    ];
    open(onBackend(run, 'seedance-2.0@fal'));
    const s = sentence();
    expect(s).toBe('K2 will be rendered on its own. The joins on both sides become scene cuts.');
    expect(promisesSeamless(s)).toBe(false);
  });

  it('"seamless" is reserved: of every variant, only the native one says it bare', () => {
    const soft = ['seedance-2.0@fal', 'seedance-2.5@fal', 'seedance-2.0@segmind'] as Backend[];
    for (const backend of soft) {
      const { unmount } = open(onBackend(threeSegmentRun(), backend));
      expect(promisesSeamless(sentence())).toBe(false);
      expect(sentence()).toContain('near-seamless (reference-guided)');
      unmount();
    }
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind', { castLess: true }));
    expect(promisesSeamless(sentence())).toBe(true);
  });

  // Both ends asked for, only one affordable: seedance-2.0@fal carries 9 images, so eight cast
  // references leave room for a single pin and SEAM_PRIORITY gives up the CLOSING one —
  // { in: 'soft', out: 'none' }. Reporting the weaker of the two for both ends lied twice over: it
  // called a reference-guided opening a scene cut, and it hid the soft pin's caveat entirely.
  it('a budget that can afford only one pin reports each end on its own terms', () => {
    expect(pinStrengthsFor('seedance-2.0@fal', { castRefCount: 8, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'soft', out: 'none' });

    open(withCast(onBackend(threeSegmentRun(), 'seedance-2.0@fal'), 8));
    const s = sentence();
    expect(s).toContain("K2 will aim to start on K1's last frame — that join is near-seamless (reference-guided).");
    expect(s).toContain('Nothing pins its ending, so the cut into K3 stays a scene cut.');
    expect(s).not.toContain('rendered on its own');
    expect(promisesSeamless(s)).toBe(false);
    // the surviving pin keeps its caveat on screen
    expect(screen.getByTestId('soft-pin-warning')).toBeInTheDocument();
    // and the ending nobody could pin is predicted to break downstream, not to hold
    expect(screen.getByTestId('downstream-seam-warning')).toHaveTextContent("K3's join will break");
  });

  // fal's Seedance 2.5 budgets images + audio + video against ONE 50-reference cap, so a registered
  // voice clip takes the slot a boundary pin would have used — and only the pin is sacrificial. The
  // browser cannot read the voices dir, so the count rides the run payload; without it this dialog
  // sold a near-seamless opening on a take the renderer deterministically opens with a scene cut.
  it('a voice reference the render will send is subtracted before any pin is promised', () => {
    expect(pinStrengthsFor('seedance-2.5@fal', { castRefCount: 49, otherRefCount: 1, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'none', out: 'none' });

    const run = withCast(onBackend(threeSegmentRun(), 'seedance-2.5@fal'), 49);
    open({ ...run, voiceRefs: { K2: 1 } });
    expect(sentence()).toBe('K2 will be rendered on its own. The joins on both sides become scene cuts.');
    expect(screen.queryByTestId('soft-pin-warning')).not.toBeInTheDocument();
  });

  it('…and a job that sends no voice clip keeps the pin that last slot buys', () => {
    expect(pinStrengthsFor('seedance-2.5@fal', { castRefCount: 49, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'soft', out: 'none' });

    open(withCast(onBackend(threeSegmentRun(), 'seedance-2.5@fal'), 49));
    expect(sentence()).toContain("K2 will aim to start on K1's last frame — that join is near-seamless (reference-guided).");
  });

  it('a budget that can afford neither pin still promises nothing at all', () => {
    expect(pinStrengthsFor('seedance-2.0@fal', { castRefCount: 14, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'none', out: 'none' });
    open(withCast(onBackend(threeSegmentRun(), 'seedance-2.0@fal'), 14));
    expect(sentence()).toBe('K2 will be rendered on its own. The joins on both sides become scene cuts.');
    expect(screen.queryByTestId('soft-pin-warning')).not.toBeInTheDocument();
  });

  it('Custom re-computes the sentence live, and opens on exactly what Auto would have done', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    const before = sentence();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(sentence()).toBe(before);
    fireEvent.click(screen.getByRole('checkbox', { name: /End on K3/ }));
    expect(sentence()).toContain('the cut into K3 stays a scene cut');
    fireEvent.click(screen.getByRole('checkbox', { name: /Start on K1/ }));
    expect(sentence()).toBe('K2 will be rendered on its own. The joins on both sides become scene cuts.');
  });
});

describe('SegmentRerenderDialog — what it warns about (D16)', () => {
  it('the soft-pin warning is about frame adherence, and claims nothing about references', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    const warn = screen.getByTestId('soft-pin-warning');
    expect(warn).toHaveTextContent('Frame pinning here is reference-guided — close, but not guaranteed frame-perfect.');
    // The correction this dialog was rebuilt around: fal keeps every cast reference. A warning that
    // said otherwise would be describing an endpoint switch this app does not do.
    expect(warn.textContent ?? '').not.toMatch(/\b(drops?|dropped|loses?|lost|instead of your|without your)\b/i);
  });

  it('a native pin carries no soft-pin warning at all', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind', { castLess: true }));
    expect(screen.queryByTestId('soft-pin-warning')).not.toBeInTheDocument();
  });

  it('the refs/frames trade is STATED for Segmind with a cast — and nowhere else', () => {
    // D16 asks for this trade to be resolved by the user with an "Exact frames / Keep references"
    // chooser. This build does not ship one, because `rerender-job` has no way to render a segment
    // without its cast: an "Exact frames" button would be one we cannot honour. So the choice the
    // renderer made is stated with its reason instead — never silently swallowed. The moment the
    // endpoint carries a refs knob, this note becomes that SegmentedControl.
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    const note = screen.getByTestId('refs-tradeoff-note');
    expect(note).toHaveTextContent(/can pin an exact frame only when a segment carries no reference images/);
    expect(note).toHaveTextContent(/keeps the cast and pins by reference/);
    expect(screen.queryByRole('radio', { name: 'Exact frames' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Keep references' })).not.toBeInTheDocument();
  });

  it('no trade to state on fal (references are always kept) or on a cast-less Segmind segment', () => {
    const { unmount } = open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    expect(screen.queryByTestId('refs-tradeoff-note')).not.toBeInTheDocument();
    unmount();
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind', { castLess: true }));
    expect(screen.queryByTestId('refs-tradeoff-note')).not.toBeInTheDocument();
  });

  it('the downstream seam warning needs BOTH a closing anchor and a clip that feeds the next one', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    expect(screen.getByTestId('downstream-seam-warning')).toBeInTheDocument();
  });

  it('…so a join that is already broken gets no warning about breaking it', () => {
    const run = threeSegmentRun();
    run.continuity = [head, entry('K2', 1), entry('K3', 2, { continuesFromPrev: false, reason: 'source-replaced' })];
    open(onBackend(run, 'seedance-2.0@fal'));
    expect(screen.queryByTestId('downstream-seam-warning')).not.toBeInTheDocument();
  });

  it('…and neither does the last segment, which feeds nothing', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'), 'K3');
    expect(screen.queryByTestId('downstream-seam-warning')).not.toBeInTheDocument();
  });

  it('a backend with no closing anchor for this segment says nothing about a join it cannot make', () => {
    // Kling seeds a boundary frame through its Elements set: with no cast reference there is nothing
    // to attach one to, so `supportsEndFrame` is false and the warning stays away.
    const run = onBackend(threeSegmentRun(), 'kling-o3@fal', { castLess: true });
    open(run);
    expect(screen.queryByTestId('downstream-seam-warning')).not.toBeInTheDocument();
    expect(sentence()).toContain('rendered on its own');
  });

  it('when the ending IS pinned the warning stops predicting a break it is preventing', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    const warn = screen.getByTestId('downstream-seam-warning');
    expect(warn).toHaveTextContent(/keeps that join near-seamless \(reference-guided\)/);
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /End on K3/ }));
    expect(screen.getByTestId('downstream-seam-warning')).toHaveTextContent("K3's join will break");
  });

  // …and it stops SELLING the fix, too. An applied ending pin renders K2 against the K3 that is in
  // the cut and records that it lands there — the joint src/lib/seam-rule.js then reads as intact,
  // which is why renderJob lists nothing stale behind it. Offering to re-render every downstream
  // clip on top of that is charging for footage nothing changed.
  it('a pinned ending is not sold a downstream cascade', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    const warn = screen.getByTestId('downstream-seam-warning');
    expect(warn).toHaveTextContent(/K3 and everything after it can stay exactly as they are/);
    expect(warn.textContent ?? '').not.toMatch(/exact fix/);
    expect(screen.queryByRole('checkbox', { name: /Also re-render K3/ })).not.toBeInTheDocument();
  });

  it('…and the offer returns the moment the ending is left unpinned', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /End on K3/ }));
    expect(screen.getByRole('checkbox', { name: /Also re-render K3/ })).toBeInTheDocument();
  });

  it('a pin the reference budget drops is no pin at all — the cascade is still offered', () => {
    // eight cast references leave room for one pin, and SEAM_PRIORITY gives up the CLOSING one
    open(withCast(onBackend(threeSegmentRun(), 'seedance-2.0@fal'), 8));
    expect(screen.getByRole('checkbox', { name: /Also re-render K3/ })).toBeInTheDocument();
  });
});

describe('SegmentRerenderDialog — the frames it shows (D14.2)', () => {
  it('shows the neighbours as 96px stills, captioned by which frame they are', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    const prev = screen.getByTestId('boundary-frame-K1') as HTMLImageElement;
    expect(prev.tagName).toBe('IMG');
    expect(prev.getAttribute('src')).toBe('/api/media/runs/x/renders/t1/K1/last_frame.png');
    expect(prev.style.height).toBe('96px');
    expect(prev.style.aspectRatio.replace(/\s/g, '')).toBe('9/16');
    expect(screen.getByText('K1 · last frame')).toBeInTheDocument();
    expect(screen.getByText('K3 · opening frame')).toBeInTheDocument();
    expect(screen.getByText('this is what gets replaced')).toBeInTheDocument();
    expect(screen.getByTestId('boundary-frame-K2').className).toContain('opacity-40');
  });

  it('the head of the cut shows no left-hand frame — there is no neighbour to show', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'), 'K1');
    expect(screen.queryByText(/· last frame/)).not.toBeInTheDocument();
    expect(screen.getByText('K2 · opening frame')).toBeInTheDocument();
  });
});

describe('SegmentRerenderDialog — the money (D13/D17)', () => {
  it('is wide enough for two boundary frames', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    expect(screen.getByRole('dialog').className).toContain('max-w-[640px]');
    // and the default dialog is untouched
    const { container } = render(<Dialog open onClose={() => {}} title="Plain" actions={null}>body</Dialog>);
    expect(container.querySelector('[role="dialog"]')!.className).toContain('max-w-[480px]');
  });

  it('states the price on the button and posts the chosen boundaries exactly once', async () => {
    markPaidConfirmed();
    const bodies: unknown[] = [];
    server.use(http.post('/api/runs/:id/rerender-job', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: [], boundaries: { mode: 'both' } });
    }));
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));

    await screen.findByLabelText('estimated cost $4.16');
    const go = screen.getByRole('button', { name: /^Re-render K2/ });
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /End on K3/ }));
    fireEvent.click(go);
    await waitFor(() => expect(bodies).toEqual([{ jobId: 'K2', boundaries: 'start' }]));
  });

  it('sends `auto` as auto — the server owns the mirroring, not a stale reading of the cut', async () => {
    markPaidConfirmed();
    const bodies: unknown[] = [];
    server.use(http.post('/api/runs/:id/rerender-job', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: [], boundaries: { mode: 'auto' } });
    }));
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    await screen.findByLabelText('estimated cost $4.16');
    fireEvent.click(screen.getByRole('button', { name: /^Re-render K2/ }));
    await waitFor(() => expect(bodies).toEqual([{ jobId: 'K2', boundaries: 'auto' }]));
  });

  it('the cascade checkbox re-prices and rides along in the request', async () => {
    markPaidConfirmed();
    const bodies: unknown[] = [];
    server.use(
      http.get('/api/runs/:id/estimate', ({ request }) => {
        const cascade = new URL(request.url).searchParams.get('cascade');
        return HttpResponse.json({
          perJob: [], totalUsd: cascade ? 9.5 : 4.16, currency: 'USD', label: 'estimate',
        });
      }),
      http.post('/api/runs/:id/rerender-job', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ takeId: 't2', estUsd: 9.5, cascadeJobs: ['K3'], boundaries: { mode: 'auto' } });
      }),
    );
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    await screen.findByLabelText('estimated cost $4.16');
    // The cascade is offered for the ending nobody pins — which, with an intact joint on that side,
    // is Custom with "End on K3" unticked.
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /End on K3/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Also re-render K3/ }));
    await screen.findByLabelText('estimated cost $9.50');
    fireEvent.click(screen.getByRole('button', { name: /^Re-render K2/ }));
    await waitFor(() => expect(bodies).toEqual([{ jobId: 'K2', boundaries: 'start', cascade: true }]));
  });

  it('a cascade ticked and then pinned away is neither priced nor charged', async () => {
    markPaidConfirmed();
    const bodies: unknown[] = [];
    server.use(
      http.get('/api/runs/:id/estimate', ({ request }) => {
        const cascade = new URL(request.url).searchParams.get('cascade');
        return HttpResponse.json({ perJob: [], totalUsd: cascade ? 9.5 : 4.16, currency: 'USD', label: 'estimate' });
      }),
      http.post('/api/runs/:id/rerender-job', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: [], boundaries: { mode: 'both' } });
      }),
    );
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    await screen.findByLabelText('estimated cost $4.16');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /End on K3/ }));      // unpinned → the offer appears
    fireEvent.click(screen.getByRole('checkbox', { name: /Also re-render K3/ }));
    await screen.findByLabelText('estimated cost $9.50');
    fireEvent.click(screen.getByRole('checkbox', { name: /End on K3/ }));      // pinned again → offer withdrawn
    await screen.findByLabelText('estimated cost $4.16');
    fireEvent.click(screen.getByRole('button', { name: /^Re-render K2/ }));
    await waitFor(() => expect(bodies).toEqual([{ jobId: 'K2', boundaries: 'both' }]));
  });

  it('an unpriced backend says "rate not on file" and still fires — no figure anywhere else', async () => {
    markPaidConfirmed();
    server.use(http.get('/api/runs/:id/estimate', () => HttpResponse.json({
      perJob: [{ jobId: 'K2', seconds: 4, usd: null }],
      totalUsd: null,
      currency: 'USD',
      label: 'estimate',
      unknownPrice: { provider: 'examplevendor', hint: 'examplevendor does not publish a per-second rate for this model.' },
    })));
    const bodies: unknown[] = [];
    server.use(http.post('/api/runs/:id/rerender-job', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ takeId: 't2', estUsd: null, cascadeJobs: [], boundaries: { mode: 'auto' } });
    }));
    // a SYNTHETIC unpriced vendor: every backend we ship is priced, and this test is about the
    // dialog's reaction to an unpriced ESTIMATE, not about who happens to publish rates.
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));

    const go = await screen.findByRole('button', { name: /^Re-render K2 price not set$/ });
    expect(go).toBeEnabled();
    expect(screen.queryByLabelText(/estimated cost/)).not.toBeInTheDocument();
    expect(within(go).getByText('rate not on file')).toBeInTheDocument();
    // every figure on screen belongs to a PaidButton — the dialog quotes none of its own
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent ?? '').not.toMatch(/\$\s?\d/);
    expect(dialog.textContent ?? '').not.toMatch(/\bfree\b/i);
    fireEvent.click(go);
    await waitFor(() => expect(bodies).toHaveLength(1));
  });

  it('the first paid click asks INSIDE this dialog — one scrim, never two', async () => {
    // This jsdom build ships no localStorage, and useFirstPaidConfirm reads a missing one as
    // "already confirmed" — so the confirm path is unreachable until a store exists. Giving it one
    // is the only way to test the thing D13b is about.
    const restore = withLocalStorage();
    const bodies: unknown[] = [];
    server.use(http.post('/api/runs/:id/rerender-job', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: [], boundaries: { mode: 'auto' } });
    }));
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));

    const scrims = () => document.querySelectorAll('.bg-black\\/50');
    expect(scrims()).toHaveLength(1);
    await screen.findByLabelText('estimated cost $4.16');
    fireEvent.click(screen.getByRole('button', { name: /^Re-render K2/ }));

    const confirm = await screen.findByTestId('paid-inline-confirm');
    expect(scrims()).toHaveLength(1);                                  // still exactly one
    expect(screen.getByRole('dialog')).toContainElement(confirm);      // and it is inside THIS dialog
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(bodies).toHaveLength(0);                                    // nothing spent yet

    fireEvent.click(within(confirm).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    restore();
  });

  it('says the current clip is kept, and never calls a paid render free', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@fal'));
    expect(screen.getByText('Your current K2 stays on disk as a take — this adds a new one.')).toBeInTheDocument();
    expect(screen.getByRole('dialog').textContent ?? '').not.toMatch(/\bfree\b/i);
  });
});

// ── The rule the copy hangs on ──────────────────────────────────────────────────────────────────
// The dialog does not mirror the renderer's seam rule any more, it CALLS it: `pinStrengthFor` and
// `pinStrengthsFor` are typed wrappers over src/lib/seam-rule.js, the same module render-seedance.js
// and web/server import. These tests keep that true — a wrapper that started deciding anything for
// itself would let the dialog promise a seam the render only approximates, which is the exact
// failure the whole screen is built to avoid.
describe('pin strength agrees with the renderer, backend for backend', () => {
  it('matches chooseSeamMode for every backend × cast count × end', () => {
    for (const backend of ALL_BACKENDS) {
      const caps = capsFor(backend);
      for (const castRefCount of [0, 1, 4, 9]) {
        const seam = chooseSeamMode({ caps, castRefCount, hasSeamIn: true, hasSeamOut: true });
        expect({ backend, castRefCount, end: 'in', mode: pinStrengthFor(backend, { castRefCount, end: 'in' }) })
          .toEqual({ backend, castRefCount, end: 'in', mode: seam.in.mode });
        expect({ backend, castRefCount, end: 'out', mode: pinStrengthFor(backend, { castRefCount, end: 'out' }) })
          .toEqual({ backend, castRefCount, end: 'out', mode: seam.out.mode });
      }
    }
  });

  // The promise the user actually reads goes through pinStrengthsFor, which ALSO runs the reference
  // budget: a soft pin only holds while there is an image slot left for it. seedance-2.0@fal takes
  // 9 images, so two seven-element characters fill the budget on their own and SEAM_PRIORITY gives
  // up the closing pin, then the opening one. Neither may then be sold as "reference-guided".
  it('a cast that fills the image budget leaves nothing to pin with', () => {
    const backend = 'seedance-2.0@fal';
    expect(pinStrengthsFor(backend, { castRefCount: 2, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'soft', out: 'soft' });
    expect(pinStrengthsFor(backend, { castRefCount: 8, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'soft', out: 'none' });
    expect(pinStrengthsFor(backend, { castRefCount: 14, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'none', out: 'none' });
  });

  // An end with no neighbour is 'none' whatever the budget says, and the budget never touches a
  // NATIVE anchor: it rides its own argument, not the image list.
  it('an unasked end is none, and a native anchor is budget-proof', () => {
    expect(pinStrengthsFor('seedance-2.0@fal', { castRefCount: 0, hasSeamIn: true, hasSeamOut: false }).out).toBe('none');
    expect(pinStrengthsFor('kling-o3@fal', { castRefCount: 9, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'native', out: 'native' });
  });

  it('no Seedance-on-fal combination ever answers "native" — fal soft-pins (the implementer correction)', () => {
    for (const backend of ALL_BACKENDS.filter((b) => String(b).startsWith('seedance') && String(b).endsWith('@fal'))) {
      for (const end of ['in', 'out'] as const) {
        expect(pinStrengthFor(backend, { castRefCount: 0, end })).not.toBe('native');
        expect(pinStrengthFor(backend, { castRefCount: 3, end })).not.toBe('native');
      }
    }
  });

  // 'none' reads as "this join is a scene cut" — the weakest thing the UI can say. 'soft' would
  // render as "near-seamless (reference-guided)", which is a PROMISE, and a build that cannot even
  // resolve the backend id has no business making one.
  it('an id this build cannot resolve promises nothing at all', () => {
    expect(pinStrengthFor('nonsense@nowhere', { castRefCount: 0, end: 'in' })).toBe('none');
    expect(pinStrengthsFor('nonsense@nowhere', { castRefCount: 0, hasSeamIn: true, hasSeamOut: true }))
      .toEqual({ in: 'none', out: 'none' });
  });
});

// ── Fix this take vs fresh take (Segmind seed control) ──────────────────────────────────────────
// This endpoint has ALWAYS re-sent the segment's deterministic seed, so every web re-render was a
// silent "fix" — a near-repeat of the clip the user just rejected, billed in full. Making that a
// choice is the point of the control, which is why three things below are load-bearing:
//
//   * it is REGISTRY-gated and HIDDEN where the cap is absent — a greyed control would advertise a
//     capability the request cannot carry (the server 400s a seedMode on a cap-less backend), and
//     the four body assertions above are the tripwire that fal's request bytes did not move;
//   * it opens on Fresh — the default must be the option that really changes something;
//   * it says nothing about money. Both modes render one segment at the same rate.
describe('SegmentRerenderDialog — fix this take vs fresh take', () => {
  const modeOf = (label: string) => screen.getByRole('radio', { name: label }).getAttribute('aria-checked');

  it('is shown on exactly the backends whose caps carry seedControl', () => {
    for (const backend of ALL_BACKENDS) {
      const { unmount } = open(onBackend(threeSegmentRun(), backend));
      expect(Boolean(screen.queryByTestId('regen-mode')), backend).toBe(Boolean(capsFor(backend).seedControl));
      unmount();
    }
  });

  it('opens on Fresh take, and says what that means', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    expect(modeOf('Fresh take')).toBe('true');
    expect(modeOf('Fix this take')).toBe('false');
    const caption = screen.getByTestId('regen-mode-sentence');
    expect(caption).toHaveTextContent('K2 is rendered again from a new starting point');
    // the two labels differ only in this sentence, so it is announced rather than merely repainted
    expect(caption).toHaveAttribute('aria-live', 'polite');
  });

  it('a lone segment has no boundary plan to make and still gets the choice', () => {
    const run = threeSegmentRun();
    run.spec!.kling.jobs = [run.spec!.kling.jobs[0]];
    run.latestRender!.jobs = [clip('K1')];
    run.continuity = [head];
    open(onBackend(run, 'seedance-2.0@segmind'), 'K1');
    expect(screen.queryByRole('radio', { name: 'Custom' })).not.toBeInTheDocument();
    expect(screen.getByTestId('regen-mode')).toBeInTheDocument();
    expect(screen.getByTestId('regen-mode-sentence')).toHaveTextContent('K1 is rendered again');
    // With no boundary block above it, the seed control is the dialog's FIRST control — initial
    // focus must land on the checked 'Fresh take' radio, not the unchecked 'Fix this take' first
    // in DOM order, where a Space reflex would silently flip a paid choice (Dialog.tsx skips
    // roving-tabindex members for exactly this dialog).
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Fresh take' }));
  });

  it('posts the mode it is showing — fresh by default, fix once picked', async () => {
    markPaidConfirmed();
    const bodies: unknown[] = [];
    server.use(http.post('/api/runs/:id/rerender-job', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ takeId: 't2', estUsd: 4.16, cascadeJobs: [], boundaries: { mode: 'auto' }, seed: 4242 });
    }));

    const { unmount } = open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    await screen.findByLabelText('estimated cost $4.16');
    fireEvent.click(screen.getByRole('button', { name: /^Re-render K2/ }));
    await waitFor(() => expect(bodies).toEqual([{ jobId: 'K2', boundaries: 'auto', seedMode: 'fresh' }]));
    unmount();

    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    await screen.findByLabelText('estimated cost $4.16');
    fireEvent.click(screen.getByRole('radio', { name: 'Fix this take' }));
    fireEvent.click(screen.getByRole('button', { name: /^Re-render K2/ }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ jobId: 'K2', boundaries: 'auto', seedMode: 'fix' });
  });

  // Same rule the boundary boxes follow (and the same reason): the dialog resets on the SEGMENT and
  // on opening, never on a run snapshot — an SSE tick under an open dialog must not quietly move a
  // paid choice the user already made.
  it('resets to Fresh per segment, and a run update underneath an open dialog does not', () => {
    const run = onBackend(threeSegmentRun(), 'seedance-2.0@segmind');
    const { rerender } = renderReview(<SegmentRerenderDialog run={run} jobId="K2" open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Fix this take' }));
    expect(modeOf('Fix this take')).toBe('true');

    rerender(<SegmentRerenderDialog run={{ ...run, status: 'rendering' }} jobId="K2" open onClose={() => {}} />);
    expect(modeOf('Fix this take')).toBe('true');

    rerender(<SegmentRerenderDialog run={run} jobId="K3" open onClose={() => {}} />);
    expect(modeOf('Fresh take')).toBe('true');
  });

  it('switching mode re-prices nothing — the starting point is not a price', async () => {
    let estimates = 0;
    server.use(http.get('/api/runs/:id/estimate', () => { estimates += 1; return HttpResponse.json(ESTIMATE); }));
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    await screen.findByLabelText('estimated cost $4.16');
    expect(estimates).toBe(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Fix this take' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Fresh take' }));
    await waitFor(() => expect(screen.getByTestId('regen-mode-sentence')).toHaveTextContent('new starting point'));
    expect(estimates).toBe(1);
  });

  it('never sells a fix as the cheaper option', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    fireEvent.click(screen.getByRole('radio', { name: 'Fix this take' }));
    const block = screen.getByTestId('regen-mode');
    expect(block).toHaveTextContent('Same price as a fresh take.');
    expect(block.textContent ?? '').not.toMatch(/\$/);
    expect(block.textContent ?? '').not.toMatch(/\b(free|cheap|cheaper|discount)\b/i);
  });

  // The server sends the chosen seed for THIS segment only (a cascade's children keep their own
  // deterministic default), so a ticked cascade must not be read as "fix everything after it".
  it('a ticked cascade says the mode applies to this segment alone', () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    expect(screen.queryByTestId('regen-cascade-note')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /End on K3/ }));   // unpinned ending → cascade offered
    fireEvent.click(screen.getByRole('checkbox', { name: /Also re-render K3/ }));
    expect(screen.getByTestId('regen-cascade-note')).toHaveTextContent(
      'This applies to K2 only — K3 and everything after it are re-rendered to follow it, each from its own starting point.',
    );
  });

  it('a saved prompt edit sharpens the fix sentence and nudges — it never moves the selection', async () => {
    server.use(http.get('/api/runs/:id/prompts', ({ params }) => HttpResponse.json({
      runId: String(params.id),
      backend: 'seedance-2.0@segmind',
      jobs: ['K1', 'K2', 'K3'],
      prompts: [promptView('K1'), promptView('K2', { source: 'override' })],
      orphaned: [],
    })));
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));

    // the hint arrives with the prompt read; the default does NOT move with it
    expect(await screen.findByTestId('regen-edit-hint')).toHaveTextContent('K2 carries a saved prompt edit');
    expect(modeOf('Fresh take')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'Fix this take' }));
    expect(screen.getByTestId('regen-mode-sentence')).toHaveTextContent('your prompt edit lands on this picture');
    expect(screen.getByTestId('regen-mode-sentence')).toHaveTextContent('close, not guaranteed');
    // the nudge has done its job once fix is picked — the sentence now says the same thing
    expect(screen.queryByTestId('regen-edit-hint')).not.toBeInTheDocument();
  });

  it('an unedited segment gets no nudge, and the fix sentence pairs itself with an edit instead', async () => {
    open(onBackend(threeSegmentRun(), 'seedance-2.0@segmind'));
    fireEvent.click(screen.getByRole('radio', { name: 'Fix this take' }));
    await waitFor(() =>
      expect(screen.getByTestId('regen-mode-sentence')).toHaveTextContent('expect nearly the same clip'));
    expect(screen.queryByTestId('regen-edit-hint')).not.toBeInTheDocument();
  });
});
