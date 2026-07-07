// The Library: every run, straight from disk. Three intent filters (not six status chips), a
// pinned Needs-attention group (the grid-level expression of "errors persist until addressed" —
// placement is the emphasis, never alarm styling), and the per-card delete with its confirm
// dialog. Deletion lives HERE; Home's Recent row is read-only.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clapperboard } from 'lucide-react';
import type { RunSummary } from '../../../shared/api-types';
import { api, ApiClientError } from '../api/client';
import { bytes } from '../lib/format';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState } from '../components/ui/EmptyState';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { useToast } from '../components/ui/Toast';
import { GRID_STYLE, RunCard, runName } from '../components/library/RunCard';

export type LibraryFilter = 'all' | 'waiting' | 'complete';

/** plan-ready + review + attention: every state where money or judgment blocks progress. */
const WAITING = new Set(['plan-ready', 'review', 'attention']);

export function applyFilter(runs: RunSummary[], filter: LibraryFilter): RunSummary[] {
  if (filter === 'waiting') return runs.filter((r) => WAITING.has(r.status));
  if (filter === 'complete') return runs.filter((r) => r.status === 'complete');
  return runs;
}

/** Attention runs are EXTRACTED above the rest (never duplicated); newest-first within each. */
export function pinAttention(runs: RunSummary[]): { pinned: RunSummary[]; rest: RunSummary[] } {
  return {
    pinned: runs.filter((r) => r.status === 'attention'),
    rest: runs.filter((r) => r.status !== 'attention'),
  };
}

const FILTERED_EMPTY: Record<Exclude<LibraryFilter, 'all'>, string> = {
  waiting: 'Nothing is waiting on you.',
  complete: 'No finished films yet.',
};

export default function LibraryPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const runsQ = useQuery({ queryKey: ['runs'], queryFn: api.runs });
  const [target, setTarget] = useState<RunSummary | null>(null);

  const raw = params.get('filter');
  const filter: LibraryFilter = raw === 'waiting' || raw === 'complete' ? raw : 'all';
  const setFilter = (f: LibraryFilter) => setParams(f === 'all' ? {} : { filter: f }, { replace: true });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteRun(id),
    onSuccess: (res) => {
      setTarget(null);
      toast({ kind: 'success', text: `Deleted — ${bytes(res.bytes)} freed.` });
      qc.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (err) => {
      setTarget(null);
      toast({ kind: 'error', text: err instanceof ApiClientError ? err.hint : 'Delete failed — please try again.' });
    },
  });

  if (runsQ.isPending) {
    return (
      <div aria-hidden className="grid gap-4" style={GRID_STYLE}>
        {[0, 1, 2].map((i) => <div key={i} className="shimmer h-48 rounded-r3 bg-surface-1" />)}
      </div>
    );
  }
  if (runsQ.isError) {
    return (
      <p role="alert" className="text-body text-ink-secondary">
        The library couldn&rsquo;t load{runsQ.error instanceof ApiClientError ? ` — ${runsQ.error.hint}` : '.'}
      </p>
    );
  }

  const runs = runsQ.data.runs;
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<Clapperboard size={18} />}
        title="Nothing here yet."
        action={
          <Link
            to="/"
            className="inline-flex h-8 items-center rounded-r2 bg-accent px-3 text-label font-medium text-onaccent transition-colors duration-[120ms] hover:bg-accent-hover"
          >
            Start your first video
          </Link>
        }
      >
        Runs you start will collect here — every plan, clip and finished film.
      </EmptyState>
    );
  }

  const waitingCount = applyFilter(runs, 'waiting').length;
  const completeCount = applyFilter(runs, 'complete').length;
  const filtered = applyFilter(runs, filter);
  // pinning honors the user's narrower intent: never under Complete
  const { pinned, rest } = filter === 'complete' ? { pinned: [], rest: filtered } : pinAttention(filtered);

  const segments = [
    { value: 'all' as const, label: 'All', count: runs.length },
    ...(waitingCount > 0 ? [{ value: 'waiting' as const, label: 'Waiting on you', count: waitingCount }] : []),
    ...(completeCount > 0 ? [{ value: 'complete' as const, label: 'Complete', count: completeCount }] : []),
  ];

  return (
    <section aria-label="Run library">
      <div className="flex items-baseline gap-3">
        <h1 className="text-display text-ink">Library</h1>
        <span className="tnum text-body text-ink-muted">{runs.length} run{runs.length === 1 ? '' : 's'}</span>
      </div>
      <p className="mt-1 text-dense text-ink-muted">
        Everything you&rsquo;ve made — plans, clips and finished films, straight from disk.
      </p>

      {segments.length > 1 && (
        <SegmentedControl<LibraryFilter>
          className="mt-4"
          label="Filter runs by status"
          value={filter}
          onChange={setFilter}
          segments={segments}
        />
      )}

      <p aria-live="polite" className="sr-only">
        {filtered.length === 0 ? 'No runs match' : `${filtered.length} run${filtered.length === 1 ? '' : 's'} shown`}
      </p>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12">
          <p className="text-body text-ink-secondary">{FILTERED_EMPTY[filter as Exclude<LibraryFilter, 'all'>]}</p>
          <Button variant="quiet" onClick={() => setFilter('all')}>Show all</Button>
        </div>
      ) : (
        <>
          {pinned.length > 0 && (
            <>
              <h2 className="mb-3 mt-6 text-heading text-ink">
                Needs attention <span className="tnum text-body text-ink-muted">· {pinned.length}</span>
              </h2>
              <div className="grid gap-4" style={GRID_STYLE}>
                {pinned.map((run) => <RunCard key={run.id} run={run} onDelete={setTarget} />)}
              </div>
              {rest.length > 0 && <h2 className="mb-3 mt-8 text-heading text-ink">Everything else</h2>}
            </>
          )}
          {rest.length > 0 && (
            <div className={pinned.length > 0 ? 'grid gap-4' : 'mt-6 grid gap-4'} style={GRID_STYLE}>
              {rest.map((run) => <RunCard key={run.id} run={run} onDelete={setTarget} />)}
            </div>
          )}
        </>
      )}

      <Dialog
        open={target != null}
        onClose={() => setTarget(null)}
        title="Delete this run?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>Keep it</Button>
            <Button variant="destructive" loading={del.isPending} onClick={() => target && del.mutate(target.id)}>
              Delete
            </Button>
          </>
        }
      >
        This removes &ldquo;{target ? runName(target) : ''}&rdquo; and its plan, clips and renders from disk.
        It cannot be undone.
      </Dialog>
    </section>
  );
}
