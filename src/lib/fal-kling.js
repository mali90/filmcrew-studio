// Kling renderer on the fal.ai backend. It consumes the render spec and returns
// { jobId, clip, totalDuration, segments }, so pipeline.finishRender() stitches/dubs/upscales it.
//
// It targets fal's "reference-to-video" endpoint (o3): a TEXT prompt drives the video while
// `elements` pin each recurring character — every element carries its LOOK (a frontal image + up to
// 3 angle references) AND a bound persistent `voice_id` (minted once via create-voice). No first
// frame is required. Elements are referenced in the prompt as @Element1, @Element2, … so the element
// whose @ElementN appears speaks with its bound voice. Multi-shot is native via `multi_prompt`.
//
// Schema verified against the model's fal "API" tab (config.fal.klingEndpoint):
//   KlingV3ComboElementInput { frontal_image_url, reference_image_urls[1-3], video_url?, voice_id? }
//   inputs: prompt | multi_prompt[{prompt,duration}], elements[], aspect_ratio, generate_audio,
//           duration, start_image_url?, end_image_url?  (start/end optional — not used unless the spec
//           job sets first_frame/last_frame).
import path from 'node:path';
import fs from 'node:fs';
import config from '../../config.js';
import log from './logger.js';
import { buildKlingStoryboard, klingConfigFor } from './kling.js';
import { generateKling, toFalInput, falRef } from './fal.js';
import { resolveImage } from './elements.js';
import { getVoiceId } from './voices.js';
import { slug } from './util.js';

const MAX_REFS_PER_ELEMENT = 3; // schema: 1-3 additional reference images per element
const MAX_VOICES_PER_JOB = 2;   // Kling hard cap: at most two bound voices per task (runbook §5)

const oneMp4 = (outs) => outs.find((p) => /\.(mp4|mov|webm)$/i.test(p)) ?? outs[0];

/** A local image as a fal input (cached across runs in storage mode) — shared falRef, config mode. */
const falRefFor = (absPath) => falRef(absPath, config.fal.uploadMode);

/** Distinct speaker names among a job's VO lines (first-seen order, first-seen casing). Deduped by
 *  slug — the voice registry and the element/audio-ref maps all match speakers slug-wise, so "Host"
 *  and "host" are the same character and must not count twice. Shared with fal-seedance.js. */
export function jobSpeakers(job, spec) {
  const seen = new Map();
  for (const l of spec.audio?.voice?.lines ?? []) {
    if (!job.shots.includes(l?.shot_id) || !(l?.text ?? '').trim() || !l?.speaker) continue;
    if (!seen.has(slug(l.speaker))) seen.set(slug(l.speaker), l.speaker);
  }
  return [...seen.values()];
}

/**
 * Group a job's spec elements into one fal element per character. If any element carries a `character`
 * field, group by it (multi-character); otherwise all of the job's images form ONE element named after
 * the job's sole speaker (or 'subject'). Each group → @Element{index} in prompt order. Shared with
 * fal-seedance.js, where each group's images become flat @ImageN refs instead.
 */
export function characterGroups(job, spec) {
  const roster = spec.kling.elements ?? [];
  const ids = job.elements?.length ? job.elements : roster.map((e) => e.id);
  const els = ids.map((id) => {
    const e = roster.find((r) => r.id === id);
    if (!e) throw new Error(`fal job ${job.job_id}: element id "${id}" not in spec.kling.elements`);
    return e;
  });
  if (els.some((e) => e.character)) {
    const m = new Map();
    for (const e of els) { const c = e.character || e.id; if (!m.has(c)) m.set(c, []); m.get(c).push(e); }
    return [...m.entries()].map(([name, list]) => ({ name, els: list }));
  }
  const speakers = jobSpeakers(job, spec);
  return [{ name: speakers.length === 1 ? speakers[0] : 'subject', els }];
}

/**
 * Render ONE Kling job on fal (reference-to-video) → a single mp4 under <runDir>/<job_id>/.
 * `startFrame` (optional): the previous job clip's last frame, passed by pipeline.renderSpec for
 * cross-job seam continuity — used as start_image_url unless the job authors its own first_frame.
 * @returns {Promise<{jobId:string, clip:string, totalDuration:number, segments:number}>}
 */
// `nonce`/`feedback` are accepted for renderer-contract parity but unused here: the fal Kling
// endpoint takes no seed input (every render is naturally a fresh take), and director feedback
// reaches Kling through an engine revision (which rewrites the content prompts) instead of a
// prompt suffix — the 512-char segment budget leaves no room for a reliable note.
export async function renderKlingJobFal({ job, spec, runDir, seed, lowRes = false, startFrame = null, nonce = 0, feedback = '' }) {
  if (feedback) {
    log.warn(`[${job.job_id}] Kling ignores per-render director notes (its 512-char segment budget leaves no room) — route feedback through a revision (revise) so the engine rewrites the prompts instead.`);
  }
  const dir = path.join(runDir, job.job_id);
  fs.mkdirSync(dir, { recursive: true });
  const klingCfg = klingConfigFor(spec);

  // 1. Character elements (look + bound voice), and a speaker → @ElementN resolver. When Casting
  //    attached no references (an image-less idea), there are no elements → TEXT-TO-VIDEO: the video
  //    is driven by the prompts alone, with no @Element refs, no bound voices, and no start/end frame.
  const groups = characterGroups(job, spec);
  const textToVideo = groups.every((g) => g.els.length === 0);
  const startFrameSrc = job.first_frame || startFrame || null;

  const idxByName = new Map(groups.map((g, i) => [slug(g.name), i + 1]));
  if (!textToVideo) {
    for (const sp of jobSpeakers(job, spec)) {
      if (groups.length > 1 && !idxByName.has(slug(sp))) {
        throw new Error(`fal job ${job.job_id}: speaker "${sp}" matches no element character — set a "character" field on that character's elements (one of: ${groups.map((g) => g.name).join(', ')}).`);
      }
    }
  }
  const voiceTokenFor = textToVideo ? () => '' : (sp) => {
    const i = idxByName.get(slug(sp ?? '')) ?? (groups.length === 1 ? 1 : null);
    return i ? `@Element${i}` : '';
  };

  const elements = [];
  if (!textToVideo) {
    for (const g of groups) {
      const urls = [];
      for (const e of g.els) urls.push(await falRefFor(resolveImage(e.image)));
      const refs = urls.slice(1, 1 + MAX_REFS_PER_ELEMENT);
      const el = { frontal_image_url: urls[0], reference_image_urls: refs.length ? refs : [urls[0]] };
      const voiceId = getVoiceId(g.name);
      if (voiceId) el.voice_id = voiceId;
      elements.push(el);
    }
  }
  const voiced = elements.filter((e) => e.voice_id).length;
  if (voiced > MAX_VOICES_PER_JOB) {
    throw new Error(`fal job ${job.job_id}: ${voiced} voiced characters exceeds Kling's ${MAX_VOICES_PER_JOB}-voice/task cap — split the dialogue across jobs.`);
  }

  // 2. Storyboard prompts: @Element1 leads every shot (look), the speaker's @ElementN voices the line.
  //    In text-to-video there is no ref to lead with (leadRef null) and no @ElementN voice token.
  const { segments, totalDuration } = buildKlingStoryboard(job, spec, {
    lowercaseSpeech: true, leadRef: textToVideo ? null : '@Element1', voiceTokenFor,
  });

  // 3. Payload. reference-to-video carries `elements`; text-to-video carries none (and no frames).
  const endpoint = textToVideo ? config.fal.klingTextEndpoint : config.fal.klingEndpoint;
  const payload = { aspect_ratio: klingCfg.aspectRatio, generate_audio: klingCfg.generateAudio };
  if (!textToVideo) payload.elements = elements;
  if (segments.length > 1) {
    payload.multi_prompt = segments.map((s) => ({ prompt: s.prompt, duration: String(Math.min(15, Math.max(1, s.duration))) }));
  } else {
    payload.prompt = segments[0].prompt;
    payload.duration = String(Math.min(15, Math.max(3, totalDuration)));
  }
  // Opening frame (reference-to-video only): an authored job.first_frame (intentional seed) wins; else
  // the chained SEAM frame (previous job clip's last frame, from pipeline.renderSpec) pins this job's
  // start so the cross-job cut is continuous. text-to-video has no element to seed a frame from.
  if (!textToVideo) {
    if (startFrameSrc) payload.start_image_url = await falRefFor(resolveImage(startFrameSrc));
    if (job.last_frame) payload.end_image_url = await falRefFor(resolveImage(job.last_frame));
  } else if (startFrameSrc) {
    log.warn(`[${job.job_id}] Kling text-to-video ignores the first_frame seed (no reference element) — add a reference to elements/references/ to pin the opening frame.`);
  }

  log.step(`[${job.job_id}] fal Kling ${textToVideo ? 'text-to-video' : 'reference-to-video'} — ${segments.length} shot(s), ${totalDuration}s, ${elements.length} element(s)${voiced ? `, ${voiced} voice(s)` : ''}${lowRes ? ' (probe)' : ''}`);

  // Effective prompts/elements → sidecar for review (mirrors the cloud renderer).
  try {
    fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify({
      job_id: job.job_id, transport: 'fal', endpoint,
      aspect_ratio: klingCfg.aspectRatio, generate_audio: !!klingCfg.generateAudio, total_duration_s: totalDuration,
      start_frame: textToVideo ? null : (job.first_frame ?? (startFrame ? `seam:${path.basename(startFrame)}` : null)),
      elements: textToVideo ? [] : groups.map((g, i) => ({ ref: `@Element${i + 1}`, character: g.name, images: g.els.map((e) => e.id), voice_id: getVoiceId(g.name) ?? null })),
      segments,
    }, null, 2));
  } catch { /* sidecar best-effort */ }

  const outs = await generateKling(payload, { endpoint, destDir: dir, timeoutMs: 1200000 });
  const clip = oneMp4(outs);
  log.info(`[${job.job_id}] fal Kling clip -> ${clip}`);
  return { jobId: job.job_id, clip, totalDuration, segments: segments.length };
}

export default { renderKlingJobFal };
