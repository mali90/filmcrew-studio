// Persistent character-voice registry — the audio analog of the Elements image inventory. Maps a
// character name → its persistent fal Kling voice_id (minted once by `mint-voice`, replayed forever
// for identical timbre). Stored at <config.voices.dir>/voices.json so it survives between runs and
// is shared by the engine (speaker awareness) and the fal renderer (speaker → voice_id resolution).
import fs from 'node:fs';
import path from 'node:path';
import config, { resolvePath } from '../../config.js';
import { slug } from './util.js';

export const VOICES_FILE = path.join(resolvePath(config.voices.dir), 'voices.json');

/** The raw registry object ({ "<character>": { voice_id, ref_clip, minted_at } }), or {} if absent. */
export function loadVoices() {
  try {
    return JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const CLIP_EXT = /\.(mp3|wav|mp4|mov)$/i;
const titleFromSlug = (s) => s.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Synthetic STAGED entries for bundled voice clips on disk (voices/<slug>.<ext>) that have no registry
 *  entry yet — the shipped sample cast (e.g. Wren). Lets a fresh clone recognize a shipped voice without
 *  an account-specific voices.json (git-ignored, since it holds minted voice_ids). */
function sampleClipEntries() {
  const dir = resolvePath(config.voices.dir);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => CLIP_EXT.test(f)); } catch { return {}; }
  return Object.fromEntries(files.map((f) => {
    const key = slug(f.replace(CLIP_EXT, ''));
    return [key, { name: titleFromSlug(key), voice_id: null, ref_clip: path.join(config.voices.dir, f), minted_at: null, staged: true }];
  }));
}

/** The registry augmented with staged entries for any bundled clip that isn't registered yet. Real
 *  registry entries (including minted voice_ids) always win over the shipped-clip fallback. */
export function loadVoicesWithClips() {
  return { ...sampleClipEntries(), ...loadVoices() };
}

/** The registry entry for a speaker name (any case) — or a staged entry for a bundled clip on disk — or
 *  null if unregistered and no clip ships. */
export function getVoiceEntry(name) {
  if (!name) return null;
  const map = loadVoicesWithClips();
  return map[name] ?? map[slug(name)] ?? Object.entries(map).find(([k]) => slug(k) === slug(name))?.[1] ?? null;
}

/** Resolve a speaker name (any case) to its persistent voice_id, or null if unregistered. */
export function getVoiceId(name) {
  return getVoiceEntry(name)?.voice_id ?? null;
}

/**
 * Absolute path of the character's mint-time reference clip, IF it still exists on disk. Seedance
 * lip-syncs to the clip itself (@AudioN ref) — unlike Kling, which only needs the minted voice_id —
 * so legacy entries without a clip (or with a deleted one) return null and the Seedance renderer
 * falls back to native audio.
 */
export function getVoiceRefClip(name) {
  const clip = getVoiceEntry(name)?.ref_clip;
  if (!clip) return null;
  const abs = resolvePath(clip);
  return fs.existsSync(abs) ? abs : null;
}

/** Register/replace a character's voice_id. Keyed by slug(name) for stable matching; keeps the label. */
export function setVoice(name, voiceId, refClip, mintedAt) {
  const map = loadVoices();
  map[slug(name)] = { name, voice_id: voiceId, ref_clip: refClip ?? null, minted_at: mintedAt ?? null };
  fs.mkdirSync(path.dirname(VOICES_FILE), { recursive: true });
  fs.writeFileSync(VOICES_FILE, JSON.stringify(map, null, 2) + '\n');
  return voiceId;
}

/** A human-readable listing of registered (and bundled/staged) voices for an agent prompt. */
export function voicesInventoryText(map = loadVoicesWithClips()) {
  const names = Object.values(map).map((v) => v?.name).filter(Boolean);
  if (!names.length) return '(no character voices registered — run `npm run mint-voice -- <name> <clip>` to add one)';
  return names.map((n) => `  - ${n}`).join('\n');
}

export default { VOICES_FILE, loadVoices, loadVoicesWithClips, getVoiceEntry, getVoiceId, getVoiceRefClip, setVoice, voicesInventoryText };
