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

/**
 * spec.kling.generate_audio wins wherever it is set; an ABSENT flag falls back, never reads false.
 * Exported because the answer decides more than a prompt: audio off means a voiced character's clip
 * does not ride, so web/server's reference budget has to resolve the flag the SAME way the renderer
 * does, or it quotes a boundary pin against a slot nobody will spend.
 */
export const audioFlag = (spec, fallback) =>
  (spec?.kling?.generate_audio !== undefined ? !!spec.kling.generate_audio : !!fallback);

/**
 * THE rule for which resolution a Seedance render runs (and bills) at, from every source that can
 * name one. It lives here, exported, because two halves of the product have to agree on it: the
 * render child reaches it through seedancePromptSettings, and web/server's estimator imports it
 * directly. They used to be two hand-mirrored expressions — and the mirror was wrong in the same
 * way on both sides.
 *
 * Precedence, highest first:
 *  - `pick`: the tier chosen FOR THIS RUN (the create-run picker; web/server pins it onto every
 *    child spawn as RENDER_RESOLUTION_PICK). It outranks everything, including a spec pin: the
 *    picker exists precisely because a pin the plan carried once governed the render and the bill
 *    instead of the tier the user chose. It also means an off-ladder stale pin (a 1080p value that
 *    survived a 2.0 → 2.5 switch) can no longer fail a run whose tier the user has settled.
 *  - `spec.seedance.resolution`: a hand-authored pin. Still meaningful — a CLI run makes no per-run
 *    pick, so a pin is how a spec asks for its own tier — and it still beats the .env knobs below.
 *  - `own`: THIS MODEL's own knob (config[caps.knobsKey]); then `shared`, the shared Seedance one.
 *
 * spec.kling.resolution sits at NO rank: the agents fill that block from the KLING defaults (its
 * enum cannot even express 480p), so honouring it silently rendered and billed Seedance at 1080p.
 * @param {{pick?:string, spec?:object, own?:string, shared?:string}} [sources]
 */
export function seedanceResolution({ pick, spec, own, shared } = {}) {
  return pick || spec?.seedance?.resolution || own || shared;
}

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
 *          avoid?:string, textRule?:string, resolution?:string, resolutionPick?:string,
 *          aspectRatio?:string, knobs?:object}} [defaults]
 *   the caller's shared Seedance block; `knobs` is the bag `caps.knobsKey` is looked up in (config),
 *   and `resolutionPick` is the per-run tier the run was created at, when there is one
 */
export function seedancePromptSettings(spec, caps, defaults = {}) {
  const k = spec?.kling ?? {};
  const own = knobsFor(caps, defaults.knobs) ?? {};
  const audioOn = audioFlag(spec, defaults.generateAudio);
  return {
    // One shared rule (seedanceResolution above), never a local re-statement of it: the tier this
    // run was created at, else a hand-authored spec pin, else THIS MODEL's knob, else the shared
    // Seedance one — and spec.kling.resolution at no rank at all.
    resolution: seedanceResolution({
      pick: defaults.resolutionPick, spec, own: own.resolution, shared: defaults.resolution,
    }),
    aspectRatio: k.aspect_ratio || defaults.aspectRatio,
    generateAudio: audioOn,
    audioOn,
    // Prompt front matter + budgets. A model that does not redeclare one keeps the shared value —
    // `??`, never `||`: 0 is the uncapped sentinel, so a model that declares itself uncapped must
    // not silently inherit the shared cap.
    promptMaxBytes: own.promptMaxBytes ?? defaults.promptMaxBytes,
    defaultShotSeconds: defaults.defaultShotSeconds,
    style: own.style ?? defaults.style ?? '',
    avoid: own.avoid ?? defaults.avoid ?? '',
    textRule: own.textRule ?? defaults.textRule ?? '',
  };
}

export default { knobsFor, audioFlag, seedanceResolution, klingPromptSettings, seedancePromptSettings };
