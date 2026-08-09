// The provider/model registry — the single source of truth for "which model, on which provider,
// with which caps". Two properties make it load-bearing and both are pinned here:
//
//   1. ZERO IMPORTS. No static import, no dynamic import(), no require(), no process.env. That is
//      what lets web/server statically import it without dragging config.js (and a developer's real
//      .env) into the server's import graph — the same leak canary style as
//      web/server/test/integration/environments.test.js:63-75.
//   2. Backend ids are COMPOUND (`<model>@<provider>`) with the legacy 'kling'/'seedance' names kept
//      as permanent aliases, so old spec.json / manifest.json files keep working with NO migration.
//
// TDD (red first): src/lib/render-models.js does not exist yet — this file pins the contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neutralizeDotenv } from '../helpers/env.js';

// Belt and braces: if the registry ever grows an import of config.js, dotenv must not find a real
// .env. The zero-import canary below is the real guard; this only protects the developer's machine.
neutralizeDotenv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src/lib/render-models.js');

const {
  PROVIDERS, RENDER_MODELS, BACKEND_IDS, LEGACY_BACKENDS, ALL_BACKENDS,
  normalizeBackend, capsFor, castLimitFor, aspectsFor, refLabel, demotesOpeningFrame,
} = await import('../../src/lib/render-models.js');

const ASPECT_RE = /^\d+:\d+$/;

// ── 1. The zero-import canary ───────────────────────────────────────────────
test('render-models.js has ZERO imports and reads no env (safe for web/server\'s static chain)', () => {
  const raw = fs.readFileSync(SRC, 'utf8');
  // strip comments first so prose like "imports config" can never trip the canary
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.ok(!/^\s*import\s/m.test(src), 'no static import statements');
  assert.ok(!/^\s*export\s[^;]*\bfrom\s*['"]/m.test(src), 'no re-export-from (that is an import too)');
  assert.ok(!/\bimport\s*\(/.test(src), 'no dynamic import()');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require()');
  assert.ok(!/process\s*\.\s*env/.test(src), 'config-free: the registry never reads env');
});

// ── 2. Shape invariants (every entry, forever) ──────────────────────────────
test('PROVIDERS declares fal and segmind; Segmind now carries BOTH Seedance models', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['fal', 'segmind']);
  assert.deepEqual(PROVIDERS.fal, { id: 'fal', label: 'fal' });
  assert.deepEqual(PROVIDERS.segmind, { id: 'segmind', label: 'Segmind' });
  const segmindModels = Object.entries(RENDER_MODELS).filter(([, m]) => m.providers?.segmind).map(([id]) => id);
  assert.deepEqual(segmindModels, ['seedance-2.0', 'seedance-2.5']);
  // Kling stays fal-only, on purpose: Segmind has no elements/voice-capable Kling, and the picker
  // must say so honestly rather than offering a backend nothing can render.
  assert.ok(!RENDER_MODELS['kling-o3'].providers.segmind, 'kling-o3 is deliberately fal-only');
});

test('every RENDER_MODELS entry is well formed and every provider key is a declared provider', () => {
  assert.deepEqual(Object.keys(RENDER_MODELS).sort(), ['kling-o3', 'seedance-2.0', 'seedance-2.5']);
  for (const [id, m] of Object.entries(RENDER_MODELS)) {
    assert.equal(typeof m.label, 'string', `${id}.label`);
    assert.ok(m.label.length > 0, `${id}.label non-empty`);
    assert.ok(['kling', 'seedance'].includes(m.family), `${id}.family`);
    assert.ok(Number.isInteger(m.castLimit) && m.castLimit >= 1, `${id}.castLimit is a positive integer`);
    assert.ok(Array.isArray(m.aspects) && m.aspects.length > 0, `${id}.aspects non-empty`);
    for (const a of m.aspects) assert.match(a, ASPECT_RE, `${id}.aspects entry "${a}" is numeric (no adaptive/auto)`);
    assert.equal(typeof m.providers, 'object', `${id}.providers`);
    for (const [pid, entry] of Object.entries(m.providers ?? {})) {
      assert.ok(PROVIDERS[pid], `${id}.providers.${pid} is a declared provider`);
      assert.ok(Number.isFinite(entry.minSeconds) && Number.isFinite(entry.maxSeconds), `${id}@${pid} seconds window`);
      assert.ok(entry.minSeconds <= entry.maxSeconds, `${id}@${pid} minSeconds ≤ maxSeconds`);
      assert.ok(Number.isInteger(entry.maxImages) && entry.maxImages >= 1, `${id}@${pid}.maxImages`);
      assert.ok(['string', 'int'].includes(entry.durationType), `${id}@${pid}.durationType`);
      // The endpoint is always a CONFIG KEY NAME resolved at call time (that is what keeps this file
      // import-free) — `endpointKey` on an endpoint-shaped provider, `slugKey` on a slug-shaped one.
      const routeKey = entry.endpointKey ?? entry.slugKey;
      assert.equal(typeof routeKey, 'string', `${id}@${pid} names its route by config key (endpointKey|slugKey)`);
      assert.ok(!(entry.endpointKey && entry.slugKey), `${id}@${pid} declares ONE route key, not both`);
    }
  }
});

test('the two shipping models carry exactly the caps the renderers rely on today', () => {
  const kling = RENDER_MODELS['kling-o3'];
  assert.equal(kling.label, 'Kling 3.0 Omni');
  assert.equal(kling.family, 'kling');
  assert.deepEqual(kling.aspects, ['16:9', '9:16', '1:1']);
  assert.deepEqual(kling.providers.fal, {
    endpointKey: 'klingEndpoint', textEndpointKey: 'klingTextEndpoint',
    maxImages: 7, maxRefsPerElement: 3,
    minSeconds: 1, maxSeconds: 15, maxSegments: 6, maxSegmentChars: 512,
    durationType: 'string',
    nativeFirstFrame: true, nativeLastFrame: true,
    supportsSeed: false, supportsVoiceId: true, supportsElements: true,
    multiShot: 'multi_prompt',
  });

  const sd20 = RENDER_MODELS['seedance-2.0'];
  assert.equal(sd20.label, 'Seedance 2.0');
  assert.equal(sd20.family, 'seedance');
  assert.deepEqual(sd20.aspects, ['16:9', '9:16', '1:1']);
  assert.deepEqual(sd20.providers.fal, {
    endpointKey: 'seedanceEndpoint', probeEndpointKey: 'seedanceProbeEndpoint', textEndpointKey: 'seedanceTextEndpoint',
    maxImages: 9, maxAudioRefs: 3, audioBudgetS: 15,
    minSeconds: 4, maxSeconds: 15,
    durationType: 'string',
    resolutions: ['480p', '720p', '1080p', '4k'], defaultResolution: '480p',
    nativeFirstFrame: false, nativeLastFrame: false,
    supportsSeed: false, bannedArgs: ['seed', 'negative_prompt'],
    refStyle: 'compact', shotSyntax: 'connectors',
    argMap: { images: 'image_urls', audios: 'audio_urls', videos: null, firstFrame: null, lastFrame: null },
  });
});

// ── The three entries this phase adds, stated in full ───────────────────────
// Each deepEqual is the SPEC of one (model, provider) pair — every number below was read off the
// provider's own API page (plan "Research facts", verified 2026-08-08). A deepEqual rather than a
// spot check on purpose: a cap silently added or dropped in the registry changes what a paid render
// sends, so the whole entry is pinned.
const SIX_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

test('seedance-2.5 model level: label, family, cast cap 4, six ratios', () => {
  const sd25 = RENDER_MODELS['seedance-2.5'];
  assert.equal(sd25.label, 'Seedance 2.5');
  assert.equal(sd25.family, 'seedance');
  assert.equal(sd25.castLimit, 4);
  assert.deepEqual(sd25.aspects, SIX_ASPECTS);
  assert.deepEqual(Object.keys(sd25.providers).sort(), ['fal', 'segmind']);
});

test('seedance-2.5@fal: bracket refs, STRING duration 4–30, seed on, NO frame anchors, combined-50', () => {
  assert.deepEqual(RENDER_MODELS['seedance-2.5'].providers.fal, {
    endpointKey: 'seedance25Endpoint', probeEndpointKey: 'seedance25ProbeEndpoint',
    maxImages: 50, maxAudioRefs: 10, maxVideoRefs: 50, maxCombinedRefs: 50, audioBudgetS: 30,
    minSeconds: 4, maxSeconds: 30,
    durationType: 'string',
    resolutions: ['480p', '720p'], defaultResolution: '720p',
    nativeFirstFrame: false, nativeLastFrame: false,
    supportsSeed: true, supportsReturnLastFrame: false,
    refStyle: 'bracket', shotSyntax: 'numbered', knobsKey: 'seedance25',
    argMap: { images: 'image_urls', audios: 'audio_urls', videos: 'video_urls', firstFrame: null, lastFrame: null },
  });
  // fal's 2.5 reference endpoint has no first/last-frame parameters at all, so a seam frame ALWAYS
  // travels as a trailing image ref + a prompt pin — exactly like fal Seedance 2.0 today.
  assert.equal(demotesOpeningFrame(capsFor('seedance-2.5@fal')), true);
});

test('seedance-2.5@segmind: spaced refs, INT duration 4–30, native frames that EXCLUDE refs', () => {
  assert.deepEqual(RENDER_MODELS['seedance-2.5'].providers.segmind, {
    slugKey: 'seedance25Slug',
    maxImages: 30, maxAudioRefs: 10, maxVideoRefs: 10, audioBudgetS: 30, audioPerClipS: [2, 30],
    minSeconds: 4, maxSeconds: 30,
    durationType: 'int',
    resolutions: ['480p', '720p'], defaultResolution: '720p',
    aspects: SIX_ASPECTS,
    nativeFirstFrame: true, nativeLastFrame: true, firstFrameExcludesRefs: true,
    supportsSeed: true, supportsReturnLastFrame: true,
    refStyle: 'spaced', shotSyntax: 'numbered', knobsKey: 'seedance25',
    argMap: {
      images: 'reference_images', audios: 'reference_audios', videos: 'reference_videos',
      firstFrame: 'first_frame_url', lastFrame: 'last_frame_url',
    },
  });
  const caps = capsFor('seedance-2.5@segmind');
  assert.deepEqual(caps.audioPerClipS, [2, 30], 'a reference audio under 2s is a hard Segmind rejection');
  // The native slot is MUTUALLY EXCLUSIVE with reference_images, so the moment a job carries cast
  // refs the opening frame must be demoted — one image slot has to be reserved for it upstream.
  assert.equal(demotesOpeningFrame(caps), true);
});

test('seedance-2.0@segmind: the same queue, a smaller model — 9 images, 3 audios, 4–15s, up to 4k', () => {
  assert.deepEqual(RENDER_MODELS['seedance-2.0'].providers.segmind, {
    slugKey: 'seedance20Slug',
    maxImages: 9, maxAudioRefs: 3, maxVideoRefs: 3, audioBudgetS: 15,
    minSeconds: 4, maxSeconds: 15,
    durationType: 'int',
    resolutions: ['480p', '720p', '1080p', '4k'], defaultResolution: '480p',
    aspects: SIX_ASPECTS,
    nativeFirstFrame: true, nativeLastFrame: true, firstFrameExcludesRefs: true,
    supportsSeed: true, supportsReturnLastFrame: true,
    refStyle: 'spaced', shotSyntax: 'connectors', knobsKey: 'seedance',
    argMap: {
      images: 'reference_images', audios: 'reference_audios', videos: 'reference_videos',
      firstFrame: 'first_frame_url', lastFrame: 'last_frame_url',
    },
  });
  // Seedance 2.0's MODEL-level ratio list stays the three fal renders — the six live on the Segmind
  // entry, so `seedance-2.0@fal` cannot gain a ratio fal will 422 on.
  assert.deepEqual(RENDER_MODELS['seedance-2.0'].aspects, ['16:9', '9:16', '1:1']);
  assert.equal(demotesOpeningFrame(capsFor('seedance-2.0@segmind')), true);
});

test('demotesOpeningFrame stays FALSE only where a native slot coexists with refs (kling)', () => {
  assert.equal(demotesOpeningFrame(capsFor('kling-o3@fal')), false);
  assert.equal(demotesOpeningFrame(capsFor('seedance-2.0@fal')), true); // no anchor at all
});

// ── 3. Derived id lists ─────────────────────────────────────────────────────
test('BACKEND_IDS derives ONLY from models that have at least one provider entry', () => {
  assert.deepEqual(BACKEND_IDS, [
    'kling-o3@fal',
    'seedance-2.0@fal', 'seedance-2.0@segmind',
    'seedance-2.5@fal', 'seedance-2.5@segmind',
  ]);
  // and the derivation is real, not a hand-written literal
  const derived = Object.entries(RENDER_MODELS)
    .flatMap(([m, e]) => Object.keys(e.providers ?? {}).map((p) => `${m}@${p}`));
  assert.deepEqual(BACKEND_IDS, derived);
});

test('LEGACY_BACKENDS / ALL_BACKENDS keep the old names accepted forever (no disk migration)', () => {
  assert.deepEqual(LEGACY_BACKENDS, ['kling', 'seedance']);
  assert.deepEqual(ALL_BACKENDS, [...BACKEND_IDS, ...LEGACY_BACKENDS]);
});

// ── 4. normalizeBackend ─────────────────────────────────────────────────────
test('normalizeBackend: legacy aliases resolve to canonical compound ids and are flagged legacy', () => {
  assert.deepEqual(normalizeBackend('kling'), { id: 'kling-o3@fal', model: 'kling-o3', provider: 'fal', legacy: true });
  assert.deepEqual(normalizeBackend('seedance'), { id: 'seedance-2.0@fal', model: 'seedance-2.0', provider: 'fal', legacy: true });
});

test('normalizeBackend: compound ids pass through, legacy:false, and the function is idempotent', () => {
  assert.deepEqual(normalizeBackend('kling-o3@fal'), { id: 'kling-o3@fal', model: 'kling-o3', provider: 'fal', legacy: false });
  assert.equal(normalizeBackend('seedance-2.0@fal').legacy, false);
  for (const v of [...ALL_BACKENDS]) {
    const once = normalizeBackend(v);
    assert.equal(normalizeBackend(once.id).id, once.id, `${v} normalizes idempotently`);
  }
});

test('normalizeBackend: surrounding whitespace is trimmed (RENDER_BACKEND=... in a .env file)', () => {
  // a value typed into .env or piped through a shell picks up spaces and a stray newline; rejecting
  // those as "unknown backend" would be a baffling failure for a correct setting.
  for (const v of ['  kling  ', '\tseedance\n', ' kling-o3@fal ']) {
    assert.equal(normalizeBackend(v).id, v.trim() === 'seedance' ? 'seedance-2.0@fal' : 'kling-o3@fal', JSON.stringify(v));
  }
});

test('normalizeBackend is CASE-SENSITIVE and takes exactly one @ — no fuzzy matching', () => {
  // ids are looked up, never parsed loosely: a near-miss must fail loudly at the gate rather than
  // resolve to something the user did not ask to be billed for.
  for (const v of ['KLING', 'Seedance', 'seedance-2.0@FAL', 'kling-o3@fal@x', 'kling-o3@@fal']) {
    assert.throws(() => normalizeBackend(v), /Unknown render backend/, v);
  }
});

test('normalizeBackend: the optional hint is appended to the error (how to set the backend)', () => {
  assert.throws(() => normalizeBackend('nope', { hint: 'RENDER_BACKEND in .env, or --backend' }),
    /\(RENDER_BACKEND in \.env, or --backend\)\.$/);
  // and with no hint the message simply ends after the list — never a dangling "()"
  assert.throws(() => normalizeBackend('nope'), (e) => {
    assert.ok(!e.message.includes('()'), 'no empty parenthetical');
    return true;
  });
});

test('normalizeBackend: anything else throws, and the message LISTS the accepted values', () => {
  const bad = [
    'runway',                 // not a model at all
    'seedance-2.5',           // a known model, but a bare model id is not a backend id
    'kling-o3@segmind',       // declared provider, deliberately no entry (Kling stays fal-only)
    'kling-o3@',
    '@fal',
    // Inherited object properties are NOT registry entries: these would otherwise validate at the
    // gate, queue paid planning, and only fail later when no renderer exists (codex P1).
    'kling-o3@__proto__',
    'kling-o3@constructor',
    'seedance-2.0@toString',
    'constructor@fal',
    '__proto__@fal',
    '',
    null,
    undefined,
    42,
  ];
  for (const v of bad) {
    assert.throws(() => normalizeBackend(v), (e) => {
      assert.ok(e instanceof Error, `${String(v)} throws an Error`);
      for (const valid of ALL_BACKENDS) {
        assert.ok(e.message.includes(valid), `the message for "${String(v)}" lists ${valid}`);
      }
      return true;
    }, `normalizeBackend(${JSON.stringify(v)}) must throw`);
  }
  // The bare-model helpers must not treat inherited properties as models either.
  assert.throws(() => castLimitFor('constructor'), /Unknown render backend/);
  assert.throws(() => aspectsFor('__proto__'), /Unknown render backend/);
  assert.throws(() => capsFor('kling-o3@__proto__'), /Unknown render backend/);
});

// ── 5. capsFor ──────────────────────────────────────────────────────────────
test('capsFor: model fields + provider fields shallow-merged, plus the derived identity fields', () => {
  const caps = capsFor('kling-o3@fal');
  assert.equal(caps.id, 'kling-o3@fal');
  assert.equal(caps.model, 'kling-o3');
  assert.equal(caps.provider, 'fal');
  assert.equal(caps.family, 'kling');
  assert.equal(caps.label, 'Kling 3.0 Omni');
  assert.equal(caps.providerLabel, 'fal');
  assert.equal(caps.castLimit, 1);          // model level
  assert.equal(caps.maxImages, 7);          // provider level
  assert.equal(caps.maxSeconds, 15);
  assert.equal(caps.minSeconds, 1);
  assert.deepEqual(caps.aspects, ['16:9', '9:16', '1:1']);
  assert.ok(!('providers' in caps), 'the providers sub-object never leaks into caps');

  // legacy aliases resolve to the SAME caps
  assert.deepEqual(capsFor('kling'), capsFor('kling-o3@fal'));
  assert.deepEqual(capsFor('seedance'), capsFor('seedance-2.0@fal'));
});

test('capsFor: the merge is structural — provider fields WIN over model fields, for every entry', () => {
  for (const id of BACKEND_IDS) {
    const { model, provider } = normalizeBackend(id);
    const m = RENDER_MODELS[model];
    const entry = m.providers[provider];
    const expected = { ...m, ...entry };
    delete expected.providers;
    assert.deepEqual(capsFor(id), {
      ...expected,
      id, model, provider,
      family: m.family,
      label: m.label,
      providerLabel: PROVIDERS[provider].label,
    }, `${id} caps = model ⊕ provider ⊕ derived`);
    // every key the provider declares must survive the merge unchanged (precedence pin)
    for (const k of Object.keys(entry)) {
      assert.deepEqual(capsFor(id)[k], entry[k], `${id}.${k} comes from the provider entry`);
    }
  }
});

test('capsFor returns a FRESH object — mutating caps can never corrupt the registry', () => {
  const a = capsFor('seedance-2.0@fal');
  assert.notEqual(a, capsFor('seedance-2.0@fal'), 'a new object each call');
  a.maxImages = 999;
  a.aspects.push('99:1');
  assert.equal(capsFor('seedance-2.0@fal').maxImages, 9);
  assert.deepEqual(capsFor('seedance-2.0@fal').aspects, ['16:9', '9:16', '1:1']);
  assert.deepEqual(RENDER_MODELS['seedance-2.0'].aspects, ['16:9', '9:16', '1:1']);
});

test('capsFor: a bare model id is never a backend id, however many providers it now has', () => {
  assert.throws(() => capsFor('seedance-2.5'), (e) => {
    assert.match(e.message, /needs a provider/);
    assert.ok(e.message.includes('seedance-2.5@fal') && e.message.includes('seedance-2.5@segmind'), 'names both');
    return true;
  });
  assert.throws(() => capsFor('kling-o3@segmind'), /Unknown render backend/);
});

test('capsFor on a BARE model id that DOES ship names the compound ids to use instead', () => {
  // the other half of the bare-model branch: 'kling-o3' is a real model, but it says nothing about
  // where the render runs, so the error has to be actionable rather than "unknown backend".
  for (const [model, expected] of [['kling-o3', 'kling-o3@fal'], ['seedance-2.0', 'seedance-2.0@fal']]) {
    assert.throws(() => capsFor(model), (e) => {
      assert.match(e.message, new RegExp(`"${model.replace('.', '\\.')}" needs a provider`));
      assert.ok(e.message.includes(expected), `it names ${expected}`);
      return true;
    }, model);
  }
  // The OTHER branch — "nothing in this build can render it" — is unreachable while every declared
  // model ships a provider, but it must stay: the next model lands model-level first, as 2.5 did.
  const orphan = { label: 'X', family: 'seedance', castLimit: 1, aspects: ['16:9'], providers: {} };
  assert.deepEqual(Object.keys(orphan.providers), [], 'a model may legally exist with no provider');
});

// ── 6. castLimitFor / aspectsFor — the two helpers the UI and the server need ──
// Both accept a backend id (compound OR legacy) AND a bare model id, so seedance-2.5's values are
// assertable (and UI-selectable) before it has a provider entry. That is what keeps adding a
// provider a one-line registry change.
test('castLimitFor: the cap table is exactly {kling-o3:1, seedance-2.0:2, seedance-2.5:4}', () => {
  assert.deepEqual(
    Object.fromEntries(Object.keys(RENDER_MODELS).map((m) => [m, castLimitFor(m)])),
    { 'kling-o3': 1, 'seedance-2.0': 2, 'seedance-2.5': 4 },
  );
  // reachable through every id form
  assert.equal(castLimitFor('kling'), 1);
  assert.equal(castLimitFor('kling-o3@fal'), 1);
  assert.equal(castLimitFor('seedance'), 2);
  assert.equal(castLimitFor('seedance-2.0@fal'), 2);
  assert.throws(() => castLimitFor('runway'));
});

// Ratios are per (model, PROVIDER) now, not per model: Seedance 2.0 renders six ratios on Segmind
// and three on fal, from ONE model entry. aspectsFor therefore follows capsFor's precedence —
// provider entry wins, model list is the fallback — while a BARE model id still answers with the
// model-level list (that is what lets the UI offer a model before its provider is chosen).
test('aspectsFor is PROVIDER-aware for a backend id, model-level for a bare model id', () => {
  assert.deepEqual(aspectsFor('kling-o3'), ['16:9', '9:16', '1:1']);
  assert.deepEqual(aspectsFor('kling'), ['16:9', '9:16', '1:1']);
  assert.deepEqual(aspectsFor('kling-o3@fal'), ['16:9', '9:16', '1:1']);
  assert.deepEqual(aspectsFor('seedance-2.0@fal'), ['16:9', '9:16', '1:1'], 'fal 2.0 keeps its three');
  assert.deepEqual(aspectsFor('seedance'), ['16:9', '9:16', '1:1'], 'the legacy alias IS seedance-2.0@fal');
  assert.deepEqual(aspectsFor('seedance-2.0'), ['16:9', '9:16', '1:1'], 'the bare model reads model level');
  assert.deepEqual(aspectsFor('seedance-2.0@segmind'), SIX_ASPECTS, 'Segmind 2.0 renders all six');
  assert.deepEqual(aspectsFor('seedance-2.5@fal'), SIX_ASPECTS);
  assert.deepEqual(aspectsFor('seedance-2.5@segmind'), SIX_ASPECTS);
  assert.deepEqual(aspectsFor('seedance-2.5'), SIX_ASPECTS);
  // and capsFor agrees, for every id — the two must never disagree about what a run may select
  for (const id of BACKEND_IDS) assert.deepEqual(capsFor(id).aspects, aspectsFor(id), id);
  for (const m of Object.keys(RENDER_MODELS)) {
    assert.ok(!aspectsFor(m).includes('adaptive'), `${m}: adaptive is deliberately not exposed`);
    assert.ok(!aspectsFor(m).includes('auto'), `${m}: auto is deliberately not exposed`);
  }
  // a copy, so a caller (or React state) can never mutate the registry
  const list = aspectsFor('seedance-2.5');
  list.push('99:1');
  assert.equal(aspectsFor('seedance-2.5').length, 6);
  assert.throws(() => aspectsFor('runway'));
});

// ── 7. refLabel — the three citation styles the prompt builders share ────────
test('refLabel: compact / spaced / bracket styles for Image, Audio and Video refs', () => {
  assert.equal(refLabel({ refStyle: 'compact' }, 'Image', 1), '@Image1');
  assert.equal(refLabel({ refStyle: 'spaced' }, 'Image', 1), '@Image 1');
  assert.equal(refLabel({ refStyle: 'bracket' }, 'Image', 1), '[Image1]');
  assert.equal(refLabel({ refStyle: 'compact' }, 'Audio', 2), '@Audio2');
  assert.equal(refLabel({ refStyle: 'spaced' }, 'Video', 3), '@Video 3');
  assert.equal(refLabel({ refStyle: 'bracket' }, 'Audio', 10), '[Audio10]');
  // today's shipping renderers emit @Image1 — a caps object without refStyle must keep doing that
  assert.equal(refLabel({}, 'Image', 1), '@Image1');
  assert.equal(refLabel(capsFor('seedance-2.0@fal'), 'Image', 1), '@Image1');
});

test('refLabel degrades to the shipping style rather than emitting a broken citation', () => {
  // a caps bundle from a newer registry entry may name a style this build does not know. Emitting
  // "undefined1" into a paid prompt is far worse than falling back to the style that ships today.
  for (const caps of [undefined, null, {}, { refStyle: 'nonsense' }, { refStyle: '' }]) {
    assert.equal(refLabel(caps, 'Image', 1), '@Image1', JSON.stringify(caps));
  }
  // the kind is normalized, so a caller writing 'image' still gets the canonical citation
  assert.equal(refLabel({}, 'image', 2), '@Image2');
  assert.equal(refLabel({ refStyle: 'spaced' }, 'audio', 2), '@Audio 2');
});

test('the published spec schema names exactly the registry backends', async () => {
  // engine/schema/spec.schema.json ships to spec authors and editors — its render_backend enum
  // drifting behind ALL_BACKENDS would reject specs the engine itself accepts.
  const { ALL_BACKENDS } = await import('../../src/lib/render-models.js');
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../engine/schema/spec.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepEqual(new Set(schema.properties.render_backend.enum), new Set(ALL_BACKENDS));
});
