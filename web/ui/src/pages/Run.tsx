// The hero screen: one scrolling narrative that morphs with run.status. The SSE snapshot seeds
// the live state; the REST query is the fallback until it arrives (and stays fresh because
// useRunEvents invalidates it on every lifecycle edge).
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import type { RunDetail } from '../../../shared/api-types';
import { api } from '../api/client';
import { useRunEvents } from '../api/useRunEvents';
import { elapsed, seconds, spendLabel } from '../lib/format';
import { PhaseStrip } from '../components/run/PhaseStrip';
import { AgentRail } from '../components/run/AgentRail';
import { SpecInspector } from '../components/run/SpecInspector';
import { PlanReview } from '../components/run/PlanReview';
import { JobCards } from '../components/run/JobCards';
import { LogViewer } from '../components/run/LogViewer';
import { AttentionBanner } from '../components/run/AttentionBanner';
import { ReviewStage, ChangeRequestPanel, ApproveBar, TakesHistory, FinalCard } from '../components/run/review';
import { PromptSheet, PromptSheetProvider } from '../components/run/review/PromptSheet';

/** The rail's calm fact sheet while clips render. */
function RunFacts({ run }: { run: RunDetail }) {
  const ledger = run.manifest?.costLedger ?? [];
  // The cast the run actually pins, per character with its reference count (U2a) — the picker's
  // other half, verifiable after Create without opening the spec inspector.
  const refCounts = new Map<string, number>();
  for (const el of run.spec?.kling?.elements ?? []) {
    const who = el.character ?? el.id;
    refCounts.set(who, (refCounts.get(who) ?? 0) + 1);
  }
  const cast = [...refCounts].map(([who, n]) => `${who} (${n} ref${n === 1 ? '' : 's'})`).join(' · ');
  const facts: [string, string][] = [
    ['backend', run.backend ?? '—'],
    ['aspect', run.aspect ?? '—'],
    // the per-run resolution pick changes the bill, so it must be verifiable here (U2a)
    ['resolution', run.manifest?.resolution ?? 'model default'],
    ['duration', seconds(run.durationS)],
    ['takes', String(run.manifest?.takes?.length ?? 0)],
    ...(cast ? ([['cast', cast]] as [string, string][]) : []),
    ['est. cost so far', spendLabel(ledger)],
  ];
  return (
    <section aria-label="Run facts" className="rounded-r3 border border-line bg-surface-1 p-4">
      <h3 className="text-heading text-ink">This run</h3>
      <dl className="mt-2 space-y-1.5">
        {facts.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-caption text-ink-muted">{k}</dt>
            <dd className="tnum min-w-0 truncate text-right text-dense text-ink-secondary">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The deliver interstitial (U7): reads the same cached estimate ApproveBar fetched, so the target
 *  it names is the provider's real one — never a hardcoded "1080p" over a 720p/4K plan. */
function UpscaleInterstitial({ run }: { run: RunDetail }) {
  // The vendor THIS upscale is billing: approve just wrote it on the ledger line. Quoting the
  // env-derived default here instead could name the wrong target the moment the pick diverges
  // (Segmind honors UPSCALE_TARGET_RESOLUTION; fal lifts toward ~1080p). When the pick is on
  // record the query key matches the estimate ApproveBar already cached for that provider.
  const ledgerProvider = [...(run.manifest?.costLedger ?? [])].reverse().find((l) => l.action === 'upscale')?.provider ?? null;
  const estimate = useQuery({
    queryKey: ['estimate', run.id, 'upscale', null, ledgerProvider],
    queryFn: () => api.estimate(run.id, { mode: 'upscale', provider: ledgerProvider ?? undefined }),
  });
  const targetShort = estimate.data?.targetShortSide ?? 1080;
  const targetLabel = targetShort >= 2160 ? '4K' : `${targetShort}p`;
  const startedAt = run.manifest?.activeJob?.startedAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return (
    <section role="status" className="rounded-r3 border border-line bg-surface-1 p-5">
      <h2 className="text-heading text-ink">Approved — upscaling with Topaz</h2>
      <p className="mt-1 text-dense text-ink-muted">
        {/* while the estimate loads, the target clause is dropped rather than guessed */}
        {estimate.data
          ? <>Topaz is lifting the stitched master toward ~{targetLabel}. The final file lands here when it finishes.</>
          : <>Topaz is lifting the stitched master. The final file lands here when it finishes.</>}
      </p>
      <div className="sweep mt-3 h-1 w-full" aria-hidden />
      {startedAt && (
        <p className="tnum mt-2 text-caption text-ink-muted">{elapsed(now - new Date(startedAt).getTime())}</p>
      )}
    </section>
  );
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const live = useRunEvents(id);
  const runQ = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id as string),
    enabled: Boolean(id),
  });
  const run = live.run ?? runQ.data?.run ?? null;

  // The cut the reviewer previews (null ⇒ latest) is shared between the stage (preview) and the
  // approve bar (finalize/upscale target) so approving finalizes exactly the cut on screen.
  const [cutId, setCutId] = useState<string | null>(null);
  // Drop the selection back to "latest" when the run changes (React Router reuses this component
  // across /runs/A → /runs/B) OR when a new cut arrives — so after the reviewer re-renders, the bar
  // targets the freshly paid-for cut instead of clinging to the now-superseded one they had picked.
  const latestCutId = run?.manifest?.cuts?.at(-1)?.id ?? null;
  useEffect(() => { setCutId(null); }, [id, latestCutId]);

  // A real stream drop, never the initial connect (U8): only after we HAD a live snapshot does a
  // disconnected EventSource mean the picture on screen may be going stale.
  const [linkDropped, setLinkDropped] = useState(false);
  useEffect(() => {
    if (live.connected) setLinkDropped(false);
    else if (live.run) setLinkDropped(true); // we HAD a snapshot — this is a drop, not a first connect
  }, [live.connected, live.run]);

  if (!run) return null; // sub-400ms fetch — no skeleton flash

  // attention: keep whichever stage the run actually reached under the banner
  const hasRenderArtifacts = (run.latestRender?.jobs?.length ?? 0) > 0;

  let main: ReactNode;
  let rail: ReactNode;
  switch (run.status) {
    case 'planning':
      main = (
        <>
          {/* Revising from review morphs the whole page into the agent rail — honest about what is
              happening, but silent about what was NOT lost. Say it (U9). */}
          {(run.manifest?.takes?.length ?? 0) > 0 && (
            <div className="rounded-r3 border border-line bg-surface-1 px-4 py-3 text-dense text-ink-secondary" data-testid="revise-in-review-notice">
              Revising the plan — your clips, takes and cut are untouched. Review returns when the agents finish, and nothing re-renders until you choose.
            </div>
          )}
          <div id="section-plan"><AgentRail run={run} live={live} /></div>
          <LogViewer run={run} live={live} defaultExpanded />
        </>
      );
      rail = <SpecInspector run={run} />;
      break;
    case 'plan-ready':
      main = (
        <>
          <div id="section-plan"><AgentRail run={run} live={live} collapsed /></div>
          <PlanReview run={run} />
          <PromptSheet run={run} />
        </>
      );
      rail = <SpecInspector run={run} />;
      break;
    case 'rendering': {
      // an approved run being Topaz-upscaled is DELIVERING — bouncing back to the job cards reads
      // as a regression to the render step
      //
      // A job-mode re-render replaces ONE clip of a cut the user is reviewing — tearing the review
      // room down for it would take away the very video they just paid to improve (U1). Full
      // renders, probes and first renders replace everything, so JobCards stays the honest view.
      //
      // The re-render is ONE interval, and `activeJob` names only its middle: it is empty while the
      // job waits behind another run's child (the queue is global, only the SPEND lock is per run),
      // and it reads `assemble` while the free stitch that follows rebuilds the master. Keyed on it,
      // the stage was torn down and rebuilt on both sides of the model process. The take being
      // worked on is what actually names the interval, and `rerender-job` records its mode before it
      // enqueues anything — so a full render or a probe can never be mistaken for one.
      const segmentRerender = run.phase === 'render'
        && run.manifest?.takes?.at(-1)?.mode === 'job'
        && (run.manifest?.cuts?.length ?? 0) > 0;
      main = run.phase === 'deliver' ? (
        <>
          <div id="section-deliver"><UpscaleInterstitial run={run} /></div>
          <LogViewer run={run} live={live} />
        </>
      ) : segmentRerender ? (
        <>
          <div id="section-review"><ReviewStage run={run} cutId={cutId} setCutId={setCutId} /></div>
          <PromptSheet run={run} />
          <LogViewer run={run} live={live} />
        </>
      ) : (
        <>
          <div id="section-render"><JobCards run={run} /></div>
          <PromptSheet run={run} />
          <LogViewer run={run} live={live} />
        </>
      );
      // no ApproveBar in the segment-re-render state — nothing is approvable mid-render
      rail = (
        <>
          <RunFacts run={run} />
          <TakesHistory run={run} />
        </>
      );
      break;
    }
    case 'attention':
      main = (
        <>
          <AttentionBanner run={run} />
          {hasRenderArtifacts ? (
            <div id="section-render"><JobCards run={run} /></div>
          ) : (
            <div id="section-plan"><AgentRail run={run} live={live} /></div>
          )}
          {hasRenderArtifacts && <PromptSheet run={run} />}
          <LogViewer run={run} live={live} defaultExpanded />
        </>
      );
      rail = hasRenderArtifacts ? (
        <>
          <RunFacts run={run} />
          <TakesHistory run={run} />
        </>
      ) : (
        <SpecInspector run={run} />
      );
      break;
    case 'review':
      main = (
        <>
          <div id="section-review"><ReviewStage run={run} cutId={cutId} setCutId={setCutId} /></div>
          {/* Directly beneath the stage band, pushing the log down — an inline disclosure, never a
              modal or a side sheet (spec D18). */}
          <PromptSheet run={run} />
          <LogViewer run={run} live={live} />
        </>
      );
      // Approve on top (U6): the free, happy-path exit must not sit below a money accordion and a
      // history list — that layout reads as "you are expected to keep spending".
      rail = (
        <>
          <ApproveBar run={run} cutId={cutId} />
          <ChangeRequestPanel run={run} />
          <TakesHistory run={run} />
        </>
      );
      break;
    case 'complete':
      main = <div id="section-deliver"><FinalCard run={run} /></div>;
      rail = <TakesHistory run={run} />;
      break;
  }

  return (
    // The prompt sheet's open target is held above `main`: the controls that open it live in the
    // plan card, the job cards and the clip strip, while the one panel lives under the stage band.
    <PromptSheetProvider>
      <div>
        <PhaseStrip run={run} agents={live.agents} activeKind={live.activeKind} />
        {/* Silence during paid work is the most expensive kind of silence (U8): EventSource retries
            by itself, the user just needs to know the picture may be stale meanwhile. */}
        {linkDropped && (run.status === 'planning' || run.status === 'rendering') && (
          <div role="status" className="-mx-6 border-b border-line bg-[var(--status-warn-soft)] px-6 py-2 text-dense text-ink-secondary">
            Live updates dropped — reconnecting. The run keeps going on the server; this page may lag until the stream is back.
          </div>
        )}
        {run.idea && (
          <div className="sticky top-[104px] z-20 -mx-6 h-10 border-b border-line bg-surface-0/90 px-6 backdrop-blur">
            <div className="mx-auto flex h-full max-w-[1280px] items-center gap-3">
              <span className="shrink-0 text-caption uppercase tracking-wide text-ink-muted">Idea</span>
              <p className="min-w-0 truncate text-body text-ink-secondary" title={run.idea}>{run.idea}</p>
            </div>
          </div>
        )}
        <div className="mx-auto w-full max-w-[1280px] px-6 py-6">
          <div className="flex flex-col gap-6 lg:flex-row">
            <main className="min-w-0 flex-1 space-y-6">{main}</main>
            <aside className={`w-full shrink-0 space-y-4 lg:sticky ${run.idea ? 'lg:top-[144px]' : 'lg:top-[104px]'} lg:w-[380px] lg:self-start`}>
              {rail}
            </aside>
          </div>
        </div>
      </div>
    </PromptSheetProvider>
  );
}
