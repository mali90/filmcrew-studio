// The rail card for changing something, in three honestly-priced levels (spec D28): feedback
// re-runs the planning engine (LLM usage, no render), a prompt edit rewrites only the words we send
// (a local file write), and a segment re-render spends real money at the provider.
//
// One row is open at a time. Row 3 opens the SAME SegmentRerenderDialog the clip strip opens and
// posts to the SAME rerender-job endpoint — there is exactly one implementation of a paid segment
// re-render in this app, and its price and its one-time confirm live on that dialog's PaidButton.
//
// When the plan has moved past the latest cut, today's re-render block pins ABOVE the rows (spec
// D30): the plan changing is a consequence to act on, not a fourth thing to choose between.
import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Film, MessageSquare, PenLine } from 'lucide-react';
import type { RunDetail } from '../../../../../shared/api-types';
import { castRefCountFor } from '../../../../../shared/render-models';
import { api, ApiClientError } from '../../../api/client';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { useToast } from '../../ui/Toast';
import { downstreamSeamSentence, segmentJoins } from './lib';
import { PaidButton } from './PaidButton';
import { PromptButton } from './PromptSheet';
import { SegmentRerenderDialog } from './SegmentRerenderDialog';

type RowId = 'tell' | 'prompt' | 'rerender';

/** One accordion row: its label, when to reach for it, and what it costs — in words, never a figure. */
function Row({ id, open, onToggle, icon, label, when, cost, children }: {
  id: RowId;
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  when: string;
  cost: string;
  children: ReactNode;
}) {
  const bodyId = `change-row-${id}`;
  return (
    <div className="border-t border-line first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full items-center gap-2 py-2.5 text-left"
      >
        <span className="text-ink-muted" aria-hidden>{icon}</span>
        <span className="flex-1">
          <span className="block text-label text-ink">{label}</span>
          <span className="block text-caption text-ink-muted">{when}</span>
        </span>
        <span className="text-caption text-ink-muted">{cost}</span>
        <ChevronDown size={14} className={clsx('shrink-0 text-ink-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && <div id={bodyId} className="flex flex-col gap-2.5 pb-3">{children}</div>}
    </div>
  );
}

export function ChangeRequestPanel({ run }: { run: RunDetail }) {
  const { toast } = useToast();
  const [scope, setScope] = useState<string>('whole');
  const [feedback, setFeedback] = useState('');
  const [row, setRow] = useState<RowId>('tell');
  const [rerendering, setRerendering] = useState<string | null>(null);
  const headingId = useId();

  const onError = (e: Error) =>
    toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e.message });

  const jobIds = (run.spec?.kling.jobs ?? []).map((j) => j.job_id);
  const [segment, setSegment] = useState<string>(jobIds[0] ?? '');
  const picked = jobIds.includes(segment) ? segment : jobIds[0] ?? null;
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

  // ── Re-render block (the plan moved past the latest cut) ──
  const revScope = lastRevision?.scope ?? 'whole';
  const scopedJob = planChanged && revScope !== 'whole' ? revScope : null;
  const jobIdx = scopedJob ? jobIds.indexOf(scopedJob) : -1;
  const downstream = jobIdx >= 0 ? jobIds.slice(jobIdx + 1) : [];

  // What this block may say about the downstream join, and whether a cascade would repair anything
  // at all. Its scoped buttons post `boundaries: 'auto'` to the endpoint SegmentRerenderDialog posts
  // to, so the answer is that dialog's own — the same helper, not a second reading of the same cut.
  const backend = run.latestRender?.backend ?? run.backend ?? 'kling';
  const entryOf = (id: string | null | undefined) => (run.continuity ?? []).find((e) => e.jobId === id) ?? null;
  const { endStrength, showSeamWarning, offerCascade } = segmentJoins({
    backend,
    castRefCount: scopedJob ? castRefCountFor(run.spec, scopedJob) : 0,
    hasPrev: jobIdx > 0,
    hasNext: downstream.length > 0,
    entry: entryOf(scopedJob),
    nextEntry: entryOf(downstream[0]),
  });

  const jobEstimate = useQuery({
    queryKey: ['estimate', run.id, 'job', scopedJob],
    queryFn: () => api.estimate(run.id, { mode: 'job', jobId: scopedJob! }),
    enabled: !!scopedJob,
  });
  const cascadeEstimate = useQuery({
    queryKey: ['estimate', run.id, 'job-cascade', scopedJob],
    queryFn: () => api.estimate(run.id, { mode: 'job', jobId: scopedJob!, cascade: true }),
    // Priced only where it is offered: a cascade nobody can click is a paid render nobody asked to
    // hear the price of.
    enabled: !!scopedJob && offerCascade,
  });
  const fullEstimate = useQuery({
    queryKey: ['estimate', run.id, 'full'],
    queryFn: () => api.estimate(run.id, { mode: 'full' }),
    enabled: planChanged && !scopedJob,
  });

  const rerenderJob = useMutation({
    mutationFn: (cascade: boolean) => api.rerenderJob(run.id, { jobId: scopedJob!, boundaries: 'auto', ...(cascade ? { cascade: true } : {}) }),
    onSuccess: () => toast({ kind: 'success', text: 'Re-render started.' }),
    onError,
  });
  const rerenderAll = useMutation({
    mutationFn: () => api.render(run.id, 'full'),
    onSuccess: () => toast({ kind: 'success', text: 'Full re-render started.' }),
    onError,
  });

  return (
    <section className="rounded-r3 border border-line bg-surface-1 p-4" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-heading text-ink">Change something</h2>
      <p className="mt-1 text-caption text-ink-muted">
        Feedback rewrites the plan; a prompt edit changes only the words we send; a re-render spends money.
      </p>

      {planChanged && (
        <div className="mt-3 flex flex-col gap-2.5 rounded-r2 border border-line bg-surface-0 p-3">
          <p className="text-caption text-ink-muted">The plan changed since this cut.</p>
          {scopedJob ? (
            <>
              <PaidButton
                variant="secondary"
                className="w-full justify-center"
                costUsd={jobEstimate.data?.totalUsd ?? null}
                costUnknown={Boolean(jobEstimate.data?.unknownPrice)}
                loading={rerenderJob.isPending}
                onPaidClick={() => rerenderJob.mutate(false)}
              >
                Re-render {scopedJob} only
              </PaidButton>
              {/* Offered only where it repairs something: an ending pin Auto applies renders this
                  segment against the unchanged next clip and records the joint as intact, so
                  re-rendering everything downstream would charge for footage nothing touched. */}
              {offerCascade && (
                <PaidButton
                  variant="secondary"
                  className="w-full justify-center"
                  costUsd={cascadeEstimate.data?.totalUsd ?? null}
                  costUnknown={Boolean(cascadeEstimate.data?.unknownPrice)}
                  loading={rerenderJob.isPending}
                  onPaidClick={() => rerenderJob.mutate(true)}
                >
                  Re-render {scopedJob} + downstream
                </PaidButton>
              )}
              {showSeamWarning && (
                <p className="text-caption text-ink-muted" data-testid="rail-seam-note">
                  {downstreamSeamSentence({ jobId: scopedJob, nextId: downstream[0], endStrength })}
                </p>
              )}
            </>
          ) : (
            <PaidButton
              variant="secondary"
              className="w-full justify-center"
              costUsd={fullEstimate.data?.totalUsd ?? null}
              costUnknown={Boolean(fullEstimate.data?.unknownPrice)}
              loading={rerenderAll.isPending}
              onPaidClick={() => rerenderAll.mutate()}
            >
              Re-render all
            </PaidButton>
          )}
        </div>
      )}

      <div className="mt-3">
        <Row
          id="tell"
          open={row === 'tell'}
          onToggle={() => setRow('tell')}
          icon={<MessageSquare size={15} />}
          label="Tell the agents"
          when="The story or the shot is wrong."
          cost="LLM usage, no render"
        >
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
        </Row>

        <Row
          id="prompt"
          open={row === 'prompt'}
          onToggle={() => setRow('prompt')}
          icon={<PenLine size={15} />}
          label="Edit a prompt"
          when="The words are almost right."
          cost="Saving is free — you pay only when you re-render"
        >
          {picked ? (
            <>
              <SegmentedControl
                label="Segment to edit"
                value={picked}
                onChange={setSegment}
                segments={jobIds.map((id) => ({ value: id, label: id }))}
              />
              <div className="flex items-center gap-2">
                <PromptButton variant="secondary" size="md" target={picked} label={`Open ${picked}'s prompt`} />
                <span className="text-caption text-ink-muted">Nothing renders until you re-render it.</span>
              </div>
            </>
          ) : (
            <p className="text-caption text-ink-muted">This run has no segments yet.</p>
          )}
        </Row>

        <Row
          id="rerender"
          open={row === 'rerender'}
          onToggle={() => setRow('rerender')}
          icon={<Film size={15} />}
          label="Re-render one segment"
          when="The clip is wrong, the words are fine."
          cost="Spends money"
        >
          {picked ? (
            <>
              <SegmentedControl
                label="Segment to re-render"
                value={picked}
                onChange={setSegment}
                segments={jobIds.map((id) => ({ value: id, label: id }))}
              />
              <div className="flex items-center gap-2">
                {/* The price and the one-time paid confirm live on the dialog's PaidButton — this
                    opens it, and no money moves until that button is pressed. */}
                <Button variant="secondary" icon={<Film size={14} aria-hidden />} onClick={() => setRerendering(picked)}>
                  Re-render {picked}&hellip;
                </Button>
                <span className="text-caption text-ink-muted">You&rsquo;ll see the price before anything spends.</span>
              </div>
            </>
          ) : (
            <p className="text-caption text-ink-muted">This run has no segments yet.</p>
          )}
        </Row>
      </div>

      {rerendering && (
        <SegmentRerenderDialog run={run} jobId={rerendering} open onClose={() => setRerendering(null)} />
      )}
    </section>
  );
}
