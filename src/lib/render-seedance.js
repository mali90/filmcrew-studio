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
import { buildSeedanceArgs, firstFrameIsRef, fitAudioRef, audioWindowFor, nameOf } from './seedance-args.js';
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
  if (refs.length > caps.maxAudioRefs) {
    throw new Error(`job ${job.job_id}: ${refs.length} voiced speakers exceeds ${nameOf(caps)}'s ${caps.maxAudioRefs}-audio-ref cap — split the dialogue across jobs.`);
  }
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
 * `startFrame` (optional): the previous job clip's last frame, passed by pipeline.renderSpec for
 * cross-job seam continuity, used unless the job authors its own first_frame.
 * @param {object} params  { job, spec, runDir, seed, lowRes, startFrame, nonce, feedback }
 * @param {{caps:object, adapter:{assetUrl:Function, generate:Function}}} deps
 * @returns {Promise<{jobId:string, clip:string, totalDuration:number, segments:number}>}
 */
export async function renderSeedanceJob({ job, spec, runDir, seed, lowRes = false, startFrame = null, nonce = 0, feedback = '' }, { caps, adapter }) {
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
  //    An opening frame (authored first_frame wins over the chained seam frame) takes the LAST
  //    slot on models that demote it to a ref, so one slot is held back from the model's cap.
  const startFrameSrc = job.first_frame || startFrame || null;
  const maxImages = caps.maxImages - (startFrameSrc && firstFrameIsRef(caps, 1) ? 1 : 0);
  const groups = characterGroups(job, spec);
  const imageUrls = [];
  const imageRefs = []; // sidecar legend
  const refGroups = [];
  for (const g of groups) {
    const refs = [];
    for (const e of g.els) {
      if (imageUrls.length >= maxImages) {
        log.warn(`[${job.job_id}] image refs exceed ${nameOf(caps)}'s ${caps.maxImages}-image cap — dropping "${e.id}" (and any further refs).`);
        break;
      }
      imageUrls.push(await adapter.assetUrl(resolveImage(e.image), mode));
      refs.push(refLabel(caps, 'Image', imageUrls.length));
      imageRefs.push({ ref: refLabel(caps, 'Image', imageUrls.length), id: e.id, character: g.name });
    }
    refGroups.push({ name: g.name, refs });
  }
  // The frame itself is handed to the arg builder, which places it in the native slot or appends
  // it to the refs — `refCount` is what the prompt and the endpoint choice below must agree with.
  let startFrameRef = null;
  let firstFrameUrl = null;
  let startFrameSource = null;
  let refCount = imageUrls.length;
  if (startFrameSrc) {
    firstFrameUrl = await adapter.assetUrl(resolveImage(startFrameSrc), mode, { cache: false });
    startFrameSource = job.first_frame ?? path.basename(startFrame);
    if (firstFrameIsRef(caps, imageUrls.length)) {
      refCount += 1;
      startFrameRef = refLabel(caps, 'Image', refCount);
      imageRefs.push({ ref: startFrameRef, id: job.first_frame ? 'first_frame' : 'seam', source: startFrameSource });
    }
  }

  // An authored job.last_frame is a REAL model input where the caps have a native closing-frame
  // slot (Segmind). Native first/last mode excludes reference images there, so it only engages on
  // a job whose opening frame stayed native too — with cast refs in play the first frame demoted
  // to a reference and a closing frame has no slot to ride: fail loudly, because silently ignoring
  // an authored framing constraint delivers a paid clip that breaks it. Models with no native slot
  // (fal Seedance) keep the long-documented behaviour: last_frame is Kling-only and is ignored.
  let lastFrameUrl = null;
  if (job.last_frame && caps.argMap?.lastFrame) {
    if (firstFrameUrl && !firstFrameIsRef(caps, imageUrls.length)) {
      lastFrameUrl = await adapter.assetUrl(resolveImage(job.last_frame), mode, { cache: false });
    } else {
      throw new Error(`${job.job_id}: last_frame is authored, but ${nameOf(caps)} pins a closing frame only in native first/last mode, and this job's reference images occupy it — drop the job's last_frame or its reference images.`);
    }
  }

  // 2. Voice refs (@AudioN), only when audio is on AND voiceMode keeps the clip. In 'native' mode we
  //    attach NO clip and let the model voice the written line natively (see config.seedance.voiceMode).
  //    A text-to-video job (no image refs) also voices natively: the endpoint requires audio refs to
  //    ride ≥1 image/video ref, so with no images we attach no clip.
  const voiceRefs = ((refCount || firstFrameUrl) && sdCfg.generateAudio && knobs.voiceMode !== 'native') ? await audioRefsFor(job, spec, dir, caps) : [];
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

  // 3. ONE multi-shot prompt for the whole job (pure, unit-tested).
  const { prompt, shotPrompts, totalDuration } = buildSeedanceJobPrompt(job, spec, {
    refGroups,
    audioRefFor,
    startFrameRef,
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
    // return_last_frame is deliberately NOT requested: nothing downstream consumes the provider's
    // frame yet (seam chaining reads the ffmpeg-grabbed <job>/last_frame.png), so asking would tag
    // every paid job with a capability no code uses. The per-joint seam-lineage work wires it up.
  }, caps);
  // No image inputs AT ALL → text-to-video (Casting attached nothing relevant); rides at probe
  // resolution too. A native-slot first frame keeps refCount at 0 but is still an image the model
  // conditions on, so it must route through the reference endpoint, not the text one.
  // A model with NO text tier (Seedance 2.5) simply keeps its ordinary endpoint — including the
  // probe variant, so a text-to-video probe still renders cheap instead of at full resolution.
  const textToVideo = refCount === 0 && !firstFrameUrl;
  const endpointKey = (textToVideo && caps.textEndpointKey)
    ? caps.textEndpointKey
    : (lowRes ? (caps.probeEndpointKey ?? routeKey(caps)) : routeKey(caps));
  const endpoint = endpointFor(caps, endpointKey);

  log.step(`[${job.job_id}] ${caps.providerLabel} ${caps.label} ${textToVideo ? 'text-to-video' : 'reference-to-video'}${lowRes ? ' [probe]' : ''} — ${shotPrompts.length} shot(s), ${args.duration}s, ${refCount} image ref(s)${audioUrls.length ? `, ${audioUrls.length} voice ref(s)` : ''}, ${args.resolution} ${args.aspect_ratio}`);

  const sidecarPath = path.join(dir, 'prompts.json');
  const sidecar = {
    job_id: job.job_id,
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
    image_refs: imageRefs,
    audio_refs: voiceRefs.map((r, i) => ({ ref: refLabel(caps, 'Audio', i + 1), speaker: r.speaker, clip: r.clip })),
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
  log.info(`[${job.job_id}] clip -> ${clip}`);
  return { jobId: job.job_id, clip, totalDuration, segments: shotPrompts.length };
}

export default { renderSeedanceJob };
