// The prompt composers for both render backends, as PURE, CONFIG-FREE functions.
//
// This is the single source of the exact bytes that reach fal/Segmind. It used to live inside the
// two renderers (kling.js / seedance.js), which read `config` — and therefore dotenv — directly.
// Two callers now need the same bytes:
//
//   • the renderers, via the thin shims in kling.js/seedance.js (config values → `settings`);
//   • web/server's prompt preview/editor, whose STATIC import graph must stay config-free, so it
//     reads a run's .env as DATA and hands the values in.
//
// A preview that is not byte-identical to what is sent is a lie, so the composers take every knob
// as an argument and the parity is pinned over the whole golden matrix
// (test/unit/prompt-compose.test.js against test/fixtures/prompt-golden.json).
//
// Nothing here reads the environment, loads dotenv, or imports config.js — a spec asserts that
// transitively over every relative import below.
import { createHash } from 'node:crypto';
// The seam rule (how a boundary frame is applied on a backend, and which pins survive the reference
// budget) lives in its own module: this one imports node:crypto for the fingerprint below, which the
// browser bundle cannot take, and the re-render dialog must call the SAME rule the renderer calls.
// Re-exported here so every existing `from './prompt-compose.js'` import is unchanged.
import {
  SEAM_MODES, SEAM_PRIORITY, chooseSeamMode, seamPinSentence, planSeamRefs, appliedSeamModes, pinStrengths,
} from './seam-rule.js';
import { sanitizeSpeech, slug } from './text.js';

export {
  SEAM_MODES, SEAM_PRIORITY, chooseSeamMode, seamPinSentence, planSeamRefs, appliedSeamModes, pinStrengths,
};

// ── Shared vocabulary (both backends describe shots the same way) ───────────────────────────────

export const SHOT_SIZE_WORDS = {
  extreme_close_up: 'Extreme close-up', close_up: 'Close-up', medium_close_up: 'Medium close-up',
  medium: 'Medium shot', medium_wide: 'Medium-wide shot', wide: 'Wide shot', extreme_wide: 'Extreme wide shot',
};

// 2-second hook rule (parity with the storyboard skill): the spec's opening hook shot must show the
// payoff immediately, so its block leads with this directive.
export const HOOK_PREFIX = 'Open on the payoff; the key subject and action are fully visible and legible from the first frame.';

// assembly.transitions[].type → the connector word between two shots (optional, hand-authored specs).
export const TRANSITION_WORDS = { hard_cut: 'Cut to:', match_cut: 'Match cut to:', whip: 'Whip pan to:', crossfade: 'Crossfade to:', none: 'Then:' };

// Strict default; a spec that NEEDS diegetic text overrides it via the Seedance textRule setting.
export const DEFAULT_TEXT_RULE = 'No on-screen text, letters, captions, or signs anywhere in frame.';

// Last-resort shot length, used only when a caller omits `settings.defaultShotSeconds`. Every
// shipping caller passes one (config.kling.defaultShotSeconds); this keeps a missing setting from
// silently turning every shot into 1s rather than throwing somewhere far away.
export const DEFAULT_SHOT_SECONDS = 5;

// Same idea for the whole-prompt clamp: no documented model cap, and 5000 carries a rich 6-shot prompt.
export const DEFAULT_PROMPT_MAX_BYTES = 5000;

// Capitalize a speaker id for the spoken-line clause (e.g. a future line.speaker); default neutral.
export const speakerName = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'The character');

// ── Byte helpers (fal enforces its caps in UTF-8 BYTES, not JS characters) ──────────────────────

export const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');

/** Trim to a UTF-8 byte budget without ever splitting a code point. */
export function trimToBytes(s, maxBytes) {
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

/** Clamp to ≤ maxBytes UTF-8 bytes (reserving room for the ellipsis) without splitting a multibyte char. */
export function clampBytes(s, maxBytes) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const ELL = '…';
  let end = Math.max(0, maxBytes - Buffer.byteLength(ELL, 'utf8')); // leave room so the result never exceeds maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off a UTF-8 continuation byte
  return `${buf.slice(0, end).toString('utf8').trimEnd()}${ELL}`;
}

/** One shot's rendered length in seconds — the derivation BOTH backends and the job planner share. */
const shotSeconds = (shot, defaultShotSeconds) =>
  Math.max(1, Math.round(Number(shot?.kling?.duration) || Number(shot?.duration_s) || Number(defaultShotSeconds) || DEFAULT_SHOT_SECONDS));

/**
 * The spoken line for a shot: matched by `shot_id` (preferred), else an `at_s`-only line whose
 * timestamp falls inside this shot's [start,end) window (cumulative shot durations). Shared by both
 * renderers so `at_s` lines are VOICED, not silently dropped (a speaking character with no words →
 * the model invents garbled pseudo-speech to match the visible mouthing). Returns the line or null.
 * @param {number} [defaultShotSeconds]  fallback shot length for the cumulative window
 */
export function lineForShot(spec, shotId, defaultShotSeconds) {
  const lines = (spec?.audio?.voice?.lines ?? []).filter((l) => (l?.text ?? '').trim());
  const direct = lines.find((l) => l?.shot_id === shotId);
  if (direct) return direct;
  const atLines = lines.filter((l) => l?.shot_id == null && typeof l?.at_s === 'number');
  if (!atLines.length) return null;
  let start = 0;
  for (const s of spec?.shots ?? []) {
    const end = start + shotSeconds(s, defaultShotSeconds);
    if (s.shot_id === shotId) return atLines.find((l) => l.at_s >= start && l.at_s < end) ?? null;
    start = end;
  }
  return null;
}

// ── Kling: one storyboard segment per shot ──────────────────────────────────────────────────────

/**
 * Compose one job's storyboard from its shots' `kling` blocks. Each shot → one segment string
 * (framing + scene/action + the spoken line + camera; identity comes from the reference images, never
 * appearance prose), hard-trimmed to ≤settings.segmentMaxBytes UTF-8 BYTES (fal rejects 512 — its
 * documented cap is exclusive; 500 keeps margin). Asserts segment count and total duration caps.
 *
 * The scripted line for a shot (spec.audio.voice.lines[] matched by shot_id) is folded INTO the segment
 * prompt so Kling lip-syncs + VOICES the exact words (with generate_audio on but no words in the prompt,
 * Kling invents garbled pseudo-speech to match the visible mouthing). On fal, the speaker's minted voice_id voices it.
 *
 * @param {object} job   spec.kling.jobs[i]
 * @param {object} spec  the full Production Spec
 * @param {{audioOn:boolean, segmentMaxBytes:number, maxStoryboards:number, maxJobSeconds:number,
 *          defaultShotSeconds:number}} settings  from klingPromptSettings()
 * @param {{lowercaseSpeech?:boolean, leadRef?:string|null, voiceTokenFor?:((s:string)=>string)|null}} [opts]
 *   transport adaptations:
 *   - lowercaseSpeech: lowercase the quoted English line (a real Kling input rule on fal/V3).
 *   - leadRef: a string (e.g. `@Element1`) prepended to every segment so the character's LOOK is
 *     referenced in each shot (fal references elements in the prompt as @Element1, @Element2, …).
 *   - voiceTokenFor(speaker): returns the `@ElementN` of the speaking character; used as the spoken
 *     line's subject so that element's BOUND voice_id is what speaks (fal binds voice per element).
 * @returns {{ segments: {prompt:string, duration:number, speaker:string|null}[], totalDuration:number,
 *             parts:object[] }}
 *   Each segment also carries its `speaker` (or null) so the renderer can map speakers→elements.
 *   `parts` is the SYSTEM-owned scaffolding of each segment, in segment order — it is what
 *   `applyOverride` re-composes a user's own scene body inside (never serialized anywhere).
 */
export function composeKlingStoryboard(job, spec, settings, opts = {}) {
  // `opts` (lowercaseSpeech / leadRef / voiceTokenFor) is consumed by klingSegmentParts, below.
  const byId = Object.fromEntries(spec.shots.map((s) => [s.shot_id, s]));
  const cap = settings?.segmentMaxBytes;
  const parts = [];
  const segments = job.shots.map((id) => {
    const shot = byId[id];
    if (!shot) throw new Error(`kling job ${job.job_id}: shot "${id}" not found in spec.shots`);
    const k = shot.kling;
    if (!k || !k.content_prompt) throw new Error(`kling job ${job.job_id}: shot ${id} is missing kling.content_prompt`);
    const p = klingSegmentParts(shot, spec, settings, opts);
    parts.push(p);
    return { prompt: klingSegmentPrompt(p, k.content_prompt, cap), duration: shotSeconds(shot, settings?.defaultShotSeconds), speaker: p.hit?.speaker ?? null };
  });
  const totalDuration = segments.reduce((a, s) => a + s.duration, 0);
  if (segments.length > settings?.maxStoryboards)
    throw new Error(`kling job ${job.job_id}: ${segments.length} segments exceeds the ${settings?.maxStoryboards}-storyboard cap`);
  if (totalDuration > settings?.maxJobSeconds)
    throw new Error(`kling job ${job.job_id}: total ${totalDuration}s exceeds the ${settings?.maxJobSeconds}s/job cap`);
  return { segments, totalDuration, parts };
}

/** The bytes of one Kling segment left for the authored scene body: the cap minus the scaffolding. */
const klingBodyBudget = ({ leadPrefix, head, say, tail }, cap) =>
  cap - utf8Bytes(leadPrefix) - utf8Bytes(head) - utf8Bytes(say) - utf8Bytes(tail);

/**
 * One Kling segment: the system scaffolding wrapped around ONE scene body, clamped to the
 * per-segment byte cap. Shared by the plan path and `applyOverride`, so a hand-edited body is
 * wrapped by exactly the rules the agents' body is wrapped by — there is no second composer.
 *
 * `trim` is the ONE thing the two callers do not share: the agents' body is re-cut to fit (nobody
 * promised them otherwise), a user's is not — see applyOverride.
 */
function klingSegmentPrompt(parts, sceneBody, cap, { trim = true } = {}) {
  const { leadPrefix, head, say, tail, who, lineText, hit } = parts;
  let body = String(sceneBody ?? '').trim();
  // fal enforces the 512 cap in UTF-8 BYTES, not JS characters. The SPOKEN clause is protected:
  // reserve its full length (+ lead/framing/camera) and trim only the SCENE body to fit — the words
  // are never cut here (the old blanket end-trim lopped the dialogue off the end → mid-word gibberish).
  const budget = klingBodyBudget(parts, cap);
  if (trim && utf8Bytes(body) > budget) body = budget > 3 ? trimToBytes(body, budget - 3).trimEnd() + '...' : '';
  let prompt = leadPrefix + head + body + say + tail;
  if (trim && utf8Bytes(prompt) > cap) {
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
  return prompt;
}

/**
 * The fixed (SYSTEM-owned) pieces of one Kling segment: everything except the authored scene body.
 * Split out so the byte meter can price exactly what a user's edit cannot spend.
 */
function klingSegmentParts(shot, spec, settings, opts = {}) {
  const { lowercaseSpeech = false, voiceTokenFor = null, leadRef = null } = opts;
  const k = shot.kling;
  const audioOn = !!settings?.audioOn;
  const size = SHOT_SIZE_WORDS[k.shot_size] ?? k.shot_size ?? '';
  const lead = [size, (k.perspective ?? '').trim()].filter(Boolean).join(', ');
  const cam = (k.camera_move ?? '').trim();
  const head = lead ? `${lead}. ` : '';
  const hit = audioOn ? lineForShot(spec, shot.shot_id, settings?.defaultShotSeconds) : null;
  const speakerTok = hit && voiceTokenFor ? voiceTokenFor(hit.speaker) || '' : '';
  const who = speakerTok || (hit?.speaker ? speakerName(hit.speaker) : 'The character');
  const clean = hit ? sanitizeSpeech(hit.text) : '';                     // typographic punctuation / emoji / embedded quotes → speakable ASCII
  const lineText = lowercaseSpeech ? clean.toLowerCase() : clean;
  // Dialogue → the scripted line; audio-on but no line → an explicit no-speech directive (keeps SFX/
  // ambience, stops the model inventing garbled pseudo-speech to match visible mouthing); audio off → nothing.
  const say = hit ? ` ${who} says: "${lineText}"` : (audioOn ? ' No dialogue in this shot; ambient sound and SFX only.' : '');
  const leadPrefix = leadRef ? `${leadRef} ` : '';
  const tail = cam ? ` Camera: ${cam}.` : '';
  return { leadPrefix, head, say, tail, who, lineText, hit };
}

// ── Seedance: ONE rich multi-shot prompt per job ────────────────────────────────────────────────

/** One shot → one labelled block: framing/perspective. scene. Camera: move. Speaker says "line" (tone). */
export function shotBlock(shot, spec, { audioOn, isFirstInJob, defaultShotSeconds }) {
  const k = shot.kling;
  const size = SHOT_SIZE_WORDS[k.shot_size] ?? k.shot_size ?? '';
  const lead = [size, String(k.perspective ?? '').trim()].filter(Boolean).join(', ');
  const head = lead ? `${lead}. ` : '';
  const body = String(k.content_prompt ?? '').trim();
  const cam = String(k.camera_move ?? '').trim();
  const cameraClause = cam ? ` Camera: ${cam}.` : '';
  const hit = audioOn ? lineForShot(spec, shot.shot_id, defaultShotSeconds) : null;
  const tone = String(hit?.tone ?? '').trim();
  const dialogueClause = hit ? ` ${speakerName(hit.speaker)} says: "${sanitizeSpeech(hit.text)}"${tone ? ` (tone: ${tone})` : ''}.` : '';
  // Hook rule: ONLY the episode's opening shot, when authored as the hook, opens on the payoff.
  const isHook = isFirstInJob && spec.shots?.[0]?.shot_id === shot.shot_id && shot.beat === 'hook';
  return `${isHook ? `${HOOK_PREFIX} ` : ''}${head}${body}${cameraClause}${dialogueClause}`.trim();
}

/** The identity front-matter clause from the renderer's @Image ref groups. */
export function identityClause(refGroups) {
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

/** This job's shots, resolved and validated against the spec (the two errors both builders raise). */
function jobShots(job, spec, backend) {
  const byId = Object.fromEntries((spec.shots ?? []).map((s) => [s.shot_id, s]));
  return job.shots.map((id) => {
    const shot = byId[id];
    if (!shot) throw new Error(`${backend} job ${job.job_id}: shot "${id}" not found in spec.shots`);
    if (!shot.kling?.content_prompt) throw new Error(`${backend} job ${job.job_id}: shot ${id} is missing kling.content_prompt`);
    return shot;
  });
}

/** The distinct speakers among this job's (audio-gated) voice lines, deduped by slug, first-seen order. */
function jobSpeakers(job, spec, audioOn) {
  const bySlug = new Map();
  if (audioOn) {
    for (const l of spec.audio?.voice?.lines ?? []) {
      if (!job.shots.includes(l?.shot_id) || !(l?.text ?? '').trim() || !l?.speaker) continue;
      if (!bySlug.has(slug(l.speaker))) bySlug.set(slug(l.speaker), l.speaker);
    }
  }
  return [...bySlug.values()];
}

/**
 * The SYSTEM front matter for one Seedance job: style, identity, guards, take/note directives, the
 * first-frame pin and the per-speaker voice notes. It sits ahead of the shot bodies so it survives
 * the byte clamp — and it is exactly what a user's prompt edit may NOT spend (see pinBytesOf).
 */
function seedanceFrontMatter(job, spec, settings, opts = {}) {
  const { refGroups = [], audioRefFor = null, startFrameRef = null, endFrameRef = null, feedback = '', nonce = 0 } = opts;
  const audioOn = !!settings?.audioOn;
  const style = String(settings?.style ?? '').trim();
  const identity = identityClause(refGroups);
  const avoid = String(settings?.avoid ?? '').trim();
  const textRule = String(settings?.textRule ?? '').trim() || DEFAULT_TEXT_RULE;
  // Speak ONLY scripted words; otherwise stay wordless (keeps SFX/ambience, stops invented
  // pseudo-speech on a shot whose visuals show a character but for which no line was written).
  const speakRule = audioOn ? 'Speech rule: characters speak ONLY the exact words in a shot\'s says: "…" line; in shots without one they do not speak — generate ambient sound and SFX only, never invented or mumbled dialogue.' : '';
  const note = String(feedback ?? '').trim();
  const n = Number(nonce) || 0;
  const lipSync = jobSpeakers(job, spec, audioOn).map((sp) => {
    const ref = audioRefFor?.(sp);
    if (!ref) return '';
    const name = speakerName(sp);
    // Voice-IDENTITY framing (not "reproduce the clip"): the clip is only the SOUND of the character's
    // voice; the WORDS come from each shot's `says: "…"` line. The old "lip-sync mouth to it" phrasing
    // made the model reproduce the reference clip's words → gibberish.
    return ` ${ref} is the sound of ${name}'s voice — a voice reference only; do NOT speak the words contained in that clip. ${name} speaks ONLY the "…" lines written in the shots below, in that voice.`;
  }).join('');
  return [
    style,
    identity,
    avoid,
    textRule,
    speakRule,
    note ? `Director note: ${note}` : '',
    n > 0 ? `Alternate take ${n}: vary the staging, camera framing, and timing from the previous take while keeping the same story, characters, and shots.` : '',
    startFrameRef ? seamPinSentence(startFrameRef, 'in') : '',
    // The closing pin comes AFTER the opening one, always — planSeamRefs emits its sentences in the
    // same order, so a prompt built from either path reads identically.
    endFrameRef ? seamPinSentence(endFrameRef, 'out') : '',
  ].filter(Boolean).join(' ') + lipSync;
}

/**
 * Compose ONE job's Seedance prompt from its shots' `kling` blocks + the spec's voice lines.
 * @param {object} job   spec.kling.jobs[i]
 * @param {object} spec  the full Production Spec
 * @param {{audioOn:boolean, promptMaxBytes:number, defaultShotSeconds:number, style?:string,
 *          avoid?:string, textRule?:string}} settings  from seedancePromptSettings()
 * @param {{
 *   refGroups?: {name:string, refs:string[]}[],   // character → its @ImageN labels, prompt order (from the renderer)
 *   audioRefFor?: (speaker:string) => string|null,// speaker → its @AudioN label (uploaded voice ref), or null
 *   startFrameRef?: string|null,                  // the seam/authored first frame's @ImageN → prompt-pins the opening frame
 *   endFrameRef?: string|null,                    // the seam/authored last frame's @ImageN → prompt-pins the closing frame
 *   feedback?: string,                            // free-form director note (regen feedback)
 *   nonce?: number,                               // >0 → "Alternate take N" variation directive (Seedance accepts no seed)
 *   shotSyntax?: 'connectors'|'numbered',         // how the model wants shots joined (caps.shotSyntax; default 'connectors')
 * }} [opts]
 * @returns {{ prompt:string, shotPrompts:string[], totalDuration:number, speakers:string[], front:string }}
 *   `front` is the SYSTEM front matter alone — what `applyOverride` re-composes over a user's own
 *   words, and what `pinBytesOf` prices. It is never sent on its own and never serialized.
 */
export function composeSeedanceJobPrompt(job, spec, settings, opts = {}) {
  const shots = jobShots(job, spec, 'seedance');
  const audioOn = !!settings?.audioOn;
  const defaultShotSeconds = settings?.defaultShotSeconds;

  // Per-shot blocks, joined the way this MODEL writes a multi-shot prompt (nothing truncated per
  // shot). 'connectors' (Seedance 2.0) chains them with transition words; 'numbered' (Seedance 2.5
  // on every provider) numbers them and drops the connectors, which is that model's documented
  // syntax. `shotPrompts` below stays the RAW blocks either way — the joining is not part of a
  // shot's authored prose, and the sidecar/preview contract depends on that.
  const numbered = opts.shotSyntax === 'numbered';
  const blocks = shots.map((shot, i) => shotBlock(shot, spec, { audioOn, isFirstInJob: i === 0, defaultShotSeconds }));
  const trans = Object.fromEntries((spec?.assembly?.transitions ?? []).map((t) => [t.after_shot, t.type]));
  const joined = blocks.map((b, i) => {
    if (numbered) return `${i === 0 ? '' : '\n'}Shot ${i + 1}: ${b}`;
    if (i === 0) return b;
    const word = TRANSITION_WORDS[trans[shots[i - 1].shot_id]] ?? 'Cut to:';
    return `\n${word} ${b}`;
  }).join('');

  const front = seedanceFrontMatter(job, spec, settings, opts);
  const maxBytes = Number(settings?.promptMaxBytes) || DEFAULT_PROMPT_MAX_BYTES;
  const prompt = clampBytes(`${front}\n\n${joined}`, maxBytes);
  // Same duration derivation as composeKlingStoryboard, so both backends agree with the job planner.
  const totalDuration = shots.reduce((a, s) => a + shotSeconds(s, defaultShotSeconds), 0);
  return { prompt, shotPrompts: blocks, totalDuration, speakers: jobSpeakers(job, spec, audioOn), front };
}

// ── Prompt overrides: the user's own words, inside our contract ─────────────────────────────────

/**
 * Re-compose one job's prompt around a hand-edited body.
 *
 * The user owns the WORDS; the system owns the CONTRACT. So an override replaces only the shot
 * bodies — the front matter (style, identity clause, text/speech rules, director note, take
 * directive), the seam pins and the byte clamp are all re-composed on top, from this render's own
 * settings. That is why a stored override never contains a pin sentence: pins name `@Image3` labels
 * that only exist once THIS render has laid out its references, so storing one would freeze a
 * stale (or plain wrong) reference into every future take.
 *
 * Pure, and shape-preserving: hand it what a composer returned and it returns the same shape.
 *
 * THE ONE ASYMMETRY WITH THE PLAN PATH: the agents' own text is CLAMPED to the model's cap (see
 * composeSeedanceJobPrompt and klingSegmentPrompt's `trim`) — we wrote it, we may re-cut it. A
 * user's words are not. `savePromptOverride` could only budget the front matter of the render it
 * could see; a re-render adds "Alternate take N" and "Director note: …", and a revise pass can grow
 * the identity or lip-sync clauses, so words that fitted at save time need not fit at submit time.
 * Clamping them here would delete the tail of a PAID prompt where nobody could see it went, against
 * an editor that promises an edit is sent word for word. So the overrun is measured into
 * `overflowBytes` and `assertOverrideFits` refuses on the render path instead.
 *
 * @param {object} composed  a `composeKlingStoryboard` or `composeSeedanceJobPrompt` result
 * @param {{prompt?:string, segments?:string[]}|null} override  the sidecar entry for this job
 * @param {object} settings  the same settings the composer was given (byte budgets live here)
 * @returns {object} the composed result with the user's words in it, plus `overflowBytes` — how
 *   many bytes of them no longer fit (0 when they do). The input, untouched, when there is nothing
 *   to apply: an absent, empty or blank override changes nothing.
 */
export function applyOverride(composed, override, settings) {
  if (!composed || !override) return composed;
  const hasBody = typeof override.prompt === 'string' || Array.isArray(override.segments);
  if (!hasBody) return composed;

  // Kling: the budget is PER SEGMENT, so the edit is too — one body per shot, and a blank or
  // missing entry leaves that shot on the agents' text rather than sending an empty shot.
  if (Array.isArray(composed.segments)) {
    if (!Array.isArray(composed.parts)) return composed; // composed by an older caller — nothing to re-wrap
    const cap = Number(settings?.segmentMaxBytes);
    const bodies = Array.isArray(override.segments) ? override.segments : [override.prompt];
    let touched = false;
    let overflowBytes = 0;
    const segments = composed.segments.map((s, i) => {
      const body = bodies[i];
      if (typeof body !== 'string' || !body.trim()) return s;
      touched = true;
      overflowBytes += Math.max(0, utf8Bytes(body.trim()) - klingBodyBudget(composed.parts[i], cap));
      return { ...s, prompt: klingSegmentPrompt(composed.parts[i], body, cap, { trim: false }) };
    });
    return touched ? { ...composed, segments, promptSource: 'override', overflowBytes } : composed;
  }

  // Seedance: ONE document per job. `segments` is accepted (a per-shot editor may hand them over)
  // and joined plainly — the connector words belong to the agents' blocks, not to a user's prose.
  const body = (typeof override.prompt === 'string' ? override.prompt : override.segments.join('\n')).trim();
  if (!body) return composed;
  const maxBytes = Number(settings?.promptMaxBytes) || DEFAULT_PROMPT_MAX_BYTES;
  const prompt = `${composed.front}\n\n${body}`;
  return {
    ...composed,
    prompt,
    // `shotPrompts` is the record of the authored bodies that were SENT. With an override there is
    // one body (or the user's own per-shot split), and claiming the plan's blocks would be a lie.
    shotPrompts: Array.isArray(override.segments) ? override.segments.map((s) => String(s).trim()) : [body],
    promptSource: 'override',
    overflowBytes: Math.max(0, utf8Bytes(prompt) - maxBytes),
  };
}

/**
 * Refuse a saved prompt edit this render can no longer fit — the enforcement half of the
 * measurement above, and the reason `applyOverride` may leave an over-cap prompt in its result.
 *
 * Called by the render-facing shims (kling.js / seedance.js), which is where the money is: the
 * preview keeps composing so the editor stays usable and its byte meter can SHOW the overrun, and
 * nothing reaches a provider without passing through here first. Worded like the editor's own
 * over-budget 400, because it is the same promise being kept a second time.
 *
 * @param {object} built  an `applyOverride` result
 * @param {string} jobId  the job whose edit this is — the fix is per job, so the message names it
 * @returns {object} `built`, so a shim can `return assertOverrideFits(…)`
 */
export function assertOverrideFits(built, jobId) {
  const over = Number(built?.overflowBytes) || 0;
  if (over <= 0) return built;
  throw new Error(
    `job ${jobId}: the saved prompt edit no longer fits — it is ${over} byte(s) over the room this render leaves for your words. `
    + 'Something the SYSTEM owns has grown since it was saved: a re-render adds an "Alternate take"/"Director note" line the editor could not budget for, '
    + 'and a revise can lengthen the identity or voice clauses. Nothing was sent — shorten the edit in the prompt editor, or discard it. '
    + 'Trimming it here would drop the end of words you are paying to send, without showing you what went.',
  );
}

// ── The byte meter's denominator ────────────────────────────────────────────────────────────────

/**
 * How many bytes of a job's prompt budget the SYSTEM already owns — front matter, identity clause,
 * guards and frame pins — and which a user's prompt edit therefore cannot spend. The editor draws
 * its meter against `maxBytes − pinBytes`, so this must be measured from the same composer that
 * builds the real prompt (a hand-counted estimate would drift the first time a clause changes).
 *
 * @param {'kling'|'seedance'} backend
 * @returns {number|number[]} Seedance: ONE number (the prompt is one document). Kling: one number
 *   per segment — its budget is per shot (500 B each), so the editor draws one meter per shot.
 */
export function pinBytesOf(backend, job, spec, settings, opts = {}) {
  if (backend === 'kling') {
    const byId = Object.fromEntries((spec.shots ?? []).map((s) => [s.shot_id, s]));
    return job.shots.map((id) => {
      const shot = byId[id];
      if (!shot?.kling) throw new Error(`kling job ${job.job_id}: shot "${id}" not found in spec.shots`);
      const { leadPrefix, head, say, tail } = klingSegmentParts(shot, spec, settings, opts);
      return utf8Bytes(leadPrefix) + utf8Bytes(head) + utf8Bytes(say) + utf8Bytes(tail);
    });
  }
  // Seedance: the front matter plus the blank line that separates it from the shot bodies.
  return utf8Bytes(seedanceFrontMatter(job, spec, settings, opts)) + utf8Bytes('\n\n');
}

// ── The staleness oracle behind the "this prompt was edited before X changed" banner ────────────

/**
 * A stable hash of exactly the AUTHORED inputs one job's prompt is composed from — its shots, its
 * dialogue, its transitions and its cast. A saved prompt override records the fingerprint it was
 * written against; when a revise pass moves any of these, the UI marks the override stale. Cosmetic
 * churn (title, logline, QC report) must NOT: those never reach the prompt, and staling an edit for
 * them would train users to ignore the banner.
 * @param {object} spec
 * @param {string} jobId
 * @returns {string} a short hex digest
 */
export function promptFingerprint(spec, jobId) {
  const job = (spec?.kling?.jobs ?? []).find((j) => j?.job_id === jobId);
  const ids = job?.shots ?? [];
  const byId = new Map((spec?.shots ?? []).map((s) => [s.shot_id, s]));
  const shots = ids.map((id) => {
    const s = byId.get(id) ?? {};
    const k = s.kling ?? {};
    return [id, s.beat ?? null, s.duration_s ?? null, k.duration ?? null,
      k.content_prompt ?? null, k.shot_size ?? null, k.perspective ?? null, k.camera_move ?? null];
  });
  // Lines addressed to this job's shots, plus every at_s-only line (any of them can fall into one of
  // this job's windows once a duration moves — see lineForShot).
  const lines = (spec?.audio?.voice?.lines ?? [])
    .filter((l) => ids.includes(l?.shot_id) || (l?.shot_id == null && typeof l?.at_s === 'number'))
    .map((l) => [l.shot_id ?? null, l.at_s ?? null, l.speaker ?? null, l.tone ?? null, l.text ?? null]);
  const transitions = (spec?.assembly?.transitions ?? [])
    .filter((t) => ids.includes(t?.after_shot))
    .map((t) => [t.after_shot, t.type ?? null]);
  // The job's CAST, resolved the way characterGroups resolves it — an absent/empty `job.elements`
  // inherits the WHOLE roster, so a Casting revise moves this job's prompt without touching a shot.
  // The groups it builds are what the Seedance identity clause names and what Kling's `@ElementN`
  // speaker tokens count from, so a re-cast roster changes the composed prompt with the shots
  // untouched, and an override written before it is genuinely stale. Only the fields that reach the
  // TEXT are hashed: swapping an element's image file changes which picture is uploaded, not a byte
  // of the prompt, and staling an edit for that would train users to ignore the banner.
  const roster = spec?.kling?.elements ?? [];
  const cast = (job?.elements?.length ? job.elements : roster.map((e) => e?.id))
    .map((id) => [id ?? null, roster.find((e) => e?.id === id)?.character ?? null]);
  const payload = JSON.stringify({ jobId, shots, lines, transitions, cast, audio: spec?.kling?.generate_audio ?? null });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

export default {
  composeKlingStoryboard,
  composeSeedanceJobPrompt,
  applyOverride,
  assertOverrideFits,
  chooseSeamMode,
  planSeamRefs,
  seamPinSentence,
  appliedSeamModes,
  pinStrengths,
  SEAM_MODES,
  SEAM_PRIORITY,
  pinBytesOf,
  promptFingerprint,
  clampBytes,
  trimToBytes,
  utf8Bytes,
  lineForShot,
  speakerName,
  identityClause,
  shotBlock,
  SHOT_SIZE_WORDS,
  HOOK_PREFIX,
  TRANSITION_WORDS,
  DEFAULT_TEXT_RULE,
};
