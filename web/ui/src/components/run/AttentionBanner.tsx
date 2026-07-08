// A run that stopped mid-flight gets a permanent surface, not a toast: what failed, the last log
// lines, and the cheapest sensible way forward — assembling already-rendered clips is free,
// retrying a job lives on its card, and a fully interrupted render can restart or be discarded.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import type { RunDetail } from '../../../../shared/api-types';
import { api } from '../../api/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { useToast } from '../ui/Toast';

// Matches the backend's content-policy tokens (fal.js contentPolicyError always embeds
// `content_policy_violation`). Deliberately NOT a bare "sensitive" — that would false-match log lines
// like "case-sensitive" or the project title, wrongly hiding the priced job-card Retry.
const CONTENT_FLAG_RE = /content_policy_violation|sensitive content|partner_validation_failed|content policy/i;

export function AttentionBanner({ run }: { run: RunDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [assembling, setAssembling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [revisingContent, setRevisingContent] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const error = run.error;
  const jobs = run.latestRender?.jobs ?? [];
  const clipsExist = jobs.some((j) => j.clipExists);
  const hasFailedJob = jobs.some((j) => j.error);
  // A moderation false positive on the GENERATED video: recover by revising the plan (LLM only), not
  // a paid re-roll of the same prompt. Match the backend's own tokens (NOT a bare "sensitive", which
  // would false-match "case-sensitive"/"sensitive data" in the log tail — e.g. the project title).
  const contentFlagged = jobs.some((j) => CONTENT_FLAG_RE.test(j.error ?? ''))
    || CONTENT_FLAG_RE.test(error?.logTail?.join('\n') ?? '');
  const masterExists = !!run.latestRender?.masterExists;
  const canAssemble = clipsExist && !masterExists;
  // Every attention state must offer a way forward. Which one depends on what's actually on disk:
  const planFailed = !run.planned;                                             // engine died before spec.json — retry planning (LLM cost, no render)
  const preRender = run.planned && !clipsExist && !hasFailedJob && !masterExists;
  const wasRenderStep = ['render', 'probe', 'render-job'].includes(error?.action ?? '');
  const interrupted = preRender && wasRenderStep;                              // a render died before any clip — re-render (paid)
  const dismissable = masterExists || (preRender && !wasRenderStep);           // healthy artifacts; the error is stale news — file it

  const fullQ = useQuery({
    queryKey: ['estimate', run.id, 'full'],
    queryFn: () => api.estimate(run.id, { mode: 'full' }),
    enabled: interrupted,
  });

  const assemble = async () => {
    setAssembling(true);
    try {
      await api.assemble(run.id);
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The assemble could not start.' });
    } finally {
      setAssembling(false);
    }
  };

  const resume = async () => {
    setResuming(true);
    try {
      await api.render(run.id, 'full');
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The render could not restart.' });
    } finally {
      setResuming(false);
    }
  };

  const replan = async () => {
    setReplanning(true);
    try {
      await api.replan(run.id);
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'Planning could not restart.' });
    } finally {
      setReplanning(false);
    }
  };

  const reviseForContent = async () => {
    setRevisingContent(true);
    try {
      await api.reviseForContentPolicy(run.id);
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The revise could not start.' });
    } finally {
      setRevisingContent(false);
    }
  };

  const dismiss = async () => {
    setDismissing(true);
    try {
      await api.dismissError(run.id);
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : 'The error could not be dismissed.' });
    } finally {
      setDismissing(false);
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

  return (
    <section
      role="alert"
      aria-label="This run needs attention"
      className="rounded-r3 border border-line bg-[var(--status-failed-soft)] p-4"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-status-failed" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-heading text-ink">
            {error ? `The ${error.action} step stopped.` : 'This run stopped and needs a decision.'}
          </h3>
          {error?.message && <p className="mt-1 text-body text-ink-secondary">{error.message}</p>}
          {!!error?.logTail?.length && (
            <pre className="well mt-2 max-h-40 overflow-auto rounded-r2 bg-stage p-2.5 font-mono text-caption text-ink-secondary">
              {error.logTail.slice(-5).join('\n')}
            </pre>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canAssemble && (
              <Button variant="secondary" loading={assembling} onClick={() => void assemble()}>
                Finish free (assemble)
              </Button>
            )}
            {contentFlagged && (
              <>
                <p className="w-full text-dense text-ink-secondary">
                  The model's content filter flagged the generated video as sensitive — usually a false positive on a benign idea. Revising rewrites the shots with cleaner wording (uses your LLM, no render spend) and usually clears it.
                </p>
                <Button variant="secondary" loading={revisingContent} onClick={() => void reviseForContent()}>
                  Revise to pass content check
                </Button>
              </>
            )}
            {hasFailedJob && !contentFlagged && (
              <p className="text-dense text-ink-secondary">
                A job failed — its Retry button lives on the job card below, priced before you click.
              </p>
            )}
            {planFailed && (
              <>
                <p className="w-full text-dense text-ink-secondary">
                  Planning stopped before the spec was finished. Retrying uses your LLM, no render spend.
                </p>
                <Button variant="secondary" loading={replanning} onClick={() => void replan()}>
                  Retry planning
                </Button>
                <Button variant="destructive" onClick={() => setConfirmDiscard(true)}>Discard</Button>
              </>
            )}
            {interrupted && (
              <>
                <p className="w-full text-dense text-ink-secondary">
                  The render was interrupted before any clip finished. You can start it again, or discard the run.
                </p>
                <Button variant="secondary" loading={resuming} costUsd={fullQ.data?.totalUsd ?? null} onClick={() => void resume()}>
                  Resume: re-render
                </Button>
                <Button variant="destructive" onClick={() => setConfirmDiscard(true)}>Discard</Button>
              </>
            )}
            {dismissable && (
              <>
                <p className="w-full text-dense text-ink-secondary">
                  {masterExists
                    ? 'Your stitched video is intact — this error only blocked the last change. Dismiss it to get back to review.'
                    : 'The plan on disk is intact — dismiss this error to get back to it.'}
                </p>
                <Button variant="secondary" loading={dismissing} onClick={() => void dismiss()}>
                  {masterExists ? 'Dismiss — back to review' : 'Dismiss — back to the plan'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

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
