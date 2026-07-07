// The create hero: one line in, a planned film out. Planning costs only LLM usage, so the primary button
// carries no cost tag — the price conversation happens on the run page, before any render.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import type { Aspect, Backend } from '../../../../shared/api-types';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';

const BACKEND_HINT: Record<Backend, string> = {
  kling: 'Kling renders the richest motion at roughly $0.11 per second (~720p — approving can upscale the final to 1080p).',
  seedance: 'Seedance lip-syncs to your voice clips and renders at 480p for roughly $0.14 per second — approving can upscale the final to 1080p.',
};

const ASPECT_TILES: { value: Aspect; shape: string }[] = [
  { value: '9:16', shape: 'h-8 w-[18px]' },
  { value: '16:9', shape: 'h-[18px] w-8' },
  { value: '1:1', shape: 'h-6 w-6' },
];

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

const clampDuration = (n: number) => Math.min(120, Math.max(3, Math.round(n)));

export function CreateHero({ idea, onIdeaChange, ideaRef }: {
  idea: string;
  onIdeaChange: (v: string) => void;
  ideaRef: RefObject<HTMLTextAreaElement>;
}) {
  const navigate = useNavigate();
  const [backend, setBackend] = useState<Backend>('kling');
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [durationMode, setDurationMode] = useState<'auto' | 'custom'>('auto');
  const [customS, setCustomS] = useState(12);
  const touched = useRef(false);
  const hydrated = useRef(false);

  // Server-side defaults seed the controls once — never overriding a choice already made.
  const defaults = useQuery({ queryKey: ['defaults'], queryFn: api.defaults });
  useEffect(() => {
    const d = defaults.data;
    if (!d || hydrated.current || touched.current) return;
    hydrated.current = true;
    if (d.backend === 'kling' || d.backend === 'seedance') setBackend(d.backend);
    if (d.aspect === '9:16' || d.aspect === '16:9' || d.aspect === '1:1') setAspect(d.aspect);
  }, [defaults.data]);

  // Cast picker — starring is free (no cost tags). Zero profiles renders nothing at all.
  const charactersQuery = useQuery({ queryKey: ['cast-characters'], queryFn: api.characters });
  const [castSlugs, setCastSlugs] = useState<string[]>([]);
  const characters = charactersQuery.data?.characters ?? [];
  const selectedCast = characters.filter((c) => castSlugs.includes(c.slug));
  const selectedNoRefs = selectedCast.filter((c) => c.refs.length === 0);
  const toggleCast = (slug: string) =>
    setCastSlugs((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));

  const create = useMutation({
    mutationFn: api.createRun,
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });

  // Autogrow 1–3 rows; beyond that the textarea scrolls.
  useEffect(() => {
    const el = ideaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 3 * 21 + 24)}px`;
  }, [idea, ideaRef]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = idea.trim();
    if (!trimmed || create.isPending) return;
    create.mutate({
      idea: trimmed,
      backend,
      aspect,
      durationS: durationMode === 'custom' && Number.isFinite(customS) ? clampDuration(customS) : null,
      ...(castSlugs.length ? { cast: castSlugs } : {}),
    });
  };

  const onIdeaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <section className="mx-auto w-full max-w-[720px] pt-8" aria-label="Create a new run">
      <h1 className="text-center text-display text-ink">Start with one line.</h1>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-5">
        <textarea
          ref={ideaRef}
          rows={1}
          value={idea}
          onChange={(e) => onIdeaChange(e.target.value)}
          onKeyDown={onIdeaKeyDown}
          placeholder="a lighthouse keeper watching a storm roll in at dusk…"
          aria-label="Your idea, in one line"
          className="w-full resize-none overflow-hidden rounded-r3 border border-line-strong bg-surface-1 px-4 py-3 text-body text-ink placeholder:text-ink-faint"
        />

        {characters.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-muted">Starring</span>
            <div role="group" aria-label="Starring" className="flex flex-wrap items-center gap-1.5">
              {characters.map((c) => {
                const selected = castSlugs.includes(c.slug);
                const refUrl = c.refs.find((r) => r.url)?.url;
                return (
                  <button
                    key={c.slug}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleCast(c.slug)}
                    className={clsx(
                      'inline-flex h-8 items-center gap-1.5 rounded-full border py-0 pl-1 pr-2.5 text-label transition-colors duration-[120ms]',
                      selected
                        ? 'border-accent bg-[var(--accent-soft)] text-ink'
                        : 'border-line bg-surface-1 text-ink-secondary hover:border-line-strong',
                    )}
                  >
                    {refUrl ? (
                      <img src={refUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
                    ) : (
                      <span
                        aria-hidden
                        className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-caption text-ink-secondary"
                      >
                        {initials(c.name)}
                      </span>
                    )}
                    {c.name}
                  </button>
                );
              })}
            </div>
            <span className="text-caption text-ink-muted">
              {selectedCast.length === 0
                ? 'Optional — star characters to build the plan around them.'
                : `${selectedCast.map((c) => c.name).join(' & ')} ★ — their profile, reference images and voice will guide the plan.`}
            </span>
            {selectedNoRefs.length > 0 && (
              <span className="text-caption text-status-warn">
                {`${selectedNoRefs.map((c) => c.name).join(' & ')} ${selectedNoRefs.length > 1 ? 'have' : 'has'} no reference images — their look will vary between shots.`}
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-muted">Backend</span>
            <SegmentedControl
              label="Render backend"
              value={backend}
              onChange={(v) => { touched.current = true; setBackend(v); }}
              segments={[
                { value: 'kling', label: 'Kling', hint: '≈ $0.11 per second' },
                { value: 'seedance', label: 'Seedance', hint: '≈ $0.14 per second at 480p' },
              ]}
            />
            <span className="tnum max-w-[260px] text-caption text-ink-muted">{BACKEND_HINT[backend]}</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-muted">Aspect</span>
            <div role="radiogroup" aria-label="Aspect ratio" className="flex items-stretch gap-1">
              {ASPECT_TILES.map((t) => {
                const selected = aspect === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={t.value}
                    onClick={() => { touched.current = true; setAspect(t.value); }}
                    className={clsx(
                      'flex h-16 w-14 flex-col items-center justify-center gap-1.5 rounded-r2 transition-colors duration-[120ms]',
                      selected ? 'bg-surface-2' : 'hover:bg-surface-2',
                    )}
                  >
                    <span
                      aria-hidden
                      className={clsx(
                        'rounded-[3px] border',
                        t.shape,
                        selected ? 'border-accent bg-[var(--accent-soft)] ring-2 ring-accent' : 'border-line-strong bg-surface-3',
                      )}
                    />
                    <span className={clsx('tnum text-caption', selected ? 'text-ink' : 'text-ink-muted')}>{t.value}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-muted">Duration</span>
            <div className="flex items-center gap-2">
              <SegmentedControl
                label="Duration"
                value={durationMode}
                onChange={setDurationMode}
                segments={[{ value: 'auto', label: 'Auto' }, { value: 'custom', label: 'Custom' }]}
              />
              {durationMode === 'custom' && (
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min={3}
                    max={120}
                    value={Number.isFinite(customS) ? customS : ''}
                    onChange={(e) => setCustomS(e.target.valueAsNumber)}
                    aria-label="Duration in seconds"
                    className="tnum h-8 w-16 rounded-r2 border border-line-strong bg-surface-1 px-2 text-label text-ink"
                  />
                  <span className="text-label text-ink-muted" aria-hidden>s</span>
                </span>
              )}
            </div>
            {durationMode === 'auto' && (
              <span className="text-caption text-ink-muted">the engine decides from the story</span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 pt-1">
          <Button type="submit" variant="primary" size="lg" loading={create.isPending} disabled={!idea.trim()}>
            Plan it
          </Button>
          <p className="text-caption text-ink-muted" aria-live="polite">
            Planning costs only your LLM usage (varies by provider, model and plan — typically small). You&rsquo;ll see the render price before anything spends more.
          </p>
          {create.isError && (
            <p role="alert" className="text-caption text-status-failed">
              {create.error instanceof ApiClientError
                ? `${create.error.message} — ${create.error.hint}`
                : 'Something went wrong — please try again.'}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
