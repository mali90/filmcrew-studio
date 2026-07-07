// Step 4 — the default render backend. Two honest comparison cards; no winner is implied beyond
// the shipped default, and the caption reminds that this is only a default, changeable per run.
import type { Dispatch } from 'react';
import clsx from 'clsx';
import type { Backend } from '../../../../shared/api-types';
import { FixFooter } from './FixFooter';
import type { WizardAction, WizardState } from './wizard';

const BACKENDS: { id: Backend; name: string; tag?: string; rate: string; points: string[] }[] = [
  {
    id: 'kling',
    name: 'Kling 3.0 Omni',
    tag: 'Default',
    rate: '≈ $0.11/s est',
    points: [
      'Multi-shot storyboards from one plan',
      'Per-character minted voices',
    ],
  },
  {
    id: 'seedance',
    name: 'Seedance 2.0',
    rate: '≈ $0.14/s est at 480p',
    points: [
      'One rich prompt per job, lip-sync from your voice clips',
      'Renders 480p, approve upscales to 1080p · 4s minimum per job',
    ],
  },
];

export function StepBackend({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  return (
    <div>
      <h1 className="text-title text-ink">Pick a default render backend.</h1>
      <p className="mt-1 text-body text-ink-secondary">Both make good videos; they trade differently.</p>

      <div role="radiogroup" aria-label="Render backend" className="mt-5 grid grid-cols-2 gap-2">
        {BACKENDS.map((b) => {
          const selected = state.backend === b.id;
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => dispatch({ type: 'patch', patch: { backend: b.id } })}
              className={clsx(
                'flex flex-col items-start rounded-r2 border p-4 text-left transition-colors duration-[120ms]',
                selected ? 'border-accent bg-[var(--accent-soft)]' : 'border-line bg-surface-2 hover:border-line-strong',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-label text-ink">{b.name}</span>
                {b.tag && (
                  <span className="rounded-full bg-surface-3 px-1.5 py-px text-caption text-ink-muted">{b.tag}</span>
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
