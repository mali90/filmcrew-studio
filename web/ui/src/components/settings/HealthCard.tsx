// Doctor — the same checks the CLI's `doctor` runs, as an ACTIONABLE checklist: hard rows scroll
// to the owning card (Keys/Defaults) and pulse it; soft rows link to Cast; ffmpeg failures carry
// the guided install panel. Shares the ['doctor'] cache with the shell's health dot; Keys/Defaults
// saves invalidate it, so fixing something updates this card while you watch.
import { useQuery } from '@tanstack/react-query';
import { XCircle } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { CheckRow } from '../health/CheckRow';

/** Scroll the owning card into view, focus its first input, pulse its border. */
function anchorTo(headingId: string) {
  const heading = document.getElementById(headingId);
  const card = heading?.closest('section');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.querySelector<HTMLElement>('input, select, button[role="radio"]')?.focus({ preventScroll: true });
  card.classList.add('!border-accent');
  setTimeout(() => card.classList.remove('!border-accent'), 1200);
}

export function HealthCard() {
  const q = useQuery({ queryKey: ['doctor'], queryFn: api.doctor, staleTime: 0 });

  const hard = q.data?.hard ?? 0;
  const softFails = q.data?.checks.filter((c) => !c.ok && c.soft).length ?? 0;
  const summary = !q.data ? '' : hard > 0 ? `${hard} check${hard === 1 ? '' : 's'} failing.` : softFails > 0 ? 'Passing, with warnings.' : 'All checks passed.';

  return (
    <section aria-labelledby="health-heading" className="rounded-r3 border border-line bg-surface-1 p-5 transition-colors duration-[600ms]">
      <div className="flex items-center justify-between">
        <h2 id="health-heading" className="text-heading text-ink">Health</h2>
        <Button variant="secondary" size="sm" loading={q.isFetching} onClick={() => q.refetch()}>
          Re-check
        </Button>
      </div>

      <p role="status" className="sr-only">{summary}</p>

      {q.isLoading ? (
        <p className="mt-3 flex items-center gap-2 text-caption text-ink-muted"><Spinner size={12} /> Running checks…</p>
      ) : q.isError ? (
        <p className="mt-3 flex items-center gap-2 text-dense text-status-failed">
          <XCircle size={14} aria-hidden /> The doctor could not run — is the server healthy?
        </p>
      ) : (
        <ul className={clsx('mt-3 space-y-2.5 transition-opacity duration-[200ms]', q.isFetching && 'opacity-60')}>
          {q.data?.checks.map((c) => (
            <CheckRow
              key={c.id + c.label}
              check={c}
              context="settings"
              platform={q.data.platform}
              refetching={q.isFetching}
              failedRechecks={0}
              allChecks={q.data.checks}
              onRecheck={() => void q.refetch()}
              onAnchor={anchorTo}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
