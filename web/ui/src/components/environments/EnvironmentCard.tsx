// One environment on the Cast page's Environments section: an accent-tinted icon badge (never a
// thumbnail — an environment is text-only, by design), the name, and a description excerpt. The
// whole card is a stretched link to the editor; delete is a hover overlay + confirm dialog.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mountain, Trash2 } from 'lucide-react';
import type { EnvironmentView } from '../../../../shared/api-types';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { useToast } from '../ui/Toast';

const errText = (e: unknown) =>
  e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e instanceof Error ? e.message : 'Something went wrong.';

/** First non-heading, non-empty line of the environment markdown — the card's excerpt. */
const excerptOf = (description: string) =>
  description.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? '';

export function EnvironmentCard({ environment: e }: { environment: EnvironmentView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  const excerpt = excerptOf(e.description);

  const remove = useMutation({
    mutationFn: () => api.deleteEnvironment(e.slug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['environments'] });
      toast({ kind: 'success', text: `Deleted ${e.name}.` });
    },
    onError: (err) => toast({ kind: 'error', text: errText(err) }),
    onSettled: () => setConfirming(false),
  });

  return (
    <article className="group relative rounded-r3 border border-line bg-surface-1 p-4 transition-colors duration-[120ms] hover:border-line-strong">
      {/* stretched link — the whole card opens the editor */}
      <Link to={`/environments/${e.slug}`} aria-label={`Edit ${e.name}`} className="absolute inset-0 rounded-r3" />

      <div className="flex items-center gap-3">
        {/* accent-tinted icon badge (NOT the neutral avatar) signals "text-only, by design" */}
        <span aria-hidden className="flex h-14 w-14 shrink-0 items-center justify-center rounded-r2 border border-line bg-[var(--accent-soft)] text-accent">
          <Mountain size={24} strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-body font-medium text-ink">{e.name}</h3>
          {!excerpt && <p className="mt-0.5 text-caption text-status-warn">no description</p>}
        </div>
      </div>

      {excerpt && <p className="mt-3 line-clamp-3 text-dense text-ink-muted">{excerpt}</p>}

      <button
        type="button"
        aria-label={`Delete ${e.name}`}
        onClick={() => setConfirming(true)}
        className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-r2 bg-surface-0/80 text-ink-muted opacity-0 backdrop-blur-sm transition-colors duration-[120ms] hover:text-status-failed focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 size={14} aria-hidden />
      </button>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Delete ${e.name}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete environment
            </Button>
          </>
        }
      >
        <p>The environment description is removed. Ideas already rendered in this setting keep their copy.</p>
      </Dialog>
    </article>
  );
}
