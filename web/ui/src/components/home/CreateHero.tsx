// The create hero: one line in, a planned film out. Planning costs only LLM usage, so the primary button
// carries no cost tag — the price conversation happens on the run page, before any render.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Mountain } from 'lucide-react';
import type { Aspect, Backend } from '../../../../shared/api-types';
import {
  ALL_BACKENDS, MODEL_IDS, aspectsFor, backendIdFor, canonicalBackendFor, castLimitFor,
  modelIdFor, modelLabelFor, modelSegmentLabelFor, providerIdFor, providerLabelFor, providersFor,
} from '../../../../shared/render-models';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';

// One hint per canonical `<model>@<provider>` id — the price is a property of the PAIR, not of the
// model: the same Seedance renders on two bills. Copy only; every number below is a rate somebody
// publishes, and a pair whose rate nobody publishes says exactly that (SEGMIND_HINT) instead of
// borrowing its sibling's figure or pretending the render is free.
const BACKEND_HINT: Record<string, string> = {
  'kling-o3@fal': 'Kling renders the richest motion at roughly $0.11 per second (~720p — approving can upscale the final to 1080p).',
  'seedance-2.0@fal': 'Seedance lip-syncs to your voice clips and renders at 480p for roughly $0.14 per second — approving can upscale the final to 1080p.',
  'seedance-2.5@fal': 'Seedance 2.5 takes up to four starring characters and renders 720p at roughly $0.47 per second (roughly $0.22 at 480p).',
};
// Segmind publishes no per-second rate for the models we drive, so no figure can be quoted honestly.
const SEGMIND_HINT = 'Segmind publishes no per-second rate for this model, so the price is not on file yet — the render still costs money, and the run page will say so rather than guess a figure.';
const hintFor = (backend: Backend) =>
  BACKEND_HINT[canonicalBackendFor(backend)]
  ?? (providerIdFor(backend) === 'segmind'
    ? SEGMIND_HINT
    : `${modelLabelFor(backend)} — you’ll see its render price on the run page, before anything spends.`);

// The models on offer, straight from the registry and in its order: a model with no provider entry
// cannot render, so it is not offered at all. Adding a model or a provider is a registry edit.
const MODEL_SEGMENTS: { value: string; label: string }[] = MODEL_IDS
  .filter((id) => providersFor(id).length > 0)
  .map((id) => ({ value: id, label: modelSegmentLabelFor(id) }));

/** A model on its first provider — the pair a fresh pick lands on. */
const firstBackendOf = (model: string): Backend => backendIdFor(model, providersFor(model)[0]!.id);
/** The registry's first renderable pair: what the page starts on until a saved default hydrates. */
const DEFAULT_BACKEND: Backend = firstBackendOf(MODEL_SEGMENTS[0]!.value);

// Tile silhouette per ratio — a lookup, not a list: which ratios are *offered* is per model
// (aspectsFor(backend)), this only says what each one looks like.
const ASPECT_SHAPE: Record<Aspect, string> = {
  '9:16': 'h-8 w-[18px]',
  '16:9': 'h-[18px] w-8',
  '1:1': 'h-6 w-6',
  '4:3': 'h-6 w-8',
  '3:4': 'h-8 w-6',
  '21:9': 'h-[15px] w-[35px]',
};

// ── per-model rules, all sourced from the registry (never restated here) ──────────────────────────
/** How many characters this backend's model can star. */
export const castCapFor = (backend: string): number => castLimitFor(backend);
/** The ratios this backend's model renders, in menu order. */
export const aspectsForBackend = (backend: string): Aspect[] => aspectsFor(backend);
export { modelLabelFor };
/** Keeps the FIRST N starred slugs — a trim is predictable, and the earliest pick is the deliberate one. */
export const trimCast = (slugs: string[], backend: string): string[] => slugs.slice(0, castCapFor(backend));
/** Keeps a ratio the model can render, else falls back to its first (its default). */
export const trimAspect = (aspect: string, backend: string): Aspect => {
  const offered = aspectsForBackend(backend);
  return offered.includes(aspect as Aspect) ? (aspect as Aspect) : offered[0]!;
};

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

const clampDuration = (n: number) => Math.min(120, Math.max(3, Math.round(n)));

export function CreateHero({ idea, onIdeaChange, ideaRef }: {
  idea: string;
  onIdeaChange: (v: string) => void;
  ideaRef: RefObject<HTMLTextAreaElement>;
}) {
  const navigate = useNavigate();
  // ONE canonical `<model>@<provider>` string is the whole selection — the two controls below are two
  // views of it, and it is what the POST carries, so nothing downstream ever sees a pair.
  const [backend, setBackend] = useState<Backend>(DEFAULT_BACKEND);
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [durationMode, setDurationMode] = useState<'auto' | 'custom'>('auto');
  const [customS, setCustomS] = useState(12);
  const [trimNote, setTrimNote] = useState<string | null>(null); // what a model switch had to drop
  const touched = useRef(false);
  const hydrated = useRef(false);

  const castCap = castCapFor(backend);
  const modelLabel = modelLabelFor(backend);
  const offeredAspects = aspectsForBackend(backend);
  const model = modelIdFor(backend);
  const provider = providerIdFor(backend);
  const providerOptions = providersFor(model);

  // Server-side defaults seed the controls once — never overriding a choice already made. Both values
  // are validated against the registry rather than a hardcoded list, so a default of 'seedance-2.0@fal'
  // or (once a model offers it) '4:3' hydrates, and a ratio that model cannot render is trimmed.
  const defaults = useQuery({ queryKey: ['defaults'], queryFn: api.defaults });
  useEffect(() => {
    const d = defaults.data;
    if (!d || hydrated.current || touched.current) return;
    hydrated.current = true;
    // A saved default may be a legacy one-word id; the picker works in canonical pairs, so it is
    // canonicalized here — the segment AND the provider then light up from the same string.
    const nextBackend = ALL_BACKENDS.includes(d.backend as Backend) ? canonicalBackendFor(d.backend) : backend;
    const nextAspect = aspectsForBackend(nextBackend).includes(d.aspect as Aspect)
      ? (d.aspect as Aspect)
      : trimAspect(aspect, nextBackend);
    if (nextBackend !== backend) setBackend(nextBackend);
    if (nextAspect !== aspect) setAspect(nextAspect);
  }, [defaults.data]);

  // Cast picker — starring is free (no cost tags). Zero profiles renders nothing at all. Every model
  // has its own ceiling (reference-image slots are finite), enforced here so the pick can never be
  // one the engine and POST /api/runs would refuse.
  const charactersQuery = useQuery({ queryKey: ['cast-characters'], queryFn: api.characters });
  const [castSlugs, setCastSlugs] = useState<string[]>([]);
  const characters = charactersQuery.data?.characters ?? [];
  const selectedCast = characters.filter((c) => castSlugs.includes(c.slug));
  const selectedNoRefs = selectedCast.filter((c) => c.refs.length === 0);
  const nameOf = (slug: string) => characters.find((c) => c.slug === slug)?.name ?? slug;
  const atCastCap = castSlugs.length >= castCap;
  const capTitle = `${modelLabel} renders up to ${castCap} starring character${castCap > 1 ? 's' : ''} — unstar one to swap.`;
  const toggleCast = (slug: string) => {
    setTrimNote(null); // the note reports the last switch — a fresh pick supersedes it
    setCastSlugs((prev) => {
      if (prev.includes(slug)) return prev.filter((s) => s !== slug);
      return prev.length >= castCap ? prev : [...prev, slug]; // at the cap the pill is disabled too
    });
  };

  // Switching the model OR the provider re-applies the new pair's limits to what is already picked and
  // says what it dropped — one status line for both trims, so the user never submits something the
  // server will 400. Caps and ratios are per (model, provider), so a provider switch trims too.
  const chooseBackend = (next: Backend) => {
    touched.current = true;
    setBackend(next);
    const keptCast = trimCast(castSlugs, next);
    const dropped = castSlugs.slice(keptCast.length);
    const nextAspect = trimAspect(aspect, next);
    // Name the PAIR when the model runs in more than one place — "Seedance 2.0 does not render 21:9"
    // would be a lie about the model; it is this provider's endpoint that cannot.
    const label = providersFor(next).length > 1
      ? `${modelLabelFor(next)} on ${providerLabelFor(next)}`
      : modelLabelFor(next);
    const cap = castCapFor(next);
    const notes = [
      dropped.length
        ? `${label} stars up to ${cap} character${cap > 1 ? 's' : ''} — unstarred ${dropped.map(nameOf).join(' & ')}.`
        : '',
      nextAspect !== aspect ? `${label} does not render ${aspect} — switched the aspect to ${nextAspect}.` : '',
    ].filter(Boolean);
    if (dropped.length) setCastSlugs(keptCast);
    if (nextAspect !== aspect) setAspect(nextAspect);
    setTrimNote(notes.join(' ') || null);
  };
  // Keep the provider across a model switch when the new model runs there too; backendIdFor falls
  // back to the model's first provider when it does not (picking Kling after Segmind lands on fal).
  const chooseModel = (nextModel: string) => chooseBackend(backendIdFor(nextModel, provider));
  const chooseProvider = (nextProvider: string) => chooseBackend(backendIdFor(model, nextProvider));

  // "Set in" picker — a single environment anchors the plan's look. Zero environments renders nothing.
  const environmentsQuery = useQuery({ queryKey: ['environments'], queryFn: api.environments });
  const environments = environmentsQuery.data?.environments ?? [];
  const [envSlug, setEnvSlug] = useState<string | null>(null);
  const selectedEnv = environments.find((e) => e.slug === envSlug) ?? null;
  // single-select: clicking the selected chip again clears the whole selection
  const selectEnv = (slug: string) => setEnvSlug((prev) => (prev === slug ? null : slug));

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
      // derived from the LIVE list, not raw envSlug state — an environment deleted while Home is
      // mounted drops out of the payload instead of 400-ing every submit until a reload
      ...(selectedEnv ? { environment: selectedEnv.slug } : {}),
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
            <span className="text-caption font-medium text-ink-muted">{`Starring — up to ${castCap} for ${modelLabel}`}</span>
            <div role="group" aria-label="Starring" className="flex flex-wrap items-center gap-1.5">
              {characters.map((c) => {
                const selected = castSlugs.includes(c.slug);
                const capped = !selected && atCastCap; // selected pills stay clickable — swapping must work
                const refUrl = c.refs.find((r) => r.url)?.url;
                return (
                  <button
                    key={c.slug}
                    type="button"
                    aria-pressed={selected}
                    disabled={capped}
                    title={capped ? capTitle : undefined}
                    onClick={() => toggleCast(c.slug)}
                    className={clsx(
                      'inline-flex h-8 items-center gap-1.5 rounded-full border py-0 pl-1 pr-2.5 text-label transition-colors duration-[120ms]',
                      selected
                        ? 'border-accent bg-[var(--accent-soft)] text-ink'
                        : 'border-line bg-surface-1 text-ink-secondary hover:border-line-strong',
                      capped && 'cursor-not-allowed opacity-45 hover:border-line',
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

        {environments.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-muted">Set in</span>
            <div role="radiogroup" aria-label="Set in" className="flex max-h-[76px] flex-wrap gap-1.5 overflow-y-auto">
              {environments.map((e) => {
                const selected = envSlug === e.slug;
                return (
                  <button
                    key={e.slug}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => selectEnv(e.slug)}
                    className={clsx(
                      'inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 py-0 text-label transition-colors duration-[120ms]',
                      selected
                        ? 'border-accent bg-[var(--accent-soft)] text-ink'
                        : 'border-line bg-surface-1 text-ink-secondary hover:border-line-strong',
                    )}
                  >
                    <Mountain size={14} aria-hidden className={selected ? 'text-accent' : 'text-ink-muted'} />
                    {e.name}
                  </button>
                );
              })}
            </div>
            <span className="text-caption text-ink-muted">
              {!selectedEnv
                ? 'Optional — pick an environment to anchor the plan’s look.'
                : selectedCast.length > 0
                  ? `Set in ${selectedEnv.name} — steers the world; ${selectedCast.map((c) => c.name).join(' & ')}’s own world notes take a back seat.`
                  : `${selectedEnv.name} — its mood, light and palette will guide every shot.`}
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <div className="flex flex-col gap-1.5">
            {/* The control picks a MODEL; its accessible name stays "Render backend" because that is
                what the pair it forms with the provider below actually sets. */}
            <span className="text-caption font-medium text-ink-muted">Model</span>
            <SegmentedControl
              label="Render backend"
              value={model}
              onChange={chooseModel}
              segments={MODEL_SEGMENTS}
            />
            <span data-testid="backend-hint" className="tnum max-w-[260px] text-caption text-ink-muted">{hintFor(backend)}</span>
            {trimNote && (
              <span role="status" className="max-w-[260px] text-caption text-status-warn">{trimNote}</span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-muted">Provider</span>
            {providerOptions.length > 1 ? (
              <SegmentedControl
                label="Provider"
                value={provider}
                onChange={chooseProvider}
                segments={providerOptions.map((p) => ({ value: p.id, label: p.label }))}
              />
            ) : (
              // One place to render it: say so rather than showing a dead control or, worse, an
              // option that would post a backend nothing in this build can render.
              <span className="text-caption text-ink-muted">
                {`${modelLabel} runs on ${providerOptions[0]!.label} only.`}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-muted">Aspect</span>
            <div role="radiogroup" aria-label="Aspect ratio" className="flex items-stretch gap-1">
              {offeredAspects.map((ratio) => {
                const selected = aspect === ratio;
                return (
                  <button
                    key={ratio}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={ratio}
                    onClick={() => { touched.current = true; setTrimNote(null); setAspect(ratio); }}
                    className={clsx(
                      'flex h-16 w-14 flex-col items-center justify-center gap-1.5 rounded-r2 transition-colors duration-[120ms]',
                      selected ? 'bg-surface-2' : 'hover:bg-surface-2',
                    )}
                  >
                    <span
                      aria-hidden
                      className={clsx(
                        'rounded-[3px] border',
                        ASPECT_SHAPE[ratio],
                        selected ? 'border-accent bg-[var(--accent-soft)] ring-2 ring-accent' : 'border-line-strong bg-surface-3',
                      )}
                    />
                    <span className={clsx('tnum text-caption', selected ? 'text-ink' : 'text-ink-muted')}>{ratio}</span>
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
