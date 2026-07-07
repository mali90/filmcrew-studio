// Cast — character-first: each card bundles a profile, its reference images and a voice.
// Loose assets live in the collapsed "Unassigned assets" parking lot below the grid.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { api, ApiClientError } from '../api/client';
import { CharacterCard } from '../components/cast/CharacterCard';
import { UnassignedAssets } from '../components/cast/UnassignedAssets';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';

const errText = (e: unknown) =>
  e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e instanceof Error ? e.message : 'Something went wrong.';

export default function CastPage() {
  const q = useQuery({ queryKey: ['cast-characters'], queryFn: api.characters });
  const characters = q.data?.characters ?? [];
  const unassigned = q.data?.unassigned;

  return (
    <div className="mx-auto max-w-[880px]">
      <header>
        <h1 className="text-display text-ink">Cast</h1>
        <p className="mt-1 text-body text-ink-secondary">
          Characters carry a profile, reference images and a voice into every plan. All of it is optional — ideas work fine without a cast.
        </p>
      </header>

      {q.isLoading && (
        <p className="mt-6 flex items-center gap-2 text-caption text-ink-muted" aria-live="polite">
          <Spinner size={12} /> Loading cast…
        </p>
      )}
      {q.isError && (
        <p role="alert" className="mt-6 text-dense text-status-failed">{errText(q.error)}</p>
      )}

      {q.isSuccess && (
        characters.length === 0 ? (
          <EmptyState
            icon={<UserPlus size={18} aria-hidden />}
            title="No characters yet"
            action={
              <Link
                to="/cast/new"
                className="inline-flex h-8 items-center gap-2 rounded-r2 bg-accent px-3 text-label font-medium text-onaccent transition-colors duration-[120ms] hover:bg-accent-hover"
              >
                <UserPlus size={14} aria-hidden />
                New character
              </Link>
            }
          >
            Create a character once — name, look, voice — and star them in any video.
          </EmptyState>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {characters.map((c) => <CharacterCard key={c.slug} character={c} />)}
            <Link
              to="/cast/new"
              className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-r3 border border-dashed border-line-strong text-ink-muted transition-colors hover:border-accent hover:text-ink-secondary"
            >
              <UserPlus size={18} aria-hidden />
              <span className="text-label">New character</span>
            </Link>
          </div>
        )
      )}

      {unassigned && (
        <UnassignedAssets references={unassigned.references} voices={unassigned.voices} characters={characters} />
      )}
    </div>
  );
}
