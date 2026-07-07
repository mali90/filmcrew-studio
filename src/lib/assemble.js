// Final assembly with ffmpeg: stitch the job clips, normalize to the target frame, keep the
// source frame rate (fabricating no frames) unless asked to convert, and handle audio.
//
// AUDIO — NATIVE (nativeAudio: true): the clips' own audio (Kling's generate_audio, which SPEAKS the
//   scripted VO lines and, on the fal transport, in each character's minted voice_id) is concatenated
//   and PRESERVED as the primary track. Internal seams get a short afade out/in so each clip's own
//   score/ambience eases across the cut instead of hard-jumping. An optional quiet music bed can be
//   mixed UNDER it. LEGACY mode lays an external track over silent clips.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import log from './logger.js';
import { ensureDir } from './util.js';

const V = config.video;
// EBU R128 loudness target so the track sits at a consistent level and nothing clips.
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';
// Normalize every audio source to one format so concat/amix never fail on mismatched streams.
const AFORMAT = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    log.debug(`ffmpeg ${args.join(' ')}`);
    const child = spawn(V.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`Failed to spawn ffmpeg (${V.ffmpeg}): ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${err.slice(-3000)}`))));
  });
}

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(V.ffprobe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`Failed to spawn ffprobe (${V.ffprobe}): ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffprobe exited ${code}:\n${err.slice(-1000)}`))));
  });
}

/** Probe a clip: does it carry an audio stream, and how long is it (seconds)? */
/** Parse an ffprobe frame-rate ratio ("24/1", "24000/1001") to a number; 0 when unknown ("0/0"). */
function parseFps(ratio) {
  const m = /^(\d+)\/(\d+)$/.exec(String(ratio ?? ''));
  if (!m) return 0;
  const [num, den] = [Number(m[1]), Number(m[2])];
  return den > 0 ? num / den : 0;
}

export async function probeClip(file) {
  const out = await runFfprobe(['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate:format=duration', '-of', 'json', file]);
  const info = JSON.parse(out);
  const hasAudio = (info.streams ?? []).some((s) => s.codec_type === 'audio');
  const v = (info.streams ?? []).find((s) => s.codec_type === 'video');
  const duration = Number(info.format?.duration) || 0;
  const fps = parseFps(v?.avg_frame_rate) || parseFps(v?.r_frame_rate); // avg is truer; r_frame_rate is the fallback
  return { hasAudio, duration, width: Number(v?.width) || 0, height: Number(v?.height) || 0, fps };
}

/**
 * Extract a clip's AUDIO track to an .mp3, trimmed to the first `seconds` when given. Seedance
 * voice refs must be MP3/WAV within a ≤15s combined budget, but minted clips may be longer or ride
 * inside an .mp4/.mov — this re-cuts them to fit.
 */
export async function extractAudio(inPath, outPath, { seconds } = {}) {
  await runFfmpeg(['-y', '-i', inPath, ...(seconds ? ['-t', String(seconds)] : []), '-vn', '-acodec', 'libmp3lame', '-q:a', '4', outPath]);
  return outPath;
}

/** True when at least one clip carries its own audio stream. */
export async function clipsHaveNativeAudio(clipPaths) {
  for (const c of clipPaths) {
    if (!fs.existsSync(c)) continue;
    if ((await probeClip(c)).hasAudio) return true;
  }
  return false;
}

/**
 * Stitch clips into the final video.
 *
 * NATIVE mode (`nativeAudio: true`): per-clip audio is normalized and concatenated (clips with no
 * audio get matching silence), so Kling's generated audio survives 1:1. `bedTrack` (optional)
 * mixes a quiet instrumental UNDER the native track at `bedGainDb`.
 *
 * LEGACY mode: an external `audioTrack` is laid over the (silent) clips. Pass `audioTrack: null`
 * for a SILENT cut.
 */
const even = (n) => 2 * Math.round(n / 2); // yuv420p needs even dimensions

/** The stitch canvas: explicit VIDEO_WIDTH/HEIGHT wins; else the RUN'S aspect shapes it at
 *  VIDEO_SHORT_SIDE scale, CAPPED at the source clips' own short side (`srcShortSide`) — the
 *  stitch must never upscale. A ~496p Kling standard render must deliver a ~496p master: blowing
 *  it up to 1080 here made the delivered size lie, which disabled the approve-time Topaz upscale
 *  (the one REAL upscaler) as "already 1080p". A fixed portrait canvas also once center-cropped
 *  16:9 masters into 9:16. */
export function canvasFor(aspect, srcShortSide = null) {
  if (V.width && V.height) return { w: V.width, h: V.height };
  const s = srcShortSide ? Math.min(V.shortSide, srcShortSide) : V.shortSide;
  const m = /^(\d+):(\d+)$/.exec(aspect ?? '');
  if (!m) return { w: even(s), h: even((s * 16) / 9) }; // unknown → legacy portrait
  const [aw, ah] = [Number(m[1]), Number(m[2])];
  return aw >= ah
    ? { w: even((s * aw) / ah), h: even(s) }   // landscape/square: height is the short side
    : { w: even(s), h: even((s * ah) / aw) };  // portrait: width is the short side
}

export async function assembleVideo(clipPaths, outPath, {
  audioTrack, loopAudio = false, nativeAudio = false, bedTrack = null, bedGainDb = -15, aspect = null,
} = {}) {
  if (!clipPaths.length) throw new Error('No clips to assemble');
  for (const c of clipPaths) if (!fs.existsSync(c)) throw new Error(`Clip not found: ${c}`);
  ensureDir(path.dirname(outPath));

  // One probe per clip, up front — the audio layout AND the canvas cap both need it. The master
  // is only as sharp as its SOFTEST clip, so the canvas follows the smallest source short side:
  // fresh renders stitch at their native size (Kling standard ~496p, Seedance 480p) and reach a
  // true 1080p only after approve-time Topaz has lifted every clip.
  const probes = [];
  for (const c of clipPaths) probes.push(await probeClip(c));
  const srcShorts = probes.map((p) => Math.min(p.width, p.height)).filter((n) => n > 0);
  const canvas = canvasFor(aspect, srcShorts.length ? Math.min(...srcShorts) : null);

  // Frame rate: MATCH the source when the clips agree, so a 24fps run stays 24fps and no frames
  // are fabricated. An explicit VIDEO_FPS (V.fps) still forces a rate; 30 is only a last resort for
  // genuinely mixed-fps sources. Motion-compensated interpolation (minterpolate) warps synthesised
  // frames and is now OPT-IN (VIDEO_INTERPOLATE) — the default `fps=` is a passthrough when the
  // target already equals a clip's own rate, and a plain sample-and-hold only when normalising.
  const fpsList = probes.map((p) => Math.round(p.fps)).filter((n) => n > 0);
  const uniformFps = fpsList.length === probes.length && fpsList.every((f) => f === fpsList[0]);
  const targetFps = V.fps ?? (uniformFps ? fpsList[0] : 30);
  const fpsFilter = (i) =>
    V.interpolate && Math.round(probes[i].fps) !== targetFps
      ? `minterpolate=fps=${targetFps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`
      : `fps=${targetFps}`;
  const videoChain = (i) =>
    `[${i}:v]scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=increase,` +
    `crop=${canvas.w}:${canvas.h},setsar=1,${fpsFilter(i)},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`;

  const args = ['-y'];
  const parts = [];

  if (nativeAudio) {
    if (!probes.some((p) => p.hasAudio)) {
      log.warn('nativeAudio requested but no clip has an audio stream — output will carry silence' + (bedTrack ? ' under the music bed.' : '.'));
    }
    for (const c of clipPaths) args.push('-i', c);
    const silenceIdxByClip = {};
    let nextInput = clipPaths.length;
    probes.forEach((p, i) => {
      if (!p.hasAudio) {
        args.push('-f', 'lavfi', '-t', String(Math.max(0.1, p.duration || 1)), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        silenceIdxByClip[i] = nextInput++;
      }
    });
    let bedIdx = -1;
    if (bedTrack && fs.existsSync(bedTrack)) { args.push('-stream_loop', '-1', '-i', bedTrack); bedIdx = nextInput++; }
    else if (bedTrack) log.warn(`Music bed "${bedTrack}" not found — assembling with native audio only.`);

    // Per-clip audio: fade each native track OUT just before a seam and IN just after one (afade), so
    // each clip's own score/ambience eases down and the next eases up at the cut instead of hard-
    // jumping between two different per-clip tracks. No overlap (unlike acrossfade) → the audio stays
    // length-aligned to the video. Fades apply only at INTERNAL seams; the video's outer start/end keep
    // full level. A music bed underneath (native+bed), if present, still spans the whole cut.
    const XF = 0.35; // seam fade-out + fade-in seconds
    const pairLabels = [];
    clipPaths.forEach((_, i) => {
      parts.push(videoChain(i));
      const aSrc = silenceIdxByClip[i] !== undefined ? `[${silenceIdxByClip[i]}:a]` : `[${i}:a]`;
      const fades = [];
      if (i > 0) fades.push(`afade=t=in:st=0:d=${XF}`);                  // fade IN after the previous seam
      if (i < clipPaths.length - 1) {                                    // fade OUT into the next seam
        const st = Math.max(0, (probes[i].duration || 0) - XF);
        fades.push(`afade=t=out:st=${st.toFixed(3)}:d=${XF}`);
      }
      parts.push(`${aSrc}${AFORMAT},asetpts=PTS-STARTPTS${fades.length ? `,${fades.join(',')}` : ''}[a${i}]`);
      pairLabels.push(`[v${i}][a${i}]`);
    });
    parts.push(`${pairLabels.join('')}concat=n=${clipPaths.length}:v=1:a=1[vout][anat]`);
    if (bedIdx >= 0) {
      parts.push(`[${bedIdx}:a]${AFORMAT},volume=${bedGainDb}dB[bed]`);
      parts.push(`[anat][bed]amix=inputs=2:duration=first:normalize=0,${LOUDNORM}[aout]`);
    } else {
      parts.push(`[anat]${LOUDNORM}[aout]`);
    }
    args.push('-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  } else {
    const hasTrack = audioTrack && fs.existsSync(audioTrack);
    if (audioTrack && !hasTrack) log.warn(`Audio track "${audioTrack}" not found — rendering silent.`);
    for (const c of clipPaths) args.push('-i', c);
    if (hasTrack) { if (loopAudio) args.push('-stream_loop', '-1'); args.push('-i', audioTrack); }
    const labels = [];
    clipPaths.forEach((_, i) => { parts.push(videoChain(i)); labels.push(`[v${i}]`); });
    parts.push(`${labels.join('')}concat=n=${clipPaths.length}:v=1:a=0[vout]`);
    if (hasTrack) parts.push(`[${clipPaths.length}:a]${LOUDNORM}[aout]`);
    args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
    if (hasTrack) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  }

  args.push('-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(targetFps), '-movflags', '+faststart', '-crf', '19', outPath);
  log.info(`Assembling ${clipPaths.length} clip(s) -> ${outPath} (${canvas.w}x${canvas.h}@${targetFps}fps${uniformFps && V.fps == null ? ' (matched source)' : ''}, audio: ${nativeAudio ? `native${bedTrack ? '+bed' : ''}` : (audioTrack ? 'track' : 'silent')})`);
  await runFfmpeg(args);
  log.info(`Video ready: ${outPath}`);
  return outPath;
}

/** Grab one still at `t` seconds for a cover image (best-effort). */
export async function grabFrame(video, t, outPng) {
  ensureDir(path.dirname(outPng));
  try {
    await runFfmpeg(['-y', '-ss', String(Math.max(0, t)), '-i', video, '-frames:v', '1', '-q:v', '2', outPng]);
    return fs.existsSync(outPng) ? outPng : null;
  } catch { return null; }
}

/** Grab a clip's LAST frame (→ the next job's start frame for seam continuity). Best-effort; mirrors
 *  grabFrame but seeks from the END: `-sseof -0.25` (before `-i`) reads 0.25s before the end and
 *  writes one still. */
export async function lastFrameOf(video, outPng) {
  ensureDir(path.dirname(outPng));
  try {
    await runFfmpeg(['-y', '-sseof', '-0.25', '-i', video, '-update', '1', '-frames:v', '1', '-q:v', '2', outPng]);
    return fs.existsSync(outPng) ? outPng : null;
  } catch { return null; }
}

export default { assembleVideo, probeClip, extractAudio, clipsHaveNativeAudio, grabFrame, lastFrameOf };
