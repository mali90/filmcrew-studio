// Step 7 — health check, and never a dead end: every failed row carries its fix. Hard rows jump
// to the owning step (fix-mode: Save & re-check returns here); ffmpeg gets the guided install
// panel (the one thing the app can't do for itself); soft rows defer to the Cast page. Runs on
// entry — coming back from a fix IS the re-check.
import type { Dispatch } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { CheckRow } from '../health/CheckRow';
import type { WizardAction } from './wizard';

export function StepDoctor({ dispatch, onContinue }: { dispatch: Dispatch<WizardAction>; onContinue: () => void }) {
  const q = useQuery({
    queryKey: ['setup-doctor'],
    queryFn: api.doctor,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });

  const hard = q.data?.hard ?? 0;
  const blocked = !q.data || hard > 0;

  // count consecutive re-checks that still fail ffmpeg — the panel escalates its guidance
  const [failedRechecks, setFailedRechecks] = useState(0);
  const runs = useRef(0);
  useEffect(() => {
    if (!q.data) return;
    runs.current += 1;
    const ffmpegFailing = q.data.checks.some((c) => (c.id === 'ffmpeg' || c.id === 'ffprobe') && !c.ok);
    if (!ffmpegFailing) setFailedRechecks(0);
    else if (runs.current > 1) setFailedRechecks((n) => n + 1);
  }, [q.data]);

  const softFails = q.data?.checks.filter((c) => !c.ok && c.soft).length ?? 0;
  const summary = !q.data
    ? ''
    : hard > 0
      ? `${hard} check${hard === 1 ? '' : 's'} failing${softFails ? `, ${softFails} warning${softFails === 1 ? '' : 's'}` : ''}.`
      : 'All checks passed.';

  return (
    <div>
      <h1 className="text-title text-ink">One health check.</h1>
      <p className="mt-1 text-body text-ink-secondary">
        Making sure the pipeline can actually run on this machine.
      </p>

      <p role="status" className="sr-only">{summary}</p>

      <div className="mt-5">
        {q.isPending && (
          <p className="flex items-center gap-2 text-body text-ink-muted">
            <Spinner size={14} /> Running checks…
          </p>
        )}
        {q.isError && (
          <p className="text-body text-status-failed" role="alert">
            {q.error instanceof ApiClientError ? `${q.error.message} — ${q.error.hint}` : 'The health check did not run.'}
          </p>
        )}
        {q.data && (
          <ul className={clsx('space-y-2.5 transition-opacity duration-[200ms]', q.isFetching && 'opacity-60')}>
            {q.data.checks.map((c) => (
              <CheckRow
                key={c.id + c.label}
                check={c}
                context="wizard"
                platform={q.data.platform}
                refetching={q.isFetching}
                failedRechecks={failedRechecks}
                allChecks={q.data.checks}
                onFix={(step) => dispatch({ type: 'fix', step })}
                onRecheck={() => void q.refetch()}
              />
            ))}
          </ul>
        )}
      </div>

      {hard > 0 && (
        <p className="mt-4 text-caption text-ink-muted">
          Every failed check has a fix beside it. Soft warnings never block you.
        </p>
      )}

      <div className="mt-8 flex items-center justify-end gap-2">
        <Button variant="secondary" size="lg" loading={q.isFetching} onClick={() => void q.refetch()}>
          Re-check
        </Button>
        <Button variant="primary" size="lg" disabled={blocked} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
