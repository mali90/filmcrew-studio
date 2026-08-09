// WS2-P1 (WS2-04) — chooseSeamMode / planSeamRefs / SEAM_PRIORITY.
//
// "How does this segment get pinned to its neighbours?" is answered in exactly ONE pure place, so
// the renderers, the server preview, and the re-render dialog's plain-words sentence can never
// disagree about what the user is being sold.
//
// The rules (plan locked decision #4 + the UX spec's IMPLEMENTER CORRECTION):
//   · kling-o3@fal ....... native start_image_url/end_image_url, but ONLY reference-to-video
//                          (a text-to-video job has no element to seed a frame from → 'none').
//                          'unsupported' is a RUNTIME downgrade after the end_image_url fallback
//                          retry — chooseSeamMode never returns it.
//   · seedance@fal ....... ALWAYS soft-pinned. fal's reference-to-video endpoint carries no frame
//                          anchors at all, so a frame rides as an extra reference image + a prompt
//                          pin. It must NEVER report 'native' — that word is what the UI turns into
//                          the promise "seamless", and on fal it would be a lie.
//   · seedance@segmind ... native first_frame_url/last_frame_url ONLY on a cast-less segment
//                          (native is mutually exclusive with reference_images there); with any
//                          cast ref present it soft-pins and keeps the cast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { armed, pending } from '../helpers/tdd.js';

neutralizeDotenv();
const { capsFor } = await import('../../src/lib/render-models.js');
const compose = await armed(
  () => import('../../src/lib/prompt-compose.js'),
  ['chooseSeamMode', 'planSeamRefs', 'SEAM_MODES', 'SEAM_PRIORITY'],
);
const PENDING = pending(compose, 'WS2-04: prompt-compose.js#chooseSeamMode/planSeamRefs');

const BACKENDS = ['kling-o3@fal', 'seedance-2.0@fal', 'seedance-2.5@fal', 'seedance-2.0@segmind', 'seedance-2.5@segmind'];

/** The expected {in,out} modes — written as the RULE, so the table below cannot encode a typo. */
function expected(id, castRefCount, hasSeamIn, hasSeamOut) {
  const [, provider] = id.split('@');
  const family = id.startsWith('kling') ? 'kling' : 'seedance';
  const pick = (has) => {
    if (!has) return 'none';
    if (family === 'kling') return castRefCount > 0 ? 'native' : 'none'; // text-to-video seeds nothing
    if (provider === 'fal') return 'soft';                                // no frame anchors, ever
    return castRefCount === 0 ? 'native' : 'soft';                        // segmind: native ⊕ refs
  };
  return { in: pick(hasSeamIn), out: pick(hasSeamOut) };
}

test('SEAM_MODES is the closed vocabulary the sidecars and the UI share', PENDING, () => {
  assert.deepEqual([...compose.SEAM_MODES].sort(), ['native', 'none', 'soft', 'unsupported']);
});

test('chooseSeamMode: the full (backend × castRefCount × seamIn × seamOut) matrix', PENDING, () => {
  for (const id of BACKENDS) {
    const caps = capsFor(id);
    for (const castRefCount of [0, 1, 9]) {
      for (const hasSeamIn of [true, false]) {
        for (const hasSeamOut of [true, false]) {
          const got = compose.chooseSeamMode({ caps, castRefCount, hasSeamIn, hasSeamOut });
          const want = expected(id, castRefCount, hasSeamIn, hasSeamOut);
          assert.equal(got.in.mode, want.in, `${id} refs=${castRefCount} in(seamIn=${hasSeamIn})`);
          assert.equal(got.out.mode, want.out, `${id} refs=${castRefCount} out(seamOut=${hasSeamOut})`);
        }
      }
    }
  }
});

test('NO fal Seedance combination ever returns "native" — the honesty invariant', PENDING, () => {
  for (const id of ['seedance-2.0@fal', 'seedance-2.5@fal']) {
    const caps = capsFor(id);
    for (const castRefCount of [0, 1, 2, 4, 9, 30]) {
      const { in: i, out: o } = compose.chooseSeamMode({ caps, castRefCount, hasSeamIn: true, hasSeamOut: true });
      assert.equal(i.mode, 'soft', `${id} refs=${castRefCount}: fal has no first-frame anchor`);
      assert.equal(o.mode, 'soft', `${id} refs=${castRefCount}: fal has no last-frame anchor`);
    }
  }
});

test('Segmind goes native ONLY at castRefCount 0, and only where the caps declare the slots', PENDING, () => {
  for (const id of ['seedance-2.0@segmind', 'seedance-2.5@segmind']) {
    const caps = capsFor(id);
    assert.ok(caps.nativeFirstFrame && caps.argMap.firstFrame, `${id} caps declare a native first-frame slot`);
    const cast0 = compose.chooseSeamMode({ caps, castRefCount: 0, hasSeamIn: true, hasSeamOut: true });
    assert.equal(cast0.in.mode, 'native');
    assert.equal(cast0.out.mode, 'native');
    const cast1 = compose.chooseSeamMode({ caps, castRefCount: 1, hasSeamIn: true, hasSeamOut: true });
    assert.equal(cast1.in.mode, 'soft', 'one cast ref is enough to lose the native slot — keep the cast, soft-pin the frame');
    assert.equal(cast1.out.mode, 'soft');

    // A caps bundle that does NOT declare the argument must fall back to soft, never claim native.
    const crippled = { ...caps, argMap: { ...caps.argMap, firstFrame: null, lastFrame: null } };
    const c = compose.chooseSeamMode({ caps: crippled, castRefCount: 0, hasSeamIn: true, hasSeamOut: true });
    assert.equal(c.in.mode, 'soft');
    assert.equal(c.out.mode, 'soft');
  }
});

test('no frame → "none" on every backend (a missing seam is not a broken seam)', PENDING, () => {
  for (const id of BACKENDS) {
    const caps = capsFor(id);
    const r = compose.chooseSeamMode({ caps, castRefCount: 2, hasSeamIn: false, hasSeamOut: false });
    assert.equal(r.in.mode, 'none');
    assert.equal(r.out.mode, 'none');
  }
});

test('chooseSeamMode is pure: it reads caps only and never mutates them', PENDING, () => {
  const caps = capsFor('seedance-2.5@segmind');
  const before = JSON.stringify(caps);
  compose.chooseSeamMode({ caps, castRefCount: 0, hasSeamIn: true, hasSeamOut: true });
  assert.equal(JSON.stringify(caps), before, 'the caps bundle came back untouched');
});

// ── planSeamRefs + SEAM_PRIORITY ────────────────────────────────────────────────────────────────

const castUrls = (n) => Array.from({ length: n }, (_, i) => `https://cdn.test/cast-${i + 1}.png`);
const SEAM_IN = 'https://cdn.test/seam-in.png';
const SEAM_OUT = 'https://cdn.test/seam-out.png';

test('SEAM_PRIORITY names the drop order: the END pin goes first, a cast ref goes last', PENDING, () => {
  assert.deepEqual([...compose.SEAM_PRIORITY], ['seamOut', 'seamIn', 'cast'],
    'a boundary pin is a nicety; a cast reference is the character\'s identity — never drop it first');
});

test('planSeamRefs reserves TWO slots and appends the pins AFTER the cast refs', PENDING, () => {
  const caps = capsFor('seedance-2.0@fal'); // maxImages 9
  const plan = compose.planSeamRefs({ caps, castRefs: castUrls(3), seamIn: SEAM_IN, seamOut: SEAM_OUT });
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.imageRefs.length, 5);
  assert.deepEqual(plan.imageRefs.map((r) => r.kind), ['cast', 'cast', 'cast', 'seamIn', 'seamOut'],
    'the pins ride LAST so a prompt pin naming @ImageN keeps pointing at the right slot');
  assert.equal(plan.imageRefs[3].url, SEAM_IN);
  assert.equal(plan.imageRefs[4].url, SEAM_OUT);
  assert.equal(plan.imageRefs[3].label, '@Image4', 'labels come from refLabel(caps, …), 1-based, in prompt order');
  assert.equal(plan.imageRefs[4].label, '@Image5');
});

test('the START pin sentence is byte-identical to today\'s shipping wording', PENDING, () => {
  const caps = capsFor('seedance-2.0@fal');
  const plan = compose.planSeamRefs({ caps, castRefs: castUrls(1), seamIn: SEAM_IN, seamOut: null });
  assert.deepEqual(plan.pins, ['Use @Image2 as the literal first frame of this clip and continue its motion seamlessly forward.'],
    'a start-only seam must reproduce the prompt the golden fixture pins — otherwise every existing render moves');
});

test('the END pin sentence names its slot and says "literal last frame"', PENDING, () => {
  const caps = capsFor('seedance-2.0@fal');
  const plan = compose.planSeamRefs({ caps, castRefs: castUrls(1), seamIn: SEAM_IN, seamOut: SEAM_OUT });
  assert.equal(plan.pins.length, 2, 'start pin first, end pin second — prompt order is stable');
  assert.match(plan.pins[0], /^Use @Image2 as the literal first frame/);
  assert.match(plan.pins[1], /@Image3/);
  assert.match(plan.pins[1], /literal last frame/);
});

test('ref labels follow the model\'s citation style — the planner never hardcodes @ImageN', PENDING, () => {
  const bracket = compose.planSeamRefs({ caps: capsFor('seedance-2.5@fal'), castRefs: castUrls(1), seamIn: SEAM_IN, seamOut: null });
  assert.match(bracket.pins[0], /^Use \[Image2\] as the literal first frame/);
  const spaced = compose.planSeamRefs({ caps: capsFor('seedance-2.5@segmind'), castRefs: castUrls(1), seamIn: SEAM_IN, seamOut: null });
  assert.match(spaced.pins[0], /^Use @Image 2 as the literal first frame/);
});

test('at the image cap: the END pin is dropped first, then the START pin, and cast refs survive both', PENDING, () => {
  const caps = capsFor('seedance-2.0@fal'); // maxImages 9

  // 8 cast + 2 pins = 10 > 9 → exactly one drop, and it is the END pin.
  const one = compose.planSeamRefs({ caps, castRefs: castUrls(8), seamIn: SEAM_IN, seamOut: SEAM_OUT });
  assert.equal(one.imageRefs.length, 9);
  assert.deepEqual(one.dropped.map((d) => d.kind), ['seamOut']);
  assert.ok(one.imageRefs.some((r) => r.url === SEAM_IN), 'the start pin survived');
  assert.equal(one.imageRefs.filter((r) => r.kind === 'cast').length, 8, 'every cast reference survived');
  assert.equal(one.pins.length, 1, 'a dropped pin takes its prompt sentence with it — no ref, no claim');

  // 9 cast + 2 pins = 11 > 9 → both pins go, the cast is untouched.
  const two = compose.planSeamRefs({ caps, castRefs: castUrls(9), seamIn: SEAM_IN, seamOut: SEAM_OUT });
  assert.deepEqual(two.dropped.map((d) => d.kind), ['seamOut', 'seamIn']);
  assert.equal(two.imageRefs.filter((r) => r.kind === 'cast').length, 9);
  assert.deepEqual(two.pins, []);

  // Only when both pins are already gone may a cast ref be dropped (over-cap cast list).
  const three = compose.planSeamRefs({ caps, castRefs: castUrls(11), seamIn: SEAM_IN, seamOut: SEAM_OUT });
  assert.equal(three.imageRefs.length, 9);
  assert.deepEqual(three.dropped.map((d) => d.kind), ['seamOut', 'seamIn', 'cast', 'cast']);
  assert.equal(three.pins.length, 0);
});

test('the combined-reference budget bites too (fal 2.5 counts images + audio + video together)', PENDING, () => {
  const caps = capsFor('seedance-2.5@fal'); // maxImages 50, maxCombinedRefs 50
  assert.equal(caps.maxCombinedRefs, 50);
  const plan = compose.planSeamRefs({ caps, castRefs: castUrls(49), seamIn: SEAM_IN, seamOut: SEAM_OUT, otherRefCount: 0 });
  assert.equal(plan.imageRefs.length, 50);
  assert.deepEqual(plan.dropped.map((d) => d.kind), ['seamOut']);

  // …and audio refs already spent from the same budget must be counted, not ignored.
  const withAudio = compose.planSeamRefs({ caps, castRefs: castUrls(47), seamIn: SEAM_IN, seamOut: SEAM_OUT, otherRefCount: 2 });
  assert.equal(withAudio.imageRefs.length + 2, 50);
  assert.deepEqual(withAudio.dropped.map((d) => d.kind), ['seamOut']);
});

test('planSeamRefs with no seams is a pure pass-through (zero prompt movement on today\'s renders)', PENDING, () => {
  const caps = capsFor('seedance-2.0@fal');
  const plan = compose.planSeamRefs({ caps, castRefs: castUrls(2), seamIn: null, seamOut: null });
  assert.deepEqual(plan.imageRefs.map((r) => r.url), castUrls(2));
  assert.deepEqual(plan.pins, []);
  assert.deepEqual(plan.dropped, []);
});

test('every drop is reported with enough detail to log one honest warn line', PENDING, () => {
  const caps = capsFor('seedance-2.0@fal');
  const { dropped } = compose.planSeamRefs({ caps, castRefs: castUrls(9), seamIn: SEAM_IN, seamOut: SEAM_OUT });
  for (const d of dropped) {
    assert.ok(d.kind, 'what was dropped');
    assert.ok(d.url, 'which asset');
    assert.ok(typeof d.reason === 'string' && d.reason.length, 'why — the warn line must name the cap that bit');
  }
});

// ── The budget, read by everything that quotes a seam to a user ─────────────────────────────────
//
// chooseSeamMode answers the MODEL's question; planSeamRefs answers the BUDGET's. Both surfaces
// that promise a join before money moves — the prompt sheet's seam line and the re-render dialog's
// plain-words sentence — must read the composition of the two, or a pin the image cap is about to
// drop gets sold as "near-seamless (reference-guided)" and delivered as a scene cut.

test('appliedSeamModes collapses a soft pin that lost its slot, and never touches a native one', PENDING, () => {
  const soft = { in: { mode: 'soft' }, out: { mode: 'soft' } };
  assert.deepEqual(compose.appliedSeamModes(soft, [{ kind: 'cast' }, { kind: 'seamIn' }]), { in: 'soft', out: 'none' });
  assert.deepEqual(compose.appliedSeamModes(soft, [{ kind: 'cast' }]), { in: 'none', out: 'none' });
  // A native anchor rides its own argument, so the image list has no say over it.
  assert.deepEqual(compose.appliedSeamModes({ in: { mode: 'native' }, out: { mode: 'native' } }, []), { in: 'native', out: 'native' });
});

test('pinStrengths = chooseSeamMode + the SEAM_PRIORITY budget, in one answer', PENDING, () => {
  const caps = capsFor('seedance-2.0@fal'); // 9 images, always soft-pinned
  const ask = (castRefCount) => compose.pinStrengths({ caps, castRefCount, hasSeamIn: true, hasSeamOut: true });
  assert.deepEqual(ask(2), { in: 'soft', out: 'soft' }, 'room for both pins');
  assert.deepEqual(ask(8), { in: 'soft', out: 'none' }, 'one slot left — the END pin goes first');
  assert.deepEqual(ask(9), { in: 'none', out: 'none' }, 'a full cast keeps every identity ref and no pin');
  // An end with no frame is 'none' whatever the budget says.
  assert.equal(compose.pinStrengths({ caps, castRefCount: 0, hasSeamIn: true, hasSeamOut: false }).out, 'none');
});

test('a declared cap of ZERO means nothing fits — never "unlimited"', PENDING, () => {
  // Reachable the day a registry entry declares an image-less endpoint. `Number(x) || Infinity`
  // would read 0 as no cap at all and ship every reference to a model that accepts none.
  const noImages = { ...capsFor('seedance-2.0@fal'), maxImages: 0 };
  const plan = compose.planSeamRefs({ caps: noImages, castRefs: castUrls(2), seamIn: SEAM_IN, seamOut: SEAM_OUT });
  assert.deepEqual(plan.imageRefs, [], 'a zero cap admits nothing');
  assert.equal(plan.dropped.length, 4);
  assert.ok(plan.dropped.every((d) => /0-image reference cap/.test(d.reason)), `the warn line names the real cap: ${plan.dropped[0]?.reason}`);

  const noCombined = { ...capsFor('seedance-2.5@fal'), maxCombinedRefs: 0 };
  assert.deepEqual(compose.planSeamRefs({ caps: noCombined, castRefs: castUrls(1) }).imageRefs, []);
});
