// The parking lot below the character grid: reference images and minted voices that belong to no
// character yet. Collapsed by default — a healthy cast rarely needs it. Renders nothing when empty.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, FileImage, Trash2 } from 'lucide-react';
import type { CharacterView, ReferenceRow, VoiceRow } from '../../../../shared/api-types';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { useToast } from '../ui/Toast';

const OPEN_KEY = 'kva-unassigned-open';

const errText = (e: unknown) =>
  e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e instanceof Error ? e.message : 'Something went wrong.';

export function UnassignedAssets({ references, voices, characters }: {
  references: ReferenceRow[];
  voices: VoiceRow[];
  characters: CharacterView[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
  });
  // which asset's chip row is showing — 'ref:<id>' | 'voice:<key>' | null
  const [assignOpen, setAssignOpen] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ReferenceRow | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cast-characters'] });
    qc.invalidateQueries({ queryKey: ['cast-references'] });
    qc.invalidateQueries({ queryKey: ['cast-voices'] });
  };

  const assignRef = useMutation({
    // references are assigned by SLUG — the server renames the file to <slug>-NN.ext
    mutationFn: (v: { id: string; slug: string; name: string }) => api.assignReference(v.id, v.slug),
    onSuccess: (_d, v) => { invalidate(); setAssignOpen(null); toast({ kind: 'success', text: `Assigned to ${v.name}.` }); },
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
  });

  const assignVoice = useMutation({
    // voices are assigned by the character's display NAME
    mutationFn: (v: { key: string; name: string }) => api.assignVoice(v.key, v.name),
    onSuccess: (_d, v) => { invalidate(); setAssignOpen(null); toast({ kind: 'success', text: `Assigned to ${v.name}.` }); },
    // 409 (character already has a voice) surfaces here — error toasts persist until dismissed
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
  });

  const removeRef = useMutation({
    mutationFn: (id: string) => api.deleteReference(id),
    onSuccess: () => { invalidate(); toast({ kind: 'success', text: 'Reference deleted.' }); },
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
    onSettled: () => setPendingDelete(null),
  });

  if (references.length === 0 && voices.length === 0) return null;

  const toggle = () => setOpen((o) => {
    const next = !o;
    try { localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* private mode */ }
    return next;
  });

  const chips = (onPick: (c: CharacterView) => void) => (
    <span className="flex flex-wrap gap-1">
      {characters.map((c) => (
        <button
          key={c.slug}
          type="button"
          onClick={() => onPick(c)}
          className="h-6 rounded-full border border-line-strong bg-surface-2 px-2.5 text-caption text-ink-secondary transition-colors duration-[120ms] hover:border-accent hover:text-ink"
        >
          {c.name}
        </button>
      ))}
    </span>
  );

  return (
    <section className="mt-12 border-t border-line pt-6">
      <button type="button" aria-expanded={open} onClick={toggle} className="flex items-center gap-2">
        <ChevronRight size={14} aria-hidden className={clsx('text-ink-muted transition-transform duration-[120ms]', open && 'rotate-90')} />
        <span className="text-label text-ink-secondary">Unassigned assets</span>
        <span className="tnum text-caption text-ink-muted">
          {`${references.length} ${references.length === 1 ? 'reference' : 'references'} · ${voices.length} ${voices.length === 1 ? 'voice' : 'voices'}`}
        </span>
      </button>

      {open && (
        <div className="mt-4">
          {references.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
              {references.map((r) => (
                <figure key={r.id} className="group relative overflow-hidden rounded-r3 border border-line bg-surface-1">
                  {r.url ? (
                    <img src={r.url} alt={r.description ?? r.id} className="aspect-square w-full max-w-full object-cover" />
                  ) : (
                    <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 bg-surface-2 px-2 text-center">
                      <FileImage size={16} className="text-ink-faint" aria-hidden />
                      <span className="break-all font-mono text-caption text-ink-muted">{r.file}</span>
                    </div>
                  )}
                  <figcaption className="p-2">
                    <span className="block truncate font-mono text-caption text-ink-secondary" title={r.id}>{r.id}</span>
                    {characters.length > 0 && (
                      <div className="mt-1">
                        {assignOpen === `ref:${r.id}` ? (
                          chips((c) => assignRef.mutate({ id: r.id, slug: c.slug, name: c.name }))
                        ) : (
                          <Button
                            variant="quiet"
                            size="sm"
                            className="-ml-2.5"
                            aria-label={`Assign ${r.id} to a character`}
                            onClick={() => setAssignOpen(`ref:${r.id}`)}
                          >
                            Assign to…
                          </Button>
                        )}
                      </div>
                    )}
                  </figcaption>
                  <button
                    type="button"
                    aria-label={`Delete reference ${r.id}`}
                    onClick={() => setPendingDelete(r)}
                    className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-r2 bg-surface-0/80 text-ink-muted opacity-0 backdrop-blur-sm transition-colors duration-[120ms] hover:text-status-failed focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </figure>
              ))}
            </div>
          )}

          {voices.length > 0 && (
            <ul className={clsx('divide-y divide-line rounded-r3 border border-line bg-surface-1', references.length > 0 && 'mt-4')}>
              {voices.map((v, i) => {
                const key = v.key ?? v.name ?? String(i);
                return (
                  <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                    <span className="text-dense font-medium text-ink">{v.name ?? 'unnamed'}</span>
                    {v.voiceId && (
                      <span className="max-w-[180px] truncate font-mono text-caption text-ink-muted" title={v.voiceId}>{v.voiceId}</span>
                    )}
                    <span
                      className={clsx(
                        'inline-flex h-5 items-center rounded-full px-2 text-caption font-medium',
                        v.refClipAvailable ? 'bg-[var(--status-done-soft)] text-status-done' : 'bg-[var(--status-warn-soft)] text-status-warn',
                      )}
                    >
                      {v.refClipAvailable ? 'lip-sync ready' : 'no clip — Seedance falls back to native audio'}
                    </span>
                    <span className="flex-1" />
                    {characters.length > 0 && v.key && (
                      assignOpen === `voice:${key}` ? (
                        chips((c) => assignVoice.mutate({ key: v.key!, name: c.name }))
                      ) : (
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-label={`Assign voice ${v.name ?? key} to a character`}
                          onClick={() => setAssignOpen(`voice:${key}`)}
                        >
                          Assign to…
                        </Button>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <Dialog
        open={pendingDelete != null}
        onClose={() => setPendingDelete(null)}
        title="Delete this reference?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={removeRef.isPending}
              onClick={() => pendingDelete && removeRef.mutate(pendingDelete.id)}
            >
              Delete
            </Button>
          </>
        }
      >
        <span className="font-mono text-dense">{pendingDelete?.file}</span> will be removed from your references.
        Runs that already rendered with it keep their copies.
      </Dialog>
    </section>
  );
}
