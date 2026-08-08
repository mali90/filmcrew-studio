// Backend resolution + the RENDERERS dispatch table, both now derived from the render-models
// registry. Two things are pinned here that the rest of the pipeline leans on:
//
//   * resolveBackend returns the CANONICAL compound id ('seedance-2.0@fal'), whatever form the
//     caller used. Everything downstream (render.json's `backend`, the estimator's price lookup,
//     spec.render_backend) therefore speaks one vocabulary, while '--backend seedance' and old
//     spec files keep working.
//   * RENDERERS is built from BACKEND_IDS × a family→render-fn map, with the legacy names as
//     ALIASES POINTING AT THE SAME ENTRY OBJECT — one source of truth, no drifting labels.
//
// These two cases used to live in test/unit/seedance-args.test.js; they moved here so that file
// can stay a pure buildSeedanceArgs test (the byte-compat gate for the seedance-args extraction).
//
// TDD (red first): resolveBackend still returns the raw name and RENDERERS is a hardcoded literal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();
const { resolveBackend, RENDERERS } = await import('../../src/lib/pipeline.js');
const { BACKEND_IDS, LEGACY_BACKENDS, capsFor } = await import('../../src/lib/render-models.js');

test('resolveBackend precedence: explicit flag > spec.render_backend > config default', () => {
  assert.equal(resolveBackend({}, 'seedance'), 'seedance-2.0@fal');
  assert.equal(resolveBackend({ render_backend: 'kling' }, 'seedance'), 'seedance-2.0@fal');
  assert.equal(resolveBackend({ render_backend: 'seedance' }), 'seedance-2.0@fal');
  assert.equal(resolveBackend({}), 'kling-o3@fal'); // config default (env neutralized)
  assert.throws(() => resolveBackend({}, 'nope'), /Unknown render backend "nope" — use one of: /);
});

test('resolveBackend canonicalizes: a compound id and its legacy alias resolve identically', () => {
  assert.equal(resolveBackend({}, 'seedance-2.0@fal'), 'seedance-2.0@fal');
  assert.equal(resolveBackend({}, 'kling-o3@fal'), 'kling-o3@fal');
  assert.equal(resolveBackend({ render_backend: 'seedance-2.0@fal' }), 'seedance-2.0@fal');
  // and it is idempotent — re-resolving a resolved id is a no-op (renderSpec → renderJob chains do this)
  for (const be of [...BACKEND_IDS, ...LEGACY_BACKENDS]) {
    const once = resolveBackend({}, be);
    assert.equal(resolveBackend({}, once), once, be);
  }
});

test('the unknown-backend message lists every accepted value and names the two ways to set it', () => {
  assert.throws(() => resolveBackend({}, 'nope'), (e) => {
    for (const v of [...BACKEND_IDS, ...LEGACY_BACKENDS]) assert.ok(e.message.includes(v), `lists ${v}`);
    assert.match(e.message, /RENDER_BACKEND in \.env, or --backend/);
    return true;
  });
});

test('RENDERERS carries every canonical id plus the legacy alias keys, with today\'s exact labels', () => {
  assert.deepEqual(Object.keys(RENDERERS).sort(), [
    'kling', 'kling-o3@fal',
    'seedance', 'seedance-2.0@fal', 'seedance-2.0@segmind',
    'seedance-2.5@fal', 'seedance-2.5@segmind',
  ]);
  assert.equal(RENDERERS['kling-o3@fal'].label, 'Kling 3.0 Omni (fal)');
  assert.equal(RENDERERS['seedance-2.0@fal'].label, 'Seedance 2.0 (fal)');
  assert.equal(RENDERERS['seedance-2.0@segmind'].label, 'Seedance 2.0 (Segmind)');
  assert.equal(RENDERERS['seedance-2.5@fal'].label, 'Seedance 2.5 (fal)');
  assert.equal(RENDERERS['seedance-2.5@segmind'].label, 'Seedance 2.5 (Segmind)');
  for (const r of Object.values(RENDERERS)) {
    assert.equal(typeof r.render, 'function');
    assert.equal(typeof r.label, 'string');
  }
});

// A provider is a BINDING plus one line in the adapter map — never a renderer fork. If a registry
// entry ever lands without its adapter, BACKEND_IDS and RENDERERS drift and the failure surfaces as
// "has no renderer in this build" at render time, after planning has already been paid for.
test('every registry backend id has a renderer — the adapter map keeps pace with the registry', () => {
  for (const id of BACKEND_IDS) {
    assert.ok(RENDERERS[id], `${id} is renderable in this build`);
    assert.equal(typeof RENDERERS[id].render, 'function', id);
  }
  assert.equal(Object.keys(RENDERERS).length, BACKEND_IDS.length + LEGACY_BACKENDS.length);
});

test('the label is derived (`<model label> (<provider label>)`), not hand-written per backend', () => {
  for (const id of BACKEND_IDS) {
    const caps = capsFor(id);
    assert.equal(RENDERERS[id].label, `${caps.label} (${caps.providerLabel})`, id);
  }
});

test('a legacy alias key IS the canonical entry — same object, so labels can never drift apart', () => {
  assert.equal(RENDERERS.kling, RENDERERS['kling-o3@fal']);
  assert.equal(RENDERERS.seedance, RENDERERS['seedance-2.0@fal']);
});

test('each entry is bound to ITS OWN caps — never a family-shared shim', async () => {
  const { renderKlingJobFal } = await import('../../src/lib/fal-kling.js');
  const { renderSeedanceJobFal } = await import('../../src/lib/fal-seedance.js');
  // EVERY entry is a per-entry closure carrying its canonical id: seedance so a sibling model or
  // provider renders with its own caps + transport, kling so its prompts.json sidecar records the
  // backend identity. Neither may be the bare family fn — that is how caps/identity drift starts.
  for (const [id, bare] of [['kling-o3@fal', renderKlingJobFal], ['seedance-2.0@fal', renderSeedanceJobFal]]) {
    assert.equal(typeof RENDERERS[id].render, 'function', id);
    assert.notEqual(RENDERERS[id].render, bare, `${id} must not be the family-shared renderer`);
  }
  // …and no two entries share a render function: four Seedance entries built from one generalized
  // renderer must still be four distinct closures over their own caps + provider adapter.
  const fns = BACKEND_IDS.map((id) => RENDERERS[id].render);
  assert.equal(new Set(fns).size, fns.length, 'each backend id closes over its OWN caps/adapter');
});

// The Segmind transport must not be dragged into a fal-only render's import graph, and vice versa —
// each binding module owns exactly one provider's transport.
test('the segmind binding imports segmind, never fal (and the fal binding never segmind)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const staticSpecs = (src) => [...src.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  const segmindBinding = staticSpecs(read('src/lib/segmind-seedance.js'));
  assert.ok(segmindBinding.includes('./segmind.js'), 'it binds the segmind transport');
  assert.ok(!segmindBinding.some((s) => s.includes('fal')), `no fal import in the segmind binding: ${segmindBinding.join(', ')}`);

  const falBinding = staticSpecs(read('src/lib/fal-seedance.js'));
  assert.ok(!falBinding.some((s) => s.includes('segmind')), 'no segmind import in the fal binding');

  // segmind.js itself must not statically import fal.js: a Segmind-only setup (SEGMIND_UPLOAD_MODE
  // =data-uri, no FAL_KEY at all) has to work, so the fal-storage upload path is a LAZY import.
  const segmind = read('src/lib/segmind.js');
  assert.ok(!staticSpecs(segmind).some((s) => s.includes('fal')), 'segmind.js never statically imports fal.js');
});
