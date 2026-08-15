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

/**
 * "Seedance 2.0 on fal" — every error names the exact (model, provider) pair that rejected it.
 * Exported because the renderer needs the same name for the messages it raises before the args are
 * built; neither file may spell a model or provider name in a literal.
 */
export const nameOf = (caps) => `${caps?.label ?? 'Seedance'}${caps?.providerLabel ? ` on ${caps.providerLabel}` : ''}`;

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

/**
 * The per-clip audio window this model will accept, in seconds, given how many voice refs share the
 * job's combined budget. Two independent limits fold into one answer:
 *   - `caps.audioPerClipS = [minS, maxS]` — the model's own per-clip rule. Segmind's Seedance 2.5
 *     rejects a reference clip shorter than 2s outright (HTTP 422 on a paid submit), so the SHORT
 *     end has to be expressible; a model that declares no window has no minimum at all.
 *   - `caps.audioBudgetS` — the COMBINED budget, split evenly across the refs (today's math).
 * Exported so the renderer can size its ffmpeg re-cut from the same numbers the decision came from.
 * @param {object} caps
 * @param {number} refCount  voice refs sharing the budget
 * @returns {{minS:number, maxS:number}}  maxS may be Infinity (no opinion)
 */
export function audioWindowFor(caps, refCount = 1) {
  const n = Math.max(1, Math.round(Number(refCount) || 1));
  const win = Array.isArray(caps?.audioPerClipS) ? caps.audioPerClipS : null;
  const minS = win ? Math.max(0, Number(win[0]) || 0) : 0;
  const winMax = Number(win?.[1]);
  const budget = Number(caps?.audioBudgetS);
  const share = Number.isFinite(budget) ? Math.floor(budget / n) : Infinity;
  return { minS, maxS: Math.min(Number.isFinite(winMax) ? winMax : Infinity, share) };
}

/**
 * What to do with ONE voice reference clip of `durationS` seconds: send it untouched, re-cut it to
 * the window's ceiling, or leave it behind entirely. PURE — no ffprobe, no ffmpeg, no fs — so the
 * policy is unit-testable and the renderer keeps only the I/O.
 *
 * An UNKNOWN duration (a failed probe → NaN/0) is always kept: the renderer's long-standing
 * "send it as-is and let the provider complain" fallback must survive a model gaining a minimum.
 * @param {number} durationS
 * @param {object} caps
 * @param {{refCount?:number}} [opts]
 * @returns {'keep'|'cut'|'drop'}
 */
export function fitAudioRef(durationS, caps, { refCount = 1 } = {}) {
  const dur = Number(durationS);
  if (!Number.isFinite(dur) || dur <= 0) return 'keep';
  const { minS, maxS } = audioWindowFor(caps, refCount);
  if (dur < minS) return 'drop';
  if (dur > maxS) return 'cut';
  return 'keep';
}

/**
 * Do this job's `@AudioN` voice clips ride at all? The reference endpoints take audio only
 * alongside something the model is conditioned on, so a genuine text-to-video job attaches no clip
 * and is voiced natively; `voiceMode: 'native'` and audio-off are the two deliberate ways to ask
 * for the same thing.
 *
 * A CLOSING frame counts exactly like an opening one. Both reach the model as an image — a native
 * first/last-frame anchor where the model has one, otherwise a trailing image reference — so a
 * cast-less segment pinned only at its END is a reference-to-video job, and dropping its registered
 * voices there fell back to model-native dialogue for no reason the user could see.
 *
 * Lives here, beside the budget checks, because the renderer (src/lib/render-seedance.js) and the
 * prompt PREVIEW (web/server/lib/prompt-service.js) must answer it identically: the preview's whole
 * claim is that it shows what the wire will carry, and two copies of this rule is how that claim
 * quietly stops being true.
 * @param {{castRefCount?:number, hasSeamIn?:boolean, hasSeamOut?:boolean, audioOn?:boolean, voiceMode?:string}} job
 */
export function voiceRefsRide({ castRefCount = 0, hasSeamIn = false, hasSeamOut = false, audioOn = false, voiceMode = 'native' } = {}) {
  const conditioned = castRefCount > 0 || Boolean(hasSeamIn) || Boolean(hasSeamOut);
  return conditioned && Boolean(audioOn) && voiceMode !== 'native';
}

/**
 * WHICH of a job's speakers ride: the gate above, then the ones with a registered voice clip.
 * Deliberately NOT sliced to the model's @Audio cap — what an over-cap job does is the caller's
 * rule, and the callers disagree on purpose (the renderer and the preview refuse such a job; the
 * budget layers only count what will ride).
 * @param {{speakers?:string[], hasClip?:(speaker:string)=>unknown}} p  plus voiceRefsRide's own args
 * @returns {string[]}
 */
export function voiceRefSpeakers({ speakers = [], hasClip = () => true, ...ride } = {}) {
  return voiceRefsRide(ride) ? speakers.filter((sp) => Boolean(hasClip(sp))) : [];
}

/**
 * How many references those clips spend out of a COMBINED budget (fal 2.5 counts images + audio +
 * video against one cap), capped by the model's own @Audio slots — `planSeamRefs`' `otherRefCount`
 * for a Seedance job.
 *
 * Nothing ever drops a voice clip: the pre-upload check THROWS the moment images + audio pass the
 * combined cap. A soft boundary pin, by contrast, is given up (SEAM_PRIORITY) — so every surface
 * that promises a pin before the user pays has to subtract this first, or it sells continuity the
 * renderer deterministically drops. Counted here, once, for the engine's roster budget
 * (topUpStarredElements), the re-render reply and the dialog that starts it.
 * @param {{caps?:object}} p  plus voiceRefSpeakers' own args
 * @returns {number}
 */
export function voiceRefDemand({ caps, ...p } = {}) {
  return Math.min(voiceRefSpeakers(p).length, Number(caps?.maxAudioRefs) || 0);
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
 * The two reference limits a job has to clear BEFORE anything is uploaded — the renderer runs them
 * ahead of its first paid round trip (an upload round that precedes a doomed submit is money spent
 * for nothing), and the prompt PREVIEW runs the same two so it can never advertise a prompt the
 * renderer will refuse to send. Both throw, because refusing is what the renderer really does:
 * quietly slicing the list to fit would show a job as ready when it is deterministically invalid.
 *
 * Split in two because the renderer learns the numbers at two different moments: the voiced-speaker
 * count before it fits any clip, the combined total once the surviving clips are known.
 */

/** More voiced speakers than the model has @Audio slots. Named per JOB — the fix is editorial
 *  (split the dialogue), so the message has to say which job to split. */
export function cappedAudioRefs(caps, jobId, n) {
  if (caps?.maxAudioRefs != null && n > caps.maxAudioRefs) {
    throw new Error(`job ${jobId}: ${n} voiced speakers exceeds ${nameOf(caps)}'s ${caps.maxAudioRefs}-audio-ref cap — split the dialogue across jobs.`);
  }
}

/** Individually legal image/audio counts whose SUM overruns a declared combined budget (fal
 *  Seedance 2.5's 50). Worded by the same `capped` the argument builder uses, so the pre-upload
 *  refusal, the builder's own late check and the preview all read identically. */
export function cappedCombinedRefs(caps, { images = 0, audio = 0, video = 0 } = {}) {
  capped(caps, 'references in total (images + audio + video)', images + audio + video, caps?.maxCombinedRefs);
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
  // Some models budget references ACROSS modalities instead of per kind (fal's Seedance 2.5 takes 50
  // combined and declares no per-kind cap at all). Checked after the per-kind caps so the more
  // specific message wins, and counting the demoted opening frame — it is already in `images`.
  capped(caps, 'references in total (images + audio + video)', images.length + audios.length + videos.length, caps.maxCombinedRefs);

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

export default { buildSeedanceArgs, firstFrameIsRef, fitAudioRef, audioWindowFor, voiceRefsRide, voiceRefSpeakers, voiceRefDemand, cappedAudioRefs, cappedCombinedRefs };
