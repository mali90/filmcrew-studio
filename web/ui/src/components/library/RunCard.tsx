// One run as a quiet card — cover, name, status pill, and a tnum caption. Shared by the Library
// grid (with the hover delete) and Home's Recent row (read-only: management lives in the Library).
import { Link } from 'react-router-dom';
import { Film, Trash2 } from 'lucide-react';
import type { RunSummary } from '../../../../shared/api-types';
import { timeAgo, usd } from '../../lib/format';
import { StatusPill } from '../ui/StatusPill';

export const runName = (run: RunSummary) => run.title ?? run.idea ?? run.id;

export const spentUsd = (run: RunSummary) => {
  const ledger = run.manifest?.costLedger ?? [];
  if (!ledger.some((e) => e.estUsd != null)) return null;
  return ledger.reduce((sum, e) => sum + (e.estUsd ?? 0), 0);
};

export function RunCard({ run, onDelete }: { run: RunSummary; onDelete?: (run: RunSummary) => void }) {
  const spent = spentUsd(run);
  // an attention card explains itself in one line — the user should know WHY before clicking
  const caption = run.status === 'attention' && run.error?.message
    ? `${run.error.message.split('\n')[0]} — open to resume.`
    : [run.backend, timeAgo(run.createdAt), spent != null ? `≈ ${usd(spent)}` : null]
        .filter(Boolean)
        .join(' · ');
  return (
    <div className="group relative">
      <Link
        to={`/runs/${run.id}`}
        className="block rounded-r3 border border-line bg-surface-1 p-3 transition-colors duration-[120ms] hover:border-line-strong"
      >
        <div
          className="well flex items-center justify-center overflow-hidden rounded-r2 bg-surface-2"
          style={{ aspectRatio: (run.aspect ?? '16:9').replace(':', ' / ') }}
        >
          {run.coverUrl
            ? <img src={run.coverUrl} alt="" className="h-full w-full max-w-full object-cover" />
            : <Film size={20} className="text-ink-faint" aria-hidden />}
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <span className="truncate text-label font-medium text-ink">{runName(run)}</span>
          <StatusPill status={run.status} className="shrink-0" />
        </div>
        <div className="tnum mt-1 truncate text-caption text-ink-muted">{caption}</div>
      </Link>
      {onDelete && (
        <button
          aria-label={`Delete run ${runName(run)}`}
          onClick={() => onDelete(run)}
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-r2 bg-surface-1/80 text-ink-muted opacity-0 backdrop-blur-sm transition-opacity duration-[120ms] hover:text-status-failed focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** The shared grid recipe — auto-fill, 240px min tiles. */
export const GRID_STYLE = { gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' } as const;
