// Shared Kling 3.0 Omni storyboard/config helpers used by the fal renderer (fal-kling.js). ONE Omni
// generation renders a SEQUENCE of storyboard segments with the cast/style pinned by reference images
// (the "Elements" feature), so identity holds across the cut without re-composing each shot. Model
// hard caps: ≤6 segments / ≤15s total / ≤512 chars per segment / ≤7 reference images. A longer video
// is split into multiple jobs (spec.kling.jobs[]); the job clips are stitched afterwards.
import config from '../../config.js';
import { sanitizeSpeech } from './util.js';

// Shared framing vocabulary — also used by the Seedance prompt builder (seedance.js) so both
// backends describe shots the same way.
export const SHOT_SIZE_WORDS = {
  extreme_close_up: 'Extreme close-up', close_up: 'Close-up', medium_close_up: 'Medium close-up',
  medium: 'Medium shot', medium_wide: 'Medium-wide shot', wide: 'Wide shot', extreme_wide: 'Extreme wide shot',
};

// Capitalize a speaker id for the spoken-line clause (e.g. a future line.speaker); default neutral.
export const speakerName = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'The character');

/** Effective Kling native-audio flag: spec.kling.generate_audio wins, else the config default. */
const klingAudioOn = (spec) => (spec?.kling?.generate_audio !== undefined ? !!spec.kling.generate_audio : config.kling.nativeAudio);

/**
 * The spoken line for a shot: matched by `shot_id` (preferred), else an `at_s`-only line whose
 * timestamp falls inside this shot's [start,end) window (cumulative shot durations). Shared by both
 * renderers so `at_s` lines are VOICED, not silently dropped (a speaking character with no words →
 * the model invents garbled pseudo-speech to match the visible mouthing). Returns the line or null.
 */
export function lineForShot(spec, shotId) {
  const lines = (spec?.audio?.voice?.lines ?? []).filter((l) => (l?.text ?? '').trim());
  const direct = lines.find((l) => l?.shot_id === shotId);
  if (direct) return direct;
  const atLines = lines.filter((l) => l?.shot_id == null && typeof l?.at_s === 'number');
  if (!atLines.length) return null;
  let start = 0;
  for (const s of spec?.shots ?? []) {
    const dur = Math.max(1, Math.round(Number(s?.kling?.duration) || Number(s?.duration_s) || config.kling.defaultShotSeconds));
    const end = start + dur;
    if (s.shot_id === shotId) return atLines.find((l) => l.at_s >= start && l.at_s < end) ?? null;
    start = end;
  }
  return null;
}

/**
 * Compose one job's storyboard from its shots' `kling` blocks. Each shot → one segment string
 * (framing + scene/action + the spoken line + camera; identity comes from the reference images, never
 * appearance prose), hard-trimmed to ≤config.kling.segmentMaxBytes UTF-8 BYTES (fal rejects 512 —
 * its documented cap is exclusive; 500 keeps margin). Asserts segment count and total duration caps.
 *
 * The scripted line for a shot (spec.audio.voice.lines[] matched by shot_id) is folded INTO the segment
 * prompt so Kling lip-syncs + VOICES the exact words (with generate_audio on but no words in the prompt,
 * Kling invents garbled pseudo-speech to match the visible mouthing). On fal, the speaker's minted voice_id voices it.
 *
 * `opts` adapts the prompt for the fal transport:
 *   - lowercaseSpeech: lowercase the quoted English line (a real Kling input rule on fal/V3).
 *   - leadRef: a string (e.g. `@Element1`) prepended to every segment so the character's LOOK is
 *     referenced in each shot (fal references elements in the prompt as @Element1, @Element2, …).
 *   - voiceTokenFor(speaker): returns the `@ElementN` of the speaking character; used as the spoken
 *     line's subject so that element's BOUND voice_id is what speaks (fal binds voice per element).
 * Each returned segment also carries its `speaker` (or null) so the renderer can map speakers→elements.
 * @returns {{ segments: {prompt:string, duration:number, speaker:string|null}[], totalDuration:number }}
 */
const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');

/** Trim to a UTF-8 byte budget without ever splitting a code point. */
function trimToBytes(s, maxBytes) {
  if (utf8Bytes(s) <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

export function buildKlingStoryboard(job, spec, opts = {}) {
  const { lowercaseSpeech = false, voiceTokenFor = null, leadRef = null } = opts;
  const byId = Object.fromEntries(spec.shots.map((s) => [s.shot_id, s]));
  const audioOn = klingAudioOn(spec);
  const segments = job.shots.map((id) => {
    const shot = byId[id];
    if (!shot) throw new Error(`kling job ${job.job_id}: shot "${id}" not found in spec.shots`);
    const k = shot.kling;
    if (!k || !k.content_prompt) throw new Error(`kling job ${job.job_id}: shot ${id} is missing kling.content_prompt`);
    const size = SHOT_SIZE_WORDS[k.shot_size] ?? k.shot_size ?? '';
    const lead = [size, (k.perspective ?? '').trim()].filter(Boolean).join(', ');
    const cam = (k.camera_move ?? '').trim();
    const head = lead ? `${lead}. ` : '';
    const hit = audioOn ? lineForShot(spec, id) : null;
    const speakerTok = hit && voiceTokenFor ? voiceTokenFor(hit.speaker) || '' : '';
    const who = speakerTok || (hit?.speaker ? speakerName(hit.speaker) : 'The character');
    const clean = hit ? sanitizeSpeech(hit.text) : '';                     // typographic punctuation / emoji / embedded quotes → speakable ASCII
    const lineText = lowercaseSpeech ? clean.toLowerCase() : clean;
    // Dialogue → the scripted line; audio-on but no line → an explicit no-speech directive (keeps SFX/
    // ambience, stops the model inventing garbled pseudo-speech to match visible mouthing); audio off → nothing.
    const say = hit ? ` ${who} says: "${lineText}"` : (audioOn ? ' No dialogue in this shot; ambient sound and SFX only.' : '');
    const leadPrefix = leadRef ? `${leadRef} ` : '';
    const tail = cam ? ` Camera: ${cam}.` : '';
    let body = k.content_prompt.trim();
    // fal enforces the 512 cap in UTF-8 BYTES, not JS characters. The SPOKEN clause is protected:
    // reserve its full length (+ lead/framing/camera) and trim only the SCENE body to fit — the words
    // are never cut here (the old blanket end-trim lopped the dialogue off the end → mid-word gibberish).
    const cap = config.kling.segmentMaxBytes;
    const budget = cap - utf8Bytes(leadPrefix) - utf8Bytes(head) - utf8Bytes(say) - utf8Bytes(tail);
    if (utf8Bytes(body) > budget) body = budget > 3 ? trimToBytes(body, budget - 3).trimEnd() + '...' : '';
    let prompt = leadPrefix + head + body + say + tail;
    if (utf8Bytes(prompt) > cap) {
      // Words + lead/framing alone exceed the cap (a very long line — QC's length guard should stop
      // this upstream). Drop scene framing/camera to keep the words; only if the words ALONE are still
      // over cap, clip the quoted text at a byte boundary and RE-CLOSE the quote — never leave it
      // truncated mid-word without its closing quote.
      prompt = (leadPrefix + say).trimEnd();
      if (utf8Bytes(prompt) > cap && hit) {
        const overhead = utf8Bytes(`${leadPrefix}${who} says: ""`);
        prompt = `${leadPrefix}${who} says: "${trimToBytes(lineText, Math.max(0, cap - overhead)).trimEnd()}"`;
      }
    }
    const duration = Math.max(1, Math.round(Number(k.duration) || Number(shot.duration_s) || config.kling.defaultShotSeconds));
    return { prompt, duration, speaker: hit?.speaker ?? null };
  });
  const totalDuration = segments.reduce((a, s) => a + s.duration, 0);
  if (segments.length > config.kling.maxStoryboards)
    throw new Error(`kling job ${job.job_id}: ${segments.length} segments exceeds the ${config.kling.maxStoryboards}-storyboard cap`);
  if (totalDuration > config.kling.maxJobSeconds)
    throw new Error(`kling job ${job.job_id}: total ${totalDuration}s exceeds the ${config.kling.maxJobSeconds}s/job cap`);
  return { segments, totalDuration };
}

/** Effective per-spec Kling settings (model/resolution/aspect/audio), spec values over config defaults. */
export function klingConfigFor(spec) {
  const k = spec.kling ?? {};
  return {
    model: k.model_name || config.kling.model,
    resolution: k.resolution || config.kling.resolution,
    aspectRatio: k.aspect_ratio || config.kling.aspectRatio,
    generateAudio: k.generate_audio !== undefined ? !!k.generate_audio : config.kling.nativeAudio,
  };
}

export default { buildKlingStoryboard, klingConfigFor };
