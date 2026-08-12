// How many @AudioN voice references a job's render will really spend — and the voices registry it
// is read off, shared by the two server surfaces that need the answer.
//
// fal's Seedance 2.5 budgets images + audio + video against ONE 50-reference cap, so a registered
// voice clip and a soft boundary pin compete for the same slot. Only the pin is sacrificial
// (SEAM_PRIORITY drops it; the renderer throws rather than ship a job over the cap), so a boundary
// calculation that ignores the voice demand promises continuity the render deterministically drops
// — a paid re-render that comes back as a scene cut. render-seedance.js has always subtracted it
// (planSeamRefs' `otherRefCount`); this is the same subtraction on the side that quotes the seam
// BEFORE the money moves: run-service's re-render reply, and — over the run payload, since the
// browser cannot read the voices dir — the dialog that starts it.
//
// Config-free like the rest of run-service's static graph: the voices dir is read as DATA and the
// knobs arrive through a `(KEY) => value` reader over the run's .env, never from config.js.
import fs from 'node:fs';
import path from 'node:path';
import { voiceRefDemand } from '../../../src/lib/seedance-args.js';

const CLIP_EXT = /\.(mp3|wav|mp4|mov)$/i;

/**
 * `(speaker) => clipPath|null`, mirroring src/lib/voices.js `getVoiceRefClip` (bundled clips on
 * disk, overridden by voices.json entries) without importing it — that module reads config.js.
 * Seedance cites a voiced character as `@AudioN` IN THE PROMPT and spends a reference slot on the
 * clip, so whether one exists changes both the prompt bytes and the seam budget; a caller that
 * guessed would be wrong exactly for the cast that has voices.
 * `slug` is injected: prompt-service reaches the host repo's copy through `root`, and this module
 * may not assume its own tree is the one the runs were planned against.
 */
export function voiceClipLookup(voicesDir, root, slug) {
  const dir = path.isAbsolute(voicesDir) ? voicesDir : path.resolve(root, voicesDir);
  const map = new Map();
  try {
    for (const f of fs.readdirSync(dir)) if (CLIP_EXT.test(f)) map.set(slug(f.replace(CLIP_EXT, '')), path.join(dir, f));
  } catch { /* no voices dir — nothing is voiced */ }
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(dir, 'voices.json'), 'utf8'));
    // A real registry entry always wins over the shipped-clip fallback — including one with no
    // ref_clip at all, which is how a minted-but-clipless voice falls back to native audio.
    for (const [key, v] of Object.entries(reg ?? {})) {
      const clip = v?.ref_clip;
      map.set(slug(key), clip ? (path.isAbsolute(clip) ? clip : path.resolve(root, clip)) : null);
    }
  } catch { /* no registry */ }
  return (name) => {
    const clip = map.get(slug(name ?? '')) ?? null;
    return clip && fs.existsSync(clip) ? clip : null;
  };
}

/**
 * The two voice knobs, mirrored from config.seedance for a server that may not import config.js.
 * The ONE mirror: prompt-service's promptDefaults reads them through here too, so the preview and
 * the seam budget can never disagree about whether a clip rides.
 * @param {(key:string)=>string} get  a reader over the run's environment (as data)
 */
export const voiceKnobs = (get) => ({
  audioOn: get('SEEDANCE_GENERATE_AUDIO') === '' ? true : /^(1|true|yes|on)$/i.test(get('SEEDANCE_GENERATE_AUDIO')),
  voiceMode: get('SEEDANCE_VOICE_MODE') || 'reference',
});

/**
 * Per job, how many references its voice clips spend out of the model's COMBINED budget — `null`
 * for a model that publishes per-kind caps instead, where a voice clip never takes an image slot
 * and there is nothing for the seam rule to subtract.
 *
 * The conditioning half of the ride gate is settled here rather than asked per job: the seam rule
 * only ever asks about a render that carries a cast reference or a boundary frame, which is what
 * makes it reference-to-video (the same call engine.js's roster budget makes).
 *
 * The voices dir and the .env are read HERE rather than by the caller so that a model with per-kind
 * caps costs nothing at all: this runs on every run-detail read, and most runs have no such budget.
 *
 * @param {object} spec  the render spec
 * @param {{caps?:object, speakersOf:(job:object)=>string[], voicesDir:string, root:string,
 *          slug:(s:string)=>string, get:(key:string)=>string}} p
 * @returns {Record<string, number>|null}
 */
export function voiceRefCountsFor(spec, { caps, speakersOf, voicesDir, root, slug, get }) {
  if (caps?.maxCombinedRefs == null) return null;
  const { audioOn, voiceMode } = voiceKnobs(get);
  const hasClip = voiceClipLookup(voicesDir, root, slug);
  const jobs = spec?.kling?.jobs ?? [];
  return Object.fromEntries(jobs.map((job) => [job?.job_id, voiceRefDemand({
    caps, speakers: speakersOf(job), hasClip, castRefCount: 1, audioOn, voiceMode,
  })]));
}

export default { voiceClipLookup, voiceKnobs, voiceRefCountsFor };
