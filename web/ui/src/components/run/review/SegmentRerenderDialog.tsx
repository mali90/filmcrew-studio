// Re-rendering ONE segment, with its two joins in plain words before a penny is spent.
//
// This is the only place a segment re-render is started (the rail's "Re-render one segment" row and
// the clip strip's segment actions both open THIS dialog and post to THIS endpoint — one code path,
// spec D28/D29). A dialog is justified because the action is paid and consequential (spec D13); the
// price lives on a PaidButton, and inside an open dialog that button asks its one-time confirmation
// INLINE, so there is never a second scrim over the first (spec D13b).
//
// The honesty rule this screen exists to keep: what we promise about a join must be what the
// renderer will really do. The strength of a pin comes from `pinStrengthsFor` — the renderer's own
// seam rule AND its reference-budget arithmetic (src/lib/seam-rule.js), not a mirror of either —
// and the sentence from `boundaryPlanSentence`, so "seamless" can only ever be said about a native
// first/last-frame anchor, a reference-guided pin says exactly that, and a pin the image budget
// will drop is not sold at all (spec D14/D15 with the implementer's soft-pin correction).
//
// The second promise, on the backends that can keep it: what the render starts FROM. Where the caps
// carry `seedControl`, this dialog asks whether to re-send the seed the clip on screen rendered from
// ("Fix this take") or to draw a new one ("Fresh take") — the same honesty rule applies, so a fix is
// described as close rather than guaranteed, and never as the cheaper option, because it is not.
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowLeft, ArrowRight } from 'lucide-react';
import type { Aspect, BoundaryMode, ContinuityEntry, JobView, RunDetail, SeedMode } from '../../../../../shared/api-types';
import { capsFor, castRefCountFor, seedControlFor } from '../../../../../shared/render-models';
import { api, ApiClientError } from '../../../api/client';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { useToast } from '../../ui/Toast';
import { boundaryPlanSentence, downstreamSeamSentence, regenerationSentence, segmentJoins, type BoundaryChoice } from './lib';
import { PaidButton } from './PaidButton';
import { usePlanPrompts } from './PromptSheet';

/** The neighbour's still, next to its clip: `…/K1/clip.mp4` → `…/K1/last_frame.png`. */
const frameUrl = (clipUrl: string | null | undefined, file: string) =>
  (clipUrl ? clipUrl.replace(/[^/]+$/, file) : null);

/**
 * One 96px-tall boundary still (spec D14.2). A frame the renderer never wrote is NOT quietly
 * replaced by the wrong end of a clip: only an OPENING frame has a truthful fallback, because the
 * first thing a <video> paints is exactly that frame.
 */
function FrameShot({ src, clipUrl, alt, caption, aspect, dim = false, fallback, testId }: {
  src: string | null;
  clipUrl: string | null;
  alt: string;
  caption: string;
  aspect: Aspect;
  dim?: boolean;
  fallback: 'opening-frame' | 'none';
  testId: string;
}) {
  const [failed, setFailed] = useState(false);
  const style = { height: 96, aspectRatio: aspect.replace(':', ' / ') };
  const box = clsx('block shrink-0 overflow-hidden rounded-r2 border border-line bg-black object-cover', dim && 'opacity-40');

  return (
    <figure className="flex shrink-0 flex-col items-center gap-1">
      {src && !failed ? (
        <img src={src} alt={alt} style={style} className={box} onError={() => setFailed(true)} data-testid={testId} />
      ) : clipUrl && fallback === 'opening-frame' ? (
        <video src={clipUrl} preload="metadata" muted aria-label={alt} style={style} className={box} data-testid={testId} />
      ) : (
        <span style={style} className={clsx(box, 'flex items-center justify-center px-1 text-center text-caption text-ink-faint')} data-testid={testId}>
          no still on file
        </span>
      )}
      <figcaption className="text-caption text-ink-muted">{caption}</figcaption>
    </figure>
  );
}

/** A warn row: informative, never blocking (spec D16). */
function WarnRow({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="flex gap-2 rounded-r2 border border-line bg-[var(--status-warn-soft)] p-2.5 text-dense text-ink-secondary"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-warn" aria-hidden />
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function SegmentRerenderDialog({ run, jobId, open, onClose }: {
  run: RunDetail;
  jobId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [plan, setPlan] = useState<'auto' | 'custom'>('auto');
  const [cascade, setCascade] = useState(false);
  // What a re-render starts FROM, where the backend lets that be chosen. 'fresh' is the default on
  // purpose: the dialog is opened by someone who dislikes the clip, and this endpoint has always
  // re-sent the segment's deterministic seed — a silent near-repeat of a take they just rejected,
  // billed in full. Defaulting to the choice that really changes something is the honest one; the
  // targeted fix is one click away and says what it is worth.
  const [seedMode, setSeedMode] = useState<SeedMode>('fresh');
  // Where PaidButton's one-time confirmation renders — a slot this dialog owns, so the confirm
  // sentence appears INSIDE this dialog instead of behind a second scrim (spec D13b).
  const [confirmSlot, setConfirmSlot] = useState<HTMLElement | null>(null);

  const specJobs = (run.spec?.kling?.jobs ?? []).map((j) => j.job_id);
  const ids = specJobs.length ? specJobs : (run.latestRender?.jobs ?? []).map((j) => j.jobId);
  const idx = ids.indexOf(jobId);
  const prevId = idx > 0 ? ids[idx - 1] : null;
  const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;

  const clipOf = (id: string | null): JobView | null =>
    (id ? run.latestRender?.jobs.find((j) => j.jobId === id) ?? null : null);
  const entryOf = (id: string | null): ContinuityEntry | null =>
    (id ? (run.continuity ?? []).find((e) => e.jobId === id) ?? null : null);

  const backend = run.latestRender?.backend ?? run.backend ?? 'kling';
  const castRefCount = castRefCountFor(run.spec, jobId);
  // What `boundaries:'auto'` will resolve to on the server, and what the re-render it starts does to
  // this segment's two joins. One derivation, shared with the rail's "the plan changed" block
  // (./lib segmentJoins) — both post to the same endpoint, so both must offer the same things.
  const joinsFor = (over?: { pinStart: boolean; pinEnd: boolean }) => segmentJoins({
    backend,
    castRefCount,
    otherRefCount: run.voiceRefs?.[jobId] ?? 0,
    hasPrev: Boolean(prevId),
    hasNext: Boolean(nextId),
    entry: entryOf(jobId),
    nextEntry: entryOf(nextId),
    ...over,
  });
  const { autoStart, autoEnd } = joinsFor();

  const [pinStart, setPinStart] = useState(autoStart);
  const [pinEnd, setPinEnd] = useState(autoEnd);
  // Opening the dialog on another segment must not carry the previous segment's answers over.
  // Deliberately keyed on the segment and on opening only: the cut moving underneath an OPEN dialog
  // (an SSE snapshot lands) must not silently re-tick the boxes a user just chose.
  useEffect(
    () => { setPlan('auto'); setCascade(false); setPinStart(autoStart); setPinEnd(autoEnd); setSeedMode('fresh'); },
    [jobId, open], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The Custom plan re-asks the same question with the boxes as they stand; Auto keeps the answer
  // the cut already gave. Strengths are budget-aware and per end (the budget can preserve one pin
  // and drop the other), which is what the sentence and the warning below are built from.
  const { wantStart, wantEnd, startStrength, endStrength, showSeamWarning, offerCascade } =
    plan === 'custom' ? joinsFor({ pinStart, pinEnd }) : joinsFor();

  // What gets POSTed. `auto` is sent as `auto` — the server owns the mirroring, and re-deriving it
  // here into 'both'/'start' would freeze a stale reading of the cut into the request.
  const boundaries: BoundaryMode = plan === 'auto'
    ? 'auto'
    : wantStart && wantEnd ? 'both' : wantStart ? 'start' : wantEnd ? 'end' : 'none';

  const resolved: BoundaryChoice = wantStart && wantEnd ? 'both' : wantStart ? 'start' : wantEnd ? 'end' : 'none';
  const sentence = boundaryPlanSentence({
    jobId,
    prev: prevId ? { jobId: prevId } : null,
    next: nextId ? { jobId: nextId } : null,
    boundaries: resolved,
    pinStrength: { in: startStrength, out: endStrength },
  });

  // Derived, never stored: ticking the box and THEN pinning the ending (Custom) must not post a
  // cascade this screen has stopped offering.
  const willCascade = cascade && offerCascade;

  // Segmind's native frame slots are mutually exclusive with reference_images, so a segment that
  // carries cast references is pinned by reference instead. We do not silently swallow that: the
  // trade the renderer made is stated, with the reason (spec D16).
  let excludesRefs = false;
  let modelWords = 'This model';
  try {
    const caps = capsFor(backend);
    excludesRefs = Boolean(caps.firstFrameExcludesRefs);
    modelWords = caps.family === 'seedance' ? 'Seedance on Segmind' : 'This model';
  } catch { excludesRefs = false; }
  const refsTradeoff = excludesRefs && castRefCount > 0 && (wantStart || wantEnd);

  // Whether this backend lets a re-render choose its starting point at all — registry-derived, and
  // HIDDEN rather than disabled where it is not: a greyed control would advertise a capability the
  // request cannot carry (the server 400s a seedMode on a cap-less backend), and on those backends
  // this dialog must post exactly the body it always has.
  const seedControl = seedControlFor(backend);
  // Does this segment carry a saved prompt edit? Same read as the strip's pen overlay, on the SAME
  // cache entry (usePlanPrompts) — so opening this dialog on the review page costs no request, and
  // the two surfaces can never disagree about which segments were edited. Enabled only where the
  // choice is offered: on every other backend this dialog fetches exactly what it always did.
  // Absent or still loading reads as "no edit": the hint is a nudge, never a gate.
  const prompts = usePlanPrompts(run.id, open && seedControl);
  const promptEdited = prompts.data?.prompts.find((p) => p.jobId === jobId)?.source === 'override';

  const estimate = useQuery({
    queryKey: ['estimate', run.id, 'job', jobId, willCascade],
    queryFn: () => api.estimate(run.id, { mode: 'job', jobId, ...(willCascade ? { cascade: true } : {}) }),
    enabled: open,
  });

  const rerender = useMutation({
    // `seedMode` rides only where the control was on screen, and then ALWAYS explicitly: omitting it
    // is what the server reads as "no seed chosen", and a backend that offers the choice must never
    // have the choice inferred for it.
    mutationFn: () => api.rerenderJob(run.id, {
      jobId, boundaries, ...(willCascade ? { cascade: true } : {}), ...(seedControl ? { seedMode } : {}),
    }),
    // No success toast: the strip's tile starts sweeping, and a toast for a change already on
    // screen is noise (spec D17). A failure has nothing on screen to show, so it still toasts.
    onSuccess: () => onClose(),
    onError: (e: Error) =>
      toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e.message }),
  });

  const aspect = run.aspect ?? '9:16';
  const pending = rerender.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="wide"
      title={`Re-render ${jobId}`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <PaidButton
            variant="primary"
            confirmMode="inline"
            confirmSlot={confirmSlot}
            costUsd={estimate.data?.totalUsd ?? null}
            costUnknown={Boolean(estimate.data?.unknownPrice)}
            loading={pending}
            onPaidClick={() => rerender.mutate()}
          >
            Re-render {jobId}
          </PaidButton>
        </>
      }
    >
      <div className={clsx('flex flex-col gap-4', pending && 'pointer-events-none opacity-60')}>
        <div className="flex items-center justify-center gap-2" data-testid="boundary-row">
          {prevId && (
            <>
              <FrameShot
                testId={`boundary-frame-${prevId}`}
                src={frameUrl(clipOf(prevId)?.clipUrl, 'last_frame.png')}
                clipUrl={null}
                fallback="none"
                alt={`${prevId}'s last frame`}
                caption={`${prevId} · last frame`}
                aspect={aspect}
              />
              <ArrowRight size={16} className="shrink-0 text-ink-faint" aria-hidden />
            </>
          )}
          <FrameShot
            testId={`boundary-frame-${jobId}`}
            src={null}
            clipUrl={clipOf(jobId)?.clipUrl ?? null}
            fallback="opening-frame"
            alt={`${jobId} as it is now`}
            caption="this is what gets replaced"
            aspect={aspect}
            dim
          />
          {nextId && (
            <>
              <ArrowLeft size={16} className="shrink-0 text-ink-faint" aria-hidden />
              <FrameShot
                testId={`boundary-frame-${nextId}`}
                src={frameUrl(clipOf(nextId)?.clipUrl, 'first_frame.png')}
                clipUrl={clipOf(nextId)?.clipUrl ?? null}
                fallback="opening-frame"
                alt={`${nextId}'s opening frame`}
                caption={`${nextId} · opening frame`}
                aspect={aspect}
              />
            </>
          )}
        </div>

        <p className="text-body text-ink-secondary" data-testid="boundary-plan-sentence">{sentence}</p>

        {(prevId || nextId) && (
          <div className="flex flex-col gap-2">
            <SegmentedControl
              label="Boundary plan"
              value={plan}
              onChange={(v) => {
                // Custom opens on what auto would have done, so the first click changes nothing
                // by surprise — it only makes the plan editable.
                if (v === 'custom') { setPinStart(autoStart); setPinEnd(autoEnd); }
                setPlan(v);
              }}
              segments={[{ value: 'auto', label: 'Auto' }, { value: 'custom', label: 'Custom' }]}
            />
            {plan === 'auto' ? (
              <p className="text-caption text-ink-muted">Mirrors the joins this cut already has.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {prevId && (
                  <label className="flex items-center gap-2 text-dense text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={pinStart}
                      onChange={(e) => setPinStart(e.target.checked)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    Start on {prevId}&rsquo;s last frame
                  </label>
                )}
                {nextId && (
                  <label className="flex items-center gap-2 text-dense text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={pinEnd}
                      onChange={(e) => setPinEnd(e.target.checked)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    End on {nextId}&rsquo;s opening frame
                  </label>
                )}
              </div>
            )}
          </div>
        )}

        {/* What the re-render starts FROM. Deliberately below the boundary plan (the joins are what
            this screen is chiefly about) and above the warnings, and shown for a lone segment too —
            a cut of one has no joins to plan but the same choice about its own picture. */}
        {seedControl && (
          <div className="flex flex-col gap-2" data-testid="regen-mode">
            <SegmentedControl
              label="What this re-render changes"
              value={seedMode}
              onChange={setSeedMode}
              segments={[{ value: 'fix', label: 'Fix this take' }, { value: 'fresh', label: 'Fresh take' }]}
            />
            {/* Announced, not just repainted: the two options differ only in this sentence, so a
                screen-reader user who never sees it is choosing between two identical labels. */}
            <p className="text-caption text-ink-muted" aria-live="polite" data-testid="regen-mode-sentence">
              {regenerationSentence({ jobId, mode: seedMode, promptEdited })}
            </p>
            {promptEdited && seedMode === 'fresh' && (
              // A pending edit makes "fix" the interesting option — so it is pointed at, and left
              // unpicked. Choosing for the user here would silently re-send the seed of a clip they
              // opened this dialog to get away from.
              <p className="text-caption text-ink-muted" data-testid="regen-edit-hint">
                {jobId} carries a saved prompt edit — &ldquo;Fix this take&rdquo; is the option that lands it on this picture.
              </p>
            )}
            {willCascade && nextId && (
              // The mode applies to the chosen segment ALONE (the server sends no seed downstream),
              // so a ticked cascade must not be read as "fix everything after it" either.
              <p className="text-caption text-ink-muted" data-testid="regen-cascade-note">
                This applies to {jobId} only — {nextId} and everything after it are re-rendered to follow it,
                each from its own starting point.
              </p>
            )}
          </div>
        )}

        {/* Either end being reference-guided earns the caveat: a plan that pins one end softly and
            leaves the other to the budget is still selling a pin that is not frame-exact. */}
        {(startStrength === 'soft' || endStrength === 'soft') && (
          <WarnRow testId="soft-pin-warning">
            Frame pinning here is reference-guided — close, but not guaranteed frame-perfect.
          </WarnRow>
        )}

        {refsTradeoff && (
          // Deliberately NOT a chooser: this build's endpoint has no way to render a segment
          // without its cast, so offering "exact frames" would be a button we cannot honour. What
          // the renderer decided, and why, is stated instead.
          <WarnRow testId="refs-tradeoff-note">
            {modelWords} can pin an exact frame only when a segment carries no reference images.{' '}
            {jobId} has {castRefCount === 1 ? 'a cast reference' : `${castRefCount} cast references`}, so this take
            keeps the cast and pins by reference — identity first, frame second.
          </WarnRow>
        )}

        {showSeamWarning && (
          <WarnRow testId="downstream-seam-warning">
            <p>{downstreamSeamSentence({ jobId, nextId: nextId!, endStrength })}</p>
            {offerCascade && (
              <label className="mt-2 flex items-center gap-2 text-dense text-ink-secondary">
                <input
                  type="checkbox"
                  checked={cascade}
                  onChange={(e) => setCascade(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                Also re-render {nextId} and everything after it
              </label>
            )}
          </WarnRow>
        )}

        {/* PaidButton's one-time confirmation lands here — inside this dialog, never behind a second scrim. */}
        <div ref={setConfirmSlot} data-testid="paid-confirm-slot" />

        <p className="text-caption text-ink-muted">
          Your current {jobId} stays on disk as a take — this adds a new one.
        </p>
      </div>
    </Dialog>
  );
}
