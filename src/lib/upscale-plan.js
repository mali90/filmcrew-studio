// The Topaz upscale PLAN — how big the output gets — and nothing else.
//
// It lives alone in a zero-import leaf because two very different callers must agree on it:
// src/lib/upscale.js, which spends the money (and binds the CONFIGURED max factor), and the web
// estimator, which quotes it and may not import config.js (see the canaries in
// web/server/test/integration/runs-caps.test.js). A price computed from a mirrored copy of this
// rule is a price for an output the upscaler would not produce — the exact bug a duplicated
// resolution rule already caused once in estimator.js.

export const TOPAZ_MAX_FACTOR = 4;   // Topaz supports up to 4× per pass (config's FAL_TOPAZ_MAX_FACTOR default)
export const TARGET_SHORT_SIDE = 1080;

/**
 * Pure: decide whether a source needs upscaling and the Topaz factor to lift its SHORT side to the
 * target. Dimensions that can't be read (0) are a no-op HERE — "nothing to plan" — which is not the
 * same answer a price should give them; see estimateUpscale, where unknown size rounds UP.
 * @returns {{ needsUpscale: boolean, upscaleFactor: number }}
 */
export function upscalePlan(width, height, { maxFactor = TOPAZ_MAX_FACTOR, targetShort = TARGET_SHORT_SIDE } = {}) {
  const shortSide = Math.min(Number(width) || 0, Number(height) || 0);
  if (!shortSide || shortSide >= targetShort) return { needsUpscale: false, upscaleFactor: 1 };
  // smallest 0.25-step factor that reaches the target short side, capped at the Topaz max.
  const factor = Math.min(maxFactor, Math.ceil((targetShort / shortSide) / 0.25) * 0.25);
  return { needsUpscale: true, upscaleFactor: factor };
}

export default { upscalePlan, TOPAZ_MAX_FACTOR, TARGET_SHORT_SIDE };
