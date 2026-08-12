// The Seedance renderer, generalized over (model, provider). Consumes ONE job of a render spec and
// returns { jobId, clip, totalDuration, segments } — the exact contract of fal-kling.js — so
// pipeline.renderSpec dispatches per job (RENDERERS table) and finishRender stitches identically.
//
// Two injection points keep this file free of model and provider branches:
//   - `caps` (render-models.js) carries every MODEL HARD LIMIT: image/audio budgets, the duration
//     window and type, the ref citation style, which endpoint CONFIG KEY to use. User-tunable
//     knobs (style, avoid, textRule, voiceMode, uploadMode, promptMaxBytes, probeResolution) are
//     NOT caps — they stay config-sourced here, exactly as they were.
//   - `adapter` carries the provider TRANSPORT: `assetUrl(absPath, mode, {cache})` turns a local
//     file into something the provider can fetch, and `generate(args, {endpoint, destDir,
//     timeoutMs, onMeta})` runs the job and returns downloaded output paths, optionally reporting a
//     receipt (request id, cost, credits left) through `onMeta`. Adapters are DEFINED BY THE
//     PROVIDER BINDING, not here — fal's lives in fal-seedance.js, Segmind's in
//     segmind-seedance.js — so this file imports no transport and `import('./render-seedance.js')`
//     pulls neither provider's client into the graph.
//
// Model behaviour that used to be hardcoded for fal Seedance 2.0 and is now data:
//   - Inputs are FLAT refs, not elements: image refs (≤ caps.maxImages → @Image1..N in the prompt)
//     + audio refs (≤ caps.maxAudioRefs voice clips, MP3/WAV, combined ≤ caps.audioBudgetS).
//     No bound voice_id — lip-sync rides the character's mint-time clip (voices.json ref_clip).
//   - ONE rich prompt per job (multi-shot with transition connectors) — no multi_prompt.
//   - An authored job.first_frame or the chained seam frame rides the model's native first-frame
//     slot where one exists, and is otherwise appended as the LAST image ref and prompt-pinned
//     ("Use @ImageN as the literal first frame …"). fal Seedance 2.0 has no native slot.
//   - `seed` is recorded in prompts.json and sent only where caps.supportsSeed says it is legal;
//     take-to-take variation is a prompt nonce (--take).
//   - lowRes (--probe) rides caps.probeEndpointKey at the configured probe resolution.
import path from 'node:path';
import fs from 'node:fs';
import config from '../../config.js';
import log from './logger.js';
import { refLabel } from './render-models.js';
import { buildSeedanceArgs, cappedAudioRefs, cappedCombinedRefs, fitAudioRef, audioWindowFor, voiceRefsRide, nameOf } from './seedance-args.js';
import { appliedSeamModes, chooseSeamMode, planSeamRefs } from './prompt-compose.js';
import { readJobOverride } from './prompt-overrides.js';
import { buildSeedanceJobPrompt, seedanceConfigFor, modelKnobs } from './seedance.js';
import { characterGroups, jobSpeakers } from './cast-groups.js';
import { resolveImage } from './elements.js';
import { getVoiceRefClip } from './voices.js';
import { probeClip, extractAudio } from './assemble.js';
import { slug } from './util.js';

const oneMp4 = (outs) => outs.find((p) => /\.(mp4|mov|webm)$/i.test(p)) ?? outs[0];

/**
 * Resolve one of the caps' route KEY NAMES against the provider's config block. The registry stores
 * key names rather than values so it can stay import-free (see render-models.js).
 */
function endpointFor(caps, key) {
  const block = config[caps.provider] ?? {};
  const endpoint = block[key];
  if (!endpoint) throw new Error(`${caps.id}: no endpoint configured for "${key}" — set it in the ${caps.provider} config block.`);
  return endpoint;
}

/**
 * The config key naming where this model's job is sent. Providers address a model differently — fal
 * by ENDPOINT PATH (`endpointKey`), Segmind by MODEL SLUG (`slugKey`) — and both resolve out of the
 * provider's own config block, so the renderer needs no branch on provider name.
 */
const routeKey = (caps) => caps.endpointKey ?? caps.slugKey;

/**
 * Voice refs for the job's speakers: [{ speaker, clip }] from the registry's mint-time clips,
 * fitted to the model's per-clip window (MP3/WAV, combined ≤ caps.audioBudgetS): too long is re-cut,
 * too short for a model that states a minimum is DROPPED with a warning (sending it would 422 the
 * whole paid job). Speakers without a clip are warned once and voiced natively by the model; more
 * voiced speakers than the model's audio cap is a hard error (mirrors Kling's voice-cap error).
 */
async function audioRefsFor(job, spec, dir, caps) {
  const budgetS = caps.audioBudgetS ?? 15;
  const speakers = jobSpeakers(job, spec);
  const refs = [];
  for (const sp of speakers) {
    const clip = getVoiceRefClip(sp);
    if (clip) refs.push({ speaker: sp, clip });
    else log.warn(`[${job.job_id}] no voice ref clip for "${sp}" — ${caps.label} voices the line natively (mint one with: npm run mint-voice -- "${sp}" <clip>)`);
  }
  cappedAudioRefs(caps, job.job_id, refs.length);
  // The model's per-clip window, sized for how many refs share the combined budget. `maxS` is
  // today's budget/N for a model with no declared window; `minS` is 0 unless the model states one
  // (Segmind's Seedance 2.5 422s on a clip under 2s — a dropped ref costs a voice, a rejected
  // submit costs the whole paid job).
  const fitCaps = { ...caps, audioBudgetS: budgetS };
  const { minS, maxS } = audioWindowFor(fitCaps, refs.length || 1);
  const kept = [];
  for (const r of refs) {
    // Best-effort fit: over-budget or non-MP3/WAV clips are re-cut via ffmpeg; on any
    // probe/ffmpeg failure the original is sent as-is (fal rejects it loudly if unusable).
    try {
      const isRefAudio = /\.(mp3|wav)$/i.test(r.clip);
      const dur = (await probeClip(r.clip)).duration;
      const fit = fitAudioRef(dur, fitCaps, { refCount: refs.length || 1 });
      if (fit === 'drop') {
        log.warn(`[${job.job_id}] the "${r.speaker}" voice ref is ${Number(dur).toFixed(1)}s — under ${nameOf(caps)}'s ${minS}s minimum per reference clip; dropping it (${caps.label} voices the line natively). Re-mint a longer clip with: npm run mint-voice -- "${r.speaker}" <clip>`);
        continue;
      }
      if (!isRefAudio || fit === 'cut') {
        r.clip = await extractAudio(r.clip, path.join(dir, `${slug(r.speaker)}_ref.mp3`), { seconds: fit === 'cut' ? maxS : undefined });
      }
    } catch (e) {
      log.warn(`[${job.job_id}] could not fit the "${r.speaker}" voice clip to ${nameOf(caps)}'s ${budgetS}s audio budget (${e.message}) — sending it as-is.`);
    }
    kept.push(r);
  }
  return kept;
}

/**
 * Render ONE Seedance job → a single mp4 under <runDir>/<job_id>/.
 * `startFrame` / `endFrame` (optional): the boundary frames pipeline.renderSpec hands over for seam
 * continuity — the previous clip's last frame and (for a frame-conditioned re-render) the next
 * clip's first frame. An authored job.first_frame / job.last_frame wins over either. How they are
 * APPLIED is chooseSeamMode's call, never this file's.
 * `feedsNext`: a job whose clip another segment opens on — the only case where it is worth asking a
 * provider for its own closing still (`return_last_frame`).
 * `seamInFrom` / `seamOutTo`: the lineage pointers ({take, job, clip}) the caller already knows.
 * @param {object} params  { job, spec, runDir, seed, lowRes, startFrame, endFrame, feedsNext, nonce, feedback }
 * @param {{caps:object, adapter:{assetUrl:Function, generate:Function}}} deps
 * @returns {Promise<{jobId:string, clip:string, totalDuration:number, segments:number,
 *                    seamIn:object, seamOut:object, providerLastFrame:string|null}>}
 */
export async function renderSeedanceJob({ job, spec, runDir, seed, lowRes = false, startFrame = null, endFrame = null, feedsNext = false, seamInFrom = null, seamOutTo = null, nonce = 0, feedback = '' }, { caps, adapter }) {
  const dir = path.join(runDir, job.job_id);
  fs.mkdirSync(dir, { recursive: true });
  const sdCfg = seedanceConfigFor(spec, caps);
  const knobs = config.seedance; // user-tunable settings, never model caps
  // …with the model's own block winning where it declares one (Seedance 2.5 renders 480p/720p only
  // and defaults to 720p, so it cannot share 2.0's resolution settings). Everything the model does
  // not redeclare — style, avoid, textRule, voiceMode, uploadMode, promptMaxBytes — stays shared.
  const probeResolution = modelKnobs(caps)?.probeResolution ?? knobs.probeResolution;
  const mode = knobs.uploadMode;

  // Fail fast on deterministic config errors BEFORE any asset leaves the machine: with storage
  // uploads, a bad SEEDANCE_RESOLUTION or aspect would otherwise cost a full round of reference
  // uploads before the arg builder reports it. Same error text as the builder's own validators.
  const effResolution = lowRes ? probeResolution : sdCfg.resolution;
  if (caps.resolutions?.length && !caps.resolutions.includes(effResolution)) {
    throw new Error(`Unknown resolution "${effResolution}" for ${nameOf(caps)} — use one of: ${caps.resolutions.join(', ')}.`);
  }
  if (caps.aspects?.length && !caps.aspects.includes(sdCfg.aspectRatio)) {
    throw new Error(`Unknown aspect ratio "${sdCfg.aspectRatio}" for ${nameOf(caps)} — use one of: ${caps.aspects.join(', ')}.`);
  }

  // 1. Image refs: each character group's images become flat @ImageN refs, in prompt order.
  //    Boundary frames (an authored first_frame/last_frame wins over the chained seam frame) are
  //    applied the way chooseSeamMode says this model can apply them: a native anchor where one
  //    really exists, otherwise a trailing image ref plus a prompt pin. planSeamRefs owns the
  //    budget — at the image cap the END pin goes first, then the START pin, and only then a cast
  //    reference, because a boundary hint is a nicety and a cast reference is the character.
  const startFrameSrc = job.first_frame || startFrame || null;
  const endFrameSrc = job.last_frame || endFrame || null;
  const groups = characterGroups(job, spec);

  // The combined budget (fal 2.5 takes 50 across images+audio+video, no per-kind caps) must ALSO
  // fail before any asset leaves the machine: each per-kind check can admit what the shared budget
  // rejects, and the arg builder's own capped() only fires after every reference has been uploaded.
  // Counted exactly as the builder will see it — kept image refs, the demoted opening frame, and
  // the fitted voice clips (video refs are never authored today). audioRefsFor is hoisted here for
  // that count: it is local ffmpeg work (fit/transcode into the take dir), no upload — and the gate
  // is `voiceRefsRide`, the one the prompt preview asks too (see section 2).
  const plannedImages = Math.min(groups.reduce((n, g) => n + g.els.length, 0), caps.maxImages);
  const seam = chooseSeamMode({
    caps, castRefCount: plannedImages, hasSeamIn: !!startFrameSrc, hasSeamOut: !!endFrameSrc,
  });
  const voiceRefs = voiceRefsRide({
    castRefCount: plannedImages, hasSeamIn: !!startFrameSrc, hasSeamOut: !!endFrameSrc,
    audioOn: sdCfg.generateAudio, voiceMode: knobs.voiceMode,
  }) ? await audioRefsFor(job, spec, dir, caps) : [];
  // Only the CAST is counted here: a soft-pinned boundary frame is droppable (planSeamRefs drops it
  // below), so counting it would fail a render that would have succeeded without its seam.
  cappedCombinedRefs(caps, { images: plannedImages, audio: voiceRefs.length });

  const castUrls = [];
  const castMeta = [];
  const refGroups = [];
  for (const g of groups) {
    const refs = [];
    for (const e of g.els) {
      if (castUrls.length >= caps.maxImages) {
        log.warn(`[${job.job_id}] image refs exceed ${nameOf(caps)}'s ${caps.maxImages}-image cap — dropping "${e.id}" (and any further refs).`);
        break;
      }
      castUrls.push(await adapter.assetUrl(resolveImage(e.image), mode));
      castMeta.push({ id: e.id, character: g.name });
      refs.push(refLabel(caps, 'Image', castUrls.length));
    }
    refGroups.push({ name: g.name, refs });
  }

  // Lay the reference list out BEFORE anything leaves the machine: a soft pin the budget drops has
  // no business being uploaded (a fal-storage round trip, or a base64 encode of a full frame) only
  // to be thrown away with a log line. The layout is decided over placeholders; the survivors get
  // the real URLs below.
  const startFrameSource = startFrameSrc ? (job.first_frame ?? path.basename(startFrame ?? startFrameSrc)) : null;
  const endFrameSource = endFrameSrc ? (job.last_frame ?? path.basename(endFrame ?? endFrameSrc)) : null;
  const layout = planSeamRefs({
    caps,
    castRefs: castUrls,
    seamIn: seam.in.mode === 'soft' ? 'seam:in' : null,
    seamOut: seam.out.mode === 'soft' ? 'seam:out' : null,
    otherRefCount: caps.maxCombinedRefs != null ? voiceRefs.length : 0,
  });
  for (const d of layout.dropped) log.warn(`[${job.job_id}] dropped the ${d.kind} reference — ${d.reason}.`);

  const startFrameRef = layout.imageRefs.find((r) => r.kind === 'seamIn')?.label ?? null;
  const endFrameRef = layout.imageRefs.find((r) => r.kind === 'seamOut')?.label ?? null;
  // What was APPLIED, not what was wished for: a soft pin whose reference lost its slot pinned
  // nothing, and must be recorded as no seam rather than as a promise the clip cannot keep.
  const applied = appliedSeamModes(seam, layout.imageRefs);
  const appliedIn = applied.in;
  const appliedOut = applied.out;
  // Upload only the frames that are really going to ride. `cache: false`: every seam file is named
  // last_frame.png, so caching by basename would hand this job the previous one's frame.
  const seamInUrl = (appliedIn === 'native' || startFrameRef)
    ? await adapter.assetUrl(resolveImage(startFrameSrc), mode, { cache: false }) : null;
  const seamOutUrl = (appliedOut === 'native' || endFrameRef)
    ? await adapter.assetUrl(resolveImage(endFrameSrc), mode, { cache: false }) : null;
  const plan = {
    ...layout,
    imageRefs: layout.imageRefs.map((r) => (
      r.kind === 'seamIn' ? { ...r, url: seamInUrl } : r.kind === 'seamOut' ? { ...r, url: seamOutUrl } : r)),
  };
  const imageUrls = plan.imageRefs.map((r) => r.url);
  const firstFrameUrl = appliedIn === 'native' ? seamInUrl : null;
  const lastFrameUrl = appliedOut === 'native' ? seamOutUrl : null;

  let castSeen = 0;
  const imageRefs = plan.imageRefs.map((r) => { // sidecar legend
    if (r.kind === 'cast') { const m = castMeta[castSeen++]; return { ref: r.label, id: m.id, character: m.character }; }
    if (r.kind === 'seamIn') return { ref: r.label, id: job.first_frame ? 'first_frame' : 'seam', source: startFrameSource };
    return { ref: r.label, id: job.last_frame ? 'last_frame' : 'seam_out', source: endFrameSource };
  });

  // 2. Voice refs (@AudioN), only when audio is on AND voiceMode keeps the clip. In 'native' mode we
  //    attach NO clip and let the model voice the written line natively (see config.seedance.voiceMode).
  //    A text-to-video job also voices natively: the endpoint requires audio refs to ride ≥1
  //    image/video ref, so with nothing to condition on we attach no clip — and a boundary frame at
  //    EITHER end is such a thing (voiceRefsRide). The refs themselves were fitted up top (pre-upload
  //    combined-budget check) — only the uploads happen here.
  const audioUrls = [];
  const audioIdx = new Map();
  for (const r of voiceRefs) {
    audioUrls.push(await adapter.assetUrl(r.clip, mode));
    audioIdx.set(slug(r.speaker), audioUrls.length);
  }
  const audioRefFor = (sp) => {
    const i = audioIdx.get(slug(sp ?? ''));
    return i ? refLabel(caps, 'Audio', i) : null;
  };

  // 3. ONE multi-shot prompt for the whole job (pure, unit-tested). A prompt override — the user's
  //    own words, snapshotted into THIS take dir before anything was submitted — replaces the shot
  //    bodies only: the front matter, the seam pins laid out just above and the byte clamp are all
  //    re-composed over it (applyOverride), so an edit can never cost the contract.
  const override = readJobOverride(runDir, job.job_id);
  const { prompt, shotPrompts, totalDuration, promptSource } = buildSeedanceJobPrompt(job, spec, {
    override,
    refGroups,
    audioRefFor,
    startFrameRef,
    endFrameRef,
    style: knobs.style,
    avoidClause: knobs.avoid,
    textClause: knobs.textRule,
    feedback, // per-take director note ("Director note: …" in the prompt front matter)
    nonce,
    shotSyntax: caps.shotSyntax, // how THIS model wants its shots joined (undefined ⇒ connectors)
    maxBytes: knobs.promptMaxBytes,
  });

  const args = buildSeedanceArgs({
    prompt,
    imageUrls,
    audioUrls,
    firstFrameUrl,
    lastFrameUrl,
    aspectRatio: sdCfg.aspectRatio,
    resolution: lowRes ? probeResolution : sdCfg.resolution,
    generateAudio: sdCfg.generateAudio,
    totalDuration,
    seed,
    // Ask for the generator's OWN closing still only where the caps declare it AND another segment
    // opens on this clip — the provider's pixels beat an ffmpeg re-encode of them, but tagging a
    // paid job with a flag nobody reads is not free of consequence either.
    returnLastFrame: (caps.supportsReturnLastFrame && feedsNext) ? true : undefined,
  }, caps);
  // No image inputs AT ALL → text-to-video (Casting attached nothing relevant); rides at probe
  // resolution too. A native-slot first frame keeps refCount at 0 but is still an image the model
  // conditions on, so it must route through the reference endpoint, not the text one.
  // A model with NO text tier (Seedance 2.5) simply keeps its ordinary endpoint — including the
  // probe variant, so a text-to-video probe still renders cheap instead of at full resolution.
  const refCount = imageUrls.length;
  const textToVideo = refCount === 0 && !firstFrameUrl;
  const endpointKey = (textToVideo && caps.textEndpointKey)
    ? caps.textEndpointKey
    : (lowRes ? (caps.probeEndpointKey ?? routeKey(caps)) : routeKey(caps));
  const endpoint = endpointFor(caps, endpointKey);

  log.step(`[${job.job_id}] ${caps.providerLabel} ${caps.label} ${textToVideo ? 'text-to-video' : 'reference-to-video'}${lowRes ? ' [probe]' : ''} — ${shotPrompts.length} shot(s), ${args.duration}s, ${refCount} image ref(s)${audioUrls.length ? `, ${audioUrls.length} voice ref(s)` : ''}, ${args.resolution} ${args.aspect_ratio}`);

  const sidecarPath = path.join(dir, 'prompts.json');
  const sidecar = {
    job_id: job.job_id,
    // schema:2 adds the seam lineage below. Continuity has to be a RECORDED FACT: knowing that a
    // seam frame was used says nothing about WHICH CLIP it came from, and a cut that mixes take 2's
    // K1 with take 1's K2 looks exactly like an intact chain without it.
    schema: 2,
    backend: caps.id, // the canonical `<model>@<provider>` — same vocabulary as spec.render_backend
    // and render.json, so the sidecar answers "which MODEL produced this clip?" once two Seedance
    // models ship (the family token could not).
    endpoint,
    aspect_ratio: args.aspect_ratio,
    resolution: args.resolution,
    duration_s: args.duration,
    generate_audio: args.generate_audio,
    // The seed, recorded honestly either way: `seed` is what was SENT (so a take can be
    // reproduced), `seed_unused` is the record of a seed an endpoint would 422 on (fal's 2.0).
    // Exactly one of them is ever non-null.
    seed: caps.supportsSeed ? (seed ?? null) : null,
    seed_unused: caps.supportsSeed ? null : (seed ?? null),
    nonce,
    start_frame: startFrameSrc ? startFrameSource : null,
    // `from`/`to` name the SOURCE and DESTINATION clips, which is what the continuity rule compares
    // against the cut. `from` is dropped along with an unapplied opening pin: a clip that was NOT
    // conditioned on that frame does not continue from it, and a source recorded next to
    // mode:'none' would be read as exactly the continuation that never happened.
    // The two ends are not symmetric: `mode` is about the pin applied to THIS render, while
    // seam_out's `frame`/`frameSource`/`to` are the closing still handed FORWARD — only knowable
    // once the next job has rendered, so the caller re-stamps them then (and only if that job
    // really opened on this frame).
    seam_in: { mode: appliedIn, frame: appliedIn === 'none' ? null : startFrameSrc, from: appliedIn === 'none' ? null : (seamInFrom ?? null) },
    seam_out: { mode: appliedOut, frame: appliedOut === 'none' ? null : endFrameSrc, frameSource: null, to: seamOutTo ?? null },
    image_refs: imageRefs,
    audio_refs: voiceRefs.map((r, i) => ({ ref: refLabel(caps, 'Audio', i + 1), speaker: r.speaker, clip: r.clip })),
    // Whose words these are: 'plan' (the agents') or 'override' (a saved prompt edit). A past take
    // is read back verbatim, so this is the only record of WHY its text differs from the plan's.
    prompt_source: promptSource ?? 'plan',
    prompt,
    shot_prompts: shotPrompts,
  };
  // Written BEFORE the job is submitted (a render that fails still leaves the prompt behind) and
  // rewritten if the transport hands back a receipt — hence best-effort on both passes.
  const writeSidecar = () => {
    try { fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2)); } catch { /* sidecar is best-effort */ }
  };
  writeSidecar();

  // `onMeta` is the provider's receipt for a PAID job — Segmind returns a request id plus the
  // cost/credits ledger, which lands in the sidecar as soon as the job completes (before the output
  // download, so a failed download still leaves the record of what was bought). fal issues no
  // receipt and never calls this, so fal sidecars keep exactly today's keys.
  const outs = await adapter.generate(args, {
    endpoint,
    destDir: dir,
    timeoutMs: 1200000,
    onMeta: (meta) => {
      if (!meta) return;
      sidecar.request_id = meta.requestId ?? null;
      sidecar.cost_usd = meta.cost ?? null;
      sidecar.remaining_credits = meta.remainingCredits ?? null;
      writeSidecar();
    },
  });
  const clip = oneMp4(outs);
  // The provider's own closing still, if we asked for one and it came back. The transport saves it
  // AS last_frame.png (queue-transport's `saveAs`), never under the CDN's own content-hashed name —
  // that is what makes this match hold against a real provider and not just against the mocks.
  const providerLastFrame = outs.find((p) => path.basename(p) === 'last_frame.png') ?? null;
  log.info(`[${job.job_id}] clip -> ${clip}`);
  return {
    jobId: job.job_id, clip, totalDuration, segments: shotPrompts.length,
    seamIn: sidecar.seam_in, seamOut: sidecar.seam_out, providerLastFrame,
  };
}

export default { renderSeedanceJob };
