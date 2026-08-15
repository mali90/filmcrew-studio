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
  defaultResolutionFor as registryDefaultResolutionFor,
  normalizeBackend as registryNormalizeBackend,
  resolutionEnvFor as registryResolutionEnvFor,
  resolutionsFor as registryResolutionsFor,
} from '../../src/lib/render-models.js';
import type { Aspect, Backend, Resolution } from './api-types';

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
/** The render tiers this model offers, lowest first — the resolution control's segments. */
export const resolutionsFor = (value: string): Resolution[] => registryResolutionsFor(value) as Resolution[];
/** The model's own default tier (its config knob's fallback, before any .env override). */
export const defaultResolutionFor = (value: string): Resolution => registryDefaultResolutionFor(value) as Resolution;
/** The .env knob this model's resolution rides (KLING_RESOLUTION / SEEDANCE_RESOLUTION /
 *  SEEDANCE25_RESOLUTION) — what the wizard's buildUpdates writes, per MODEL, never per provider. */
export const resolutionEnvFor = (value: string): string => registryResolutionEnvFor(value) as string;

// ── Seams: how strongly this backend can pin a boundary frame (WS2-P5) ──────────────────────────
//
// The re-render dialog has to SAY, before anything is paid for, how a boundary frame will be
// applied — and only a real first/last-frame anchor may ever be called "seamless". There is exactly
// ONE implementation of that rule (src/lib/seam-rule.js, which the renderers, web/server and this
// bundle all import); the functions below only type it and default its arguments. It is safe in the
// browser for the same reason the registry is: zero env reads, no node builtins, no config.
import {
  chooseSeamMode as registryChooseSeamMode,
  pinStrengths as registryPinStrengths,
  castRefCountFor as registryCastRefCountFor,
} from '../../src/lib/seam-rule.js';

/** How a boundary frame gets applied: a true anchor, a reference-guided likeness, or nothing. */
export type PinStrength = 'native' | 'soft' | 'none';

/** Only the caps fields the seam rule reads — the registry is untyped JS. */
interface SeamCaps {
  family?: string;
  nativeFirstFrame?: boolean;
  nativeLastFrame?: boolean;
  firstFrameExcludesRefs?: boolean;
  maxImages?: number;
  maxCombinedRefs?: number | null;
  argMap?: Record<string, string | null> | null;
}

/** The merged caps bundle for a backend id (throws on an id no provider entry serves). */
export const capsFor = (value: Backend | string): SeamCaps => registryCapsFor(value) as SeamCaps;

type SeamArgs = { caps: SeamCaps; castRefCount?: number; hasSeamIn?: boolean; hasSeamOut?: boolean };
const chooseSeamMode = registryChooseSeamMode as (p: SeamArgs) => { in: { mode: PinStrength }; out: { mode: PinStrength } };
const pinStrengths = registryPinStrengths as (p: SeamArgs & { otherRefCount?: number }) => { in: PinStrength; out: PinStrength };

/**
 * How many cast image references a segment carries — the one thing the seam rule asks about the
 * cast. A job that names no elements inherits the WHOLE roster (N paid uploads), not zero, which is
 * why this is read from the registry helper rather than spelled out at each call site.
 */
export const castRefCountFor = registryCastRefCountFor as (spec: unknown, jobId: string) => number;

/**
 * Can this backend pin that end AT ALL? The model's own answer (`chooseSeamMode`), with no
 * reference-budget arithmetic: used for capability probes ("does a closing pin even exist here?"),
 * never to promise a user a particular join — that is `pinStrengthsFor` below.
 */
export function pinStrengthFor(
  backend: Backend | string,
  { castRefCount = 0, end }: { castRefCount?: number; end: 'in' | 'out' },
): PinStrength {
  let caps: SeamCaps;
  try {
    caps = capsFor(backend);
  } catch {
    // An id this build cannot resolve promises nothing — the weakest honest answer. 'soft' would
    // read as "near-seamless (reference-guided)" in the UI, which is a promise, not an unknown.
    return 'none';
  }
  const seam = chooseSeamMode({ caps, castRefCount, hasSeamIn: end === 'in', hasSeamOut: end === 'out' });
  return end === 'in' ? seam.in.mode : seam.out.mode;
}

/**
 * How both ends WOULD really be pinned, reference budget included — what the dialog's plain-words
 * sentence is built from. A soft pin only holds while there is an image slot left for it: at a full
 * cast, SEAM_PRIORITY drops the closing pin, then the opening one, and the renderer records the
 * joint as a scene cut. Selling "near-seamless" for a pin that will be dropped is the one thing
 * this must never do, so both ends are asked together (they compete for the same slots).
 *
 * `otherRefCount` is what the same job already spends out of a COMBINED budget — its voice clips,
 * on a model that counts images + audio + video against one cap (fal Seedance 2.5). Those slots are
 * gone before a pin can have one (nothing drops a voice clip), and the browser cannot read the
 * voices dir, so the count arrives on the run payload as `voiceRefs`.
 */
export function pinStrengthsFor(
  backend: Backend | string,
  { castRefCount = 0, otherRefCount = 0, hasSeamIn = false, hasSeamOut = false }:
    { castRefCount?: number; otherRefCount?: number; hasSeamIn?: boolean; hasSeamOut?: boolean },
): { in: PinStrength; out: PinStrength } {
  let caps: SeamCaps;
  try {
    caps = capsFor(backend);
  } catch {
    return { in: 'none', out: 'none' };
  }
  return pinStrengths({ caps, castRefCount, otherRefCount, hasSeamIn, hasSeamOut });
}
