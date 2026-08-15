// Step 4 — the default render backend. One honest card per (model, provider) pair the registry can
// render, and the caption reminds that this is only a default, changeable per run. The cards are
// DERIVED: adding a provider to src/lib/render-models.js puts a card here with no edit to this file
// (StepBackend.test.tsx pins that). The screen makes exactly TWO claims of its own — the shipped
// default, and which pair currently quotes the lowest per-second estimate — and the second is
// computed from the same rate table the cards print, never assigned to a favourite vendor.
import type { Dispatch } from 'react';
import clsx from 'clsx';
import type { Backend } from '../../../../shared/api-types';
import {
  MODEL_IDS, aspectsFor, backendIdFor, canonicalBackendFor, capsFor, castLimitFor,
  modelLabelFor, providersFor, resolutionsFor,
} from '../../../../shared/render-models';
import { FixFooter } from './FixFooter';
// The tier rule, the money sentence and the lowest-rate arithmetic live in the sibling lib because
// the presets step must quote the SAME figure in the SAME words one screen later.
import { lowestRateId, rateLabel, tierFor } from './rates';
import type { WizardAction, WizardState } from './wizard';

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

// The shipped default: RENDER_BACKEND unset means the first model on its first provider (config.js).
const DEFAULT_BACKEND = CARDS[0]!.id;

/** The wizard's state may still hold a legacy one-word id; cards are keyed by canonical pairs. */
const selectedId = (backend: string): string => {
  try { return canonicalBackendFor(backend); } catch { return backend; }
};

export function StepBackend({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const current = selectedId(state.backend);
  // Inside the component, never at module scope: state.resolution moves the answer (Kling's flat
  // rate sits under Seedance-on-Segmind's once the wizard holds 720p), so a module-level constant
  // would freeze a claim about money at import time.
  const lowest = lowestRateId(CARDS.map((c) => c.id), state.resolution);
  return (
    <div>
      <h1 className="text-title text-ink">Pick a default render backend.</h1>
      <p className="mt-1 text-body text-ink-secondary">They all make good videos; they trade differently — and they bill differently. The lowest per-second estimate on this screen is marked.</p>

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
              {/* mt-auto pins the money line to the card's baseline: these figures exist to be
                  compared across the row, so they must stay on one line even when a card carries an
                  extra bullet (the Segmind seed-control one). The marker rides HERE, not the title
                  row — it is a claim about this number, and it must be read with it. */}
              <span className="mt-auto flex flex-wrap items-center gap-2 pt-3">
                <span className="tnum text-caption text-ink-muted">{rateLabel(b.id, tier)}</span>
                {/* Same pill chrome as Default/provider, differentiated by weight and ink only: not
                    status-done (green means finished) and not accent (it would collide with the
                    selected card's own fill). Plain text, so it correctly joins the radio's
                    accessible name instead of an aria-label REPLACING the rate for screen readers. */}
                {b.id === lowest && (
                  <span className="rounded-full bg-surface-3 px-1.5 py-px text-caption font-medium text-ink">Lowest rate</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-caption text-ink-muted">You can change this per run. Where a model has tiers, these rates follow the resolution you pick next.</p>

      <FixFooter state={state} dispatch={dispatch} canContinue={true} scope="backend" />
    </div>
  );
}
