// Seedance 2.0 prompt/config helpers used by the fal renderer (fal-seedance.js). ONE Seedance
// generation renders a whole job from ONE rich multi-shot prompt: identity is pinned by flat
// reference images (@Image1..@ImageN), dialogue lip-syncs to voice clips (@Audio1..@AudioN), and the
// opening frame can be pinned by naming a ref image as the literal first frame (Seedance has no
// start_image_url — the pin is a documented prompt convention). Model hard caps: 4–15s per
// generation / ≤9 image refs / ≤3 audio refs (combined ≤15s) / NO seed / NO negative_prompt (both
// HTTP 422 — variation ships as an "Alternate take N" prompt directive, guards as prompt clauses).
//
// Unlike Kling (per-shot storyboard segments hard-capped at 512 chars each, so scene prose gets
// starved), nothing is truncated per shot here — only the WHOLE assembled prompt is byte-clamped,
// and the front matter (style, identity, guards, first-frame pin, lip-sync notes, opening hook)
// sits ahead of the shot bodies so it survives the clamp.
//
// buildSeedanceJobPrompt is PURE (no I/O, no network) → fully unit-tested
// (test/unit/seedance-prompt.test.js). Framing vocabulary is shared with kling.js so both backends
// describe shots the same way.
import config from '../../config.js';
import { SHOT_SIZE_WORDS, speakerName, lineForShot } from './kling.js';
import { slug, sanitizeSpeech } from './util.js';

// 2-second hook rule (parity with the storyboard skill): the spec's opening hook shot must show the
// payoff immediately, so its block leads with this directive.
export const HOOK_PREFIX = 'Open on the payoff; the key subject and action are fully visible and legible from the first frame.';

// assembly.transitions[].type → the connector word between two shots (optional, hand-authored specs).
export const TRANSITION_WORDS = { hard_cut: 'Cut to:', match_cut: 'Match cut to:', whip: 'Whip pan to:', crossfade: 'Crossfade to:', none: 'Then:' };

// Strict default; a spec that NEEDS diegetic text overrides it via config.seedance.textRule.
const DEFAULT_TEXT_RULE = 'No on-screen text, letters, captions, or signs anywhere in frame.';

// Seedance 2.0 text-to-video prompt guidance lives in its own config-free module (see the note there);
// re-exported here so existing importers (engine.js) keep a single, stable path.
export { SEEDANCE_TTV_GUIDANCE } from './seedance-guidance.js';

/** Clamp to ≤ maxBytes UTF-8 bytes (reserving room for the ellipsis) without splitting a multibyte char. */
export function clampBytes(s, maxBytes) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const ELL = '…';
  let end = Math.max(0, maxBytes - Buffer.byteLength(ELL, 'utf8')); // leave room so the result never exceeds maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off a UTF-8 continuation byte
  return `${buf.slice(0, end).toString('utf8').trimEnd()}${ELL}`;
}

/** Effective Seedance native-audio flag: spec.kling.generate_audio wins, else the Seedance default. */
const seedanceAudioOn = (spec) => (spec?.kling?.generate_audio !== undefined ? !!spec.kling.generate_audio : config.seedance.generateAudio);

/** One shot → one labelled block: framing/perspective. scene. Camera: move. Speaker says "line" (tone). */
function shotBlock(shot, spec, { audioOn, isFirstInJob }) {
  const k = shot.kling;
  const size = SHOT_SIZE_WORDS[k.shot_size] ?? k.shot_size ?? '';
  const lead = [size, String(k.perspective ?? '').trim()].filter(Boolean).join(', ');
  const head = lead ? `${lead}. ` : '';
  const body = String(k.content_prompt ?? '').trim();
  const cam = String(k.camera_move ?? '').trim();
  const cameraClause = cam ? ` Camera: ${cam}.` : '';
  const hit = audioOn ? lineForShot(spec, shot.shot_id) : null;
  const tone = String(hit?.tone ?? '').trim();
  const dialogueClause = hit ? ` ${speakerName(hit.speaker)} says: "${sanitizeSpeech(hit.text)}"${tone ? ` (tone: ${tone})` : ''}.` : '';
  // Hook rule: ONLY the episode's opening shot, when authored as the hook, opens on the payoff.
  const isHook = isFirstInJob && spec.shots?.[0]?.shot_id === shot.shot_id && shot.beat === 'hook';
  return `${isHook ? `${HOOK_PREFIX} ` : ''}${head}${body}${cameraClause}${dialogueClause}`.trim();
}

/** The identity front-matter clause from the renderer's @Image ref groups. */
function identityClause(refGroups) {
  const gs = (refGroups ?? []).filter((g) => g?.refs?.length);
  if (!gs.length) return '';
  if (gs.length === 1) {
    const name = speakerName(gs[0].name);
    const angles = gs[0].refs.length > 1 ? ' (multiple reference angles)' : '';
    return `All shots feature the SAME character — ${name}, given as ${gs[0].refs.join('/')}${angles}; keep ${name} exactly on-model and identical across every shot.`;
  }
  const list = gs.map((g) => `${speakerName(g.name)} = ${g.refs.join('/')}`).join('; ');
  return `Recurring characters: ${list}. Keep each exactly on-model and identical across every shot.`;
}

/**
 * Compose ONE job's Seedance prompt from its shots' `kling` blocks + the spec's voice lines.
 * @param {object} job   spec.kling.jobs[i]
 * @param {object} spec  the full Production Spec
 * @param {{
 *   refGroups?: {name:string, refs:string[]}[],   // character → its @ImageN labels, prompt order (from the renderer)
 *   audioRefFor?: (speaker:string) => string|null,// speaker → its @AudioN label (uploaded voice ref), or null
 *   startFrameRef?: string|null,                  // the seam/authored first frame's @ImageN → prompt-pins the opening frame
 *   style?: string,                               // global style directive (config.seedance.style)
 *   avoidClause?: string,                         // appearance guard (Seedance has NO negative_prompt)
 *   textClause?: string,                          // replaces the strict no-on-screen-text default
 *   feedback?: string,                            // free-form director note (regen feedback)
 *   nonce?: number,                               // >0 → "Alternate take N" variation directive (Seedance accepts no seed)
 *   maxBytes?: number,                            // whole-prompt byte budget (config.seedance.promptMaxBytes)
 * }} opts
 * @returns {{ prompt:string, shotPrompts:string[], totalDuration:number, speakers:string[] }}
 */
export function buildSeedanceJobPrompt(job, spec, opts = {}) {
  const { refGroups = [], audioRefFor = null, startFrameRef = null, feedback = '', nonce = 0 } = opts;
  const byId = Object.fromEntries((spec.shots ?? []).map((s) => [s.shot_id, s]));
  const audioOn = seedanceAudioOn(spec);
  const shots = job.shots.map((id) => {
    const shot = byId[id];
    if (!shot) throw new Error(`seedance job ${job.job_id}: shot "${id}" not found in spec.shots`);
    if (!shot.kling?.content_prompt) throw new Error(`seedance job ${job.job_id}: shot ${id} is missing kling.content_prompt`);
    return shot;
  });

  // Per-shot blocks, joined by transition-aware connectors (nothing truncated per shot).
  const blocks = shots.map((shot, i) => shotBlock(shot, spec, { audioOn, isFirstInJob: i === 0 }));
  const trans = Object.fromEntries((spec?.assembly?.transitions ?? []).map((t) => [t.after_shot, t.type]));
  const joined = blocks.map((b, i) => {
    if (i === 0) return b;
    const word = TRANSITION_WORDS[trans[shots[i - 1].shot_id]] ?? 'Cut to:';
    return `\n${word} ${b}`;
  }).join('');

  // Distinct speakers among this job's (audio-gated) voice lines — deduped by slug (matching the
  // renderer's audio-ref map), first-seen order and casing.
  const bySlug = new Map();
  if (audioOn) {
    for (const l of spec.audio?.voice?.lines ?? []) {
      if (!job.shots.includes(l?.shot_id) || !(l?.text ?? '').trim() || !l?.speaker) continue;
      if (!bySlug.has(slug(l.speaker))) bySlug.set(slug(l.speaker), l.speaker);
    }
  }
  const speakers = [...bySlug.values()];

  // Front matter (ahead of the shot bodies, so it survives the byte clamp).
  const style = String(opts.style ?? '').trim();
  const identity = identityClause(refGroups);
  const avoid = String(opts.avoidClause ?? '').trim();
  const textRule = String(opts.textClause ?? '').trim() || DEFAULT_TEXT_RULE;
  // Speak ONLY scripted words; otherwise stay wordless (keeps SFX/ambience, stops invented
  // pseudo-speech on a shot whose visuals show a character but for which no line was written).
  const speakRule = audioOn ? 'Speech rule: characters speak ONLY the exact words in a shot\'s says: "…" line; in shots without one they do not speak — generate ambient sound and SFX only, never invented or mumbled dialogue.' : '';
  const note = String(feedback ?? '').trim();
  const n = Number(nonce) || 0;
  const lipSync = speakers.map((sp) => {
    const ref = audioRefFor?.(sp);
    if (!ref) return '';
    const name = speakerName(sp);
    // Voice-IDENTITY framing (not "reproduce the clip"): the clip is only the SOUND of the character's
    // voice; the WORDS come from each shot's `says: "…"` line. The old "lip-sync mouth to it" phrasing
    // made the model reproduce the reference clip's words → gibberish.
    return ` ${ref} is the sound of ${name}'s voice — a voice reference only; do NOT speak the words contained in that clip. ${name} speaks ONLY the "…" lines written in the shots below, in that voice.`;
  }).join('');
  const front = [
    style,
    identity,
    avoid,
    textRule,
    speakRule,
    note ? `Director note: ${note}` : '',
    n > 0 ? `Alternate take ${n}: vary the staging, camera framing, and timing from the previous take while keeping the same story, characters, and shots.` : '',
    startFrameRef ? `Use ${startFrameRef} as the literal first frame of this clip and continue its motion seamlessly forward.` : '',
  ].filter(Boolean).join(' ') + lipSync;

  const maxBytes = Number(opts.maxBytes) || config.seedance.promptMaxBytes;
  const prompt = clampBytes(`${front}\n\n${joined}`, maxBytes);
  // Same duration derivation as buildKlingStoryboard, so both backends agree with the job planner.
  const totalDuration = shots.reduce((a, s) => a + Math.max(1, Math.round(Number(s.kling?.duration) || Number(s.duration_s) || config.kling.defaultShotSeconds)), 0);
  return { prompt, shotPrompts: blocks, totalDuration, speakers };
}

/** Effective per-spec Seedance settings (resolution/aspect/audio), spec values over config defaults. */
export function seedanceConfigFor(spec) {
  const k = spec?.kling ?? {};
  return {
    // NOT k.resolution: the kling block is written by the agents from KLING defaults (its enum
    // can't even express 480p) — letting it override would silently render/bill Seedance at the
    // Kling resolution. An explicit spec.seedance.resolution pin wins; else the user's setting.
    resolution: spec?.seedance?.resolution || config.seedance.resolution,
    aspectRatio: k.aspect_ratio || config.kling.aspectRatio,
    generateAudio: seedanceAudioOn(spec),
  };
}

export default { buildSeedanceJobPrompt, seedanceConfigFor, clampBytes, HOOK_PREFIX, TRANSITION_WORDS };
