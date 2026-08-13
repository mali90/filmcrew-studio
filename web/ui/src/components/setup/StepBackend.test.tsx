// The wizard's default-backend step. Its cards are DERIVED from src/lib/render-models.js — one per
// (model, provider) pair the build can render — so a new provider needs no edit here, and the money
// copy is honest per pair: a published rate is quoted, an unpublished one says so and quotes nothing.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../ui/Toast';
import { StepBackend } from './StepBackend';
import { initialWizardState, type WizardState } from './wizard';
import { BACKEND_IDS } from '../../../../../src/lib/render-models.js';

function renderStep(over: Partial<WizardState> = {}) {
  const dispatch = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <StepBackend state={{ ...initialWizardState, ...over }} dispatch={dispatch} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { dispatch, group: screen.getByRole('radiogroup', { name: 'Render backend' }) };
}

describe('StepBackend — the cards are the registry', () => {
  it('offers one card per renderable (model, provider) pair', () => {
    const { group } = renderStep();
    expect(within(group).getAllByRole('radio')).toHaveLength(BACKEND_IDS.length);
    for (const name of ['Kling 3.0 Omni', 'Seedance 2.0', 'Seedance 2.5']) {
      expect(within(group).getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(within(group).getAllByText('Segmind')).toHaveLength(
      BACKEND_IDS.filter((id: string) => id.endsWith('@segmind')).length,
    );
  });

  it('marks the shipped default, even when the state still holds the legacy one-word id', () => {
    const { group } = renderStep({ backend: 'kling' });
    const kling = within(group).getByRole('radio', { name: /Kling 3\.0 Omni/ });
    expect(kling).toHaveAttribute('aria-checked', 'true');
    expect(within(kling).getByText('Default')).toBeInTheDocument();
  });

  it('picking a card patches the canonical compound id and resets the model-scoped Segmind check', async () => {
    const { dispatch, group } = renderStep();
    await userEvent.click(within(group).getByRole('radio', { name: /Seedance 2\.5 Segmind/ }));
    // The segmindCheck reset rides along: validate-segmind probes the PICKED model's configured
    // slug, so a check that passed for one model says nothing about another's. The resolution trim
    // does too: the initial 1080p default is off 2.5's ladder (480p/720p), so the patch snaps it to
    // the new model's default — the presets step and buildUpdates must never hold a tier the chosen
    // backend cannot render.
    expect(dispatch).toHaveBeenCalledWith({
      type: 'patch',
      patch: { backend: 'seedance-2.5@segmind', segmindCheck: { state: 'idle' }, resolution: '720p' },
    });
  });

  it('a resolution the new model also renders survives the switch (no spurious trim)', async () => {
    const { dispatch, group } = renderStep({ resolution: '720p' });
    await userEvent.click(within(group).getByRole('radio', { name: /Seedance 2\.5 fal/ }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'patch',
      patch: { backend: 'seedance-2.5@fal', segmindCheck: { state: 'idle' } },
    });
  });

  it('an aspect the new pair cannot render trims to its first, like the tier does', async () => {
    // The presets step offers the SELECTED backend's ratios, so a 21:9 picked on 2.5 must not stay
    // selected after a switch to a three-ratio pair — it would be saved as KLING_ASPECT and every
    // run would start from a ratio the renderer refuses.
    const { dispatch, group } = renderStep({ backend: 'seedance-2.5@fal', aspect: '21:9', resolution: '720p' });
    await userEvent.click(within(group).getByRole('radio', { name: /Kling 3\.0 Omni fal/ }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'patch',
      patch: { backend: 'kling-o3@fal', segmindCheck: { state: 'idle' }, aspect: '16:9', resolution: null },
    });
  });

  it('a ratio the new pair also renders survives the switch (no spurious trim)', async () => {
    // The same MODEL can offer different ratios per provider (2.0 renders six on Segmind, three on
    // fal), so the trim asks the PAIR — and leaves a ratio both of them render alone.
    const { dispatch, group } = renderStep({ backend: 'seedance-2.5@fal', aspect: '9:16', resolution: '720p' });
    await userEvent.click(within(group).getByRole('radio', { name: /Seedance 2\.0 Segmind/ }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'patch',
      patch: { backend: 'seedance-2.0@segmind', segmindCheck: { state: 'idle' } },
    });
  });
});

describe('StepBackend — honest money copy', () => {
  it('quotes fal Seedance 2.5\'s real published rate', () => {
    const { group } = renderStep();
    const card = within(group).getByRole('radio', { name: /Seedance 2\.5 fal/ });
    expect(card).toHaveTextContent('$0.47');
  });

  it('quotes Segmind\'s real published rate — about half fal\'s for the same model', () => {
    const { group } = renderStep();
    expect(within(group).getByRole('radio', { name: /Seedance 2\.0 Segmind/ })).toHaveTextContent('$0.07');
    expect(within(group).getByRole('radio', { name: /Seedance 2\.5 Segmind/ })).toHaveTextContent('$0.24');
  });

  it('every card quotes a figure — no shipped pair is left saying "not on file"', () => {
    // The cards are DERIVED from the registry, so a provider added without a rate would silently
    // fall back to RATE_UNKNOWN and ship a card that quotes nothing. Fail here instead.
    const { group } = renderStep();
    for (const card of within(group).getAllByRole('radio')) {
      expect(card.textContent ?? '').toMatch(/\$\d/);
      expect(card).not.toHaveTextContent(/not on file/i);
      expect(card).not.toHaveTextContent(/\bfree\b/i);   // renders are never free, on any provider
    }
  });

  it('prices the PAIR, not the model — the same Seedance costs different money per provider', () => {
    const { group } = renderStep();
    const rateOf = (name: RegExp) =>
      /\$(\d+\.\d+)/.exec(within(group).getByRole('radio', { name }).textContent ?? '')?.[1];
    expect(rateOf(/Seedance 2\.5 Segmind/)).not.toEqual(rateOf(/Seedance 2\.5 fal/));
    expect(Number(rateOf(/Seedance 2\.5 Segmind/))).toBeLessThan(Number(rateOf(/Seedance 2\.5 fal/)));
  });

  // The tier is picked one step LATER (StepPresets), and the wizard can be walked backwards. A card
  // quoting the model's default tier while the wizard holds 4k is quoting a render this step will
  // not produce: clicking it KEEPS a tier the new model can render. So each card quotes the tier it
  // would actually render at — the same precedence its own click applies.
  it('quotes the tier the card would render at, not the model\'s default, once a tier is picked', () => {
    const { group } = renderStep({ backend: 'seedance-2.0@fal', resolution: '4k' });
    // 4k survives a click on 2.0, so 2.0's card must quote 4k money ($1.5552/s), not 480p's $0.14.
    const fal20 = within(group).getByRole('radio', { name: /Seedance 2\.0 fal/ });
    expect(fal20).toHaveTextContent('$1.56');
    expect(fal20).toHaveTextContent('4k');
    expect(fal20).not.toHaveTextContent('$0.14');
    // 2.5 has no 4k tier, so clicking it trims to 2.5's default (720p) — and the card says 720p money.
    expect(within(group).getByRole('radio', { name: /Seedance 2\.5 fal/ })).toHaveTextContent('$0.47');
    // Kling has no ladder at all: its endpoint's own output, one flat rate, no tier to name.
    expect(within(group).getByRole('radio', { name: /Kling 3\.0/ })).toHaveTextContent('$0.11');
  });
});
