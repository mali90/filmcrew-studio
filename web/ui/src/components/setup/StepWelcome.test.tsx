// The welcome page is the only surface whose provider facts live in PROSE, with nothing deriving
// them — which is exactly how it kept telling first-run users "fal.ai renders the clips" for two
// providers' worth of releases. This file is that missing derivation: the registry decides which
// vendors have to be named, and the copy has to name them.
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StepWelcome } from './StepWelcome';
import { PROVIDERS, RENDER_MODELS } from '../../../../../src/lib/render-models.js';

const PROVIDER_TABLE = PROVIDERS as Record<string, { id: string; label: string }>;
const MODELS = RENDER_MODELS as Record<string, { providers: Record<string, unknown> }>;

/** Every provider label a model can actually render on — a provider declared but unused by any
 *  model is an axis, not a choice, and the welcome page must not send users looking for it. */
const RENDER_PROVIDER_LABELS = [
  ...new Set(Object.values(MODELS).flatMap((m) => Object.keys(m.providers ?? {}))),
].map((id) => PROVIDER_TABLE[id]!.label);

const copy = () => render(<StepWelcome onNext={vi.fn()} />).container.textContent ?? '';

describe('StepWelcome — the prose is checked against the registry', () => {
  it('names every render provider a model can run on', () => {
    expect(RENDER_PROVIDER_LABELS.length).toBeGreaterThan(1); // a one-provider build would pass vacuously
    const text = copy();
    for (const label of RENDER_PROVIDER_LABELS) {
      expect(text.toLowerCase(), label).toContain(label.toLowerCase());
    }
  });

  it('no longer hands the whole render step to one vendor', () => {
    const text = copy();
    expect(text).not.toMatch(/fal\.ai renders/i);     // the stale claim itself
    expect(text).not.toMatch(/\ba fal\.ai key\b/i);   // …and the requirement it implied
  });

  it('never calls planning free — it bills LLM usage on every provider', () => {
    const text = copy();
    expect(text).toMatch(/planning bills your LLM usage/i);
    // Not even a vendor's free tier belongs here: this page is about what the RUN costs, and the
    // word next to "planning" is the one users remember.
    expect(text).not.toMatch(/\bfree\b/i);
  });
});
