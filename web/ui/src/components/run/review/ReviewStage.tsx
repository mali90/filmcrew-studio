// The stage band: the current cut plays center-stage on the darkened strip, with a cut switcher
// when there is more than one stitched master, a continuity strip that seeks the master per job and
// draws how the clips join, and a probe banner when the latest take only rendered the first job.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { RunDetail } from '../../../../../shared/api-types';
import { api, ApiClientError } from '../../../api/client';
import { useToast } from '../../ui/Toast';
import { elapsed, timeAgo } from '../../../lib/format';
import { jobSeconds, outMediaUrl, reopenedFinal } from './lib';
import { ClipStrip } from './ClipStrip';
import { PaidButton } from './PaidButton';
import { usePlanPrompts } from './PromptSheet';

export function ReviewStage({ run, cutId, setCutId }: {
  run: RunDetail;
  cutId: string | null;
  setCutId: (id: string | null) => void;
}) {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const cuts = useMemo(() => [...(run.manifest?.cuts ?? [])].reverse(), [run.manifest?.cuts]); // newest first
  const latestCut = cuts[0] ?? null;
  const selected = (cutId && cuts.find((c) => c.id === cutId)) || latestCut;
  const isLatest = !selected || selected.id === latestCut?.id;

  // The latest cut is served by latestRender.masterUrl; older cuts are reached by basename in out/.
  // Mid segment re-render the latest master is being rebuilt (masterUrl null) — fall back to the
  // selected cut's own file so the stage keeps playing instead of going dark (U1). Approve
  // targeting is untouched: ApproveBar is not mounted while a render is in flight.
  const src = isLatest
    ? run.latestRender?.masterUrl ?? (selected?.master ? outMediaUrl(selected.master) : undefined)
    : selected?.master ? outMediaUrl(selected.master) : undefined;

  const takes = run.manifest?.takes ?? [];
  const isProbe = takes.at(-1)?.mode === 'probe';
  // The stage's pointer at the rail's re-render block (spec D30/U14): same derivation as
  // ChangeRequestPanel's planChanged, so stage and rail never disagree about whether the plan
  // moved past the latest cut.
  const lastRevision = (run.manifest?.revisions ?? []).at(-1);
  const lastTake = takes.at(-1);
  const planChanged = !!lastRevision && (!lastTake || lastRevision.createdAt > lastTake.createdAt);
  // A run that came back here from the deliver card looks identical to one that never left — so the
  // banner slot says why the user is here and what is still on disk (spec D25). It is a standing
  // fact about the run's state, not an event, so it is written on the page and never toasted
  // (Don't #11): a toast would vanish six seconds after the one moment it was needed.
  const reopened = reopenedFinal(run.manifest);
  const fullEstimate = useQuery({
    queryKey: ['estimate', run.id, 'full'],
    queryFn: () => api.estimate(run.id, { mode: 'full' }),
    enabled: isProbe,
  });
  const fullRender = useMutation({
    mutationFn: () => api.render(run.id, 'full'),
    onSuccess: () => toast({ kind: 'success', text: 'Full render started — the clip strip will fill in.' }),
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e.message }),
  });

  // The PLAN's job list — the cut in full, whatever any single take happens to contain.
  const jobIds = useMemo(() => (run.spec?.kling?.jobs ?? []).map((j) => j.job_id), [run.spec]);
  const rendered = run.latestRender?.jobs ?? [];

  // A segment re-render in flight (U1): the page keeps this stage mounted for job-mode renders, so
  // the banner slot says which segment is being replaced and that the video below is still the
  // CURRENT cut. Read from the same fact the page mounts on — the last take is a job take and the
  // run is still working — so this covers the whole interval, including the queue wait before the
  // child spawns and the free stitch after it. `activeJob` names only the middle of it.
  const activeJob = run.manifest?.activeJob;
  const rerenderInFlight = run.status === 'rendering' && lastTake?.mode === 'job';

  // A CASCADE re-renders several segments into ONE take, writing render.json after each child. From
  // the moment the first child lands, that take counts as complete, so the run scan stops
  // synthesizing its pending jobs and `latestRender.jobs` holds only the segments already finished:
  // the one actually on the wire is absent, and so is every segment the cascade has not reached.
  // The plan knows the whole cut and the take record knows where the cascade began, so the strip is
  // rebuilt from those until it finishes — a segment this take is replacing but has not delivered
  // reads as pending, everything else keeps the clip the manifest last recorded for it. (Its
  // thumbnail is the one casualty: a media URL is the server's to mint, and the manifest carries
  // only the path.)
  const jobs = useMemo(() => {
    if (!rerenderInFlight || !jobIds.length) return rendered;
    const byId = new Map(rendered.map((j) => [j.jobId, j]));
    if (jobIds.every((id) => byId.has(id))) return rendered; // the scan is still synthesizing this take
    const from = lastTake?.mode === 'job' && lastTake.jobId ? jobIds.indexOf(lastTake.jobId) : -1;
    const replacing = (id: string) => from !== -1
      && (lastTake?.cascade === true ? jobIds.indexOf(id) >= from : id === lastTake?.jobId);
    const clips = run.manifest?.jobClips ?? {};
    return jobIds.map((id) => byId.get(id) ?? {
      jobId: id,
      clip: replacing(id) ? null : clips[id] ?? null,
      clipExists: replacing(id) ? false : Boolean(clips[id]),
      clipUrl: null,
      error: null,
    });
  }, [rerenderInFlight, jobIds, rendered, lastTake, run.manifest?.jobClips]);

  // The working segment is the first one whose clip has neither landed nor failed.
  const workingJobId = rerenderInFlight ? jobs.find((j) => !j.clipExists && !j.error)?.jobId : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!rerenderInFlight) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [rerenderInFlight]);

  // every take that PRODUCED A CLIP of this job counts — the full render's clip is a take too
  // (counting only job-mode takes once said "2 takes" for a job with three clips on disk)
  const jobTakeCount = (jobId: string) =>
    (run.manifest?.takes ?? []).filter((t) =>
      t.mode === 'full'
      || (t.mode === 'probe' && jobIds[0] === jobId)
      || (t.mode === 'job' && (t.jobId === jobId || (t.cascade === true && jobIds.indexOf(jobId) > jobIds.indexOf(t.jobId ?? ''))))).length;

  // Which segments carry an edit, for the tiles' pen overlay (spec D8/D22). Shares its cache entry
  // with the prompt sheet's plan-wide read, so opening the sheet costs no second request.
  const prompts = usePlanPrompts(run.id);
  const promptStateFor = (jobId: string) => {
    const v = prompts.data?.prompts.find((p) => p.jobId === jobId);
    return { edited: v?.source === 'override', stale: Boolean(v?.source === 'override' && v.stale) };
  };

  const seekToJob = (index: number) => {
    const offset = jobs.slice(0, index).reduce((sum, j) => sum + jobSeconds(run.spec, j.jobId), 0);
    if (videoRef.current) videoRef.current.currentTime = offset;
  };

  return (
    <section className="relative -mx-6 rounded-r3 bg-stage px-6 py-8" aria-label="Review stage">
      {rerenderInFlight && (
        <div
          className="mb-5 flex flex-wrap items-baseline justify-between gap-3 rounded-r2 border border-line bg-surface-1 px-4 py-3"
          data-testid="rerender-inflight-notice"
        >
          <p className="text-dense text-ink">
            {workingJobId
              // Once every clip of the take has landed the model work is over and the free stitch is
              // what is left. Naming a segment there would name one that is already done (and, before
              // this had an answer, `undefined`).
              ? <>Re-rendering {workingJobId} — you're watching the current cut; the new clip takes its place here when it lands.</>
              : <>Stitching the new cut — the clips are back; you're watching the current cut until the new master is ready.</>}
          </p>
          {activeJob?.startedAt && (
            <span className="tnum text-caption text-ink-muted">{elapsed(now - new Date(activeJob.startedAt).getTime())}</span>
          )}
        </div>
      )}

      {reopened && (
        <div className="mb-5 rounded-r2 border border-line bg-surface-1 px-4 py-3" data-testid="reopened-notice">
          <p className="text-dense text-ink">
            Reopened for changes. <span className="font-mono">{reopened.fileName}</span> is still on disk — approving
            again writes a new final and keeps the old one.
          </p>
        </div>
      )}

      {isProbe && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-r2 border border-line bg-surface-1 px-4 py-3">
          <p className="text-dense text-ink">Probe take — only {jobIds[0]} rendered.</p>
          <PaidButton
            variant="secondary"
            size="sm"
            costUsd={fullEstimate.data?.totalUsd ?? null}
            costUnknown={Boolean(fullEstimate.data?.unknownPrice)}
            loading={fullRender.isPending}
            onPaidClick={() => fullRender.mutate()}
          >
            Full render
          </PaidButton>
          {/* U5: "approving is free" lives in ApproveBar beside the genuinely free action — a
              "free" here would sit right next to a $-tagged button and read as its caption. The
              count is the PLAN's job list: a probe by definition rendered only the first job, so
              latestRender.jobs may hold a single entry. */}
          <span className="text-caption text-ink-muted">
            Full render replaces this probe with all {jobIds.length} clips, as a new take.
          </span>
        </div>
      )}

      {planChanged && lastRevision && (
        <div className="mb-5 rounded-r2 border border-line bg-surface-1 px-4 py-3" data-testid="plan-outran-cut-notice">
          <p className="text-dense text-ink">
            The plan changed after this cut ({lastRevision.id}) — the video below is unchanged.
            Re-render options are in the rail.
          </p>
        </div>
      )}

      {cuts.length > 1 && (
        <div className="absolute right-6 top-6 z-10">
          <button
            aria-label="Switch cut"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((o) => !o)}
            className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-3 px-3 text-caption text-ink-secondary hover:text-ink"
          >
            {selected?.id ?? 'cut'}{isLatest ? ' · latest' : ''}
            <ChevronDown size={13} aria-hidden />
          </button>
          {switcherOpen && (
            <div
              role="listbox"
              aria-label="Cuts"
              className="absolute right-0 mt-1.5 w-56 rounded-r2 border border-line bg-surface-3 p-1"
              style={{ boxShadow: 'var(--shadow-2)' }}
            >
              {cuts.map((c, i) => (
                <button
                  key={c.id}
                  role="option"
                  aria-selected={selected?.id === c.id}
                  onClick={() => { setCutId(c.id); setSwitcherOpen(false); }}
                  className={clsx(
                    'flex w-full items-center justify-between rounded-[5px] px-2.5 py-1.5 text-dense hover:bg-surface-2',
                    selected?.id === c.id ? 'text-ink' : 'text-ink-secondary',
                  )}
                >
                  <span className="font-mono">{c.id}{i === 0 ? ' · latest' : ''}</span>
                  <span className="tnum text-caption text-ink-muted">{timeAgo(c.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-center">
        <video
          key={src}
          ref={videoRef}
          data-testid="master-video"
          controls
          playsInline
          poster={run.latestRender?.coverUrl ?? undefined}
          src={src}
          className="h-auto max-h-[68vh] w-auto max-w-full rounded-r4 border border-line bg-black"
        />
      </div>

      {jobs.length > 0 && (
        <ClipStrip
          run={run}
          jobs={jobs}
          takeCountFor={jobTakeCount}
          promptStateFor={promptStateFor}
          isLatestCut={isLatest}
          onSeek={seekToJob}
        />
      )}
    </section>
  );
}
