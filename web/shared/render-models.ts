// Typed facade over the provider/model registry (src/lib/render-models.js) for the browser bundle.
// The UI must never re-declare a cast cap, a ratio list, a model name or a provider list in
// TypeScript: every per-model fact the create page shows is read through here, so the registry stays
// the single place any of them can change (web/ui/src/components/home/CreateHero.registry.test.tsx
// asserts the two agree, reading the registry module directly).
//
// Importing the registry from the UI is safe for exactly the reason the Fastify server may import it:
// it is plain ESM with ZERO imports and no env reads, so it drags neither config.js nor node builtins
// into the bundle. This file adds only types — plus the model-id/label/provider lookups the registry
// keeps internal — and holds no data of its own.
import {
  ALL_BACKENDS as REGISTRY_BACKENDS,
  PROVIDERS,
  RENDER_MODELS,
  aspectsFor as registryAspectsFor,
  capsFor as registryCapsFor,
  castLimitFor as registryCastLimitFor,
  normalizeBackend as registryNormalizeBackend,
} from '../../src/lib/render-models.js';
import type { Aspect, Backend } from './api-types';

// The registry is untyped JS; describe here only the fields the UI actually reads.
interface ModelEntry { label: string; shortLabel?: string; castLimit: number; aspects: Aspect[]; providers: Record<string, unknown> }
const MODELS = RENDER_MODELS as Record<string, ModelEntry>;
const PROVIDER_TABLE = PROVIDERS as Record<string, { id: string; label: string }>;
const normalize = registryNormalizeBackend as (value: string) => { id: string; model: string; provider: string };

/** Every accepted backend id: the canonical `<model>@<provider>` ids plus the legacy one-word aliases. */
export const ALL_BACKENDS = REGISTRY_BACKENDS as Backend[];

/** Every model in the registry, in registry order — the picker's segments come from this, so a new
 *  registry entry appears in the UI with no edit here or in the component. */
export const MODEL_IDS: string[] = Object.keys(MODELS);

/** The bare model id behind any backend id ('seedance' → 'seedance-2.0'); a bare model id passes through. */
export function modelIdFor(value: string): string {
  return MODELS[value] ? value : normalize(value).model;
}

/** Display name of the model behind a backend id ('kling' → 'Kling 3.0 Omni'). */
export const modelLabelFor = (value: string): string => MODELS[modelIdFor(value)]!.label;

/** The compact spelling a segmented control shows ('kling' → 'Kling'); falls back to the full label. */
export const modelSegmentLabelFor = (value: string): string => {
  const m = MODELS[modelIdFor(value)]!;
  return m.shortLabel ?? m.label;
};

export interface ProviderOption { id: string; label: string }

/** Where this model can render, in registry order. Empty = the model ships no provider entry yet
 *  (declared model-level first, as 2.5 was), which is exactly why the picker filters on it. */
export function providersFor(value: string): ProviderOption[] {
  return Object.keys(MODELS[modelIdFor(value)]?.providers ?? {})
    .map((id) => ({ id, label: PROVIDER_TABLE[id]!.label }));
}

/** Which provider a backend id names ('seedance' → 'fal', 'seedance-2.5@segmind' → 'segmind'). */
export const providerIdFor = (value: Backend | string): string => normalize(value).provider;

/** The provider's display name for a backend id ('seedance-2.5@segmind' → 'Segmind'). */
export const providerLabelFor = (value: Backend | string): string => PROVIDER_TABLE[providerIdFor(value)]!.label;

/** Canonical `<model>@<provider>` form of any accepted spelling ('kling' → 'kling-o3@fal'). */
export const canonicalBackendFor = (value: Backend | string): Backend => normalize(value).id as Backend;

/**
 * The backend id for a (model, provider) pair. A provider the model does not run on falls back to the
 * model's first — picking Segmind and then switching to a fal-only model must land on something
 * renderable rather than on an id the server would 400.
 */
export function backendIdFor(model: string, provider: string): Backend {
  const options = providersFor(model);
  const pick = options.find((p) => p.id === provider) ?? options[0];
  if (!pick) throw new Error(`render model "${model}" has no provider entry — nothing can render it`);
  return `${modelIdFor(model)}@${pick.id}` as Backend;
}

// Both take a backend id OR a bare model id, exactly like the registry helpers they wrap — that is
// what lets a model be asserted (and later offered) before it has a provider entry.
/** How many characters this model can carry in one plan. */
export const castLimitFor = (value: string): number => registryCastLimitFor(value) as number;
/** The ratios this model renders, in menu order (never 'adaptive'/'auto'). */
export const aspectsFor = (value: string): Aspect[] => registryAspectsFor(value) as Aspect[];

// ── Seams: how strongly this backend can pin a boundary frame (WS2-P5) ──────────────────────────
//
// The re-render dialog has to SAY, before anything is paid for, how a boundary frame will be
// applied — and only a real first/last-frame anchor may ever be called "seamless". The renderer's
// own answer is `chooseSeamMode` in src/lib/prompt-compose.js, which the browser cannot import (it
// pulls in node:crypto for the prompt fingerprint), so the rule is mirrored here over the SAME caps
// bundle and pinned by a parity test asserting the two agree over every backend × cast count
// (web/ui/src/components/run/review/SegmentRerenderDialog.test.tsx). Never edit one without the
// other: a dialog that promised a seam the renderer only approximates would be selling a guarantee
// the model never gave.

/** How a boundary frame gets applied: a true anchor, a reference-guided likeness, or nothing. */
export type PinStrength = 'native' | 'soft' | 'none';

/** Only the caps fields the seam rule reads — the registry is untyped JS. */
interface SeamCaps {
  family?: string;
  nativeFirstFrame?: boolean;
  nativeLastFrame?: boolean;
  firstFrameExcludesRefs?: boolean;
  argMap?: Record<string, string | null> | null;
}

/** The merged caps bundle for a backend id (throws on an id no provider entry serves). */
export const capsFor = (value: Backend | string): SeamCaps => registryCapsFor(value) as SeamCaps;

/** Does this model have a usable anchor argument for that end? (mirrors prompt-compose's nativeSlot) */
const nativeSlot = (caps: SeamCaps, end: 'in' | 'out'): boolean => Boolean(
  end === 'in'
    ? caps.nativeFirstFrame && (caps.argMap ? caps.argMap.firstFrame : true)
    : caps.nativeLastFrame && (caps.argMap ? caps.argMap.lastFrame : true),
);

/**
 * How a boundary frame WOULD be applied at one end of one segment, given how many cast references
 * that segment carries. Mirrors `chooseSeamMode(...).in|out.mode` for a boundary that exists; an
 * end with no frame at all is the caller's own 'none', not this function's business.
 */
export function pinStrengthFor(
  backend: Backend | string,
  { castRefCount = 0, end }: { castRefCount?: number; end: 'in' | 'out' },
): PinStrength {
  let caps: SeamCaps;
  try {
    caps = capsFor(backend);
  } catch {
    // An id this build cannot resolve promises nothing — the weakest honest answer, never 'native'.
    return 'soft';
  }
  if (!nativeSlot(caps, end)) return 'soft';
  // Kling seeds a frame through its Elements set: a text-to-video job has nothing to attach it to.
  if (caps.family === 'kling') return castRefCount > 0 ? 'native' : 'none';
  // Segmind's native slots are mutually exclusive with reference_images: the renderer keeps the
  // cast (identity) and pins by reference rather than render a stranger on a perfect seam.
  if (caps.firstFrameExcludesRefs && castRefCount > 0) return 'soft';
  return 'native';
}
