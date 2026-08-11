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
});
