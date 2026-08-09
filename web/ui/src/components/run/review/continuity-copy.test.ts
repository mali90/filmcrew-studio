// WS2-P2/P5 (UI) — the continuity vocabulary and the boundary sentence, as PURE functions.
//
// Everything the review strip and the re-render dialog SAY about seams comes from these two
// helpers, and they carry the one rule that cannot be allowed to drift (UX spec D15 + Don't #8):
//
//     native pins  → "seamless"
//     soft pins    → "near-seamless (reference-guided)"
//     nothing      → "may jump"
//
// A soft pin on fal is a prompt sentence plus an extra reference image. It usually lands close. It
// is not frame-exact, and calling it "seamless" sells the user a guarantee the model never gave.
// Keeping the copy in pure functions is what makes that testable at all — a string baked into JSX
// can only be checked by rendering the whole component.
import { describe, it, expect } from 'vitest';
import * as lib from './lib';

// Red until WS2-P2/P5 land these helpers in review/lib.ts. `describe.skipIf` keeps the UI suite
// green in the meantime, and arms the moment the exports appear.
const helpers = lib as unknown as {
  jointFor?: (j: { kind: string; confidence: string }) => { label: string; icon: string; tone: string };
  boundaryPlanSentence?: (p: {
    jobId: string;
    prev?: { jobId: string } | null;
    next?: { jobId: string } | null;
    boundaries: 'auto' | 'both' | 'start' | 'end' | 'none';
    pinStrength: 'native' | 'soft' | 'none';
  }) => string;
  seamStrengthWords?: (s: 'native' | 'soft' | 'none') => string;
};
const READY = typeof helpers.jointFor === 'function'
  && typeof helpers.boundaryPlanSentence === 'function'
  && typeof helpers.seamStrengthWords === 'function';

describe.skipIf(!READY)('ContinuityBadge vocabulary (jointFor)', () => {
  it('maps each joint kind to exactly one word and one tone', () => {
    expect(helpers.jointFor!({ kind: 'linked', confidence: 'recorded' })).toMatchObject({ label: 'joined' });
    expect(helpers.jointFor!({ kind: 'broken', confidence: 'recorded' })).toMatchObject({ label: 'join broken' });
    expect(helpers.jointFor!({ kind: 'isolated', confidence: 'recorded' })).toMatchObject({ label: 'scene cut' });
    expect(helpers.jointFor!({ kind: 'unknown', confidence: 'derived' })).toMatchObject({ label: 'join unknown' });
  });

  it('a DERIVED answer never claims a plain "joined" — reconstruction reads as unknown', () => {
    const derivedLink = helpers.jointFor!({ kind: 'linked', confidence: 'derived' });
    expect(derivedLink.label).toBe('join unknown');
    expect(derivedLink.tone).not.toBe('done');
  });

  it('an unrecognised kind degrades to unknown instead of rendering an empty badge', () => {
    expect(helpers.jointFor!({ kind: 'nonsense', confidence: 'recorded' }).label).toBe('join unknown');
  });
});

describe.skipIf(!READY)('seam strength words (the honesty rule)', () => {
  it('"seamless" is reserved for native pins', () => {
    expect(helpers.seamStrengthWords!('native')).toMatch(/seamless/);
    expect(helpers.seamStrengthWords!('native')).not.toMatch(/near-seamless/);
  });

  it('a soft pin says near-seamless AND says why', () => {
    const words = helpers.seamStrengthWords!('soft');
    expect(words).toMatch(/near-seamless/);
    expect(words).toMatch(/reference-guided/);
  });

  it('no pin promises nothing', () => {
    const words = helpers.seamStrengthWords!('none');
    expect(words).not.toMatch(/seamless/);
    expect(words).toMatch(/jump|cut/);
  });
});

describe.skipIf(!READY)('SegmentRerenderDialog boundary sentence (plain words, recomputed live)', () => {
  const base = { jobId: 'K2', prev: { jobId: 'K1' }, next: { jobId: 'K3' } };

  it('both ends, native: names both neighbours and promises seamless', () => {
    const s = helpers.boundaryPlanSentence!({ ...base, boundaries: 'both', pinStrength: 'native' });
    expect(s).toContain('K1');
    expect(s).toContain('K3');
    expect(s).toMatch(/seamless/);
    expect(s).not.toMatch(/near-seamless/);
  });

  it('both ends, soft: same plan, honest strength', () => {
    const s = helpers.boundaryPlanSentence!({ ...base, boundaries: 'both', pinStrength: 'soft' });
    expect(s).toContain('K1');
    expect(s).toContain('K3');
    expect(s).toMatch(/near-seamless \(reference-guided\)|reference-guided/);
  });

  it('start only: says plainly that the cut into the next segment stays a scene cut', () => {
    const s = helpers.boundaryPlanSentence!({ ...base, boundaries: 'start', pinStrength: 'soft' });
    expect(s).toContain('K1');
    expect(s).toMatch(/K3/);
    expect(s).toMatch(/scene cut|nothing pins its ending/i);
  });

  it('the first segment has no start to pin, and says so without jargon', () => {
    const s = helpers.boundaryPlanSentence!({ jobId: 'K1', prev: null, next: { jobId: 'K2' }, boundaries: 'auto', pinStrength: 'soft' });
    expect(s).toMatch(/opens the cut|nothing pins its start/i);
    expect(s).toContain('K2');
  });

  it('a lone segment is told there is nothing to join to', () => {
    const s = helpers.boundaryPlanSentence!({ jobId: 'K1', prev: null, next: null, boundaries: 'auto', pinStrength: 'none' });
    expect(s).toMatch(/only segment|nothing to join/i);
  });

  it('boundaries "none" promises nothing on either side', () => {
    const s = helpers.boundaryPlanSentence!({ ...base, boundaries: 'none', pinStrength: 'soft' });
    expect(s).not.toMatch(/seamless/);
    expect(s).toMatch(/on its own|scene cuts/i);
  });

  it('never contains a job id that is not in the plan (no "K3" when there is no next)', () => {
    const s = helpers.boundaryPlanSentence!({ jobId: 'K2', prev: { jobId: 'K1' }, next: null, boundaries: 'auto', pinStrength: 'soft' });
    expect(s).not.toContain('K3');
    expect(s).toContain('K1');
  });
});
