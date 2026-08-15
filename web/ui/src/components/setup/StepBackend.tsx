// Step 4 — the default render backend. One honest card per (model, provider) pair the registry can
// render; no winner is implied beyond the shipped default, and the caption reminds that this is only
// a default, changeable per run. The cards are DERIVED: adding a provider to src/lib/render-models.js
// puts a card here with no edit to this file (StepBackend.test.tsx pins that).
import type { Dispatch } from 'react';
import clsx from 'clsx';
import type { Backend, Resolution } from '../../../../shared/api-types';
import {
  MODEL_IDS, aspectsFor, backendIdFor, canonicalBackendFor, capsFor, castLimitFor, defaultResolutionFor,
  modelLabelFor, providersFor, resolutionsFor,
} from '../../../../shared/render-models';
import { perSecondUsdFor } from '../../../../shared/render-rates';
import { usd } from '../../lib/format';
import { FixFooter } from './FixFooter';
import type { WizardAction, WizardState } from './wizard';

// No rate is written here. Every figure on a card is read from the estimator's own table
// (web/shared/render-rates.ts → web/server/lib/prices.json), at the tier that card would render at,
// for two reasons: the price is a property of the PAIR (the same Seedance costs about half as much
// on Segmind as on fal) AND of the TIER (Seedance bills per pixel, so 4k is eleven times 480p), and
// a hand-copied figure is wrong the day a vendor moves a price with nothing to catch it. A pair the
// table does not price says so — it never inherits a sibling's figure, and it is never called free,
// because the render does cost money. Every pair the registry ships is priced today, so
// RATE_UNKNOWN is the fallback for the NEXT provider added, not dead code.
const RATE_UNKNOWN = 'rate not on file yet — the render still costs money';

// What each MODEL is good at, in plain words. Numbers never live here: the cap, the ratio count and
// the tier ladder on each card are read from the registry below.
const POINTS: Record<string, string> = {
  'kling-o3': 'Multi-shot storyboards from one plan, per-character minted voices',
  'seedance-2.0': 'One rich prompt per job, lip-sync from your voice clips',
  'seedance-2.5': 'Longer jobs and richer reference sets',
};

interface Card { id: Backend; model: string; name: string; provider: string; points: string[] }

const CARDS: Card[] = MODEL_IDS.flatMap((model) =>
  providersFor(model).map((p) => {
    const id = backendIdFor(model, p.id);
    const cap = castLimitFor(model);
    const tiers = resolutionsFor(id);
    return {
      id,
      model,
      name: modelLabelFor(model),
      provider: p.label,
      points: [
        POINTS[model] ?? `Renders on ${p.label}`,
        `Stars up to ${cap} character${cap > 1 ? 's' : ''} · ${aspectsFor(id).length} aspect ratios · `
          + (tiers.length ? `renders ${tiers.join(' / ')}` : 'renders the endpoint’s own output'),
        // Read off the PAIR's caps, not the model's: the same Seedance offers this on one queue and
        // not the other, so the model-keyed POINTS map above would print it on cards where the
        // re-render dialog shows no such control. A fact worth knowing BEFORE picking a provider —
        // it is the difference between fixing a clip you nearly like and rolling for another one.
        ...(capsFor(id).seedControl ? ['Segment re-renders can reuse a clip’s seed for a targeted fix'] : []),
      ],
    };
  }));

/** The tier this card would render at if it were picked — the SAME precedence its click applies
 *  below (keep a tier the model offers, else fall to that model's own default). The quoted rate and
 *  the patch therefore cannot describe different renders. */
const tierFor = (id: Backend, picked: Resolution | null): Resolution | null =>
  (picked && resolutionsFor(id).includes(picked) ? picked : defaultResolutionFor(id) ?? null);

/** What a card says about money: the estimate's own rate at the tier above, naming that tier so the
 *  figure can never be read as applying to another one. */
const rateLabel = (id: Backend, tier: Resolution | null): string => {
  const rate = perSecondUsdFor(id, tier);
  return rate === null ? RATE_UNKNOWN : `≈ ${usd(rate)}/s est${tier ? ` at ${tier}` : ''}`;
};

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
          // Resolved once per card and used by BOTH the quote and the patch below.
          const tier = tierFor(b.id, state.resolution);
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
                // slug says nothing about a bad SEGMIND_SEEDANCE20_SLUG. A resolution off the new
                // model's ladder trims to that model's default, and a ratio the new pair cannot
                // render trims to its first — the presets step must never carry (and buildUpdates
                // never write) a tier or an aspect the chosen backend cannot render. Same rule the
                // create hero and the Settings defaults card apply on their own model switch.
                patch: {
                  backend: b.id,
                  ...(b.id !== state.backend ? { segmindCheck: { state: 'idle' as const } } : {}),
                  ...(aspectsFor(b.id).includes(state.aspect) ? {} : { aspect: aspectsFor(b.id)[0]! }),
                  ...(tier === state.resolution ? {} : { resolution: tier }),
                },
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
              {/* mt-auto pins the rate to the card's baseline: these figures exist to be compared
                  across the row, so they must stay on one line even when a card carries an extra
                  bullet (the Segmind seed-control one). */}
              <span className="tnum mt-auto pt-3 text-caption text-ink-muted">{rateLabel(b.id, tier)}</span>
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-caption text-ink-muted">You can change this per run.</p>

      <FixFooter state={state} dispatch={dispatch} canContinue={true} scope="backend" />
    </div>
  );
}
