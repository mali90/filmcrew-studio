// The wizard's only DERIVED money claim: "Lowest rate". A badge that names a provider is a claim
// about every other card on the screen, so it must fall out of the same table those cards quote —
// and it must say nothing at all when the table cannot support it. The four silent cases below are
// the whole point: an unpriced pair read as $0.00 would crown the one vendor that publishes least.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backend, Resolution } from '../../../../shared/api-types';
import { perSecondUsdFor } from '../../../../shared/render-rates';
import { BACKEND_IDS } from '../../../../../src/lib/render-models.js';
import { lowestRateId, tierFor } from './rates';

// Wrapped, not replaced: the first test needs the REAL table (that is the property worth pinning),
// the rest need rates no vendor happens to publish today. beforeEach puts the real one back.
vi.mock('../../../../shared/render-rates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/render-rates')>();
  return { ...actual, perSecondUsdFor: vi.fn(actual.perSecondUsdFor) };
});

const IDS = BACKEND_IDS as Backend[];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../../../../shared/render-rates')>('../../../../shared/render-rates');
  vi.mocked(perSecondUsdFor).mockImplementation(actual.perSecondUsdFor);
});

describe('lowestRateId — read off the real table', () => {
  // Deliberately a property, not an id: the winner is whatever prices.json says today, and hard-
  // coding one here would turn a vendor's price move into a passing test with a lying badge.
  // Today the two answers genuinely differ — seedance-2.0@segmind at each model's default tier,
  // kling-o3@fal once the wizard holds 720p (Kling's flat rate undercuts Segmind's 720p one).
  it.each([null, '720p'] as (Resolution | null)[])('names a pair no other card undercuts (picked=%s)', (picked) => {
    const winner = lowestRateId(IDS, picked);
    expect(winner).not.toBeNull();
    const winnerRate = perSecondUsdFor(winner!, tierFor(winner!, picked));
    expect(winnerRate).not.toBeNull();
    for (const id of IDS) {
      const rate = perSecondUsdFor(id, tierFor(id, picked));
      if (rate !== null) expect(winnerRate!, id).toBeLessThanOrEqual(rate);
    }
  });
});

describe('lowestRateId — the cases where it must name nobody', () => {
  /** Every shipped pair at one dictated rate — ids stay real because tierFor asks the registry. */
  const rates = (map: Partial<Record<string, number | null>>) =>
    vi.mocked(perSecondUsdFor).mockImplementation((id) => map[String(id)] ?? null);

  it('all pairs at the same rate ⇒ no badge (a tie makes the badge a claim about the other card)', () => {
    rates(Object.fromEntries(IDS.map((id) => [id, 0.5])));
    expect(lowestRateId(IDS, null)).toBeNull();
  });

  it('rates that PRINT the same cents ⇒ no badge, even though one is genuinely lower', () => {
    // $0.1000 vs $0.1004 both render as "$0.10": a badge on one would be unreadable as true.
    rates({ ...Object.fromEntries(IDS.map((id) => [id, 9])), [IDS[0]!]: 0.1, [IDS[1]!]: 0.1004 });
    expect(lowestRateId(IDS, null)).toBeNull();
  });

  it('nothing priced ⇒ no badge (never "everything is equally cheap")', () => {
    rates({});
    expect(lowestRateId(IDS, null)).toBeNull();
  });

  it('one priced pair ⇒ no badge: "lowest" of one is a comparison with nothing', () => {
    rates({ [IDS[0]!]: 0.42 });
    expect(lowestRateId(IDS, null)).toBeNull();
  });

  it('an UNPRICED pair is dropped, never read as zero — the winner is the cheapest PRICED one', () => {
    // The bug this filter exists to stop: `null` coerced to 0 would hand the badge to the vendor
    // that publishes no rate at all, on a screen whose whole job is honest money.
    const unpriced = IDS[0]!;
    rates({ ...Object.fromEntries(IDS.slice(1).map((id, i) => [id, 1 + i])), [unpriced]: null });
    expect(lowestRateId(IDS, null)).toBe(IDS[1]);
    expect(lowestRateId(IDS, null)).not.toBe(unpriced);
  });
});
