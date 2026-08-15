// Typed facade over the ESTIMATOR's own rate table (web/server/lib/prices.json) for the browser
// bundle — the money twin of render-models.ts, and for the same reason: the UI must never restate a
// number that lives somewhere else.
//
// Every per-second figure the UI says out loud has to be the figure the estimate will bill against,
// AT THE TIER the run is pinned to. Seedance is billed by pixel-seconds, so fal's Seedance 2.0 runs
// $0.135/s at 480p and $1.5552/s at 4k — quoting a model's default tier beside a control set to 4k
// under-quotes the spend by more than eleven times. Hand-copied copy has the second failure too: it
// is wrong the day a vendor moves a price, and nothing goes red. Reading prices.json here leaves
// exactly one place a rate can change.
//
// Safe in the bundle for the same reason the registry is: a JSON data file drags in no code, no env
// read and no node builtin. The rules below mirror estimator.js's tableFor/rateFor — one `$alias`
// hop, a flat number or a tier ladder, `null` for a vendor that publishes nothing — with one
// deliberate difference: an unknown tier answers `null` instead of throwing, because a create page
// that crashes is a worse answer than a hint that quotes no figure.
import PRICES from '../server/lib/prices.json';
import type { Backend, Resolution } from './api-types';
import { canonicalBackendFor } from './render-models';

/** Only the fields a rate row can carry — the rest of prices.json is sourcing prose (`_source`,
 *  `_note`, the `_fixtures` block) and one scalar (`voiceMintUsd`). */
interface PriceRow {
  perSecondUsd?: number | Record<string, number> | null;
  defaultResolution?: string;
  $alias?: string;
}

const ROWS = PRICES as unknown as Record<string, unknown>;
const rowFor = (key: string): PriceRow | null => {
  const row = ROWS[key];
  return row && typeof row === 'object' ? (row as PriceRow) : null;
};

/**
 * Per-second USD for a (model, provider) pair at a tier, or `null` when there is no honest figure
 * to quote: the vendor publishes none (`perSecondUsd: null`), the pair has no row yet, or the tier
 * is off this row's ladder. Never a sibling pair's rate, and never silently the default tier's —
 * which is the whole point of taking the tier as an argument.
 *
 * `resolution` is the run's own pick. `null` means the model has no selectable ladder (Kling
 * renders its endpoint's own output), where the row is flat and the tier cannot move the bill.
 */
export function perSecondUsdFor(backend: Backend | string, resolution: Resolution | null = null): number | null {
  let key: string;
  try { key = canonicalBackendFor(backend); } catch { key = String(backend); }
  // The CLI records the canonical compound id and prices.json redirects those to its legacy rate
  // rows; the hop is single, exactly as the estimator follows it.
  const direct = rowFor(key);
  const row = direct?.$alias ? rowFor(direct.$alias) : direct;
  const rate = row?.perSecondUsd;
  if (rate === null || rate === undefined) return null;
  if (typeof rate === 'number') return rate; // a flat vendor row — the tier does not move the bill
  const tier = resolution ?? row?.defaultResolution;
  const usd = tier ? rate[tier] : undefined;
  return typeof usd === 'number' ? usd : null;
}
