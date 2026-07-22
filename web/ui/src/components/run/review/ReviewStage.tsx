// The stage band: the current cut plays center-stage on the darkened strip, with a cut switcher
// when there is more than one stitched master, a clip strip that seeks the master per job, and a
// probe banner when the latest take only rendered the first job.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { RunDetail } from '../../../../../shared/api-types';
import { api, ApiClientError } from '../../../api/client';
import { useToast } from '../../ui/Toast';
import { timeAgo } from '../../../lib/format';
import { jobSeconds, outMediaUrl } from './lib';
import { PaidButton } from './PaidButton';

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
  const src = isLatest
    ? run.latestRender?.masterUrl ?? undefined
    : selected?.master ? outMediaUrl(selected.master) : undefined;

  const isProbe = run.manifest?.takes.at(-1)?.mode === 'probe';
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

  const jobs = run.latestRender?.jobs ?? [];
  // every take that PRODUCED A CLIP of this job counts — the full render's clip is a take too
  // (counting only job-mode takes once said "2 takes" for a job with three clips on disk)
  const jobIds = (run.spec?.kling?.jobs ?? []).map((j) => j.job_id);
  const jobTakeCount = (jobId: string) =>
    (run.manifest?.takes ?? []).filter((t) =>
      t.mode === 'full'
      || (t.mode === 'probe' && jobIds[0] === jobId)
      || (t.mode === 'job' && (t.jobId === jobId || (t.cascade === true && jobIds.indexOf(jobId) > jobIds.indexOf(t.jobId ?? ''))))).length;

  const seekToJob = (index: number) => {
    const offset = jobs.slice(0, index).reduce((sum, j) => sum + jobSeconds(run.spec, j.jobId), 0);
    if (videoRef.current) videoRef.current.currentTime = offset;
  };

  return (
    <section className="relative -mx-6 rounded-r3 bg-stage px-6 py-8" aria-label="Review stage">
      {isProbe && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-r2 border border-line bg-surface-1 px-4 py-3">
          <p className="text-dense text-ink">Probe take — first job only, low cost.</p>
          <PaidButton
            variant="secondary"
            size="sm"
            costUsd={fullEstimate.data?.totalUsd ?? null}
            loading={fullRender.isPending}
            onPaidClick={() => fullRender.mutate()}
          >
            Full render
          </PaidButton>
          <span className="text-caption text-ink-muted">Finishing is free — assembly already happened.</span>
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
        <div className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Clips in this cut">
          {jobs.map((job, i) => {
            const secs = jobSeconds(run.spec, job.jobId);
            const takeCount = jobTakeCount(job.jobId);
            return (
              <button
                key={job.jobId}
                aria-label={`Play from ${job.jobId}`}
                onClick={() => seekToJob(i)}
                className="group flex flex-col items-center gap-1.5 rounded-r2 border border-line bg-surface-1 p-2 hover:border-line-strong"
              >
                <video
                  preload="metadata"
                  muted
                  src={job.clipUrl ?? undefined}
                  className="rounded-r1 bg-black object-cover"
                  style={{ height: 72, aspectRatio: (run.aspect ?? '9:16').replace(':', ' / ') }}
                  aria-hidden
                />
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-caption text-ink-secondary">{job.jobId}</span>
                  <span className="tnum text-caption text-ink-muted">{secs}s</span>
                  {takeCount > 0 && (
                    <span className="tnum rounded-full bg-surface-2 px-1.5 text-caption text-ink-muted">
                      {takeCount} {takeCount === 1 ? 'take' : 'takes'}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
