// The hero screen: one scrolling narrative that morphs with run.status. The SSE snapshot seeds
// the live state; the REST query is the fallback until it arrives (and stays fresh because
// useRunEvents invalidates it on every lifecycle edge).
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { RunDetail } from '../../../shared/api-types';
import { api } from '../api/client';
import { useRunEvents } from '../api/useRunEvents';
import { seconds, usd } from '../lib/format';
import { PhaseStrip } from '../components/run/PhaseStrip';
import { AgentRail } from '../components/run/AgentRail';
import { SpecInspector } from '../components/run/SpecInspector';
import { PlanReview } from '../components/run/PlanReview';
import { JobCards } from '../components/run/JobCards';
import { LogViewer } from '../components/run/LogViewer';
import { AttentionBanner } from '../components/run/AttentionBanner';
import { ReviewStage, ChangeRequestPanel, ApproveBar, TakesHistory, FinalCard } from '../components/run/review';

/** The rail's calm fact sheet while clips render. */
function RunFacts({ run }: { run: RunDetail }) {
  const ledger = run.manifest?.costLedger ?? [];
  const spentUsd = ledger.reduce((acc, e) => acc + (e.estUsd ?? 0), 0);
  const facts: [string, string][] = [
    ['backend', run.backend ?? '—'],
    ['aspect', run.aspect ?? '—'],
    ['duration', seconds(run.durationS)],
    ['takes', String(run.manifest?.takes?.length ?? 0)],
    ['est. cost so far', usd(spentUsd)],
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

  if (!run) return null; // sub-400ms fetch — no skeleton flash

  // attention: keep whichever stage the run actually reached under the banner
  const hasRenderArtifacts = (run.latestRender?.jobs?.length ?? 0) > 0;

  let main: ReactNode;
  let rail: ReactNode;
  switch (run.status) {
    case 'planning':
      main = (
        <>
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
        </>
      );
      rail = <SpecInspector run={run} />;
      break;
    case 'rendering':
      // an approved run being Topaz-upscaled is DELIVERING — bouncing back to the job cards reads
      // as a regression to the render step
      main = run.phase === 'deliver' ? (
        <>
          <div id="section-deliver">
            <section role="status" className="rounded-r3 border border-line bg-surface-1 p-5">
              <h2 className="text-heading text-ink">Approved — upscaling to 1080p</h2>
              <p className="mt-1 text-dense text-ink-muted">
                Topaz is lifting the stitched master. The final file lands here when it finishes.
              </p>
              <div className="sweep mt-3 h-1 w-full" aria-hidden />
            </section>
          </div>
          <LogViewer run={run} live={live} />
        </>
      ) : (
        <>
          <div id="section-render"><JobCards run={run} /></div>
          <LogViewer run={run} live={live} />
        </>
      );
      rail = (
        <>
          <RunFacts run={run} />
          <TakesHistory run={run} />
        </>
      );
      break;
    case 'attention':
      main = (
        <>
          <AttentionBanner run={run} />
          {hasRenderArtifacts ? (
            <div id="section-render"><JobCards run={run} /></div>
          ) : (
            <div id="section-plan"><AgentRail run={run} live={live} /></div>
          )}
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
          <LogViewer run={run} live={live} />
        </>
      );
      rail = (
        <>
          <ChangeRequestPanel run={run} />
          <TakesHistory run={run} />
          <ApproveBar run={run} cutId={cutId} />
        </>
      );
      break;
    case 'complete':
      main = <div id="section-deliver"><FinalCard run={run} /></div>;
      rail = <TakesHistory run={run} />;
      break;
  }

  return (
    <div>
      <PhaseStrip run={run} agents={live.agents} activeKind={live.activeKind} />
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
  );
}
