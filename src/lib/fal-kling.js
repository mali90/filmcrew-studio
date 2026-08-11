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
import { chooseSeamMode } from './prompt-compose.js';
import { readJobOverride } from './prompt-overrides.js';
import { capsFor } from './render-models.js';
import { generateKling, toFalInput, falRef, isValidationError, isTransientFalError } from './fal.js';
import { characterGroups, jobSpeakers } from './cast-groups.js';
import { resolveImage } from './elements.js';
import { getVoiceId } from './voices.js';
import { slug } from './util.js';

// The cast helpers now live in the provider-neutral cast-groups.js (every renderer reads the spec
// the same way). Re-exported here so no import path downstream changed.
export { characterGroups, jobSpeakers };

const MAX_REFS_PER_ELEMENT = 3; // schema: 1-3 additional reference images per element
const MAX_VOICES_PER_JOB = 2;   // Kling hard cap: at most two bound voices per task (runbook §5)

const oneMp4 = (outs) => outs.find((p) => /\.(mp4|mov|webm)$/i.test(p)) ?? outs[0];

/** A local image as a fal input (cached across runs in storage mode) — shared falRef, config mode. */
const falRefFor = (absPath) => falRef(absPath, config.fal.uploadMode);

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
export async function renderKlingJobFal({ job, spec, runDir, seed, lowRes = false, startFrame = null, endFrame = null, feedsNext = false, seamInFrom = null, seamOutTo = null, nonce = 0, feedback = '', backend = 'kling-o3@fal' }) {
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
  const endFrameSrc = job.last_frame || endFrame || null;
  // How this job's boundaries can actually be pinned on THIS backend — the same decision the
  // Seedance renderer, the server preview and the re-render dialog all read. Kling seeds a frame
  // through its Elements set, so a text-to-video job (no element at all) pins nothing.
  const seam = chooseSeamMode({
    caps: capsFor(backend),
    castRefCount: textToVideo ? 0 : groups.reduce((n, g) => n + g.els.length, 0),
    hasSeamIn: !!startFrameSrc,
    hasSeamOut: !!endFrameSrc,
  });

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
  //    A prompt override (snapshotted into this take dir before submit) replaces the SCENE BODY of
  //    each shot; the framing, the spoken line, the @Element lead and the 500-byte clamp are all
  //    re-composed around it, per segment — Kling's budget is per segment, so an edit's is too.
  const { segments, totalDuration, promptSource } = buildKlingStoryboard(job, spec, {
    lowercaseSpeech: true, leadRef: textToVideo ? null : '@Element1', voiceTokenFor,
    override: readJobOverride(runDir, job.job_id),
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
    if (seam.in.mode === 'native') payload.start_image_url = await falRefFor(resolveImage(startFrameSrc));
    if (seam.out.mode === 'native') payload.end_image_url = await falRefFor(resolveImage(endFrameSrc));
  } else if (startFrameSrc) {
    log.warn(`[${job.job_id}] Kling text-to-video ignores the first_frame seed (no reference element) — add a reference to elements/references/ to pin the opening frame.`);
  }

  log.step(`[${job.job_id}] fal Kling ${textToVideo ? 'text-to-video' : 'reference-to-video'} — ${segments.length} shot(s), ${totalDuration}s, ${elements.length} element(s)${voiced ? `, ${voiced} voice(s)` : ''}${lowRes ? ' (probe)' : ''}`);

  // Effective prompts/elements → sidecar for review. Normalized to the SEEDANCE SUPERSET (schema:2)
  // so one reader serves both renderers, while every key Kling wrote before is still here.
  const elementLegend = textToVideo ? [] : groups.map((g, i) => ({ ref: `@Element${i + 1}`, character: g.name, images: g.els.map((e) => e.id), voice_id: getVoiceId(g.name) ?? null }));
  const sidecar = {
    job_id: job.job_id,
    schema: 2,
    backend, transport: 'fal', endpoint,
    // No resolution recorded: the endpoint takes none (fixed native output), so a sidecar claiming
    // a tier would be the manifest lying about what was bought — the master's measured shortSide is
    // the delivered truth.
    aspect_ratio: klingCfg.aspectRatio,
    duration_s: totalDuration, total_duration_s: totalDuration,
    generate_audio: !!klingCfg.generateAudio,
    // fal's Kling endpoint takes no seed input, so the number is only ever a record of what a take
    // WOULD have used — recorded under `seed_unused`, exactly as the Seedance sidecar does it.
    seed: null, seed_unused: seed ?? null,
    nonce,
    start_frame: textToVideo ? null : (job.first_frame ?? (startFrame ? `seam:${path.basename(startFrame)}` : null)),
    // A source clip is recorded only for a seam that was actually applied: a text-to-video job is
    // handed a seam frame it cannot use, and naming its source would claim a continuation the clip
    // does not have (see the Seedance sidecar for the two ends' asymmetry).
    seam_in: { mode: seam.in.mode, frame: seam.in.mode === 'none' ? null : startFrameSrc, from: seam.in.mode === 'none' ? null : (seamInFrom ?? null) },
    seam_out: { mode: seam.out.mode, frame: seam.out.mode === 'none' ? null : endFrameSrc, frameSource: null, to: seamOutTo ?? null },
    image_refs: elementLegend.map((e) => ({ ref: e.ref, id: e.images[0] ?? null, character: e.character })),
    elements: elementLegend,
    // Whose words these are: 'plan' (the agents') or 'override' (a saved prompt edit) — the same key
    // the Seedance sidecar carries, so one reader answers "why does this take read differently?".
    prompt_source: promptSource ?? 'plan',
    segments,
  };
  const writeSidecar = () => {
    try { fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify(sidecar, null, 2)); } catch { /* sidecar best-effort */ }
  };
  writeSidecar();

  // `end_image_url` is documented on the model's API tab but unverified in practice, so it ships
  // with ONE fallback: a validation rejection that NAMES it re-submits the identical payload minus
  // that field and records the downgrade. Anything else propagates on the first attempt — fal bills
  // per accepted submit, and a blanket retry would double the bill on every unrelated 422.
  //
  // `!isTransientFalError` is the other half of that predicate, and it is load-bearing: fal returns
  // HTTP 422 "…is not valid: timeout while fetching resource" — naming the very field it could not
  // fetch — when a worker transiently misses a reference URL we just uploaded. Read as a schema
  // rejection, a CDN race on the closing frame would permanently write `seam_out.mode:'unsupported'`
  // (a lie the lineage and the stitcher then act on) AND buy a second render. generateKling's own
  // retry loop pairs the two predicates the same way.
  const submit = (body) => generateKling(body, { endpoint, destDir: dir, timeoutMs: 1200000 });
  let outs;
  try {
    outs = await submit(payload);
  } catch (e) {
    const rejectedEndFrame = payload.end_image_url && isValidationError(e) && !isTransientFalError(e)
      && /end_image_url/.test(String(e?.message ?? ''));
    if (!rejectedEndFrame) throw e;
    log.warn(`[${job.job_id}] fal Kling rejected end_image_url (${String(e.message).slice(0, 120)}) — retrying once without the closing-frame pin; this clip's ending may jump.`);
    const { end_image_url: _dropped, ...withoutEndFrame } = payload;
    sidecar.seam_out.mode = 'unsupported';
    writeSidecar();
    outs = await submit(withoutEndFrame);
  }
  const clip = oneMp4(outs);
  log.info(`[${job.job_id}] fal Kling clip -> ${clip}`);
  return { jobId: job.job_id, clip, totalDuration, segments: segments.length, seamIn: sidecar.seam_in, seamOut: sidecar.seam_out, providerLastFrame: null };
}

export default { renderKlingJobFal };
