// The wizard's format-defaults step. WHICH ratios it offers is the chosen backend's business
// (aspectsFor), exactly as the create hero and the Settings defaults card already are: the backend
// card one step back advertises six ratios for Seedance 2.5 and for 2.0 on Segmind, and a static
// three-tile list here meant a first run could not save 4:3, 3:4 or 21:9 at all.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ALL_BACKENDS, aspectsFor } from '../../../../shared/render-models';
import { StepPresets } from './StepPresets';
import { initialWizardState, type WizardState } from './wizard';

function renderStep(over: Partial<WizardState> = {}) {
  const dispatch = vi.fn();
  const { unmount } = render(<StepPresets state={{ ...initialWizardState, ...over }} dispatch={dispatch} />);
  return { dispatch, unmount, group: screen.getByRole('radiogroup', { name: 'Aspect ratio' }) };
}

const ratiosIn = (group: HTMLElement) =>
  within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'));

describe('StepPresets — the aspect tiles are the selected backend\'s own ratios', () => {
  it.each(ALL_BACKENDS)('offers exactly what %s renders, in registry order', (backend) => {
    const { group } = renderStep({ backend });
    expect(ratiosIn(group)).toEqual(aspectsFor(backend));
  });

  it('a six-ratio model really shows the three the old static list could not', () => {
    const { group, unmount } = renderStep({ backend: 'seedance-2.5@fal' });
    for (const ratio of ['4:3', '3:4', '21:9']) expect(ratiosIn(group)).toContain(ratio);
    unmount();
    // …and the three-ratio models are unchanged — this is a per-model list, not a longer one.
    const { group: kling } = renderStep({ backend: 'kling' });
    expect(ratiosIn(kling)).toEqual(['16:9', '9:16', '1:1']);
  });

  it('saves a ratio only the six-ratio endpoints render', async () => {
    const { dispatch, group } = renderStep({ backend: 'seedance-2.0@segmind' });
    await userEvent.click(within(group).getByRole('radio', { name: '21:9' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'patch', patch: { aspect: '21:9' } });
  });

  it('every offered ratio ships a silhouette and a plain-word note', () => {
    // The tiles are DERIVED from the registry, so a ratio added to a model without an entry in
    // ASPECT_TILES would render an unlabelled box (or throw). Fail here instead.
    for (const backend of ALL_BACKENDS) {
      const { unmount } = render(<StepPresets state={{ ...initialWizardState, backend }} dispatch={vi.fn()} />);
      const group = screen.getByRole('radiogroup', { name: 'Aspect ratio' });
      for (const tile of within(group).getAllByRole('radio')) {
        const ratio = tile.getAttribute('aria-label')!;
        expect(tile.querySelector('[aria-hidden]')).not.toBeNull();
        expect((tile.textContent ?? '').replace(ratio, '').trim()).not.toBe('');
      }
      unmount();
    }
  });
});
