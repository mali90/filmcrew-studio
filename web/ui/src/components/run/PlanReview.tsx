// The plan-ready decision moment: probe cheap first (guided by which button is primary), or go
// full — both with their provider estimate stated calmly on the button. A probe renders only the
// first job, so it exists ONLY on multi-job plans — on a single-job plan it would be the full
// render at the same price, and only Full render is offered. Revising costs only LLM usage;
// discarding asks first. All money copy names the RUN's provider (providerLabelFor) — a
// hardcoded "fal" is a false statement on a Segmind-backed run.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunDetail } from '../../../../shared/api-types';
import { modelLabelFor, providerLabelFor } from '../../../../shared/render-models';
import { api } from '../../api/client';
import { Button, useFirstPaidConfirm } from '../ui/Button';
import { UnknownPriceNote } from '../ui/UnknownPriceNote';
import { Dialog } from '../ui/Dialog';
import { useToast } from '../ui/Toast';
import { requestNotifyPermission } from '../../hooks/useNotifications';
import { usd } from '../../lib/format';
import { jobSeconds } from './SpecInspector';
import { PromptButton } from './review/PromptSheet';

type Mode = 'probe' | 'full';

export function PlanReview({ run }: { run: RunDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const paid = useFirstPaidConfirm();

  const canProbe = (run.spec?.kling?.jobs?.length ?? 0) > 1;
  const probeQ = useQuery({ queryKey: ['estimate', run.id, 'probe'], queryFn: () => api.estimate(run.id, { mode: 'probe' }), enabled: canProbe });
  const fullQ = useQuery({ queryKey: ['estimate', run.id, 'full'], queryFn: () => api.estimate(run.id, { mode: 'full' }) });

  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [showRevise, setShowRevise] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const spec = run.spec;
  const jobs = spec?.kling?.jobs ?? [];
  const totalSeconds = jobs.reduce((acc, j) => (spec ? acc + jobSeconds(spec, j.job_id) : acc), 0);
  const hasTakes = (run.manifest?.takes?.length ?? 0) > 0;
  const provider = providerLabelFor(run.backend ?? 'kling');
  const firstJobId = jobs[0]?.job_id;

  const start = async (mode: Mode) => {
    setBusy(mode);
    try {
      requestNotifyPermission();
      await api.render(run.id, mode);
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The render could not start.' });
    } finally {
      setBusy(null);
    }
  };

  const clickRender = (mode: Mode) => {
    if (paid.needsConfirm) setPendingMode(mode);
    else void start(mode);
  };

  const submitRevision = async () => {
    if (!feedback.trim()) return;
    setRevising(true);
    try {
      await api.revise(run.id, { feedback: feedback.trim(), scope: 'whole' });
      setShowRevise(false);
      setFeedback('');
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The revision could not start.' });
    } finally {
      setRevising(false);
    }
  };

  const discard = async () => {
    setDiscarding(true);
    try {
      await api.deleteRun(run.id);
      navigate('/');
    } catch (e) {
      setDiscarding(false);
      setConfirmDiscard(false);
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The run could not be deleted.' });
    }
  };

  const pendingUsd = pendingMode === 'probe' ? probeQ.data?.totalUsd : fullQ.data?.totalUsd;
  // Both buttons hit the same backend, so one unpriced estimate means neither can quote a figure.
  const unknownPrice = fullQ.data?.unknownPrice ?? probeQ.data?.unknownPrice ?? null;
  const pendingUnknown = Boolean(pendingMode === 'probe' ? probeQ.data?.unknownPrice : fullQ.data?.unknownPrice);

  return (
    <section aria-label="The plan is ready" className="rounded-r3 border border-line bg-surface-1 p-5">
      <h3 className="text-title text-ink">The plan is ready</h3>
      <p className="tnum mt-1.5 text-body text-ink-secondary">
        {spec?.project?.title ?? run.title ?? run.idea} · {jobs.length} job{jobs.length === 1 ? '' : 's'} · {totalSeconds}s total · {modelLabelFor(run.backend ?? 'kling')}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canProbe && (
          <Button
            variant={hasTakes ? 'secondary' : 'primary'}
            costUsd={probeQ.data?.totalUsd ?? null}
            costUnknown={Boolean(probeQ.data?.unknownPrice)}
            loading={busy === 'probe'}
            onClick={() => clickRender('probe')}
          >
            Probe
          </Button>
        )}
        <Button
          variant={!canProbe || hasTakes ? 'primary' : 'secondary'}
          costUsd={fullQ.data?.totalUsd ?? null}
          costUnknown={Boolean(fullQ.data?.unknownPrice)}
          loading={busy === 'full'}
          onClick={() => clickRender('full')}
        >
          Full render
        </Button>
        <Button variant="quiet" onClick={() => setShowRevise((v) => !v)}>Revise the plan</Button>
        {/* Before spending anything: the exact words each segment would be sent. */}
        <PromptButton variant="quiet" size="md" label="See the prompts" ariaLabel="Prompts for this plan" />
        <Button variant="destructive" onClick={() => setConfirmDiscard(true)}>Discard</Button>
      </div>
      {unknownPrice
        ? <UnknownPriceNote hint={unknownPrice.hint} />
        : (
          <p className="mt-2 text-caption text-ink-muted" aria-live="polite">
            {canProbe
              ? <>A probe renders only {firstJobId} — a cheap look before the full spend. Estimates — {provider} bills per rendered second.</>
              : <>estimates — {provider} bills per rendered second</>}
          </p>
        )}

      {showRevise && (
        <div className="mt-4 space-y-2">
          <label htmlFor="revise-feedback" className="block text-label text-ink-secondary">
            What should change? Revising re-runs the planning agents — LLM usage only, no render cost.
          </label>
          <textarea
            id="revise-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            className="w-full rounded-r2 border border-line-strong bg-surface-0 p-2.5 text-body text-ink placeholder:text-ink-faint"
            placeholder="e.g. Make the opening shot slower and moodier."
          />
          <Button variant="secondary" loading={revising} disabled={!feedback.trim()} onClick={() => void submitRevision()}>
            Send feedback (no render cost)
          </Button>
        </div>
      )}

      <Dialog
        open={pendingMode !== null}
        onClose={() => setPendingMode(null)}
        title="Before your first paid action"
        actions={
          <>
            <Button variant="ghost" onClick={() => setPendingMode(null)}>Cancel</Button>
            <Button
              variant="primary"
              costUsd={pendingUsd ?? null}
              costUnknown={pendingUnknown}
              onClick={() => {
                const mode = pendingMode;
                paid.confirm();
                setPendingMode(null);
                if (mode) void start(mode);
              }}
            >
              {pendingMode === 'probe' ? 'Start probe' : 'Start full render'}
            </Button>
          </>
        }
      >
        {pendingUnknown
          ? 'This spends real money with your render provider. It publishes no per-second rate, so there is no estimate to show — the bill lands on your provider account.'
          : <>This calls {provider} · ≈ {usd(pendingUsd)} · estimates only — {provider} bills per rendered second.</>}
      </Dialog>

      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard this run?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep it</Button>
            <Button variant="destructive" loading={discarding} onClick={() => void discard()}>Discard run</Button>
          </>
        }
      >
        This deletes the plan and any rendered clips for this run. It cannot be undone.
      </Dialog>
    </section>
  );
}
