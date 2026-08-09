// The effective per-spec prompt/render settings for each backend, as PURE functions.
//
// The rules encoded here (spec value wins → this model's own knobs block → the shared default) used
// to live inside kling.js/seedance.js, where they read `config` directly. web/server's prompt
// preview needs the SAME rules, and the server's static import graph must stay config-free (a
// dotenv load there bypasses the demo/e2e mock — the runs-caps canary guards that). So every
// default arrives as an ARGUMENT: the CLI passes its config block, the server passes the values it
// read from the run's own .env as data, and neither module ever touches the environment directly.
//
// Nothing here composes prompt text — that is prompt-compose.js, which takes what these return.

/**
 * A model's OWN user-tunable block out of a settings bag (`config[caps.knobsKey]`), or null.
 * Seedance 2.5 renders at different resolutions than 2.0 and bills differently, so it carries its
 * own block while everything it does NOT redeclare keeps falling back to the shared one.
 * Own-property lookup only: a caps bundle naming '__proto__' must never reach an inherited object.
 * @param {{knobsKey?:string}|null} [caps]
 * @param {object|null} [bag]  the settings bag to look in (the CLI hands over `config`)
 * @returns {object|null}
 */
export function knobsFor(caps, bag) {
  const key = caps?.knobsKey;
  if (!key || !bag || !Object.hasOwn(bag, key)) return null;
  const knobs = bag[key];
  return knobs && typeof knobs === 'object' ? knobs : null;
}

/** spec.kling.generate_audio wins wherever it is set; an ABSENT flag falls back, never reads false. */
const audioFlag = (spec, fallback) =>
  (spec?.kling?.generate_audio !== undefined ? !!spec.kling.generate_audio : !!fallback);

/**
 * Effective Kling settings for one spec: what to render with, plus the byte/segment budgets the
 * storyboard composer needs.
 * @param {object} spec  the Production Spec
 * @param {{nativeAudio?:boolean, segmentMaxBytes?:number, maxStoryboards?:number, maxJobSeconds?:number,
 *          defaultShotSeconds?:number, model?:string, resolution?:string, aspectRatio?:string}} [defaults]
 *   the caller's config.kling block (or the same shape read from a run's .env as data)
 */
export function klingPromptSettings(spec, defaults = {}) {
  const k = spec?.kling ?? {};
  const audioOn = audioFlag(spec, defaults.nativeAudio);
  return {
    model: k.model_name || defaults.model,
    resolution: k.resolution || defaults.resolution,
    aspectRatio: k.aspect_ratio || defaults.aspectRatio,
    generateAudio: audioOn,
    audioOn,
    // Budgets: model hard caps and the byte budget the composer trims segments to.
    segmentMaxBytes: defaults.segmentMaxBytes,
    maxStoryboards: defaults.maxStoryboards,
    maxJobSeconds: defaults.maxJobSeconds,
    defaultShotSeconds: defaults.defaultShotSeconds,
  };
}

/**
 * Effective Seedance settings for one spec on one model.
 * @param {object} spec  the Production Spec
 * @param {{knobsKey?:string}|null} [caps]  capsFor('<model>@<provider>') — picks up that model's own knobs block
 * @param {{generateAudio?:boolean, promptMaxBytes?:number, defaultShotSeconds?:number, style?:string,
 *          avoid?:string, textRule?:string, resolution?:string, aspectRatio?:string, knobs?:object}} [defaults]
 *   the caller's shared Seedance block; `knobs` is the bag `caps.knobsKey` is looked up in (config)
 */
export function seedancePromptSettings(spec, caps, defaults = {}) {
  const k = spec?.kling ?? {};
  const own = knobsFor(caps, defaults.knobs) ?? {};
  const audioOn = audioFlag(spec, defaults.generateAudio);
  return {
    // NOT k.resolution: the kling block is written by the agents from KLING defaults (its enum
    // can't even express 480p) — letting it override would silently render/bill Seedance at the
    // Kling resolution. An explicit spec.seedance.resolution pin wins; else THIS MODEL's setting;
    // else the shared Seedance one.
    resolution: spec?.seedance?.resolution || own.resolution || defaults.resolution,
    aspectRatio: k.aspect_ratio || defaults.aspectRatio,
    generateAudio: audioOn,
    audioOn,
    // Prompt front matter + budgets. A model that does not redeclare one keeps the shared value.
    promptMaxBytes: own.promptMaxBytes || defaults.promptMaxBytes,
    defaultShotSeconds: defaults.defaultShotSeconds,
    style: own.style ?? defaults.style ?? '',
    avoid: own.avoid ?? defaults.avoid ?? '',
    textRule: own.textRule ?? defaults.textRule ?? '',
  };
}

export default { knobsFor, klingPromptSettings, seedancePromptSettings };
