// Step 4 — the default render backend. One honest card per (model, provider) pair the registry can
// render; no winner is implied beyond the shipped default, and the caption reminds that this is only
// a default, changeable per run. The cards are DERIVED: adding a provider to src/lib/render-models.js
// puts a card here with no edit to this file (StepBackend.test.tsx pins that).
import type { Dispatch } from 'react';
import clsx from 'clsx';
import type { Backend } from '../../../../shared/api-types';
import {
  MODEL_IDS, aspectsFor, backendIdFor, canonicalBackendFor, castLimitFor, modelLabelFor, providersFor,
} from '../../../../shared/render-models';
import { FixFooter } from './FixFooter';
import type { WizardAction, WizardState } from './wizard';

// Rates somebody PUBLISHES, keyed by the pair that is billed. A pair missing here has no published
// per-second rate (every Segmind model we drive): it says so — it never inherits a sibling's figure,
// and it is never called free, because the render does cost money.
const RATE: Record<string, string> = {
  'kling-o3@fal': '≈ $0.11/s est',
  'seedance-2.0@fal': '≈ $0.14/s est at 480p',
  'seedance-2.5@fal': '≈ $0.47/s est at 720p',
};
const RATE_UNKNOWN = 'rate not on file yet — the render still costs money';

// What each MODEL is good at, in plain words. Numbers never live here: the cap and the ratio count on
// each card are read from the registry below.
const POINTS: Record<string, string> = {
  'kling-o3': 'Multi-shot storyboards from one plan, per-character minted voices',
  'seedance-2.0': 'One rich prompt per job, lip-sync from your voice clips — renders 480p',
  'seedance-2.5': 'Longer jobs and richer reference sets — renders 480p or 720p',
};

interface Card { id: Backend; model: string; name: string; provider: string; points: string[]; rate: string }

const CARDS: Card[] = MODEL_IDS.flatMap((model) =>
  providersFor(model).map((p) => {
    const id = backendIdFor(model, p.id);
    const cap = castLimitFor(model);
    return {
      id,
      model,
      name: modelLabelFor(model),
      provider: p.label,
      points: [
        POINTS[model] ?? `Renders on ${p.label}`,
        `Stars up to ${cap} character${cap > 1 ? 's' : ''} · ${aspectsFor(id).length} aspect ratios · approve upscales to 1080p`,
      ],
      rate: RATE[id] ?? RATE_UNKNOWN,
    };
  }));

// The shipped default: RENDER_BACKEND unset means the first model on its first provider (config.js).
const DEFAULT_BACKEND = CARDS[0]!.id;

/** The wizard's state may still hold a legacy one-word id; cards are keyed by canonical pairs. */
const selectedId = (backend: string): string => {
  try { return canonicalBackendFor(backend); } catch { return backend; }
};

export function StepBackend({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const current = selectedId(state.backend);
  return (
    <div>
      <h1 className="text-title text-ink">Pick a default render backend.</h1>
      <p className="mt-1 text-body text-ink-secondary">They all make good videos; they trade differently — and they bill differently.</p>

      <div role="radiogroup" aria-label="Render backend" className="mt-5 grid grid-cols-2 gap-2">
        {CARDS.map((b) => {
          const selected = current === b.id;
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => dispatch({
                type: 'patch',
                // A Segmind validation is MODEL-scoped (validate-segmind probes the picked model's
                // configured slug), so switching cards resets it — a check that passed for the 2.5
                // slug says nothing about a bad SEGMIND_SEEDANCE20_SLUG.
                patch: { backend: b.id, ...(b.id !== state.backend ? { segmindCheck: { state: 'idle' as const } } : {}) },
              })}
              className={clsx(
                'flex flex-col items-start rounded-r2 border p-4 text-left transition-colors duration-[120ms]',
                selected ? 'border-accent bg-[var(--accent-soft)]' : 'border-line bg-surface-2 hover:border-line-strong',
              )}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-label text-ink">{b.name}</span>
                <span className="rounded-full bg-surface-3 px-1.5 py-px text-caption text-ink-muted">{b.provider}</span>
                {b.id === DEFAULT_BACKEND && (
                  <span className="rounded-full bg-surface-3 px-1.5 py-px text-caption text-ink-muted">Default</span>
                )}
              </span>
              <ul className="mt-2 space-y-1">
                {b.points.map((p) => (
                  <li key={p} className="text-caption text-ink-secondary">{p}</li>
                ))}
              </ul>
              <span className="tnum mt-3 text-caption text-ink-muted">{b.rate}</span>
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-caption text-ink-muted">You can change this per run.</p>

      <FixFooter state={state} dispatch={dispatch} canContinue={true} scope="backend" />
    </div>
  );
}
