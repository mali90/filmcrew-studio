// The rail card for feedback. Two modes: normally a scoped feedback form that re-runs the planning
// engine (LLM cost, no render); once the plan is newer than the latest take, it becomes the re-render
// row with priced buttons (and the seam warning when a chained job is re-rendered alone).
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { RunDetail } from '../../../../../shared/api-types';
import { api, ApiClientError } from '../../../api/client';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { useToast } from '../../ui/Toast';
import { PaidButton } from './PaidButton';

export function ChangeRequestPanel({ run }: { run: RunDetail }) {
  const { toast } = useToast();
  const [scope, setScope] = useState<string>('whole');
  const [feedback, setFeedback] = useState('');

  const onError = (e: Error) =>
    toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e.message });

  const jobIds = (run.spec?.kling.jobs ?? []).map((j) => j.job_id);
  const revisions = run.manifest?.revisions ?? [];
  const takes = run.manifest?.takes ?? [];
  const lastRevision = revisions.at(-1);
  const lastTake = takes.at(-1);
  const planChanged = !!lastRevision && (!lastTake || lastRevision.createdAt > lastTake.createdAt);

  const revise = useMutation({
    mutationFn: () => api.revise(run.id, { feedback: feedback.trim(), scope: scope === 'whole' ? 'whole' : scope }),
    onSuccess: () => {
      setFeedback('');
      toast({ kind: 'success', text: 'Change request sent — the agents take it from here.' });
    },
    onError,
  });

  // ── Re-render row (the plan moved past the latest cut) ──
  const revScope = lastRevision?.scope ?? 'whole';
  const scopedJob = planChanged && revScope !== 'whole' ? revScope : null;
  const jobIdx = scopedJob ? jobIds.indexOf(scopedJob) : -1;
  const downstream = jobIdx >= 0 ? jobIds.slice(jobIdx + 1) : [];

  const jobEstimate = useQuery({
    queryKey: ['estimate', run.id, 'job', scopedJob],
    queryFn: () => api.estimate(run.id, { mode: 'job', jobId: scopedJob! }),
    enabled: !!scopedJob,
  });
  const cascadeEstimate = useQuery({
    queryKey: ['estimate', run.id, 'job-cascade', scopedJob],
    queryFn: () => api.estimate(run.id, { mode: 'job', jobId: scopedJob!, cascade: true }),
    enabled: !!scopedJob && downstream.length > 0,
  });
  const fullEstimate = useQuery({
    queryKey: ['estimate', run.id, 'full'],
    queryFn: () => api.estimate(run.id, { mode: 'full' }),
    enabled: planChanged && !scopedJob,
  });

  const rerenderJob = useMutation({
    mutationFn: (cascade: boolean) => api.rerenderJob(run.id, { jobId: scopedJob!, ...(cascade ? { cascade: true } : {}) }),
    onSuccess: () => toast({ kind: 'success', text: 'Re-render started.' }),
    onError,
  });
  const rerenderAll = useMutation({
    mutationFn: () => api.render(run.id, 'full'),
    onSuccess: () => toast({ kind: 'success', text: 'Full re-render started.' }),
    onError,
  });

  return (
    <section className="rounded-r3 border border-line bg-surface-1 p-4">
      <h2 className="text-heading text-ink">Request changes</h2>

      {planChanged ? (
        <div className="mt-3 flex flex-col gap-2.5">
          <p className="text-caption text-ink-muted">The plan changed since this cut.</p>
          {scopedJob ? (
            <>
              <PaidButton
                variant="secondary"
                className="w-full justify-center"
                costUsd={jobEstimate.data?.totalUsd ?? null}
                loading={rerenderJob.isPending}
                onPaidClick={() => rerenderJob.mutate(false)}
              >
                Re-render {scopedJob} only
              </PaidButton>
              {downstream.length > 0 && (
                <>
                  <PaidButton
                    variant="secondary"
                    className="w-full justify-center"
                    costUsd={cascadeEstimate.data?.totalUsd ?? null}
                    loading={rerenderJob.isPending}
                    onPaidClick={() => rerenderJob.mutate(true)}
                  >
                    Re-render {scopedJob} + downstream
                  </PaidButton>
                  <p className="text-caption text-ink-muted">
                    {downstream[0]} was chained from {scopedJob}&rsquo;s last frame — re-rendering{' '}
                    {scopedJob} alone may show a visible seam.
                  </p>
                </>
              )}
            </>
          ) : (
            <PaidButton
              variant="secondary"
              className="w-full justify-center"
              costUsd={fullEstimate.data?.totalUsd ?? null}
              loading={rerenderAll.isPending}
              onPaidClick={() => rerenderAll.mutate()}
            >
              Re-render all
            </PaidButton>
          )}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2.5">
          <SegmentedControl
            label="Scope of the change"
            value={scope}
            onChange={setScope}
            segments={[
              { value: 'whole', label: 'Whole video' },
              ...jobIds.map((id) => ({ value: id, label: id })),
            ]}
          />
          <textarea
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }}
            placeholder="What should be different? e.g. 'K2: the keeper should look older'"
            aria-label="Describe what should change"
            className="w-full resize-none rounded-r2 border border-line bg-surface-0 px-3 py-2 text-body text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
          <p className="text-caption text-ink-muted">
            Feedback re-runs the planning engine — QC routes it to the right agents. Then you choose
            what to re-render.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              disabled={!feedback.trim()}
              loading={revise.isPending}
              onClick={() => revise.mutate()}
            >
              Send to the engine
            </Button>
            <span className="text-caption text-ink-muted">LLM cost, no render</span>
          </div>
        </div>
      )}
    </section>
  );
}
