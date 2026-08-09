// Shared Kling 3.0 Omni storyboard/config helpers used by the fal renderer (fal-kling.js). ONE Omni
// generation renders a SEQUENCE of storyboard segments with the cast/style pinned by reference images
// (the "Elements" feature), so identity holds across the cut without re-composing each shot. Model
// hard caps: ≤6 segments / ≤15s total / ≤512 chars per segment / ≤7 reference images. A longer video
// is split into multiple jobs (spec.kling.jobs[]); the job clips are stitched afterwards.
//
// The prompt text itself is composed by src/lib/prompt-compose.js and the effective settings by
// src/lib/prompt-settings.js — both pure and config-free, so web/server's prompt preview can produce
// the exact bytes this renderer sends without dragging config/dotenv into the server's static graph.
// THIS module is the config-bound shim: it reads config.kling and forwards. Call sites are unchanged.
import config from '../../config.js';
import { klingPromptSettings } from './prompt-settings.js';
import {
  applyOverride,
  composeKlingStoryboard,
  lineForShot as composeLineForShot,
  SHOT_SIZE_WORDS,
  speakerName,
} from './prompt-compose.js';

// Shared framing vocabulary — also used by the Seedance prompt builder (seedance.js) so both
// backends describe shots the same way.
export { SHOT_SIZE_WORDS, speakerName };

/** The effective Kling prompt/render settings for a spec, with config.kling as the defaults. */
export const klingSettingsFor = (spec) => klingPromptSettings(spec, config.kling);

/**
 * The spoken line for a shot: matched by `shot_id` (preferred), else an `at_s`-only line whose
 * timestamp falls inside this shot's [start,end) window (cumulative shot durations). Shared by both
 * renderers so `at_s` lines are VOICED, not silently dropped. Returns the line or null.
 */
export const lineForShot = (spec, shotId) => composeLineForShot(spec, shotId, config.kling.defaultShotSeconds);

/**
 * Compose one job's storyboard from its shots' `kling` blocks — see composeKlingStoryboard() for the
 * segment shape, the byte budget and the `opts` transport adaptations (lowercaseSpeech, leadRef,
 * voiceTokenFor). Segment count and total duration caps are asserted there.
 * `opts.override` (optional): this job's saved prompt-override entry — the user's own scene bodies,
 * re-wrapped in the system scaffolding and re-clamped here, never stored with it.
 * @returns {{ segments: {prompt:string, duration:number, speaker:string|null}[], totalDuration:number }}
 */
export function buildKlingStoryboard(job, spec, opts = {}) {
  const settings = klingSettingsFor(spec);
  return applyOverride(composeKlingStoryboard(job, spec, settings, opts), opts.override ?? null, settings);
}

/** Effective per-spec Kling settings (model/resolution/aspect/audio), spec values over config defaults. */
export function klingConfigFor(spec) {
  const s = klingSettingsFor(spec);
  return {
    model: s.model,
    resolution: s.resolution,
    aspectRatio: s.aspectRatio,
    generateAudio: s.generateAudio,
  };
}

export default { buildKlingStoryboard, klingConfigFor };
