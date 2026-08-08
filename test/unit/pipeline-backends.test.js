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

test('RENDERERS carries both canonical ids plus the legacy alias keys, with today\'s exact labels', () => {
  assert.deepEqual(Object.keys(RENDERERS).sort(), ['kling', 'kling-o3@fal', 'seedance', 'seedance-2.0@fal']);
  assert.equal(RENDERERS['kling-o3@fal'].label, 'Kling 3.0 Omni (fal)');
  assert.equal(RENDERERS['seedance-2.0@fal'].label, 'Seedance 2.0 (fal)');
  for (const r of Object.values(RENDERERS)) {
    assert.equal(typeof r.render, 'function');
    assert.equal(typeof r.label, 'string');
  }
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
  // Kling is genuinely fal-only, so its entry may be the fal renderer itself…
  assert.equal(RENDERERS['kling-o3@fal'].render, renderKlingJobFal);
  // …but a seedance entry must NOT route through the 2.0@fal-pinned shim: a sibling model or
  // provider added to the registry has to render with its own caps and its own transport, so the
  // table binds a per-entry closure over capsFor(id) + that provider's adapter.
  assert.equal(typeof RENDERERS['seedance-2.0@fal'].render, 'function');
  assert.notEqual(RENDERERS['seedance-2.0@fal'].render, renderSeedanceJobFal);
});
