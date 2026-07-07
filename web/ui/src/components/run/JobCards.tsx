// One card per render job: thumbnail well (aspect-correct), what it covers, and its truthful
// state — queued, an indeterminate sweep + elapsed while rendering (never a fake percentage),
// done with a playable clip, or failed with a priced retry.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { Aspect, JobView, ProductionSpec, RunDetail } from '../../../../shared/api-types';
import { api } from '../../api/client';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';
import { elapsed } from '../../lib/format';
import { jobSeconds } from './SpecInspector';

type JobUiState = 'queued' | 'rendering' | 'done' | 'failed';

const THUMB_WIDTH: Record<Aspect, string> = { '9:16': 'w-[54px]', '16:9': 'w-[171px]', '1:1': 'w-24' };

function Pill({ state }: { state: JobUiState }) {
  const cls: Record<JobUiState, string> = {
    queued: 'bg-surface-2 text-ink-muted',
    rendering: 'bg-[var(--accent-soft)] text-status-active',
    done: 'bg-[var(--status-done-soft)] text-status-done',
    failed: 'bg-[var(--status-failed-soft)] text-status-failed',
  };
  const label: Record<JobUiState, string> = { queued: 'Queued', rendering: 'Rendering', done: 'Done', failed: 'Failed' };
  return (
    <span className={clsx('inline-flex h-5 items-center rounded-full px-2 text-caption font-medium', cls[state])}>
      {label[state]}
    </span>
  );
}

function JobCard({ run, job, state, now }: { run: RunDetail; job: JobView; state: JobUiState; now: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [retrying, setRetrying] = useState(false);
  const spec = run.spec;
  const specJob = spec?.kling?.jobs?.find((j) => j.job_id === job.jobId);
  const secondsForJob = spec ? jobSeconds(spec, job.jobId) : 0;
  const startedAt = run.manifest?.activeJob?.startedAt ?? null;

  const estQ = useQuery({
    queryKey: ['estimate', run.id, 'job', job.jobId],
    queryFn: () => api.estimate(run.id, { mode: 'job', jobId: job.jobId }),
    enabled: state === 'failed',
  });

  const retry = async () => {
    setRetrying(true);
    try {
      await api.rerenderJob(run.id, { jobId: job.jobId });
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The retry could not start.' });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      className={clsx(
        'flex items-center gap-4 rounded-r3 border border-line bg-surface-1 p-4',
        state === 'rendering' && 'border-l-2 border-l-accent-strong',
      )}
      aria-label={`Job ${job.jobId}`}
    >
      <div className={clsx('h-24 shrink-0 overflow-hidden rounded-r2 bg-stage', THUMB_WIDTH[run.aspect ?? '9:16'])}>
        {job.clipExists && job.clipUrl ? (
          <video src={job.clipUrl} preload="metadata" controls className="h-full w-full object-cover" aria-label={`Clip for job ${job.jobId}`} />
        ) : (
          <div className={clsx('h-full w-full', state === 'rendering' && 'shimmer bg-surface-2')} aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-label text-ink">{job.jobId}</p>
        {specJob && <p className="truncate text-dense text-ink-secondary">shots {specJob.shots.join(', ')}</p>}
        <p className="tnum text-caption text-ink-muted">{secondsForJob}s · {run.latestRender?.backend ?? run.backend}</p>
        {state === 'failed' && job.error && <p className="mt-1 text-dense text-status-failed">{job.error}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Pill state={state} />
        {state === 'rendering' && (
          <>
            <div className="sweep h-[3px] w-32" role="presentation" data-testid={`sweep-${job.jobId}`} />
            {startedAt && <span className="tnum text-caption text-ink-muted">{elapsed(now - new Date(startedAt).getTime())}</span>}
            <span className="text-caption text-ink-faint">typ. 3–6 min</span>
          </>
        )}
        {state === 'failed' && (
          <Button variant="secondary" size="sm" loading={retrying} costUsd={estQ.data?.totalUsd ?? null} onClick={() => void retry()}>
            Retry {job.jobId}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Fallback jobs synthesized from the spec when no render take exists yet. */
function jobsFromSpec(spec: ProductionSpec | null): JobView[] {
  return (spec?.kling?.jobs ?? []).map((j) => ({ jobId: j.job_id, clip: null, clipExists: false, clipUrl: null, error: null }));
}

export function JobCards({ run }: { run: RunDetail }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cancelling, setCancelling] = useState(false);
  const jobs = run.latestRender?.jobs?.length ? run.latestRender.jobs : jobsFromSpec(run.spec);

  // one shared 1s tick for the elapsed timers
  const rendering = run.status === 'rendering';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [rendering]);

  // the first job that is neither done nor failed is the one actively rendering
  const activeIdx = rendering ? jobs.findIndex((j) => !j.clipExists && !j.error) : -1;

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.cancel(run.id);
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The render could not be cancelled.' });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section aria-label="Render jobs" className="space-y-3">
      {jobs.map((job, i) => {
        const state: JobUiState = job.error ? 'failed' : job.clipExists ? 'done' : i === activeIdx ? 'rendering' : 'queued';
        return <JobCard key={job.jobId} run={run} job={job} state={state} now={now} />;
      })}
      {rendering && (
        <Button variant="quiet" size="sm" loading={cancelling} onClick={() => void cancel()}>
          Cancel render
        </Button>
      )}
    </section>
  );
}
