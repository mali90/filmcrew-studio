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
import { jointFor, seamStrengthWords, boundaryPlanSentence, regenerationSentence } from './lib';

// These were red specs behind a `describe.skipIf(!READY)` arming guard while WS2-P2/P5 were being
// built. The helpers have landed, so the guard is gone and the imports are direct and typed: a
// renamed or deleted export now fails `tsc --noEmit` and the suite, instead of quietly removing the
// 13 tests that hold the honesty rule in place.

describe('ContinuityBadge vocabulary (jointFor)', () => {
  it('maps each joint kind to exactly one word and one tone', () => {
    expect(jointFor({ kind: 'linked', confidence: 'recorded' })).toMatchObject({ label: 'joined' });
    expect(jointFor({ kind: 'broken', confidence: 'recorded' })).toMatchObject({ label: 'join broken' });
    expect(jointFor({ kind: 'isolated', confidence: 'recorded' })).toMatchObject({ label: 'scene cut' });
    expect(jointFor({ kind: 'unknown', confidence: 'derived' })).toMatchObject({ label: 'join unknown' });
  });

  it('a DERIVED answer never claims a plain "joined" — reconstruction reads as unknown', () => {
    const derivedLink = jointFor({ kind: 'linked', confidence: 'derived' });
    expect(derivedLink.label).toBe('join unknown');
    expect(derivedLink.tone).not.toBe('done');
  });

  it('an unrecognised kind degrades to unknown instead of rendering an empty badge', () => {
    expect(jointFor({ kind: 'nonsense', confidence: 'recorded' }).label).toBe('join unknown');
  });
});

describe('seam strength words (the honesty rule)', () => {
  it('"seamless" is reserved for native pins', () => {
    expect(seamStrengthWords('native')).toMatch(/seamless/);
    expect(seamStrengthWords('native')).not.toMatch(/near-seamless/);
  });

  it('a soft pin says near-seamless AND says why', () => {
    const words = seamStrengthWords('soft');
    expect(words).toMatch(/near-seamless/);
    expect(words).toMatch(/reference-guided/);
  });

  it('no pin promises nothing', () => {
    const words = seamStrengthWords('none');
    expect(words).not.toMatch(/seamless/);
    expect(words).toMatch(/jump|cut/);
  });
});

describe('SegmentRerenderDialog boundary sentence (plain words, recomputed live)', () => {
  const base = { jobId: 'K2', prev: { jobId: 'K1' }, next: { jobId: 'K3' } };

  it('both ends, native: names both neighbours and promises seamless', () => {
    const s = boundaryPlanSentence({ ...base, boundaries: 'both', pinStrength: 'native' });
    expect(s).toContain('K1');
    expect(s).toContain('K3');
    expect(s).toMatch(/seamless/);
    expect(s).not.toMatch(/near-seamless/);
  });

  it('both ends, soft: same plan, honest strength', () => {
    const s = boundaryPlanSentence({ ...base, boundaries: 'both', pinStrength: 'soft' });
    expect(s).toContain('K1');
    expect(s).toContain('K3');
    expect(s).toMatch(/near-seamless \(reference-guided\)|reference-guided/);
  });

  // The two ends can land differently — a reference budget that keeps the opening pin and drops the
  // closing one, a model with a native first-frame slot and no last-frame one. One collapsed
  // strength lies in both directions: it downgrades the join that IS pinned and upgrades the one
  // that is not.
  it('both ends, mixed: each join is described by its own strength', () => {
    const kept = boundaryPlanSentence({ ...base, boundaries: 'both', pinStrength: { in: 'soft', out: 'none' } });
    expect(kept).toMatch(/K1's last frame — that join is near-seamless \(reference-guided\)/);
    expect(kept).toMatch(/cut into K3 stays a scene cut/);
    expect(kept).not.toMatch(/rendered on its own/);

    const strongerStart = boundaryPlanSentence({ ...base, boundaries: 'both', pinStrength: { in: 'native', out: 'soft' } });
    expect(strongerStart).toMatch(/will start from K1's last frame — that join is seamless\./);
    expect(strongerStart).toMatch(/aim to end on K3's opening frame — that join is near-seamless \(reference-guided\)/);
  });

  it('start only: says plainly that the cut into the next segment stays a scene cut', () => {
    const s = boundaryPlanSentence({ ...base, boundaries: 'start', pinStrength: 'soft' });
    expect(s).toContain('K1');
    expect(s).toMatch(/K3/);
    expect(s).toMatch(/scene cut|nothing pins its ending/i);
  });

  it('the first segment has no start to pin, and says so without jargon', () => {
    const s = boundaryPlanSentence({ jobId: 'K1', prev: null, next: { jobId: 'K2' }, boundaries: 'auto', pinStrength: 'soft' });
    expect(s).toMatch(/opens the cut|nothing pins its start/i);
    expect(s).toContain('K2');
  });

  it('a lone segment is told there is nothing to join to', () => {
    const s = boundaryPlanSentence({ jobId: 'K1', prev: null, next: null, boundaries: 'auto', pinStrength: 'none' });
    expect(s).toMatch(/only segment|nothing to join/i);
  });

  it('boundaries "none" promises nothing on either side', () => {
    const s = boundaryPlanSentence({ ...base, boundaries: 'none', pinStrength: 'soft' });
    expect(s).not.toMatch(/seamless/);
    expect(s).toMatch(/on its own|scene cuts/i);
  });

  it('never contains a job id that is not in the plan (no "K3" when there is no next)', () => {
    const s = boundaryPlanSentence({ jobId: 'K2', prev: { jobId: 'K1' }, next: null, boundaries: 'auto', pinStrength: 'soft' });
    expect(s).not.toContain('K3');
    expect(s).toContain('K1');
  });
});

// ── Fix this take vs fresh take (Segmind seed control) ──────────────────────────────────────────
// The sentence under the re-render dialog's mode control is the ONLY place a user is told what
// re-sending a seed does, and it sells a paid render either way. Two claims it must never make:
// that a fix is guaranteed (the vendor promises reproducibility of the starting point, not of the
// picture), and that a fix costs less (both modes render one segment at the same rate). Keeping it
// pure is what makes those testable at all.
describe('regenerationSentence — what fix and fresh actually mean', () => {
  it('fresh says the model starts over, and warns not to expect a tweak', () => {
    expect(regenerationSentence({ jobId: 'K2', mode: 'fresh' })).toBe(
      'K2 is rendered again from a new starting point, so the model interprets it from scratch.'
      + ' Expect a different take, not a tweak of this one.',
    );
  });

  it('fix with a pending prompt edit says where the edit lands — and hedges it', () => {
    expect(regenerationSentence({ jobId: 'K2', mode: 'fix', promptEdited: true })).toBe(
      'K2 is rendered again from the same starting point (the seed this clip used), so your prompt edit'
      + ' lands on this picture and the rest stays close — close, not guaranteed. Same price as a fresh take.',
    );
  });

  it('fix with no edit predicts nearly the same clip, and names the option to pair it with', () => {
    expect(regenerationSentence({ jobId: 'K2', mode: 'fix' })).toBe(
      'K2 is rendered again from the same starting point (the seed this clip used). With the prompt'
      + ' unchanged, expect nearly the same clip — this is the option to pair with a prompt edit.'
      + ' Same price as a fresh take.',
    );
  });

  it('promptEdited only sharpens the fix sentence — fresh reads the same either way', () => {
    expect(regenerationSentence({ jobId: 'K2', mode: 'fresh', promptEdited: true }))
      .toBe(regenerationSentence({ jobId: 'K2', mode: 'fresh' }));
    expect(regenerationSentence({ jobId: 'K2', mode: 'fix', promptEdited: true }))
      .not.toBe(regenerationSentence({ jobId: 'K2', mode: 'fix' }));
  });

  it('names the segment it is about, and never a neighbour', () => {
    for (const mode of ['fix', 'fresh'] as const) {
      const s = regenerationSentence({ jobId: 'K2', mode });
      expect(s.startsWith('K2 ')).toBe(true);
      expect(s).not.toContain('K1');
      expect(s).not.toContain('K3');
    }
  });

  it('promises no seam, quotes no money, and carries no emoji', () => {
    for (const promptEdited of [false, true]) {
      for (const mode of ['fix', 'fresh'] as const) {
        const s = regenerationSentence({ jobId: 'K2', mode, promptEdited });
        // the seed decides the starting point; it says nothing about how the clip JOINS its
        // neighbours, so borrowing the seam vocabulary here would promise a join nobody planned
        expect(s).not.toMatch(/seamless/i);
        expect(s).not.toMatch(/\bfree\b/i);
        expect(s).not.toMatch(/cheap|cheaper|discount|\$/i);
        // the word may appear only in the disclaimer — a fix that "is guaranteed" is a promise the
        // vendor never made about the picture, only about the starting point
        if (/guarantee/i.test(s)) expect(s).toMatch(/not guaranteed/);
        expect(s).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/u);
      }
    }
  });
});
