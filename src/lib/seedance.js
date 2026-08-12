// Seedance 2.0/2.5 prompt/config helpers used by the renderers (render-seedance.js). ONE Seedance
// generation renders a whole job from ONE rich multi-shot prompt: identity is pinned by flat
// reference images (@Image1..@ImageN), dialogue lip-syncs to voice clips (@Audio1..@AudioN), and the
// opening frame can be pinned by naming a ref image as the literal first frame (a documented prompt
// convention where the model has no native first-frame slot). Model hard caps: 4–15s per generation
// / ≤9 image refs / ≤3 audio refs (combined ≤15s) / NO seed / NO negative_prompt (both HTTP 422 —
// variation ships as an "Alternate take N" prompt directive, guards as prompt clauses).
//
// Unlike Kling (per-shot storyboard segments hard-capped at 512 chars each, so scene prose gets
// starved), nothing is truncated per shot here — and by default nothing is truncated at all: the
// whole-prompt clamp ships OFF (SEEDANCE_PROMPT_MAX_BYTES; unset/empty/0 = uncapped). Where a cap IS
// set, only the WHOLE assembled prompt is clamped, and the front matter (style, identity, guards,
// first-frame pin, lip-sync notes, opening hook) sits ahead of the shot bodies so it survives it.
//
// The prompt text itself is composed by src/lib/prompt-compose.js and the effective settings by
// src/lib/prompt-settings.js — both pure and config-free (unit-tested in
// test/unit/prompt-compose.test.js and test/unit/seedance-prompt.test.js), so web/server's prompt
// preview produces the exact bytes this renderer sends without pulling config/dotenv into the
// server's static graph. THIS module is the config-bound shim; call sites are unchanged.
import config from '../../config.js';
import { seedancePromptSettings, knobsFor } from './prompt-settings.js';
import { applyOverride, assertOverrideFits, composeSeedanceJobPrompt, clampBytes, HOOK_PREFIX, TRANSITION_WORDS } from './prompt-compose.js';

export { clampBytes, HOOK_PREFIX, TRANSITION_WORDS };

// Seedance 2.0 text-to-video prompt guidance lives in its own config-free module (see the note there);
// re-exported here so existing importers (engine.js) keep a single, stable path.
export { SEEDANCE_TTV_GUIDANCE } from './seedance-guidance.js';

/**
 * The MODEL'S OWN user-tunable block (`config[caps.knobsKey]`), or null. Seedance 2.5 renders at
 * different resolutions than 2.0 and bills differently, so it carries its own settings block while
 * everything it does NOT redeclare keeps falling back to `config.seedance`.
 * @param {{knobsKey?:string}} [caps]
 */
export const modelKnobs = (caps) => knobsFor(caps, config);

/** The effective Seedance prompt/render settings for a spec on one model, config as the defaults. */
export const seedanceSettingsFor = (spec, caps) =>
  seedancePromptSettings(spec, caps, { ...config.seedance, aspectRatio: config.kling.aspectRatio, defaultShotSeconds: config.kling.defaultShotSeconds, knobs: config });

/**
 * Compose ONE job's Seedance prompt from its shots' `kling` blocks + the spec's voice lines.
 * Pass `opts.caps` (the renderer does) and the clause/budget knobs resolve by the model-block-wins
 * rule — the SAME merge the web preview runs, so neither half can honour a model block the other
 * ignores. The knobs (`style`, `avoidClause`, `textClause`, `maxBytes`) can still be passed as opts
 * for a caller composing outside the configured ones, and are folded into the composer's settings.
 * @param {object} job   spec.kling.jobs[i]
 * @param {object} spec  the full Production Spec
 * `opts.override` (optional): this job's saved prompt-override entry — the user's own words, with
 * the front matter and the seam pins re-composed on top (applyOverride). An edit that front matter
 * has outgrown since it was saved is REFUSED, not clamped: this is the renderer's path, so the
 * bytes that would go are bytes the user is paying to send (assertOverrideFits).
 * @param {object} [opts]  see composeSeedanceJobPrompt(); plus style/avoidClause/textClause/maxBytes
 * @returns {{ prompt:string, shotPrompts:string[], totalDuration:number, speakers:string[] }}
 */
export function buildSeedanceJobPrompt(job, spec, opts = {}) {
  const settings = {
    ...seedanceSettingsFor(spec, opts.caps ?? null),
    ...(opts.style !== undefined ? { style: opts.style } : {}),
    ...(opts.avoidClause !== undefined ? { avoid: opts.avoidClause } : {}),
    ...(opts.textClause !== undefined ? { textRule: opts.textClause } : {}),
    // `!= null`, never truthiness: 0 is the uncapped sentinel and has to travel, while undefined/
    // null still mean "the caller supplied none" and leave the configured knob alone.
    ...(opts.maxBytes != null ? { promptMaxBytes: Number(opts.maxBytes) } : {}),
  };
  return assertOverrideFits(
    applyOverride(composeSeedanceJobPrompt(job, spec, settings, opts), opts.override ?? null, settings),
    job?.job_id,
  );
}

/**
 * Effective per-spec Seedance settings (resolution/aspect/audio), spec values over config defaults.
 * @param {object} spec  the Production Spec
 * @param {object} [caps]  capsFor('<model>@<provider>') — picks up that model's own knobs block
 */
export function seedanceConfigFor(spec, caps) {
  const s = seedanceSettingsFor(spec, caps);
  return { resolution: s.resolution, aspectRatio: s.aspectRatio, generateAudio: s.generateAudio };
}

export default { buildSeedanceJobPrompt, seedanceConfigFor, modelKnobs, clampBytes, HOOK_PREFIX, TRANSITION_WORDS };
