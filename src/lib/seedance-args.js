// ONE argument builder for every Seedance model on every provider. PURE and config-free:
// everything that differs between (model, provider) pairs is DATA on the caps bundle from
// render-models.js — the argument KEY NAMES (caps.argMap), the duration type and window, the
// banned arguments, whether a seed is accepted, and the legal resolutions/aspects. No branch below
// may name a model or a provider; if you reach for `if (caps.model === …)`, add a cap instead.
//
// The byte-compat gate is test/unit/seedance-args.test.js (which calls it through the
// fal-seedance.js shim): the fal Seedance 2.0 payload this builds must not move a single byte.

/** A defensive copy — the caller's arrays are never appended to in place. */
const list = (v) => (Array.isArray(v) ? [...v] : []);

/** "Seedance 2.0 on fal" — every error names the exact (model, provider) pair that rejected it. */
const nameOf = (caps) => `${caps?.label ?? 'Seedance'}${caps?.providerLabel ? ` on ${caps.providerLabel}` : ''}`;

/**
 * Does an opening frame have to travel as a trailing IMAGE REF on this model rather than in a
 * native first-frame slot? True when the model has no native slot at all (fal Seedance 2.0), and
 * true on models whose native slot is mutually exclusive with reference images (Seedance 2.5)
 * whenever refs are present. Exported because the renderer needs the same answer one step earlier,
 * to number the `@ImageN` the prompt pins as the first frame.
 * @param {object} caps
 * @param {number} refCount  reference images already collected
 */
export function firstFrameIsRef(caps, refCount) {
  if (!caps?.nativeFirstFrame || !caps.argMap?.firstFrame) return true;
  return Boolean(caps.firstFrameExcludesRefs) && refCount > 0;
}

/** Reject an unlisted enum value loudly, naming the model's legal set (no cap ⇒ no opinion). */
function oneOf(caps, kind, value, allowed) {
  if (!allowed?.length || allowed.includes(value)) return value;
  throw new Error(`Unknown ${kind} "${value}" for ${nameOf(caps)} — use one of: ${allowed.join(', ')}.`);
}

/** A hard model limit, surfaced here rather than as a provider-side 422 round trip. */
function capped(caps, kind, n, max) {
  if (max != null && n > max) throw new Error(`${nameOf(caps)} accepts at most ${max} ${kind} — ${n} supplied.`);
}

/**
 * Emit a reference list under the model's own key name. An EMPTY list is omitted entirely (a
 * text-to-video job sends no `image_urls` key at all); a non-empty list for a slot the model does
 * not have (`argMap.<slot>: null`) is a loud throw, never a silent drop — dropping it would ship a
 * payload the caller did not ask for.
 */
function putList(args, caps, key, values, kind) {
  if (!values.length) return;
  if (!key) throw new Error(`${nameOf(caps)} takes no ${kind} — ${values.length} supplied.`);
  args[key] = values;
}

/** The scalar form of putList (first/last frame). */
function putOne(args, caps, key, value, kind) {
  if (value == null) return;
  if (!key) throw new Error(`${nameOf(caps)} takes no ${kind} input.`);
  args[key] = value;
}

/** Clamp into the model's window, then ship it in the type the endpoint expects. */
function durationFor(totalDuration, caps) {
  const rounded = Math.round(Number(totalDuration) || 0);
  const clamped = Math.min(caps.maxSeconds ?? Infinity, Math.max(caps.minSeconds ?? 0, rounded));
  return caps.durationType === 'int' ? clamped : String(clamped);
}

/**
 * Build the final Seedance arguments object.
 * @param {{prompt:string, imageUrls?:string[], audioUrls?:string[], videoUrls?:string[],
 *          firstFrameUrl?:string, lastFrameUrl?:string, aspectRatio:string, resolution?:string,
 *          generateAudio?:boolean, totalDuration:number, seed?:number, returnLastFrame?:boolean}} intent
 * @param {object} caps  capsFor('<model>@<provider>')
 */
export function buildSeedanceArgs(intent, caps) {
  if (!caps) throw new Error('buildSeedanceArgs: caps are required — pass capsFor("<model>@<provider>").');
  const argMap = caps.argMap ?? {};

  const aspectRatio = oneOf(caps, 'aspect ratio', intent.aspectRatio, caps.aspects);
  const resolution = oneOf(caps, 'resolution', intent.resolution ?? caps.defaultResolution, caps.resolutions);

  const images = list(intent.imageUrls);
  const audios = list(intent.audioUrls);
  const videos = list(intent.videoUrls);

  // An opening frame either rides the native slot or is demoted to the LAST image ref — after the
  // cast refs, so the prompt's "@ImageN is the literal first frame" pin keeps pointing at it.
  let firstFrame = null;
  if (intent.firstFrameUrl) {
    if (firstFrameIsRef(caps, images.length)) images.push(intent.firstFrameUrl);
    else firstFrame = intent.firstFrameUrl;
  }

  capped(caps, 'image references', images.length, caps.maxImages);
  capped(caps, 'audio references', audios.length, caps.maxAudioRefs);
  capped(caps, 'video references', videos.length, caps.maxVideoRefs);

  const args = {
    prompt: intent.prompt,
    aspect_ratio: aspectRatio,
    resolution,
    duration: durationFor(intent.totalDuration, caps),
    generate_audio: !!intent.generateAudio,
  };
  putList(args, caps, argMap.images, images, 'image references');
  putList(args, caps, argMap.audios, audios, 'audio references');
  putList(args, caps, argMap.videos, videos, 'video references');
  putOne(args, caps, argMap.firstFrame, firstFrame, 'first-frame');
  putOne(args, caps, argMap.lastFrame, intent.lastFrameUrl ?? null, 'last-frame');

  if (caps.supportsSeed && intent.seed != null) args.seed = intent.seed;
  if (caps.supportsReturnLastFrame && intent.returnLastFrame != null) args.return_last_frame = !!intent.returnLastFrame;

  // LAST, deliberately: whatever any rule above set, a banned argument can never reach the
  // provider. This is the belt to the braces of `supportsSeed` — fal's Seedance 2.0 endpoint 422s
  // on `seed` and `negative_prompt`, and a 422 is deterministic, so it is never retried.
  for (const key of caps.bannedArgs ?? []) delete args[key];
  return args;
}

export default { buildSeedanceArgs, firstFrameIsRef };
