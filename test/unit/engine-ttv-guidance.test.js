// The Seedance text-to-video prompt guidance is injected into planning ONLY for a GUARANTEED
// text-to-video render: Seedance backend, no cast, AND no reference image on disk (Casting has nothing
// to attach). A cast, ANY reference image (⇒ image-to-video, since Casting attaches by relevance), or
// Kling must NOT receive it — image-to-video planning stays unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { contextBlock, isTextToVideoPlan } = await import('../../src/lib/engine.js');
const { SEEDANCE_TTV_GUIDANCE } = await import('../../src/lib/seedance.js');

test('isTextToVideoPlan: only seedance + no cast + no reference images', () => {
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: undefined, refCount: 0 }), true);
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: [], refCount: 0 }), true);
  // A no-cast render whose folder HAS a reference image → Casting attaches it → image-to-video → NOT t2v.
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: [], refCount: 20 }), false);
  // Cast selected → image-to-video.
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: ['wren'], refCount: 0 }), false);
  // Kling is never on this path.
  assert.equal(isTextToVideoPlan({ backend: 'kling', cast: [], refCount: 0 }), false);
});

const HEADING = 'Seedance text-to-video — prompt style';
const baseCtx = (over) => ({
  brief: 'a cat reviews expensive cheese, deadpan', aspectRatio: '9:16', durationTargetS: 13,
  backend: 'seedance', castNames: null, textToVideo: false, inventoryText: '(none)', voicesText: '(none)', profilesText: '',
  ...over,
});

test('ctx.textToVideo → the t2v prompt guidance + identity-rule override are injected', () => {
  const block = contextBlock(baseCtx({ textToVideo: true }));
  assert.ok(block.includes(HEADING), 'the t2v prompt-style section is present');
  assert.ok(block.includes(SEEDANCE_TTV_GUIDANCE), 'the shared Seedance guidance is embedded verbatim');
  assert.match(block, /overriding the scene-director/i);          // identity rule relaxed for t2v only
});

test('NOT text-to-video (image-to-video / Kling) → no guidance, planning unchanged', () => {
  // Even a seedance/no-cast ctx does NOT get the block unless textToVideo is true (a folder image → false).
  assert.ok(!contextBlock(baseCtx({ backend: 'seedance', castNames: null, textToVideo: false })).includes(HEADING));
  assert.ok(!contextBlock(baseCtx({ castNames: ['wren'], textToVideo: false })).includes(HEADING));
  assert.ok(!contextBlock(baseCtx({ backend: 'kling', textToVideo: false })).includes(HEADING));
});
