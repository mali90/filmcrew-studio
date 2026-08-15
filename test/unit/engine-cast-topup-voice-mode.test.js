// The other half of the reserved-audio gate: SEEDANCE_VOICE_MODE.
//
// topUpStarredElements holds a slot of the COMBINED reference budget (fal Seedance 2.5's 50) for
// every voice clip a job will send, because nothing drops a voice ref — the renderer throws instead.
// "Will send" is voiceRefsRide's answer, not "has a registered clip": in `native` voice mode the
// renderer attaches no @AudioN at all and voices the written line itself, so a reservation there
// only starves a starred character of identity images for references no render will carry.
//
// This lives in its own file because config.js snapshots process.env at import time — the sibling
// cases (audio on with clips, audio off) are in engine-cast-topup.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
process.env.SEEDANCE_VOICE_MODE = 'native'; // BEFORE the import: config.js reads it once
const { topUpStarredElements } = await import('../../src/lib/engine.js');
const { capsFor } = await import('../../src/lib/render-models.js');
const config = (await import('../../config.js')).default;

const ref = (id) => ({ id, type: 'reference', file: `elements/references/${id}.png`, abs: `/synthetic/${id}.png`, description: '' });
const refsFor = (cslug, n) => Array.from({ length: n }, (_, i) => ref(`${cslug}-${String(i + 1).padStart(2, '0')}`));
const el = (id, character) => ({ id, role: 'subject', image: `elements/references/${id}.png`, character });

test('native voice mode reserves no audio slot — the cast gets the whole combined budget', () => {
  assert.equal(config.seedance.voiceMode, 'native', 'the env really reached config (this test proves nothing otherwise)');
  const inv = refsFor('keeper', 60);
  const spec = {
    spec_version: '1.0',
    kling: { elements: [el('keeper-01', 'Keeper')], jobs: [{ job_id: 'J1', shots: ['S1'] }] },
    audio: { voice: { lines: [{ shot_id: 'S1', speaker: 'Keeper', text: 'a line of dialogue' }] } },
  };
  topUpStarredElements(spec, {
    backend: 'seedance-2.5@fal',
    caps: capsFor('seedance-2.5@fal'),
    castNames: ['keeper'],
    inventory: inv,
    voiceClipFor: (sp) => (sp === 'Keeper' ? '/synthetic/keeper.mp3' : null), // registered, and still not sent
  });
  assert.equal(spec.kling.elements.length, capsFor('seedance-2.5@fal').maxCombinedRefs,
    'a clip the renderer will not attach must not cost an identity image');
});
