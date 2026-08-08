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
//     file into something the provider can fetch, `generate(args, {endpoint, destDir, timeoutMs})`
//     runs the job and returns downloaded output paths. Adapters are DEFINED BY THE PROVIDER
//     BINDING, not here — fal's lives in fal-seedance.js — so this file imports no transport and
//     `import('./render-seedance.js')` never pulls fal (or, later, segmind) into the graph.
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
import { buildSeedanceArgs, firstFrameIsRef, nameOf } from './seedance-args.js';
import { buildSeedanceJobPrompt, seedanceConfigFor } from './seedance.js';
import { characterGroups, jobSpeakers } from './cast-groups.js';
import { resolveImage } from './elements.js';
import { getVoiceRefClip } from './voices.js';
import { probeClip, extractAudio } from './assemble.js';
import { slug } from './util.js';

const oneMp4 = (outs) => outs.find((p) => /\.(mp4|mov|webm)$/i.test(p)) ?? outs[0];

/**
 * Resolve one of the caps' endpoint KEY NAMES against the provider's config block. The registry
 * stores key names rather than endpoints so it can stay import-free (see render-models.js).
 */
function endpointFor(caps, key) {
  const block = config[caps.provider] ?? {};
  const endpoint = block[key];
  if (!endpoint) throw new Error(`${caps.id}: no endpoint configured for "${key}" — set it in the ${caps.provider} config block.`);
  return endpoint;
}

/**
 * Voice refs for the job's speakers: [{ speaker, clip }] from the registry's mint-time clips,
 * re-cut to the model's budget (MP3/WAV, combined ≤ caps.audioBudgetS) when needed. Speakers
 * without a clip are warned once and voiced natively by the model; more voiced speakers than the
 * model's audio cap is a hard error (mirrors Kling's voice-cap error).
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
  const perClipS = Math.floor(budgetS / (refs.length || 1));
  for (const r of refs) {
    // Best-effort fit: over-budget or non-MP3/WAV clips are re-cut via ffmpeg; on any
    // probe/ffmpeg failure the original is sent as-is (fal rejects it loudly if unusable).
    try {
      const isRefAudio = /\.(mp3|wav)$/i.test(r.clip);
      const dur = (await probeClip(r.clip)).duration;
      if (!isRefAudio || dur > perClipS) {
        r.clip = await extractAudio(r.clip, path.join(dir, `${slug(r.speaker)}_ref.mp3`), { seconds: dur > perClipS ? perClipS : undefined });
      }
    } catch (e) {
      log.warn(`[${job.job_id}] could not fit the "${r.speaker}" voice clip to ${nameOf(caps)}'s ${budgetS}s audio budget (${e.message}) — sending it as-is.`);
    }
  }
  return refs;
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
  const sdCfg = seedanceConfigFor(spec);
  const knobs = config.seedance; // user-tunable settings, never model caps
  const mode = knobs.uploadMode;

  // Fail fast on deterministic config errors BEFORE any asset leaves the machine: with storage
  // uploads, a bad SEEDANCE_RESOLUTION or aspect would otherwise cost a full round of reference
  // uploads before the arg builder reports it. Same error text as the builder's own validators.
  const effResolution = lowRes ? knobs.probeResolution : sdCfg.resolution;
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
    maxBytes: knobs.promptMaxBytes,
  });

  const args = buildSeedanceArgs({
    prompt,
    imageUrls,
    audioUrls,
    firstFrameUrl,
    aspectRatio: sdCfg.aspectRatio,
    resolution: lowRes ? knobs.probeResolution : sdCfg.resolution,
    generateAudio: sdCfg.generateAudio,
    totalDuration,
    seed,
  }, caps);
  // No image inputs AT ALL → text-to-video (Casting attached nothing relevant); rides at probe
  // resolution too. A native-slot first frame keeps refCount at 0 but is still an image the model
  // conditions on, so it must route through the reference endpoint, not the text one.
  const textToVideo = refCount === 0 && !firstFrameUrl;
  const endpointKey = textToVideo
    ? (caps.textEndpointKey ?? caps.endpointKey)
    : (lowRes ? (caps.probeEndpointKey ?? caps.endpointKey) : caps.endpointKey);
  const endpoint = endpointFor(caps, endpointKey);

  log.step(`[${job.job_id}] ${caps.providerLabel} ${caps.label} ${textToVideo ? 'text-to-video' : 'reference-to-video'}${lowRes ? ' [probe]' : ''} — ${shotPrompts.length} shot(s), ${args.duration}s, ${refCount} image ref(s)${audioUrls.length ? `, ${audioUrls.length} voice ref(s)` : ''}, ${args.resolution} ${args.aspect_ratio}`);

  try {
    fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify({
      job_id: job.job_id,
      backend: caps.id, // the canonical `<model>@<provider>` — same vocabulary as spec.render_backend
      // and render.json, so the sidecar answers "which MODEL produced this clip?" once two Seedance
      // models ship (the family token could not).
      endpoint,
      aspect_ratio: args.aspect_ratio,
      resolution: args.resolution,
      duration_s: args.duration,
      generate_audio: args.generate_audio,
      seed_unused: caps.supportsSeed ? null : (seed ?? null), // recorded where the model 422s on a seed
      nonce,
      start_frame: startFrameSrc ? startFrameSource : null,
      image_refs: imageRefs,
      audio_refs: voiceRefs.map((r, i) => ({ ref: refLabel(caps, 'Audio', i + 1), speaker: r.speaker, clip: r.clip })),
      prompt,
      shot_prompts: shotPrompts,
    }, null, 2));
  } catch { /* sidecar is best-effort */ }

  const outs = await adapter.generate(args, { endpoint, destDir: dir, timeoutMs: 1200000 });
  const clip = oneMp4(outs);
  log.info(`[${job.job_id}] clip -> ${clip}`);
  return { jobId: job.job_id, clip, totalDuration, segments: shotPrompts.length };
}

export default { renderSeedanceJob };
