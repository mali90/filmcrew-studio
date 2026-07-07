// One character on the Cast grid: avatar, completeness caption, bio excerpt, ref thumbs.
// The whole card is a stretched link to the editor; delete is a hover overlay + confirm dialog.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileImage, Trash2 } from 'lucide-react';
import type { CharacterView } from '../../../../shared/api-types';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { useToast } from '../ui/Toast';

const errText = (e: unknown) =>
  e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e instanceof Error ? e.message : 'Something went wrong.';

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

/** First non-heading, non-empty line of the profile markdown — the card's two-line excerpt. */
const excerptOf = (description: string) =>
  description.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? '';

export function CharacterCard({ character: c }: { character: CharacterView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [alsoRefs, setAlsoRefs] = useState(false);

  const excerpt = excerptOf(c.description);
  const avatarUrl = c.refs.find((r) => r.url)?.url ?? null;
  const refWord = c.refs.length === 1 ? 'reference image' : 'reference images';

  const remove = useMutation({
    mutationFn: () => api.deleteProfile(c.slug, alsoRefs),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cast-characters'] });
      qc.invalidateQueries({ queryKey: ['cast-references'] });
      qc.invalidateQueries({ queryKey: ['cast-voices'] });
      toast({ kind: 'success', text: `Deleted ${c.name}.` });
    },
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
    onSettled: () => setConfirming(false),
  });

  return (
    <article className="group relative rounded-r3 border border-line bg-surface-1 p-4 transition-colors duration-[120ms] hover:border-line-strong">
      {/* stretched link — the whole card opens the editor */}
      <Link to={`/cast/${c.slug}`} aria-label={`Edit ${c.name}`} className="absolute inset-0 rounded-r3" />

      <div className="flex items-center gap-3">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-14 w-14 shrink-0 rounded-r2 border border-line object-cover" />
        ) : (
          <span aria-hidden className="flex h-14 w-14 shrink-0 items-center justify-center rounded-r2 border border-line bg-surface-2 text-label font-medium text-ink-secondary">
            {initials(c.name)}
          </span>
        )}
        <div className="min-w-0">
          <h3 className="truncate text-body font-medium text-ink">{c.name}</h3>
          {/* completeness: plain caption row — warn only for missing refs/bio; voice is optional, so faint */}
          <p className="mt-0.5 text-caption text-ink-muted">
            {c.refs.length > 0
              ? <span className="tnum">{c.refs.length} ref{c.refs.length === 1 ? '' : 's'}</span>
              : <span className="text-status-warn">no refs</span>}
            {' · '}
            {excerpt ? <span>bio</span> : <span className="text-status-warn">no bio</span>}
            {' · '}
            {c.voice ? <span>voice</span> : <span className="text-ink-faint">no voice</span>}
          </p>
        </div>
      </div>

      {excerpt && <p className="mt-3 line-clamp-2 text-dense text-ink-muted">{excerpt}</p>}

      {c.refs.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5">
          {c.refs.slice(0, 4).map((r) =>
            r.url ? (
              <img key={r.id} src={r.url} alt="" className="h-9 w-9 rounded-r1 border border-line object-cover" />
            ) : (
              <span key={r.id} aria-hidden className="flex h-9 w-9 items-center justify-center rounded-r1 border border-line bg-surface-2">
                <FileImage size={12} className="text-ink-faint" />
              </span>
            ),
          )}
          {c.refs.length > 4 && (
            <span className="tnum flex h-9 w-9 items-center justify-center rounded-r1 border border-line bg-surface-2 text-caption text-ink-muted">
              +{c.refs.length - 4}
            </span>
          )}
        </div>
      )}

      <button
        type="button"
        aria-label={`Delete ${c.name}`}
        onClick={() => { setAlsoRefs(false); setConfirming(true); }}
        className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-r2 bg-surface-0/80 text-ink-muted opacity-0 backdrop-blur-sm transition-colors duration-[120ms] hover:text-status-failed focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 size={14} aria-hidden />
      </button>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Delete ${c.name}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete character
            </Button>
          </>
        }
      >
        <p>The profile file is removed. Its {c.refs.length} {refWord} and minted voice stay and move to Unassigned.</p>
        <p className="mt-2">The minted voice is kept — minting it again would cost money.</p>
        {c.refs.length > 0 && (
          <label className="mt-3 flex items-center gap-2 text-dense text-ink">
            <input
              type="checkbox"
              checked={alsoRefs}
              onChange={(e) => setAlsoRefs(e.target.checked)}
              className="accent-[var(--status-failed)]"
            />
            Also delete its {c.refs.length} {refWord}
          </label>
        )}
      </Dialog>
    </article>
  );
}
