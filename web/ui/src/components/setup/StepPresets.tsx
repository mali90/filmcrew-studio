// Step 5 — default aspect + resolution. Both offer the CHOSEN backend's own list: aspect reads as
// shaped tiles (aspectsFor — six ratios on Seedance 2.5 and on 2.0@segmind, three elsewhere),
// resolution as a segmented control over that model's ladder (2.5 is 480p/720p; Kling has none),
// saved to that model's own .env knob (wizard buildUpdates). Both are just defaults for the create
// form.
import type { Dispatch } from 'react';
import clsx from 'clsx';
import type { Aspect } from '../../../../shared/api-types';
import { aspectsFor, capsFor, modelLabelFor, resolutionsFor } from '../../../../shared/render-models';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import type { WizardAction, WizardState } from './wizard';

// Silhouette + what each ratio is FOR — a lookup, not the list: WHICH ratios are offered is the
// selected backend's business (the backend card one step back advertises that same count), and a
// hard-coded three-tile list meant a 2.5 user could not save 4:3, 3:4 or 21:9 during setup at all.
const ASPECT_TILES: Record<Aspect, { shape: string; note: string }> = {
  '9:16': { shape: 'h-9 w-[20px]', note: 'Reels, Shorts, TikTok' },
  '16:9': { shape: 'h-[20px] w-9', note: 'YouTube, landscape' },
  '1:1': { shape: 'h-7 w-7', note: 'Feeds, square' },
  '4:3': { shape: 'h-[27px] w-9', note: 'Classic, TV' },
  '3:4': { shape: 'h-9 w-[27px]', note: 'Portrait, print' },
  '21:9': { shape: 'h-[15px] w-9', note: 'Cinematic, ultrawide' },
};

export function StepPresets({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  return (
    <div>
      <h1 className="text-title text-ink">Set your usual format.</h1>
      <p className="mt-1 text-body text-ink-secondary">
        These become the defaults on the create form; every run can override them.
      </p>

      <div className="mt-5">
        <span className="text-caption font-medium text-ink-muted">Aspect</span>
        {/* Three per row so a six-ratio model wraps to two rows instead of squeezing every tile
            past the point its note reads — a three-ratio model looks exactly as it always did. */}
        <div role="radiogroup" aria-label="Aspect ratio" className="mt-1.5 grid grid-cols-3 gap-2">
          {aspectsFor(state.backend).map((value) => {
            const tile = ASPECT_TILES[value];
            const selected = state.aspect === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={value}
                onClick={() => dispatch({ type: 'patch', patch: { aspect: value } })}
                className={clsx(
                  'flex h-24 flex-col items-center justify-center gap-2 rounded-r2 border transition-colors duration-[120ms]',
                  selected ? 'border-accent bg-[var(--accent-soft)]' : 'border-line bg-surface-2 hover:border-line-strong',
                )}
              >
                <span
                  aria-hidden
                  className={clsx(
                    'rounded-[3px] border',
                    tile.shape,
                    selected ? 'border-accent bg-surface-1' : 'border-line-strong bg-surface-3',
                  )}
                />
                <span className={clsx('tnum text-caption', selected ? 'text-ink' : 'text-ink-muted')}>{value}</span>
                <span className="text-caption text-ink-faint">{tile.note}</span>
              </button>
            );
          })}
        </div>
      </div>


      {resolutionsFor(state.backend).length === 0 ? (
        <div className="mt-6">
          <span className="text-caption font-medium text-ink-muted">Resolution</span>
          <p className="mt-1.5 text-caption text-ink-faint">
            {modelLabelFor(state.backend)} renders at the endpoint’s own output — there is no tier to
            pick. Approving the finished video can still upscale it to 1080p.
          </p>
        </div>
      ) : (
      <div className="mt-6">
        <span className="text-caption font-medium text-ink-muted">Resolution</span>
        <div className="mt-1.5">
          <SegmentedControl
            label="Default resolution"
            value={state.resolution ?? resolutionsFor(state.backend)[0]!}
            onChange={(resolution) => dispatch({ type: 'patch', patch: { resolution } })}
            segments={resolutionsFor(state.backend).map((r) => ({ value: r, label: r }))}
          />
        </div>
        <p className="mt-1.5 text-caption text-ink-faint">
          {capsFor(state.backend).family === 'seedance'
            ? `${modelLabelFor(state.backend)}’s own tiers — Seedance bills per pixel, so higher tiers cost more per second. Approving a finished video can upscale it to 1080p.`
            : `${modelLabelFor(state.backend)}’s own tiers, billed at one flat per-second rate. Approving a finished video can upscale it to 1080p.`}
        </p>
      </div>
      )}

      <div className="mt-8 flex justify-end">
        <Button variant="primary" size="lg" onClick={() => dispatch({ type: 'next' })}>Continue</Button>
      </div>
    </div>
  );
}
