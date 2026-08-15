// The wizard's money vocabulary, in one place. Two steps have to say the SAME thing about the same
// render — the backend cards quote a per-second rate per pair, and the presets step's tier pick is
// the one edit that can outdate the quote the user just read — so the tier rule, the sentence and
// the "which is lowest" arithmetic live in a sibling lib (the pattern run/review/lib.ts already
// uses) rather than being imported out of a component or, worse, written twice.
import type { Backend, Resolution } from '../../../../shared/api-types';
import { defaultResolutionFor, resolutionsFor } from '../../../../shared/render-models';
import { perSecondUsdFor } from '../../../../shared/render-rates';
import { usd } from '../../lib/format';

// No rate is written here. Every figure on a card is read from the estimator's own table
// (web/shared/render-rates.ts → web/server/lib/prices.json), at the tier that card would render at,
// for two reasons: the price is a property of the PAIR (the same Seedance costs about half as much
// on Segmind as on fal) AND of the TIER (Seedance bills per pixel, so 4k is eleven times 480p), and
// a hand-copied figure is wrong the day a vendor moves a price with nothing to catch it. A pair the
// table does not price says so — it never inherits a sibling's figure, and it is never called free,
// because the render does cost money. Every pair the registry ships is priced today, so
// RATE_UNKNOWN is the fallback for the NEXT provider added, not dead code.
const RATE_UNKNOWN = 'rate not on file yet — the render still costs money';

/** The tier this card would render at if it were picked — the SAME precedence its click applies
 *  below (keep a tier the model offers, else fall to that model's own default). The quoted rate and
 *  the patch therefore cannot describe different renders. */
export const tierFor = (id: Backend, picked: Resolution | null): Resolution | null =>
  (picked && resolutionsFor(id).includes(picked) ? picked : defaultResolutionFor(id) ?? null);

/** What a card says about money: the estimate's own rate at the tier above, naming that tier so the
 *  figure can never be read as applying to another one. */
export const rateLabel = (id: Backend, tier: Resolution | null): string => {
  const rate = perSecondUsdFor(id, tier);
  return rate === null ? RATE_UNKNOWN : `≈ ${usd(rate)}/s est${tier ? ` at ${tier}` : ''}`;
};

/** The pair with the lowest per-second estimate, AT THE TIER EACH WOULD RENDER AT — computed from
 *  the same table the cards quote, never assigned to a favourite provider. Recomputed per render
 *  because the answer genuinely moves: Kling's flat rate sits under Seedance-on-Segmind's 720p one.
 *  It names nobody when a badge would lie — two pairs that PRINT the same cents (an exact tie
 *  included: one badge would be a claim about the other card), or fewer than two priced pairs. An
 *  unpriced pair is filtered out, never read as zero — that is the bug this filter exists to stop. */
export const lowestRateId = (ids: Backend[], picked: Resolution | null): Backend | null => {
  const priced = ids
    .map((id) => ({ id, rate: perSecondUsdFor(id, tierFor(id, picked)) }))
    .filter((c): c is { id: Backend; rate: number } => typeof c.rate === 'number')
    .sort((a, b) => a.rate - b.rate);
  if (priced.length < 2) return null;
  return usd(priced[0]!.rate) === usd(priced[1]!.rate) ? null : priced[0]!.id;
};
