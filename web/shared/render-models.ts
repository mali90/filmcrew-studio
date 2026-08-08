// Typed facade over the provider/model registry (src/lib/render-models.js) for the browser bundle.
// The UI must never re-declare a cast cap or a ratio list in TypeScript: every per-model number the
// create page shows is read through here, so the registry stays the single place a cap can change
// (web/ui/src/components/home/CreateHero.caps.test.tsx asserts the two agree).
//
// Importing the registry from the UI is safe for exactly the reason the Fastify server may import it:
// it is plain ESM with ZERO imports and no env reads, so it drags neither config.js nor node builtins
// into the bundle. This file adds only types — plus the model-id/label lookups the registry keeps
// internal — and holds no data of its own.
import {
  ALL_BACKENDS as REGISTRY_BACKENDS,
  RENDER_MODELS,
  aspectsFor as registryAspectsFor,
  castLimitFor as registryCastLimitFor,
  normalizeBackend,
} from '../../src/lib/render-models.js';
import type { Aspect, Backend } from './api-types';

// The registry is untyped JS; describe here only the fields the UI actually reads.
const MODELS = RENDER_MODELS as Record<string, { label: string; castLimit: number; aspects: Aspect[] }>;

/** Every accepted backend id: the canonical `<model>@<provider>` ids plus the legacy one-word aliases. */
export const ALL_BACKENDS = REGISTRY_BACKENDS as Backend[];

/** The bare model id behind any backend id ('seedance' → 'seedance-2.0'); a bare model id passes through. */
export function modelIdFor(value: string): string {
  return MODELS[value] ? value : (normalizeBackend(value) as { model: string }).model;
}

/** Display name of the model behind a backend id ('kling' → 'Kling 3.0 Omni'). */
export const modelLabelFor = (value: string): string => MODELS[modelIdFor(value)]!.label;

// Both take a backend id OR a bare model id, exactly like the registry helpers they wrap — that is
// what lets a model be asserted (and later offered) before it has a provider entry.
/** How many characters this model can carry in one plan. */
export const castLimitFor = (value: string): number => registryCastLimitFor(value) as number;
/** The ratios this model renders, in menu order (never 'adaptive'/'auto'). */
export const aspectsFor = (value: string): Aspect[] => registryAspectsFor(value) as Aspect[];
