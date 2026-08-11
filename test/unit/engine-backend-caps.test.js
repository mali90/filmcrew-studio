// buildCtx is the engine's pre-spend gate: it validates the backend and the aspect BEFORE any LLM
// call, and it builds the context block every agent reads. With the registry wired in it also
//   * CANONICALIZES the backend ('seedance' and 'seedance-2.0@fal' converge on the compound id,
//     which is then stamped onto spec.render_backend), and
//   * feeds the hard-caps lines from capsFor(backend), so the Job Planner is told the REAL
//     per-model window instead of the Kling constants for every model.
//
// Env discipline: config.js snapshots dirs at import, so every *_DIR is set BEFORE the dynamic
// import of engine.js.
//
// TDD (red first): buildCtx still checks RENDER_BACKENDS.includes()/ASPECTS.includes(), stores the
// raw name, and contextBlock still reads config.kling / config.seedance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-backend-caps-'));
const ENV_DIR = path.join(tmpRoot, 'environments');
const REFS_DIR = path.join(tmpRoot, 'refs');       // empty ⇒ refCount 0
const PROFILES_DIR = path.join(tmpRoot, 'profiles');
const VOICES_DIR = path.join(tmpRoot, 'voices');
for (const d of [ENV_DIR, REFS_DIR, PROFILES_DIR, VOICES_DIR]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, {
  ENVIRONMENTS_DIR: ENV_DIR, ELEMENTS_REFERENCES_DIR: REFS_DIR,
  PROFILES_DIR, VOICES_DIR,
  // A tier 2.5 does not render, on 2.5's OWN knob — drives the buildCtx resolution gate below while
  // every kling/2.0 test keeps its config defaults (config.js snapshots env at import).
  SEEDANCE25_RESOLUTION: '1080p',
});

const { buildCtx, contextBlock, isTextToVideoPlan } = await import('../../src/lib/engine.js');
const { capsFor } = await import('../../src/lib/render-models.js');

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ── canonicalization ────────────────────────────────────────────────────────
test('buildCtx canonicalizes the backend: legacy alias and compound id converge', async () => {
  const viaAlias = await buildCtx({ brief: 'x', backend: 'seedance' });
  const viaCompound = await buildCtx({ brief: 'x', backend: 'seedance-2.0@fal' });
  assert.equal(viaAlias.backend, 'seedance-2.0@fal');
  assert.equal(viaCompound.backend, 'seedance-2.0@fal');
  assert.equal(viaAlias.caps.model, 'seedance-2.0');
  assert.equal(viaAlias.caps.provider, 'fal');
  assert.equal(viaAlias.caps.family, 'seedance');
  assert.deepEqual(viaAlias.caps, capsFor('seedance-2.0@fal'));
  assert.deepEqual(viaCompound.caps, viaAlias.caps);
});

test('buildCtx: the config default resolves to the canonical Kling id', async () => {
  const ctx = await buildCtx({ brief: 'x' }); // no backend → config.render.backend (env neutralized)
  assert.equal(ctx.backend, 'kling-o3@fal');
  assert.equal(ctx.caps.family, 'kling');
});

test('buildCtx rejects an unknown backend BEFORE any LLM work, listing the accepted values', async () => {
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'sedance' }),
    (e) => {
      assert.match(e.message, /Unknown render backend "sedance"/);
      for (const v of ['kling-o3@fal', 'seedance-2.0@fal', 'kling', 'seedance']) assert.ok(e.message.includes(v), v);
      return true;
    },
  );
});

// ── per-model aspects, enforced at the gate ─────────────────────────────────
test('buildCtx rejects an aspect outside the MODEL\'s list, naming the valid ratios', async () => {
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'kling', aspectRatio: '21:9' }),
    /Unknown aspect ratio "21:9" — use one of: 16:9, 9:16, 1:1/,
  );
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'seedance-2.0@fal', aspectRatio: '4:3' }),
    /Unknown aspect ratio "4:3" — use one of: 16:9, 9:16, 1:1/,
  );
  // the model's own ratios still pass, and an omitted aspect still means "config default"
  for (const a of ['16:9', '9:16', '1:1']) {
    assert.equal((await buildCtx({ brief: 'x', backend: 'kling', aspectRatio: a })).aspectRatio, a);
  }
  assert.equal((await buildCtx({ brief: 'x', backend: 'kling' })).aspectRatio, undefined);
});

// ── per-model resolutions, enforced at the gate ─────────────────────────────
test('buildCtx judges the EFFECTIVE resolution against the model\'s own ladder, naming the knob', async () => {
  // SEEDANCE25_RESOLUTION=1080p is pinned above; 2.5 renders 480p/720p only — the plan must cost
  // nothing rather than advertise a tier the render child will refuse (render-seedance throws too).
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'seedance-2.5@fal' }),
    /Unknown resolution "1080p" \(the SEEDANCE25_RESOLUTION config default\) — Seedance 2\.5 renders: 480p, 720p/,
  );
  // each model reads ITS knob: the bad 2.5 value must not leak into kling or 2.0 plans
  assert.equal((await buildCtx({ brief: 'x', backend: 'kling' })).resolution, '1080p');
  assert.equal((await buildCtx({ brief: 'x', backend: 'seedance-2.0@fal' })).resolution, '480p');
});

// ── contextBlock is caps-fed ────────────────────────────────────────────────
const baseCtx = (over) => ({
  brief: 'a courier races the last train', aspectRatio: '9:16', durationTargetS: 13,
  backend: 'seedance', castNames: null, textToVideo: false, inventoryText: '(none)', voicesText: '(none)', profilesText: '',
  ...over,
});

test('contextBlock prints the CANONICAL backend id the spec will be stamped with', async () => {
  const ctx = await buildCtx({ brief: 'x', backend: 'seedance' });
  assert.ok(contextBlock({ ...baseCtx(), ...ctx }).includes('- Render backend: seedance-2.0@fal'));
});

test('contextBlock hard caps come from capsFor — Kling unchanged, Seedance now states its real 9', () => {
  const kling = contextBlock(baseCtx({ backend: 'kling-o3@fal', caps: capsFor('kling-o3@fal') }));
  assert.ok(
    kling.includes('- Hard caps: ≤6 shots/job, ≤15s/job, ≤512 chars/segment, ≤7 reference images/job'),
    'the Kling line is byte-identical to today',
  );
  // Seedance 2.0 declares no maxSegments/maxSegmentChars → the shared 6/512 fallback; its image cap
  // really is 9, and validateJobs now allows 9, so the planner must be told 9 (they must not disagree).
  const seedance = contextBlock(baseCtx({ backend: 'seedance-2.0@fal', caps: capsFor('seedance-2.0@fal') }));
  assert.ok(
    seedance.includes('- Hard caps: ≤6 shots/job, ≤15s/job, ≤512 chars/segment, ≤9 reference images/job'),
    'the Seedance line states the model\'s own reference-image cap',
  );
});

test('contextBlock: the resolution enum and the Defaults line are the MODEL\'s, never a Kling constant', () => {
  // the enum once hardcoded 'kling.resolution ∈ {4k, 1080p, 720p}' — false for 2.5 (480p/720p only)
  const kling = contextBlock(baseCtx({ backend: 'kling-o3@fal', caps: capsFor('kling-o3@fal') }));
  assert.ok(kling.includes('kling.resolution ∈ {720p, 1080p, 4k}'));
  const sd20 = contextBlock(baseCtx({ backend: 'seedance-2.0@fal', caps: capsFor('seedance-2.0@fal') }));
  assert.ok(sd20.includes('kling.resolution ∈ {480p, 720p, 1080p, 4k}'));
  // and the Defaults line advertises the knob the render will READ (2.0's 480p, not KLING's 1080p);
  // a hand-assembled ctx without `resolution` derives it from the caps' own knob
  assert.ok(sd20.includes('resolution=480p,'), 'a Seedance plan is never told the Kling default');
  assert.ok(kling.includes('resolution=1080p,'));
  assert.ok(contextBlock(baseCtx({ backend: 'seedance', resolution: '720p' })).includes('resolution=720p,'), 'an explicit ctx.resolution (the per-run pick) wins');
});

test('the Seedance packing rule keys off caps.family, not a literal backend string', () => {
  const RULE = '- Seedance packing rule: every job must total 4–15s';
  assert.ok(contextBlock(baseCtx({ backend: 'seedance-2.0@fal', caps: capsFor('seedance-2.0@fal') })).includes(RULE));
  assert.ok(!contextBlock(baseCtx({ backend: 'kling-o3@fal', caps: capsFor('kling-o3@fal') })).includes(RULE));
});

test('contextBlock tolerates a ctx WITHOUT caps by deriving them from ctx.backend', () => {
  // Existing unit tests (engine-ttv-guidance, engine-environment) hand-build a ctx literal with a
  // legacy backend name and no caps — contextBlock must keep working for them.
  const legacy = contextBlock(baseCtx({ backend: 'seedance' }));
  assert.ok(legacy.includes('- Seedance packing rule: every job must total 4–15s'));
  assert.ok(legacy.includes('- Hard caps: ≤6 shots/job, ≤15s/job, ≤512 chars/segment, ≤9 reference images/job'));
  assert.ok(!contextBlock(baseCtx({ backend: 'kling' })).includes('- Seedance packing rule'));
});

// ── isTextToVideoPlan keys off the family ───────────────────────────────────
test('isTextToVideoPlan: family-driven, so every Seedance id (incl. 2.5) behaves the same', () => {
  for (const be of ['seedance', 'seedance-2.0@fal', 'seedance-2.5']) {
    assert.equal(isTextToVideoPlan({ backend: be, cast: [], refCount: 0 }), true, be);
    assert.equal(isTextToVideoPlan({ backend: be, cast: [], refCount: 20 }), false, be);
    assert.equal(isTextToVideoPlan({ backend: be, cast: ['wren'], refCount: 0 }), false, be);
  }
  for (const be of ['kling', 'kling-o3@fal']) {
    assert.equal(isTextToVideoPlan({ backend: be, cast: [], refCount: 0 }), false, be);
  }
});
