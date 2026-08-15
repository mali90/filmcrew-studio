// buildUpdates' resolution line is the wizard's whole reason to know about the registry: the pick
// must land on the env variable the CHOSEN backend's model actually reads. It used to write
// KLING_RESOLUTION unconditionally, so a Seedance default backend silently ignored the wizard's
// resolution and rendered at its own .env default — the headline bug of this change.
import { describe, expect, it } from 'vitest';
import { PROVIDERS, buildUpdates, initialWizardState, type WizardState } from './wizard';

const at = (over: Partial<WizardState>): WizardState => ({ ...initialWizardState, ...over });

describe('buildUpdates — the resolution rides the chosen model’s own knob', () => {
  it('kling → NO resolution write at all (no ladder: the endpoint takes no resolution parameter)', () => {
    const updates = buildUpdates(at({ backend: 'kling', resolution: null }));
    expect(updates).not.toHaveProperty('KLING_RESOLUTION');
    expect(updates).not.toHaveProperty('SEEDANCE_RESOLUTION');
    expect(updates).not.toHaveProperty('SEEDANCE25_RESOLUTION');
    expect(updates).not.toHaveProperty('undefined'); // `[undefined]: …` is the literal bug this guards
  });

  it('Seedance 2.0 → SEEDANCE_RESOLUTION; the kling knob is untouched', () => {
    const updates = buildUpdates(at({ backend: 'seedance-2.0@segmind', resolution: '480p' }));
    expect(updates.SEEDANCE_RESOLUTION).toBe('480p');
    expect(updates).not.toHaveProperty('KLING_RESOLUTION');
  });

  it('Seedance 2.5 → its OWN knob, on either provider (the knob is per model, never per provider)', () => {
    for (const backend of ['seedance-2.5@fal', 'seedance-2.5@segmind'] as const) {
      const updates = buildUpdates(at({ backend, resolution: '480p' }));
      expect(updates.SEEDANCE25_RESOLUTION, backend).toBe('480p');
      expect(updates, backend).not.toHaveProperty('KLING_RESOLUTION');
      expect(updates, backend).not.toHaveProperty('SEEDANCE_RESOLUTION');
    }
  });

  it('legacy one-word ids resolve through the registry too', () => {
    expect(buildUpdates(at({ backend: 'seedance', resolution: '720p' })).SEEDANCE_RESOLUTION).toBe('720p');
  });
});

// The planner cards are where "free" is most tempting and most dangerous: planning ALWAYS bills the
// LLM usage, and the only free thing a note may mention is a vendor's own plan. These three rules
// are mechanical so a note added for the next provider cannot quietly break them.
describe('PROVIDERS notes — a vendor’s free tier is a fact, free planning is not', () => {
  it('never says "free" except as that vendor’s own free tier/plan', () => {
    for (const p of PROVIDERS) expect(p.note, p.id).not.toMatch(/\bfree\b(?!\s+(tier|plan))/i);
  });

  it('quotes no quota numbers — a figure we cannot re-check reads as a promise', () => {
    // The vendor moves it, the card keeps saying it, and nothing goes red. Words only.
    for (const p of PROVIDERS) expect(p.note, p.id).not.toMatch(/\d/);
  });

  it('still points at the free-tier route on at least one card (Gemini’s CLI today)', () => {
    // The step's own sentence tells the user the cheapest planner is a CLI on a free tier; if no
    // card names one, that sentence sends them looking for something the wizard never shows.
    expect(PROVIDERS.some((p) => /free (tier|plan)/i.test(p.note))).toBe(true);
  });
});
