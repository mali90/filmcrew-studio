#!/usr/bin/env node
// Mint a persistent fal Kling voice_id from a clean reference clip and save it to the voices
// registry. Run ONCE per character; the saved id is then replayed on every fal render for identical
// timbre (the audio analog of an @Element reference image).
//
//   npm run mint-voice -- <character> <clip.wav>
//   node src/cli/mint-voice.js host path/to/host_reference.wav
//
// Clip: 5–30s, single speaker, clean (no music/SFX), .mp3/.wav/.mp4/.mov. Costs ≈ $0.007.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, resolvePath } from '../../config.js';
import log from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { mintVoice } from '../lib/fal.js';
import { setVoice, VOICES_FILE } from '../lib/voices.js';
import { slug } from '../lib/util.js';

const args = parseArgs();

async function main() {
  const name = args._[0];
  const clip = args._[1];
  if (!name || !clip) throw new Error('Usage: npm run mint-voice -- <character> <path-to-clip>  (clip: 5–30s, single speaker, clean)');

  const clipPath = resolvePath(clip);
  log.step(`Minting voice for "${name}" from ${path.relative(process.cwd(), clipPath)} …`);
  const voiceId = await mintVoice(clipPath);
  const mintedAt = new Date().toISOString();
  // Keep the clip itself next to the registry: Kling only needs the minted voice_id, but Seedance
  // lip-syncs to the CLIP (@Audio1 ref) at render time, so it must survive wherever the original
  // came from. Falls back to the original path if the copy fails.
  let refClip = clip;
  try {
    fs.mkdirSync(path.dirname(VOICES_FILE), { recursive: true }); // setVoice creates it later — the copy runs first
    const kept = path.join(path.dirname(VOICES_FILE), `${slug(name)}${path.extname(clipPath).toLowerCase()}`);
    if (path.resolve(kept) !== path.resolve(clipPath)) fs.copyFileSync(clipPath, kept);
    refClip = path.relative(ROOT, kept);
  } catch (e) {
    log.warn(`could not keep a copy of the clip under ${path.dirname(VOICES_FILE)} (${e.message}) — registering the original path.`);
  }
  setVoice(name, voiceId, refClip, mintedAt);

  log.info(`\n✅ voice_id for "${name}" = ${voiceId}`);
  log.info(`   Saved to ${path.relative(process.cwd(), VOICES_FILE)} — reuse it on every fal render for this character.`);
  log.info(`   The clip is kept alongside it: Seedance lip-syncs to the clip itself (keep it ≤15s for best results).`);
  log.info(`   In a spec, set a VO line's "speaker": "${name}" so the renderer binds this voice.`);
}

main().catch((e) => { log.error(e); process.exit(1); });
