// src/lib/render-seedance.js generalizes the Seedance renderer: caps in, provider adapter in, one
// mp4 out. src/lib/fal-seedance.js survives as a COMPAT SHIM so nothing downstream changes import
// paths and the existing gate tests (test/unit/seedance-args.test.js,
// test/integration/seedance-render.test.js) keep passing untouched.
//
// TDD (red first): src/lib/render-seedance.js does not exist; fal-seedance.js still owns the renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();

const rs = await import('../../src/lib/render-seedance.js');
const shim = await import('../../src/lib/fal-seedance.js');
const { buildSeedanceArgs } = await import('../../src/lib/seedance-args.js');
const { capsFor } = await import('../../src/lib/render-models.js');

test('render-seedance exposes the generalized renderer and the fal provider adapter', () => {
  assert.equal(typeof rs.renderSeedanceJob, 'function');
  assert.equal(typeof rs.falAdapter, 'object');
  assert.equal(typeof rs.falAdapter.assetUrl, 'function', 'assetUrl: local path → a url the provider can fetch');
  assert.equal(typeof rs.falAdapter.generate, 'function', 'generate: args → downloaded output paths');
  assert.deepEqual(Object.keys(rs.falAdapter).sort(), ['assetUrl', 'generate'], 'the adapter surface is exactly two functions');
});

test('fal-seedance.js keeps its public surface — no downstream import changes', () => {
  assert.equal(typeof shim.renderSeedanceJobFal, 'function');
  assert.equal(typeof shim.buildSeedanceArgs, 'function');
  assert.deepEqual(Object.keys(shim.default).sort(), ['buildSeedanceArgs', 'renderSeedanceJobFal']);
});

test('the shim\'s one-arg buildSeedanceArgs === the pure builder fed fal Seedance 2.0 caps', () => {
  const caps = capsFor('seedance-2.0@fal');
  const intents = [
    { prompt: 'p', imageUrls: ['u1'], aspectRatio: '9:16', resolution: '1080p', generateAudio: true, totalDuration: 13 },
    { prompt: 'p', imageUrls: [], aspectRatio: '16:9', resolution: '480p', generateAudio: false, totalDuration: 3 },
    { prompt: 'p', imageUrls: ['u1'], audioUrls: ['a1', 'a2'], aspectRatio: '1:1', resolution: '720p', generateAudio: true, totalDuration: 99 },
  ];
  for (const intent of intents) {
    assert.deepEqual(shim.buildSeedanceArgs(intent), buildSeedanceArgs(intent, caps), JSON.stringify(intent));
  }
});

test('renderSeedanceJobFal is the shim binding, not a second implementation', () => {
  // it must not BE the generalized function (it pre-binds backend + adapter), but it must be the
  // only thing fal-seedance defines — the rendering logic lives in render-seedance.js.
  assert.notEqual(shim.renderSeedanceJobFal, rs.renderSeedanceJob);
  assert.equal(shim.renderSeedanceJobFal.length <= 1, true, 'same one-object-argument contract as every renderer');
});
