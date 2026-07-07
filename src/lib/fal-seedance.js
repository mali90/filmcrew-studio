// Seedance 2.0 renderer on the fal.ai backend. Consumes ONE job of a render spec and returns
// { jobId, clip, totalDuration, segments } — the exact contract of fal-kling.js — so
// pipeline.renderSpec dispatches per job (RENDERERS table) and finishRender stitches identically.
//
// Differences from the Kling renderer, all verified against the endpoint's fal "API" tab
// (config.fal.seedanceEndpoint):
//   - Inputs are FLAT refs, not elements: image_urls (≤9 → @Image1..N in the prompt) + audio_urls
//     (≤3 voice clips, MP3/WAV, combined ≤15s → @Audio1..N). No bound voice_id — lip-sync rides
//     the character's mint-time clip itself (voices.json ref_clip).
//   - ONE rich prompt per job (multi-shot with transition connectors) — no multi_prompt.
//   - NO start_image_url: an authored job.first_frame or the chained seam frame is appended as the
//     LAST image ref and prompt-pinned ("Use @ImageN as the literal first frame …").
//   - NO seed and NO negative_prompt (both HTTP 422 — deterministic, never retried): `seed` is
//     recorded in prompts.json only; take-to-take variation is a prompt nonce (--take).
//   - lowRes (--probe) rides the SAME standard endpoint at the probe resolution (no mini/fast tier).
import path from 'node:path';
import fs from 'node:fs';
import config from '../../config.js';
import log from './logger.js';
import { buildSeedanceJobPrompt, seedanceConfigFor } from './seedance.js';
import { characterGroups, jobSpeakers } from './fal-kling.js';
import { generateSeedance, falRef, toFalInputAs } from './fal.js';
import { resolveImage } from './elements.js';
import { getVoiceRefClip } from './voices.js';
import { probeClip, extractAudio } from './assemble.js';
import { slug } from './util.js';

const AUDIO_REFS_BUDGET_S = 15; // endpoint cap: audio_urls combined length ≤ 15s
const oneMp4 = (outs) => outs.find((p) => /\.(mp4|mov|webm)$/i.test(p)) ?? outs[0];

/**
 * The final Seedance args object. PURE (unit-tested): guarantees the two 422 landmines — `seed`
 * and `negative_prompt` — can never appear, clamps duration into the model's 4–15s range, and
 * ships it as the STRING the endpoint expects.
 */
export function buildSeedanceArgs({ prompt, imageUrls, audioUrls = [], aspectRatio, resolution, generateAudio, totalDuration }) {
  const s = config.seedance;
  const args = {
    prompt,
    aspect_ratio: aspectRatio,
    resolution,
    duration: String(Math.min(s.maxJobSeconds, Math.max(s.minJobSeconds, Math.round(Number(totalDuration) || 0)))),
    generate_audio: !!generateAudio,
  };
  if (imageUrls?.length) args.image_urls = imageUrls; // omitted for a text-to-video job (no reference image)
  if (audioUrls.length) args.audio_urls = audioUrls;
  return args;
}

/**
 * Voice refs for the job's speakers: [{ speaker, clip }] from the registry's mint-time clips,
 * re-cut to the endpoint's budget (MP3/WAV, combined ≤15s) when needed. Speakers without a clip
 * are warned once and voiced natively by the model; more voiced speakers than the model's audio
 * cap is a hard error (mirrors Kling's voice-cap error).
 */
async function audioRefsFor(job, spec, dir) {
  const speakers = jobSpeakers(job, spec);
  const refs = [];
  for (const sp of speakers) {
    const clip = getVoiceRefClip(sp);
    if (clip) refs.push({ speaker: sp, clip });
    else log.warn(`[${job.job_id}] no voice ref clip for "${sp}" — Seedance voices the line natively (mint one with: npm run mint-voice -- "${sp}" <clip>)`);
  }
  if (refs.length > config.seedance.maxAudioRefs) {
    throw new Error(`fal job ${job.job_id}: ${refs.length} voiced speakers exceeds Seedance's ${config.seedance.maxAudioRefs}-audio-ref cap — split the dialogue across jobs.`);
  }
  const perClipS = Math.floor(AUDIO_REFS_BUDGET_S / (refs.length || 1));
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
      log.warn(`[${job.job_id}] could not fit the "${r.speaker}" voice clip to Seedance's ${AUDIO_REFS_BUDGET_S}s audio budget (${e.message}) — sending it as-is.`);
    }
  }
  return refs;
}

/**
 * Render ONE Seedance job on fal (reference-to-video) → a single mp4 under <runDir>/<job_id>/.
 * `startFrame` (optional): the previous job clip's last frame, passed by pipeline.renderSpec for
 * cross-job seam continuity — appended as the last @Image ref and prompt-pinned as the first frame
 * unless the job authors its own first_frame. `seed` is accepted for contract parity but NEVER
 * sent (Seedance 422s on it); pass `nonce` (--take) to vary a retake instead.
 * @returns {Promise<{jobId:string, clip:string, totalDuration:number, segments:number}>}
 */
export async function renderSeedanceJobFal({ job, spec, runDir, seed, lowRes = false, startFrame = null, nonce = 0, feedback = '' }) {
  const dir = path.join(runDir, job.job_id);
  fs.mkdirSync(dir, { recursive: true });
  const sdCfg = seedanceConfigFor(spec);
  const mode = config.seedance.uploadMode;

  // 1. Image refs: each character group's images become flat @ImageN refs, in prompt order.
  //    An opening frame (authored first_frame wins over the chained seam frame) takes the LAST
  //    slot, so one slot is held back from the model's image cap.
  const startFrameSrc = job.first_frame || startFrame || null;
  const maxImages = config.seedance.maxImages - (startFrameSrc ? 1 : 0);
  const groups = characterGroups(job, spec);
  const imageUrls = [];
  const imageRefs = []; // sidecar legend
  const refGroups = [];
  for (const g of groups) {
    const refs = [];
    for (const e of g.els) {
      if (imageUrls.length >= maxImages) {
        log.warn(`[${job.job_id}] image refs exceed Seedance's ${config.seedance.maxImages}-image cap — dropping "${e.id}" (and any further refs).`);
        break;
      }
      imageUrls.push(await falRef(resolveImage(e.image), mode));
      refs.push(`@Image${imageUrls.length}`);
      imageRefs.push({ ref: `@Image${imageUrls.length}`, id: e.id, character: g.name });
    }
    refGroups.push({ name: g.name, refs });
  }
  let startFrameRef = null;
  if (startFrameSrc) {
    // No falRef cache here: seam frames are per-run files that all share the basename
    // last_frame.png, so the basename-keyed cache would churn/collide.
    imageUrls.push(await toFalInputAs(resolveImage(startFrameSrc), mode));
    startFrameRef = `@Image${imageUrls.length}`;
    imageRefs.push({ ref: startFrameRef, id: job.first_frame ? 'first_frame' : 'seam', source: job.first_frame ?? path.basename(startFrame) });
  }

  // 2. Voice refs (@AudioN), only when audio is on AND voiceMode keeps the clip. In 'native' mode we
  //    attach NO clip and let the model voice the written line natively (see config.seedance.voiceMode).
  //    A text-to-video job (no image refs) also voices natively: the endpoint requires audio refs to
  //    ride ≥1 image/video ref, so with no images we attach no clip.
  const voiceRefs = (imageUrls.length && sdCfg.generateAudio && config.seedance.voiceMode !== 'native') ? await audioRefsFor(job, spec, dir) : [];
  const audioUrls = [];
  const audioIdx = new Map();
  for (const r of voiceRefs) {
    audioUrls.push(await falRef(r.clip, mode));
    audioIdx.set(slug(r.speaker), audioUrls.length);
  }
  const audioRefFor = (sp) => {
    const i = audioIdx.get(slug(sp ?? ''));
    return i ? `@Audio${i}` : null;
  };

  // 3. ONE multi-shot prompt for the whole job (pure, unit-tested).
  const { prompt, shotPrompts, totalDuration } = buildSeedanceJobPrompt(job, spec, {
    refGroups,
    audioRefFor,
    startFrameRef,
    style: config.seedance.style,
    avoidClause: config.seedance.avoid,
    textClause: config.seedance.textRule,
    feedback, // per-take director note ("Director note: …" in the prompt front matter)
    nonce,
    maxBytes: config.seedance.promptMaxBytes,
  });

  const args = buildSeedanceArgs({
    prompt,
    imageUrls,
    audioUrls,
    aspectRatio: sdCfg.aspectRatio,
    resolution: lowRes ? config.seedance.probeResolution : sdCfg.resolution,
    generateAudio: sdCfg.generateAudio,
    totalDuration,
  });
  // No image refs → text-to-video (Casting attached nothing relevant); rides at probe resolution too.
  const textToVideo = imageUrls.length === 0;
  const endpoint = textToVideo
    ? config.fal.seedanceTextEndpoint
    : (lowRes ? config.fal.seedanceProbeEndpoint : config.fal.seedanceEndpoint);

  log.step(`[${job.job_id}] fal Seedance 2.0 ${textToVideo ? 'text-to-video' : 'reference-to-video'}${lowRes ? ' [probe]' : ''} — ${shotPrompts.length} shot(s), ${args.duration}s, ${imageUrls.length} image ref(s)${audioUrls.length ? `, ${audioUrls.length} voice ref(s)` : ''}, ${args.resolution} ${args.aspect_ratio}`);

  try {
    fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify({
      job_id: job.job_id,
      backend: 'seedance',
      endpoint,
      aspect_ratio: args.aspect_ratio,
      resolution: args.resolution,
      duration_s: args.duration,
      generate_audio: args.generate_audio,
      seed_unused: seed ?? null, // Seedance accepts no seed (422) — recorded for traceability only
      nonce,
      start_frame: startFrameRef ? imageRefs.at(-1).source : null,
      image_refs: imageRefs,
      audio_refs: voiceRefs.map((r, i) => ({ ref: `@Audio${i + 1}`, speaker: r.speaker, clip: r.clip })),
      prompt,
      shot_prompts: shotPrompts,
    }, null, 2));
  } catch { /* sidecar is best-effort */ }

  const outs = await generateSeedance(args, { endpoint, destDir: dir, timeoutMs: 1200000 });
  const clip = oneMp4(outs);
  log.info(`[${job.job_id}] clip -> ${clip}`);
  return { jobId: job.job_id, clip, totalDuration, segments: shotPrompts.length };
}

export default { renderSeedanceJobFal, buildSeedanceArgs };
