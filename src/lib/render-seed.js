// The render seed — the number that decides WHERE a generation starts, and the vocabulary for
// choosing it. Like src/lib/render-models.js this module has ZERO IMPORTS and reads no env, and for
// the same reason: web/server has to compute the very seed a render child would compute (that is
// what makes "re-render this take from the same starting point" honest), and every module in the
// server's static graph is walked by the config-free leak canaries. Anything importing config.js —
// pipeline.js included — would drag a developer's real .env into the server and make the demo/e2e
// mocks miss. So the seed rules live here, and pipeline.js re-exports the one every renderer used
// to get from it.
//
// Nothing here is provider-specific: which endpoints ACCEPT a seed is a registry cap
// (`supportsSeed`), and which ones make choosing one worthwhile is another (`seedControl`).

/**
 * How a paid re-render may pick its seed. 'fix' re-sends the seed the segment's current take used,
 * so a prompt tweak lands on the same picture; 'fresh' draws a new one for a new interpretation.
 * Frozen because it is also the wire vocabulary — the server 400s on anything else, and a mutated
 * list would widen that check at runtime.
 */
export const SEED_MODES = Object.freeze(['fix', 'fresh']);

// The inclusive window a seed may fall in. 2^31-1 is the largest value every endpoint in this build
// documents as accepted, and 1 rather than 0 keeps a drawn seed truthy — a 0 read back out of a
// sidecar or a CLI flag must never be mistaken for "no seed" by an `||` somewhere downstream.
export const SEED_MIN = 1;
export const SEED_MAX = 2147483647;

/** Whether a value is a seed this build would send: an integer inside the accepted window. */
export const isSeed = (v) => Number.isInteger(v) && v >= SEED_MIN && v <= SEED_MAX;

/** The DEFAULT per-job seed when no explicit one is given — deterministic, so a take can be
 *  reproduced and so a re-render that says nothing about seeds behaves exactly as it always has.
 *  Recorded in every renderer's prompts.json sidecar (`seed` where the endpoint takes one,
 *  `seed_unused` where it does not — fal's Seedance 2.0 422s on a seed, while Segmind's 2.0/2.5 and
 *  fal's 2.5 accept one); `take` offsets it so retakes are distinguishable. */
export const seedForJob = (index, take = 0) => 70000 + index * 100 + (Number(take) || 0) * 7;

/**
 * A fresh seed inside the accepted window. `rand` is injectable for exactly one reason: a drawn seed
 * lands in a manifest row, a reply and the child's argv, so tests have to be able to say which
 * number that was.
 * @param {() => number} [rand]  a [0,1) source, Math.random by default
 * @returns {number} an integer in [SEED_MIN, SEED_MAX]
 */
export function randomSeed(rand = Math.random) {
  const n = SEED_MIN + Math.floor(rand() * (SEED_MAX - SEED_MIN + 1));
  // Clamped, not trusted: an injected `rand` that returns exactly 1 (or something out of range)
  // would otherwise hand a paid render a seed its endpoint rejects.
  return Math.min(Math.max(n, SEED_MIN), SEED_MAX);
}

export default { SEED_MODES, SEED_MIN, SEED_MAX, isSeed, seedForJob, randomSeed };
