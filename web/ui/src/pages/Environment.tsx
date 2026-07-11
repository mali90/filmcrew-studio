// Environment create/edit — /environments/new (create) and /environments/:slug (edit). One page
// owns an environment: purely descriptive markdown whose first heading is the display name. Modeled
// on the Character page MINUS reference images and voice — an environment carries no assets. Delete
// lives on the card only (parity with Character).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Mountain, XCircle } from 'lucide-react';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const NAME_HINT = 'Start with a letter or number; then letters, numbers, spaces, dots, underscores or dashes (max 64).';
const DUPLICATE_HINT = 'An environment with this name already exists.';
// Section headings match the shipped sample (environments/neon-city.md) and the design spec — H2
// bodies under the H1 name the server prepends. The placeholder teaches with a world orthogonal to
// the sample (a 1950s coastal town) so the shape is clear without copying the sample's prose.
const TEMPLATE =
  '## Mood & tone\n\n\n## Time & place\n\n\n## Weather & light\n\n\n## Palette & texture\n\n\n## Sound & ambience\n\n\n## Avoid\n';
const PLACEHOLDER =
  '## Mood & tone\nwistful, warm, unhurried…\n## Time & place\na sleepy 1950s coastal town…\n## Weather & light\nlow golden-hour light, long soft shadows…\n## Palette & texture\nwarm ambers, faded teal, grainy 16mm, handheld shallow DoF…\n## Sound & ambience\ngulls, distant surf, a creaking screen door…\n## Avoid\nmodern signage, cars, over-saturation…';
const NAME_INPUT =
  'h-8 w-full rounded-r2 border border-line-strong bg-surface-2 px-2.5 text-dense text-ink outline-none placeholder:text-ink-faint focus:border-accent';

const errText = (e: unknown) =>
  e instanceof ApiClientError ? `${e.message} — ${e.hint}` : e instanceof Error ? e.message : 'Something went wrong.';

/** The first markdown heading is the display name — the Name concept owns it, so the textarea
 *  edits only the body; save re-attaches the heading (server-side). */
function stripHeading(md: string) {
  const lines = md.split('\n');
  if (/^#\s/.test(lines[0] ?? '')) {
    lines.shift();
    if ((lines[0] ?? '').trim() === '') lines.shift();
  }
  return lines.join('\n');
}

const slugOf = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export default function EnvironmentPage() {
  const { slug } = useParams();
  const isEdit = slug !== undefined;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();

  const envQuery = useQuery({ queryKey: ['environments'], queryFn: api.environments });
  const environments = envQuery.data?.environments ?? [];
  const env = isEdit ? environments.find((e) => e.slug === slug) : undefined;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Seed the textarea once per slug — refetches must not clobber edits.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (env && seededFor.current !== env.slug) {
      seededFor.current = env.slug;
      setDescription(stripHeading(env.description));
    }
  }, [env]);

  const h1Ref = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const headingFocused = useRef(false);
  useEffect(() => {
    if (!isEdit) nameRef.current?.focus();
  }, [isEdit]);
  useEffect(() => {
    if (isEdit && env && !headingFocused.current) {
      headingFocused.current = true;
      h1Ref.current?.focus();
    }
  }, [isEdit, env]);

  const trimmed = name.trim();
  const nameError = useMemo(() => {
    if (isEdit || trimmed === '') return null;
    if (!NAME_RE.test(trimmed)) return NAME_HINT;
    const lower = trimmed.toLowerCase();
    const asSlug = slugOf(trimmed);
    if (environments.some((e) => e.name.toLowerCase() === lower || e.slug === asSlug)) return DUPLICATE_HINT;
    return null;
  }, [isEdit, trimmed, environments]);

  const save = useMutation({
    mutationFn: () =>
      env
        ? api.updateEnvironment(env.slug, { description }) // the server prepends the # Name heading
        : api.createEnvironment(description ? { name: trimmed, description } : { name: trimmed }),
    onSuccess: async ({ slug: savedSlug }) => {
      // await the refetch BEFORE navigating — landing on /environments/<slug> with the stale
      // list still cached would flash the "No such environment" state until the refetch lands
      await qc.invalidateQueries({ queryKey: ['environments'] });
      toast({ kind: 'success', text: 'Environment saved.' });
      if (!isEdit) navigate(`/environments/${savedSlug}`);
    },
  });

  if (isEdit && envQuery.isSuccess && !env) {
    return (
      <div className="mx-auto max-w-[720px]">
        <EmptyState
          icon={<Mountain size={18} />}
          title="No such environment"
          action={
            <Button variant="ghost" icon={<ArrowLeft size={14} aria-hidden />} onClick={() => navigate('/cast')}>
              Back to Cast
            </Button>
          }
        >
          No environment answers to “{slug}” — it may have been renamed or deleted.
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
        {isEdit ? env?.name ?? '…' : 'New environment'}
      </h1>

      {isEdit && envQuery.isLoading && (
        <p className="mt-4 flex items-center gap-2 text-caption text-ink-muted" aria-live="polite">
          <Spinner size={12} /> Loading environment…
        </p>
      )}
      {envQuery.isError && (
        <p role="alert" className="mt-4 text-caption text-status-failed">{errText(envQuery.error)}</p>
      )}

      {(!isEdit || env) && (
        <>
          <div className="mt-6">
            {isEdit ? (
              <>
                <p className="mb-1 text-label text-ink-secondary">Name</p>
                <p className="font-mono text-caption text-ink-secondary">{env?.name}</p>
              </>
            ) : (
              <>
                <label htmlFor="env-name" className="mb-1 block text-label text-ink-secondary">Name</label>
                <input
                  id="env-name"
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. neon-city"
                  className={clsx(NAME_INPUT, nameError && 'border-status-failed')}
                />
                {nameError ? (
                  <p aria-live="polite" className="mt-1 flex items-center gap-1.5 text-caption text-status-failed">
                    <XCircle size={12} aria-hidden /> {nameError}
                  </p>
                ) : (
                  <p className="mt-1 text-caption text-ink-muted">
                    The canonical name agents use to anchor the world.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="mt-6">
            <div className="mb-1 flex items-end justify-between">
              <label htmlFor="env-description" className="block text-label text-ink-secondary">Description</label>
              {description === '' && (
                <Button variant="quiet" size="sm" onClick={() => setDescription(TEMPLATE)}>Insert template</Button>
              )}
            </div>
            <textarea
              id="env-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={PLACEHOLDER}
              className="min-h-[200px] w-full resize-y rounded-r2 border border-line-strong bg-surface-2 p-3 font-mono text-dense text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            />
            <p className="mt-1 text-caption text-ink-muted">
              This steers every shot’s look — weather, light and palette. Put people in Cast, not here.
            </p>
          </div>

          <div className="mt-8 flex items-center gap-3">
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!isEdit && (trimmed === '' || nameError != null)}
              onClick={() => save.mutate()}
            >
              {isEdit ? 'Save' : 'Create environment'}
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
