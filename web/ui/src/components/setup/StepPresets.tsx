// Step 5 — default aspect + resolution. Aspect reads as shaped tiles; resolution is a segmented
// control. Both are just defaults for the create form.
import type { Dispatch } from 'react';
import clsx from 'clsx';
import type { Aspect } from '../../../../shared/api-types';
import { Button } from '../ui/Button';
import type { WizardAction, WizardState } from './wizard';

const ASPECT_TILES: { value: Aspect; shape: string; note: string }[] = [
  { value: '9:16', shape: 'h-9 w-[20px]', note: 'Reels, Shorts, TikTok' },
  { value: '16:9', shape: 'h-[20px] w-9', note: 'YouTube, landscape' },
  { value: '1:1', shape: 'h-7 w-7', note: 'Feeds, square' },
];

export function StepPresets({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  return (
    <div>
      <h1 className="text-title text-ink">Set your usual format.</h1>
      <p className="mt-1 text-body text-ink-secondary">
        These become the defaults on the create form; every run can override them.
      </p>

      <div className="mt-5">
        <span className="text-caption font-medium text-ink-muted">Aspect</span>
        <div role="radiogroup" aria-label="Aspect ratio" className="mt-1.5 flex items-stretch gap-2">
          {ASPECT_TILES.map((t) => {
            const selected = state.aspect === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t.value}
                onClick={() => dispatch({ type: 'patch', patch: { aspect: t.value } })}
                className={clsx(
                  'flex h-24 flex-1 flex-col items-center justify-center gap-2 rounded-r2 border transition-colors duration-[120ms]',
                  selected ? 'border-accent bg-[var(--accent-soft)]' : 'border-line bg-surface-2 hover:border-line-strong',
                )}
              >
                <span
                  aria-hidden
                  className={clsx(
                    'rounded-[3px] border',
                    t.shape,
                    selected ? 'border-accent bg-surface-1' : 'border-line-strong bg-surface-3',
                  )}
                />
                <span className={clsx('tnum text-caption', selected ? 'text-ink' : 'text-ink-muted')}>{t.value}</span>
                <span className="text-caption text-ink-faint">{t.note}</span>
              </button>
            );
          })}
        </div>
      </div>


      <div className="mt-8 flex justify-end">
        <Button variant="primary" size="lg" onClick={() => dispatch({ type: 'next' })}>Continue</Button>
      </div>
    </div>
  );
}
