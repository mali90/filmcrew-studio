// Character create/edit — /cast/new (create) and /cast/:slug (edit). One page owns a character:
// the profile markdown (whose first heading is the display name), the reference images linked to
// it by filename prefix, and the voice bound to its name. The Cast index only lists cards.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, ImagePlus, Mic, UserX, X, XCircle } from 'lucide-react';
import type { CharacterView, ReferenceRow, VoiceRow } from '../../../shared/api-types';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const MAX_REFS = 7; // Kling's per-job model cap — a character can never use more in one render
const NAME_HINT = 'Start with a letter or number; then letters, numbers, spaces, dots, underscores or dashes (max 64).';
const DUPLICATE_HINT = 'A character with this name already exists.';
const TEMPLATE = '# Appearance\n\n\n# Wardrobe\n\n\n# Mannerisms & voice\n';
const PLACEHOLDER = '# Appearance\n…\n# Wardrobe\n…\n# Mannerisms & voice\n…';
const NAME_INPUT =
  'h-8 w-full rounded-r2 border border-line-strong bg-surface-2 px-2.5 text-dense text-ink outline-none placeholder:text-ink-faint focus:border-accent';

const errText = (e: unknown) =>
  e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e instanceof Error ? e.message : 'Something went wrong.';

/** The first markdown heading is the display name — the Name concept owns it, so the textarea
 *  edits only the body; save re-attaches the heading. */
function stripHeading(md: string) {
  const lines = md.split('\n');
  if (/^#\s/.test(lines[0] ?? '')) {
    lines.shift();
    if ((lines[0] ?? '').trim() === '') lines.shift();
  }
  return lines.join('\n');
}

const slugOf = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export default function CharacterPage() {
  const { slug } = useParams();
  const isEdit = slug !== undefined;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();

  const charsQuery = useQuery({ queryKey: ['cast-characters'], queryFn: api.characters });
  const characters = charsQuery.data?.characters ?? [];
  const char = isEdit ? characters.find((c) => c.slug === slug) : undefined;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Seed the textarea once per slug — refetches after ref/voice mutations must not clobber edits.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (char && seededFor.current !== char.slug) {
      seededFor.current = char.slug;
      setDescription(stripHeading(char.description));
    }
  }, [char]);

  const h1Ref = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const headingFocused = useRef(false);
  useEffect(() => {
    if (!isEdit) nameRef.current?.focus();
  }, [isEdit]);
  useEffect(() => {
    if (isEdit && char && !headingFocused.current) {
      headingFocused.current = true;
      h1Ref.current?.focus();
    }
  }, [isEdit, char]);

  const trimmed = name.trim();
  const nameError = useMemo(() => {
    if (isEdit || trimmed === '') return null;
    if (!NAME_RE.test(trimmed)) return NAME_HINT;
    const lower = trimmed.toLowerCase();
    const asSlug = slugOf(trimmed);
    if (characters.some((c) => c.name.toLowerCase() === lower || c.slug === asSlug)) return DUPLICATE_HINT;
    return null;
  }, [isEdit, trimmed, characters]);

  const save = useMutation({
    mutationFn: () =>
      char
        ? api.updateProfile(char.slug, { description }) // the server prepends the # Name heading
        : api.createProfile(description ? { name: trimmed, description } : { name: trimmed }),
    onSuccess: ({ slug: savedSlug }) => {
      qc.invalidateQueries({ queryKey: ['cast-characters'] });
      toast({ kind: 'success', text: `Profile saved to profiles/${savedSlug}.md` });
      if (!isEdit) navigate(`/cast/${savedSlug}`);
    },
  });

  if (isEdit && charsQuery.isSuccess && !char) {
    return (
      <div className="mx-auto max-w-[720px]">
        <EmptyState
          icon={<UserX size={18} />}
          title="No such character"
          action={
            <Button variant="ghost" icon={<ArrowLeft size={14} aria-hidden />} onClick={() => navigate('/cast')}>
              Back to Cast
            </Button>
          }
        >
          No profile answers to “{slug}” — it may have been renamed or deleted.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px]">
      <Button variant="ghost" icon={<ArrowLeft size={14} aria-hidden />} onClick={() => navigate('/cast')}>
        Cast
      </Button>
      <h1 ref={h1Ref} tabIndex={-1} className="mt-2 text-display text-ink outline-none">
        {isEdit ? char?.name ?? '…' : 'New character'}
      </h1>

      {isEdit && charsQuery.isLoading && (
        <p className="mt-4 flex items-center gap-2 text-caption text-ink-muted" aria-live="polite">
          <Spinner size={12} /> Loading character…
        </p>
      )}
      {charsQuery.isError && (
        <p role="alert" className="mt-4 text-caption text-status-failed">{errText(charsQuery.error)}</p>
      )}

      {(!isEdit || char) && (
        <>
          <div className="mt-6">
            {isEdit ? (
              <>
                <p className="mb-1 text-label text-ink-secondary">Name</p>
                <p className="font-mono text-caption text-ink-secondary">{char?.name}</p>
              </>
            ) : (
              <>
                <label htmlFor="char-name" className="mb-1 block text-label text-ink-secondary">Name</label>
                <input
                  id="char-name"
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. keeper"
                  className={clsx(NAME_INPUT, nameError && 'border-status-failed')}
                />
                {nameError ? (
                  <p aria-live="polite" className="mt-1 flex items-center gap-1.5 text-caption text-status-failed">
                    <XCircle size={12} aria-hidden /> {nameError}
                  </p>
                ) : (
                  <p className="mt-1 text-caption text-ink-muted">
                    The canonical name agents use in prompts and voice binding.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="mt-6">
            <div className="mb-1 flex items-end justify-between">
              <label htmlFor="char-description" className="block text-label text-ink-secondary">Description</label>
              {description === '' && (
                <Button variant="quiet" size="sm" onClick={() => setDescription(TEMPLATE)}>Insert template</Button>
              )}
            </div>
            <textarea
              id="char-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={PLACEHOLDER}
              className="min-h-[200px] w-full resize-y rounded-r2 border border-line-strong bg-surface-2 p-3 font-mono text-dense text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            />
            <p className="mt-1 text-caption text-ink-muted">
              Describe behaviour, tone and world. The look comes from reference images — don't write hair, face or
              outfit here.
            </p>
          </div>

          {isEdit && char && (
            <>
              <ReferencesEditor char={char} unassigned={charsQuery.data?.unassigned.references ?? []} />
              <VoiceEditor char={char} unassignedVoices={charsQuery.data?.unassigned.voices ?? []} />
            </>
          )}

          <div className="mt-8 flex items-center gap-3">
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!isEdit && (trimmed === '' || nameError != null)}
              onClick={() => save.mutate()}
            >
              {isEdit ? 'Save' : 'Create character'}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/cast')}>Cancel</Button>
            {save.isError && (
              <p role="alert" className="text-caption text-status-failed">{errText(save.error)}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Reference images (edit mode) ──────────────────────────────────────────────────────────────

function RefThumb({ r }: { r: ReferenceRow }) {
  return r.url ? (
    <img
      src={r.url}
      alt={r.description ?? r.file}
      className="aspect-square w-full max-w-[100%] rounded-r2 border border-line object-cover"
    />
  ) : (
    <div className="flex aspect-square w-full items-center justify-center rounded-r2 border border-line bg-surface-2 px-1.5 text-center">
      <span className="break-all font-mono text-caption text-ink-muted">{r.file}</span>
    </div>
  );
}

function ReferencesEditor({ char, unassigned }: { char: CharacterView; unassigned: ReferenceRow[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['cast-characters'] });

  const unlink = useMutation({
    mutationFn: (id: string) => api.assignReference(id, null),
    onSuccess: refresh,
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
  });
  const link = useMutation({
    mutationFn: (id: string) => api.assignReference(id, char.slug),
    onSuccess: refresh,
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
  });
  const remaining = Math.max(0, MAX_REFS - char.refs.length);
  const upload = useMutation({
    // sequential on purpose: the server assigns <slug>-NN names as each file lands
    mutationFn: async (files: File[]) => {
      for (const f of files) await api.uploadReference(f, char.slug);
      return files.length;
    },
    onSuccess: (n) => {
      refresh();
      toast({ kind: 'success', text: n === 1 ? 'Reference added.' : `${n} references added.` });
    },
    onError: (e) => {
      refresh(); // some of a batch may have landed before the failure
      toast({ kind: 'error', text: errText(e) });
    },
  });
  const onPick = (files: File[]) => {
    if (!files.length) return;
    if (files.length > remaining) {
      toast({ kind: 'error', text: `Only ${remaining} of ${files.length} added — a character holds at most ${MAX_REFS} reference images (a render can't use more).` });
    }
    if (remaining > 0) upload.mutate(files.slice(0, remaining));
  };

  return (
    <section className="mt-8" aria-labelledby="char-refs-label">
      <p id="char-refs-label" className="mb-1 text-label text-ink-secondary">
        Reference images <span className="tnum text-caption text-ink-muted">{char.refs.length} of {MAX_REFS}</span>
      </p>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
        {char.refs.map((r) => (
          <figure key={r.id} className="group relative">
            <RefThumb r={r} />
            <button
              type="button"
              aria-label={`Unlink ${r.file}`}
              title="Unlink"
              onClick={() => unlink.mutate(r.id)}
              className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-r2 bg-surface-0/80 text-ink-muted opacity-0 transition-opacity duration-[120ms] hover:text-status-failed focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X size={12} aria-hidden />
            </button>
          </figure>
        ))}

        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={upload.isPending || remaining === 0}
          title={remaining === 0 ? `At the ${MAX_REFS}-image limit — unlink one first` : undefined}
          className="flex aspect-square flex-col items-center justify-center gap-1 rounded-r2 border border-dashed border-line-strong text-ink-muted transition-colors duration-[120ms] hover:border-accent hover:text-ink-secondary disabled:opacity-60"
        >
          {upload.isPending ? <Spinner size={16} /> : <ImagePlus size={16} aria-hidden />}
          <span className="text-caption">{upload.isPending ? 'Uploading…' : remaining === 0 ? 'Full' : 'Add'}</span>
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        aria-label="Upload reference images"
        onChange={(e) => {
          onPick(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {unassigned.length > 0 && (
        <div className="mt-2">
          <Button variant="quiet" size="sm" onClick={() => setTrayOpen((v) => !v)}>
            Pick from library ({unassigned.length})
          </Button>
          {trayOpen && (
            <div className="mt-2 rounded-r2 bg-surface-2 p-3">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
                {unassigned.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-label={`Link ${r.file}`}
                    disabled={link.isPending || remaining === 0}
                    onClick={() => link.mutate(r.id)}
                    className="rounded-r2 outline-none transition-colors duration-[120ms] focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
                  >
                    <RefThumb r={r} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="mt-3 rounded-r2 bg-surface-2 px-3 py-2.5 text-caption text-ink-secondary">
        1–4 clean, frontal, well-lit images keep a character on-model — more can confuse the pick; {MAX_REFS} is the hard limit (a render can't use more per job).
        Only add photos and voices of people who&rsquo;ve said yes.
      </p>
    </section>
  );
}

// ── Voice (edit mode) ─────────────────────────────────────────────────────────────────────────

function VoiceEditor({ char, unassignedVoices }: { char: CharacterView; unassignedVoices: VoiceRow[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const voicesQuery = useQuery({ queryKey: ['cast-voices'], queryFn: api.voices });
  const clipInput = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['cast-voices'] });
    qc.invalidateQueries({ queryKey: ['cast-characters'] });
  };

  const unlink = useMutation({
    mutationFn: (key: string) => api.assignVoice(key, null),
    onSuccess: refresh,
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
  });
  const linkVoice = useMutation({
    mutationFn: (key: string) => api.assignVoice(key, char.name),
    onSuccess: () => {
      refresh();
      setLinkOpen(false);
    },
    // 409 (character already voiced) rides the same persistent error toast as any failure
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
  });
  // selecting a clip SAVES it with the character right away (free) — leaving the page must not
  // lose it; minting is the separate, paid step that runs on the staged clip
  const stage = useMutation({
    mutationFn: (file: File) => api.stageVoice(char.name, file),
    onSuccess: (r) => {
      toast({ kind: 'success', text: `Clip saved with ${char.name} (${r.clipName}) — mint it when you're ready.` });
      if (clipInput.current) clipInput.current.value = '';
      refresh();
    },
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
  });
  const mint = useMutation({
    mutationFn: () => api.mintStagedVoice(char.name),
    onSuccess: () => {
      toast({ kind: 'success', text: 'Minting — the voice appears here shortly.' });
      refresh();
    },
    onError: (e) => toast({ kind: 'error', text: errText(e) }),
  });

  const voice = char.voice;

  return (
    <section className="mt-6 rounded-r3 border border-line bg-surface-1 p-4" aria-labelledby="char-voice-heading">
      <h2 id="char-voice-heading" className="flex items-center gap-2 text-label text-ink">
        <Mic size={14} className="text-ink-muted" aria-hidden /> Voice
      </h2>

      {voice ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-body font-medium text-ink">{voice.name ?? char.name}</span>
            {voice.voiceId ? (
              <span className="max-w-[180px] truncate font-mono text-caption text-ink-muted" title={voice.voiceId}>
                {voice.voiceId}
              </span>
            ) : (
              <span className="inline-flex h-5 items-center rounded-full bg-surface-2 px-2 text-caption font-medium text-ink-secondary">
                clip saved{voice.clipName ? ` — ${voice.clipName}` : ''} · not minted yet
              </span>
            )}
            {voice.refClipAvailable ? (
              <span className="inline-flex h-5 items-center rounded-full bg-[var(--status-done-soft)] px-2 text-caption font-medium text-status-done">
                lip-sync ready
              </span>
            ) : (
              <span className="inline-flex h-5 items-center rounded-full bg-[var(--status-warn-soft)] px-2 text-caption font-medium text-status-warn">
                no clip — Seedance falls back to native audio
              </span>
            )}
            <span className="flex-1" />
            {!voice.voiceId && (
              <Button
                variant="primary"
                size="sm"
                costUsd={voicesQuery.data?.mintUsd ?? null}
                loading={mint.isPending}
                onClick={() => mint.mutate()}
              >
                Mint voice
              </Button>
            )}
            <Button
              variant="destructive"
              size="sm"
              loading={unlink.isPending}
              disabled={!voice.key}
              onClick={() => voice.key && unlink.mutate(voice.key)}
            >
              Unlink
            </Button>
          </div>
          {!voice.voiceId && (
            <p className="mt-2 text-caption text-ink-muted">
              The saved clip already drives Seedance lip-sync. Minting locks a persistent Kling voice from it.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[120px]">
              <p className="mb-1 text-label text-ink-secondary">Character</p>
              <p className="font-mono text-caption text-ink-secondary">{char.name}</p>
            </div>
            <div className="min-w-[200px] flex-1">
              <label htmlFor="char-voice-clip" className="mb-1 block text-label text-ink-secondary">Voice clip</label>
              <input
                id="char-voice-clip"
                ref={clipInput}
                type="file"
                accept=".mp3,.wav,.mp4,.mov,audio/mpeg,audio/wav,audio/mp4,video/mp4,video/quicktime"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) stage.mutate(f); }}
                className="block w-full text-dense text-ink-secondary file:mr-2.5 file:h-8 file:cursor-pointer file:rounded-r2 file:border file:border-line-strong file:bg-surface-2 file:px-2.5 file:text-label file:text-ink"
              />
            </div>
            {stage.isPending && <Spinner size={14} />}
          </div>
          <p className="mt-2 text-caption text-ink-muted">
            MP3, WAV, MP4 or MOV · 5–30s, one clean speaker, no music. Choosing a clip saves it with the
            character right away — minting the voice is the separate paid step.
          </p>

          {unassignedVoices.length > 0 && (
            <div className="mt-3">
              <Button variant="quiet" size="sm" onClick={() => setLinkOpen((v) => !v)}>Link existing voice</Button>
              {linkOpen && (
                <ul className="mt-2 divide-y divide-line rounded-r2 bg-surface-2">
                  {unassignedVoices.map((v, i) => (
                    <li key={v.key ?? v.voiceId ?? i}>
                      <button
                        type="button"
                        disabled={!v.key || linkVoice.isPending}
                        onClick={() => v.key && linkVoice.mutate(v.key)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-[120ms] hover:bg-surface-3 disabled:opacity-60"
                      >
                        <span className="text-dense font-medium text-ink">{v.name ?? 'unnamed'}</span>
                        {v.voiceId && (
                          <span className="max-w-[180px] truncate font-mono text-caption text-ink-muted">{v.voiceId}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
