// Step 6 — save. Shows the exact masked .env diff the server will apply (key, from → to) before
// anything is written; the preview and the write share one buildUpdates() so they cannot drift.
import type { Dispatch } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { buildUpdates, type WizardAction, type WizardState } from './wizard';

export function StepReview({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const updates = buildUpdates(state);

  const preview = useQuery({
    queryKey: ['env-preview', JSON.stringify(updates)],
    queryFn: () => api.envPreview(updates),
    staleTime: 0,
    gcTime: 0,
  });

  const write = useMutation({
    mutationFn: () => api.envWrite(updates),
    onSuccess: () => dispatch({ type: 'next' }),
  });

  return (
    <div>
      <h1 className="text-title text-ink">Save your settings.</h1>
      <p className="mt-1 text-body text-ink-secondary">Here is exactly what will change.</p>

      <div className="well mt-5 max-h-64 overflow-auto rounded-r2 bg-stage p-3 font-mono text-dense">
        {preview.isPending && (
          <p className="text-ink-muted" aria-live="polite">Reading the current .env…</p>
        )}
        {preview.isError && (
          <p className="text-status-failed" role="alert">
            {preview.error instanceof ApiClientError
              ? `${preview.error.message} — ${preview.error.hint}`
              : 'Could not preview the changes.'}
          </p>
        )}
        {preview.data?.rows.map((r) => (
          <div key={r.key} className="flex items-baseline gap-2 py-0.5">
            <span className="w-44 shrink-0 truncate text-ink">{r.key}</span>
            <span className="truncate text-ink-faint">{r.from}</span>
            <span aria-hidden className="text-ink-muted">→</span>
            <span className="truncate text-ink-secondary">{r.to}</span>
          </div>
        ))}
        {preview.data && preview.data.rows.length === 0 && (
          <p className="text-ink-muted">Nothing changes — your .env already matches.</p>
        )}
      </div>

      <p className="mt-2 text-caption text-ink-muted">
        Written to .env in the project root — nothing leaves your machine.
      </p>

      {write.isError && (
        <p className="mt-2 text-caption text-status-failed" role="alert">
          {write.error instanceof ApiClientError
            ? `${write.error.message} — ${write.error.hint}`
            : 'The write failed. Try again.'}
        </p>
      )}

      <div className="mt-8 flex justify-end">
        <Button
          variant="primary"
          size="lg"
          loading={write.isPending}
          disabled={preview.isPending}
          onClick={() => write.mutate()}
        >
          Write .env
        </Button>
      </div>
    </div>
  );
}
