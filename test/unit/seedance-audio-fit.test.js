// fitAudioRef — the PURE per-clip audio-window decision, lifted out of render-seedance.js so it can
// be asserted without ffmpeg, a temp dir or a mock provider.
//
// Why it exists: Segmind's Seedance 2.5 rejects a reference audio clip shorter than 2 SECONDS
// outright (HTTP 422, a whole paid submit wasted), while every model also caps the COMBINED audio
// budget. Today's renderer only knows how to shorten a clip ("is it longer than budget/N?"). The
// short end needs a third answer — DROP it, with a warning naming the speaker — and that decision
// must be data-driven (caps.audioPerClipS = [minS, maxS]) rather than a `if (model === …)` branch.
//
// Contract:
//   fitAudioRef(durationS, caps, { refCount = 1 } = {}) → 'keep' | 'cut' | 'drop'
//     caps.audioPerClipS = [minS, maxS]  → the model's own per-clip window (Segmind 2.5: [2, 30])
//     no audioPerClipS                   → today's behaviour exactly: max = caps.audioBudgetS/refCount
//                                          (floored), no minimum, so 'drop' is IMPOSSIBLE
//   an UNKNOWN duration (NaN/0 from a failed ffprobe) is never dropped — the renderer's existing
//   "send it as-is and let the provider complain" fallback must survive.
//
// TDD (red first): src/lib/seedance-args.js exports no fitAudioRef yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { fitAudioRef } = await import('../../src/lib/seedance-args.js');

const SEGMIND_25 = { audioPerClipS: [2, 30], audioBudgetS: 30, maxAudioRefs: 10 };

test('a clip under the model\'s per-clip MINIMUM is dropped (a <2s ref is a hard Segmind 422)', () => {
  assert.equal(fitAudioRef(1.4, SEGMIND_25), 'drop');
  assert.equal(fitAudioRef(0.2, SEGMIND_25), 'drop');
  assert.equal(fitAudioRef(1.999, SEGMIND_25), 'drop');
});

test('a clip over the per-clip MAXIMUM is re-cut, one inside the window is kept as-is', () => {
  assert.equal(fitAudioRef(45, SEGMIND_25), 'cut');
  assert.equal(fitAudioRef(30.5, SEGMIND_25), 'cut');
  assert.equal(fitAudioRef(12, SEGMIND_25), 'keep');
});

test('the window is INCLUSIVE at both ends — an exactly-legal clip is never touched', () => {
  // A 2.000s clip is legal; re-cutting or dropping it would be a bug that costs the take a voice.
  assert.equal(fitAudioRef(2, SEGMIND_25), 'keep');
  assert.equal(fitAudioRef(30, SEGMIND_25), 'keep');
});

test('WITHOUT audioPerClipS the answer is today\'s math: budget/N, and never "drop"', () => {
  // fal Seedance 2.0's caps carry audioBudgetS: 15 and NO audioPerClipS — its behaviour must not move.
  const fal20 = { audioBudgetS: 15 };
  assert.equal(fitAudioRef(20, fal20), 'cut');            // over the 15s budget for a single ref
  assert.equal(fitAudioRef(14, fal20), 'keep');
  assert.equal(fitAudioRef(4, fal20, { refCount: 3 }), 'keep'); // floor(15/3) = 5s each
  assert.equal(fitAudioRef(6, fal20, { refCount: 3 }), 'cut');
  for (const d of [0.1, 0.5, 1, 1.9]) {
    assert.equal(fitAudioRef(d, fal20), 'keep', `${d}s must never be dropped without a declared minimum`);
  }
});

test('an unprobeable clip (NaN / 0 duration) is kept — the renderer still sends it as-is', () => {
  for (const d of [NaN, 0, null, undefined]) {
    assert.equal(fitAudioRef(d, SEGMIND_25), 'keep', String(d));
    assert.equal(fitAudioRef(d, { audioBudgetS: 15 }), 'keep', String(d));
  }
});

test('caps with neither window nor budget have no opinion — everything is kept', () => {
  assert.equal(fitAudioRef(120, {}), 'keep');
  assert.equal(fitAudioRef(0.1, {}), 'keep');
});
