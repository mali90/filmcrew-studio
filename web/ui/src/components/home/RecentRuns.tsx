// Home's glimpse of the library: the 4 newest runs, read-only (no delete — management lives in
// the Library), with a quiet See-all link. Renders nothing when there are no runs at all.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { GRID_STYLE, RunCard } from '../library/RunCard';

export function RecentRuns() {
  const runsQ = useQuery({ queryKey: ['runs'], queryFn: api.runs });
  const runs = runsQ.data?.runs ?? [];
  if (runs.length === 0) return null;

  return (
    <section aria-label="Recent runs">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-heading text-ink">Recent</h2>
        <Link to="/library" className="text-label text-accent transition-colors duration-[120ms] hover:text-accent-hover">
          See all →
        </Link>
      </div>
      <div className="grid gap-4" style={GRID_STYLE}>
        {runs.slice(0, 4).map((run) => <RunCard key={run.id} run={run} />)}
      </div>
    </section>
  );
}
