// The provider/model registry — the single source of truth for "which model, on which provider,
// with which caps". Two properties make it load-bearing, and both are pinned by
// test/unit/render-models.test.js:
//
//   1. ZERO IMPORTS (no static/dynamic import, no require, no env reads). That is what lets
//      web/server statically pull it in without dragging config.js — and a developer's real .env —
//      into the server's import graph (the leak canary in
//      web/server/test/integration/environments.test.js guards the other side of that rule).
//      Endpoints are therefore stored as CONFIG KEY NAMES (`endpointKey: 'klingEndpoint'`) and
//      resolved by the caller at call time, never read here.
//   2. Backend ids are COMPOUND — `<model>@<provider>` — with the legacy 'kling'/'seedance' names
//      kept as permanent aliases, so old spec.json / manifest.json files keep working with NO
//      migration. The id stays ONE string everywhere (--backend, spec.render_backend, manifests,
//      the estimator, the UI), so adding a provider changes no plumbing shape.
//
// Adding a model/provider = one entry below. BACKEND_IDS, RENDERERS (pipeline.js), the schema's
// backend list, the estimator keys and the UI's pickers all derive from it.

/** Render providers. `segmind` is declared so the axis exists; its model entries land next phase. */
export const PROVIDERS = {
  fal: { id: 'fal', label: 'fal' },
  segmind: { id: 'segmind', label: 'Segmind' },
};

// Model-level fields (label, family, castLimit, aspects) describe the MODEL wherever it runs;
// `providers.<id>` carries what differs per endpoint. capsFor() shallow-merges the two, provider
// winning, so a provider may override a model default without duplicating the rest.
export const RENDER_MODELS = {
  'kling-o3': {
    label: 'Kling 3.0 Omni',
    // The picker's compact spelling. A model whose full label already fits a segment omits it, and
    // every caller falls back to `label` — so this is a display detail, never a second name: the UI
    // reads it from HERE rather than keeping its own segment table (CreateHero.registry.test.tsx).
    shortLabel: 'Kling',
    family: 'kling',
    castLimit: 1, // one starred cast member — Kling takes a single elements set per job
    aspects: ['16:9', '9:16', '1:1'],
    // NO selectable resolution: fal's Kling o3 endpoint schema takes prompt/frames/refs/duration/
    // aspect_ratio and nothing else — no resolution parameter exists, output size is the endpoint's
    // own (verified against the fal API tab, Aug 2026). An empty ladder makes every surface hide the
    // control and the API reject a pick, instead of selling a tier the render cannot honor (the old
    // KLING_RESOLUTION knob was exactly that: parsed, displayed, priced — never sent). The delivered
    // size is still shown truthfully everywhere it matters, measured off the master (shortSide).
    resolutions: [],
    providers: {
      fal: {
        endpointKey: 'klingEndpoint',
        textEndpointKey: 'klingTextEndpoint',
        maxImages: 7,
        maxRefsPerElement: 3,
        minSeconds: 1,
        maxSeconds: 15,
        maxSegments: 6,
        maxSegmentChars: 512,
        durationType: 'string',
        nativeFirstFrame: true,
        nativeLastFrame: true,
        supportsSeed: false,
        supportsVoiceId: true,
        supportsElements: true,
        multiShot: 'multi_prompt',
      },
    },
  },
  'seedance-2.0': {
    label: 'Seedance 2.0',
    family: 'seedance',
    castLimit: 2,
    aspects: ['16:9', '9:16', '1:1'],
    // Model-level resolution facts (see the kling-o3 note). Both provider entries restate the same
    // ladder — the model renders the same tiers on either queue, so neither may drift alone.
    resolutions: ['480p', '720p', '1080p', '4k'],
    defaultResolution: '480p',
    resolutionEnv: 'SEEDANCE_RESOLUTION',
    providers: {
      fal: {
        endpointKey: 'seedanceEndpoint',
        probeEndpointKey: 'seedanceProbeEndpoint',
        textEndpointKey: 'seedanceTextEndpoint',
        maxImages: 9,
        maxAudioRefs: 3,
        audioBudgetS: 15,
        minSeconds: 4,
        maxSeconds: 15,
        durationType: 'string',
        resolutions: ['480p', '720p', '1080p', '4k'],
        defaultResolution: '480p',
        nativeFirstFrame: false,
        nativeLastFrame: false,
        supportsSeed: false,
        bannedArgs: ['seed', 'negative_prompt'], // fal's 2.0 endpoint 422s on either
        refStyle: 'compact',
        shotSyntax: 'connectors',
        argMap: { images: 'image_urls', audios: 'audio_urls', videos: null, firstFrame: null, lastFrame: null },
      },
      // The SAME model on Segmind is a different endpoint contract: it is addressed by model SLUG
      // (`slugKey`, resolved against config.segmind exactly as `endpointKey` is against config.fal),
      // it takes an INTEGER duration, it accepts a seed, and it has real first/last-frame slots —
      // which are MUTUALLY EXCLUSIVE with reference_images, hence firstFrameExcludesRefs.
      segmind: {
        slugKey: 'seedance20Slug',
        maxImages: 9,
        maxAudioRefs: 3,
        maxVideoRefs: 3,
        audioBudgetS: 15,
        minSeconds: 4,
        maxSeconds: 15,
        durationType: 'int',
        resolutions: ['480p', '720p', '1080p', '4k'],
        defaultResolution: '480p',
        // Six ratios live HERE rather than at model level: fal's 2.0 endpoint renders three and 422s
        // on the rest, so the model-level list must not widen underneath `seedance-2.0@fal`.
        aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
        nativeFirstFrame: true,
        nativeLastFrame: true,
        firstFrameExcludesRefs: true,
        supportsSeed: true, // fal's 2.0 endpoint 422s on a seed; Segmind's takes one
        supportsReturnLastFrame: true,
        refStyle: 'spaced',
        shotSyntax: 'connectors',
        knobsKey: 'seedance', // the shared 2.0 knobs block (resolution, probe resolution, style…)
        argMap: {
          images: 'reference_images', audios: 'reference_audios', videos: 'reference_videos',
          firstFrame: 'first_frame_url', lastFrame: 'last_frame_url',
        },
      },
    },
  },
  'seedance-2.5': {
    label: 'Seedance 2.5',
    family: 'seedance',
    castLimit: 4,
    aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    // 480p|720p ONLY, and its own knob: 2.5 bills and renders differently from 2.0 (config.seedance25).
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    resolutionEnv: 'SEEDANCE25_RESOLUTION',
    providers: {
      fal: {
        endpointKey: 'seedance25Endpoint',
        probeEndpointKey: 'seedance25ProbeEndpoint',
        // No textEndpointKey: fal's 2.5 has no separate text tier on this family, so a job with zero
        // image refs rides THIS endpoint (the renderer falls through to it, probe variant included).
        // fal budgets 2.5's references ACROSS modalities — 50 combined, no per-kind limit published.
        // The per-kind numbers are therefore high-water marks inside that budget, and
        // `maxCombinedRefs` is the cap that actually bites (enforced in seedance-args.js).
        maxImages: 50,
        maxAudioRefs: 10,
        maxVideoRefs: 50,
        maxCombinedRefs: 50,
        audioBudgetS: 30,
        // duration is a STRING here, as on fal's 2.0 endpoint ('auto' is also accepted by the
        // endpoint; this build always computes a numeric duration, so it is never emitted).
        minSeconds: 4,
        maxSeconds: 30,
        durationType: 'string',
        // 480p|720p ONLY (24 fps native) — 1080p comes from approve's Topaz upscale, not from here.
        resolutions: ['480p', '720p'],
        defaultResolution: '720p',
        // The reference-to-video endpoint carries NO frame anchors at all (they live on the separate
        // image-to-video endpoint), so a seam frame is always demoted to a trailing image ref + a
        // prompt pin — byte-for-byte the strategy fal Seedance 2.0 already uses.
        nativeFirstFrame: false,
        nativeLastFrame: false,
        supportsSeed: true, // unlike fal's 2.0 endpoint, which 422s on `seed`
        supportsReturnLastFrame: false,
        refStyle: 'bracket',
        shotSyntax: 'numbered',
        knobsKey: 'seedance25', // its own user-tunable block (config.seedance25), falling back to config.seedance
        argMap: { images: 'image_urls', audios: 'audio_urls', videos: 'video_urls', firstFrame: null, lastFrame: null },
      },
      // Segmind publishes per-kind reference caps instead of fal's combined budget, so there is no
      // `maxCombinedRefs` here — the per-kind numbers ARE the limits. Its reference audio also has a
      // stated 2s FLOOR (a shorter clip is a hard 422 on an already-paid submit), which is what
      // `audioPerClipS` exists for; the renderer drops such a clip instead of shipping it.
      segmind: {
        slugKey: 'seedance25Slug',
        maxImages: 30,
        maxAudioRefs: 10,
        maxVideoRefs: 10,
        audioBudgetS: 30,
        audioPerClipS: [2, 30],
        minSeconds: 4,
        maxSeconds: 30,
        durationType: 'int',
        resolutions: ['480p', '720p'],
        defaultResolution: '720p',
        aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
        nativeFirstFrame: true,
        nativeLastFrame: true,
        firstFrameExcludesRefs: true,
        supportsSeed: true,
        supportsReturnLastFrame: true,
        refStyle: 'spaced',
        shotSyntax: 'numbered',
        knobsKey: 'seedance25',
        argMap: {
          images: 'reference_images', audios: 'reference_audios', videos: 'reference_videos',
          firstFrame: 'first_frame_url', lastFrame: 'last_frame_url',
        },
      },
    },
  },
};

// The old one-word backend names, kept accepted forever so nothing on disk needs migrating.
const LEGACY_ALIASES = { kling: 'kling-o3@fal', seedance: 'seedance-2.0@fal' };

/** Every renderable backend id — derived, so a model without a provider entry simply has none. */
export const BACKEND_IDS = Object.entries(RENDER_MODELS)
  .flatMap(([model, entry]) => Object.keys(entry.providers ?? {}).map((provider) => `${model}@${provider}`));

export const LEGACY_BACKENDS = Object.keys(LEGACY_ALIASES);

/** Everything a user may type or a spec may carry: canonical ids first, then the legacy aliases. */
export const ALL_BACKENDS = [...BACKEND_IDS, ...LEGACY_BACKENDS];

/**
 * Resolve any accepted backend spelling to its canonical form.
 * @param {string} value  'kling' | 'seedance' (legacy) or '<model>@<provider>'
 * @param {{hint?:string}} [opts]  extra parenthetical for the error (e.g. how to set the backend)
 * @returns {{id:string, model:string, provider:string, legacy:boolean}}
 */
export function normalizeBackend(value, { hint = '' } = {}) {
  if (typeof value === 'string') {
    const raw = value.trim();
    const alias = Object.hasOwn(LEGACY_ALIASES, raw) ? LEGACY_ALIASES[raw] : undefined;
    const id = alias ?? raw;
    const parts = id.split('@');
    if (parts.length === 2) {
      const [model, provider] = parts;
      // Own-property lookups ONLY: 'kling-o3@__proto__' or 'seedance-2.0@constructor' would match
      // inherited object properties, validate as a backend, and queue paid planning for an entry
      // no renderer can ever serve.
      if (Object.hasOwn(RENDER_MODELS, model) && Object.hasOwn(RENDER_MODELS[model].providers ?? {}, provider)) {
        return { id, model, provider, legacy: Boolean(alias) };
      }
    }
  }
  throw new Error(`Unknown render backend "${String(value)}" — use one of: ${ALL_BACKENDS.join(', ')}${hint ? ` (${hint})` : ''}.`);
}

/**
 * The merged caps for a backend id: model fields ⊕ provider entry (provider wins) ⊕ the derived
 * identity fields. Always a fresh deep copy — callers stash caps on a ctx and hand them to pure
 * builders, so a stray mutation must never reach the registry.
 * @param {string} id  a backend id (compound or legacy alias)
 */
export function capsFor(id) {
  if (typeof id === 'string' && Object.hasOwn(RENDER_MODELS, id)) {
    // A bare model id is not a backend id: it says nothing about where the render runs.
    const ids = Object.keys(RENDER_MODELS[id].providers ?? {}).map((p) => `${id}@${p}`);
    throw new Error(ids.length
      ? `Render model "${id}" needs a provider — use one of: ${ids.join(', ')}.`
      : `Render model "${id}" has no provider entry yet — nothing in this build can render it.`);
  }
  const { id: backendId, model, provider } = normalizeBackend(id);
  const entry = RENDER_MODELS[model];
  const caps = structuredClone({ ...entry, ...entry.providers[provider] });
  delete caps.providers; // the sub-object is plumbing, never part of a caps bundle
  return {
    ...caps,
    id: backendId,
    model,
    provider,
    family: entry.family,
    label: entry.label,
    providerLabel: PROVIDERS[provider].label,
  };
}

// castLimitFor/aspectsFor deliberately accept a BARE MODEL ID as well as a backend id, so a model
// whose provider entries have not landed yet still answers "how many cast members?" and "which
// ratios?" — that is what keeps adding a provider a one-line registry change. Given a BACKEND id
// they follow capsFor's precedence (provider entry ⊕ model), because some facts are per (model,
// provider): Seedance 2.0 renders six ratios on Segmind and three on fal, from one model entry.
function lookup(value) {
  if (typeof value === 'string' && Object.hasOwn(RENDER_MODELS, value)) return { model: RENDER_MODELS[value], entry: null };
  const { model, provider } = normalizeBackend(value);
  return { model: RENDER_MODELS[model], entry: RENDER_MODELS[model].providers[provider] };
}

/** One merged field, provider entry winning over the model default (a bare model id has no entry). */
function fieldFor(value, key) {
  const { model, entry } = lookup(value);
  return entry?.[key] ?? model[key];
}

/** Max starred cast members for a model/backend. Enforced in the engine, the server and the UI. */
export const castLimitFor = (value) => fieldFor(value, 'castLimit');

/** The selectable aspect ratios (a copy). Numeric only — 'adaptive'/'auto' stay unexposed. */
export const aspectsFor = (value) => [...fieldFor(value, 'aspects')];

/** The render resolutions this model offers (a copy), lowest tier first. */
export const resolutionsFor = (value) => [...fieldFor(value, 'resolutions')];

/** The model's own default resolution — what its config knob falls back to when the .env is silent. */
export const defaultResolutionFor = (value) => fieldFor(value, 'defaultResolution');

/**
 * The .env variable this model's render resolution is read from (config.js). Per MODEL, never per
 * provider: the same Seedance reads the same knob on fal and on Segmind. Every surface that writes
 * or prices a resolution default resolves the knob through here, so none can write one the render
 * child will not read.
 */
export const resolutionEnvFor = (value) => fieldFor(value, 'resolutionEnv');

/**
 * How this model cites a reference in a prompt: '@Image1' (compact, today's shipping style),
 * '@Image 1' (spaced) or '[Image1]' (bracket). Kept here so the prompt builders never fork.
 * @param {{refStyle?:string}} caps
 * @param {'Image'|'Audio'|'Video'} kind
 * @param {number} n  1-based reference index
 */
/**
 * Whether an opening frame consumes one of this model's ordinary image slots when references are
 * present: true when there is no native first-frame slot at all, and also when the native slot is
 * mutually exclusive with reference images (Segmind's shape). The single source for the seam-slot
 * budget — spec-schema's validation and the render paths must never disagree on it.
 */
export const demotesOpeningFrame = (caps) =>
  !caps.nativeFirstFrame
  // `argMap` is the Seedance builder's key table: an entry that declares one and leaves `firstFrame`
  // null has no anchor argument to put the frame in. An entry with NO argMap at all (Kling, whose
  // renderer builds its own payload) is not saying "no slot" — its nativeFirstFrame flag stands.
  || (caps.argMap ? !caps.argMap.firstFrame : false)
  || Boolean(caps.firstFrameExcludesRefs);

export function refLabel(caps, kind, n) {
  const k = String(kind).charAt(0).toUpperCase() + String(kind).slice(1);
  const style = caps?.refStyle ?? 'compact';
  if (style === 'bracket') return `[${k}${n}]`;
  if (style === 'spaced') return `@${k} ${n}`;
  return `@${k}${n}`;
}
