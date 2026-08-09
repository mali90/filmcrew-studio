// Final assembly with ffmpeg: stitch the job clips, normalize to the target frame, keep the
// source frame rate (fabricating no frames) unless asked to convert, and handle audio.
//
// VIDEO — two stitch paths. CONCAT (always available) hard-cuts the clips together. SEAMLESS
//   (tools/seamstitch, opt-in via `continuity`) colour-matches every CHAINED joint, drops the frame
//   the two clips share and crossfades, so a >15s multi-job render reads as one continuous take
//   instead of popping at each seam. It is pure local ffmpeg either way — no API, no cost. Every
//   failure path falls back to concat with one warning; only STITCH_SEAMLESS=force turns those into
//   errors. See docs/STITCHING.md.
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
import { planSeamstitch, runSeamstitch, seamstitchAvailable } from './seamstitch.js';
import { computeOffsets } from './stitch-math.js';

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

/** Parse an ffprobe "16:15" ratio to a number; 1 when unknown ("0:1", "N/A", absent) — i.e. square. */
function parseSar(ratio) {
  const m = /^(\d+):(\d+)$/.exec(String(ratio ?? ''));
  if (!m) return 1;
  const [num, den] = [Number(m[1]), Number(m[2])];
  return num > 0 && den > 0 ? num / den : 1;
}

export async function probeClip(file) {
  const out = await runFfprobe(['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio:format=duration', '-of', 'json', file]);
  const info = JSON.parse(out);
  const hasAudio = (info.streams ?? []).some((s) => s.codec_type === 'audio');
  const v = (info.streams ?? []).find((s) => s.codec_type === 'video');
  const duration = Number(info.format?.duration) || 0;
  const fps = parseFps(v?.avg_frame_rate) || parseFps(v?.r_frame_rate); // avg is truer; r_frame_rate is the fallback
  const width = Number(v?.width) || 0;
  const height = Number(v?.height) || 0;
  // Non-square pixels make WxH lie about the SHAPE of the picture. The seamless stitcher compares a
  // clip's framing against the canvas, so it needs the DISPLAY aspect, not the storage one.
  const sar = parseSar(v?.sample_aspect_ratio);
  return { hasAudio, duration, width, height, fps, sar, dar: height > 0 ? (width * sar) / height : 0 };
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
 * Stitch clips into the final video. Returns `{ out, stitcher, joints, matched }` — `stitcher` is
 * 'seamless' or 'concat', and the counts say how many joints were colour-matched.
 *
 * VIDEO: two paths. With `continuity` (one flag per joint saying whether that clip was rendered from
 * the previous clip's LAST frame) the seam-invisible stitcher runs first; without it — or if
 * anything about it fails — clips are hard-cut together with the concat filter, exactly as before.
 *
 * NATIVE mode (`nativeAudio: true`): per-clip audio is normalized and concatenated (clips with no
 * audio get matching silence), so Kling's generated audio survives 1:1. `bedTrack` (optional)
 * mixes a quiet instrumental UNDER the native track at `bedGainDb`.
 *
 * LEGACY mode: an external `audioTrack` is laid over the (silent) clips. Pass `audioTrack: null`
 * for a SILENT cut.
 */
const even = (n) => 2 * Math.round(n / 2); // yuv420p needs even dimensions

/** The tail of the NATIVE audio chain: mix an optional quiet music bed under `natLabel`, then bring
 *  the result to the EBU R128 target. Shared by both stitch paths so they deliver the same loudness. */
function audioMixChain({ natLabel = '[anat]', bedIdx = -1, bedGainDb = -15 } = {}) {
  if (bedIdx < 0) return [`${natLabel}${LOUDNORM}[aout]`];
  return [
    `[${bedIdx}:a]${AFORMAT},volume=${bedGainDb}dB[bed]`,
    `${natLabel}[bed]amix=inputs=2:duration=first:normalize=0,${LOUDNORM}[aout]`,
  ];
}

/**
 * ffmpeg argv for the audio pass that finishes a seamless stitch. PURE — takes only decided facts.
 *
 * The stitcher already produced the finished VIDEO and crossfaded the clips' own audio, so this pass
 * copies the video untouched (no second encode, no generation loss) and only rebuilds the track:
 * native audio gets the bed + loudness treatment, a legacy `audioTrack` replaces it outright, and a
 * silent cut keeps the video alone.
 */
export function audioFinishArgs({
  stitched, outPath, hasStitchedAudio = true, nativeAudio = false,
  audioTrack = null, loopAudio = false, bedTrack = null, bedGainDb = -15,
} = {}) {
  const args = ['-y', '-i', stitched];
  const parts = [];
  let nextInput = 1;

  // `loudnorm` emits 192 kHz, so the encoder would otherwise land on a 96 kHz AAC track — pin the
  // delivery rate instead. (The concat path has always shipped 96 kHz here; left alone deliberately,
  // so the fallback stays byte-identical to the master this release replaces.)
  const AAC = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];

  if (nativeAudio && hasStitchedAudio) {
    let bedIdx = -1;
    if (bedTrack) { args.push('-stream_loop', '-1', '-i', bedTrack); bedIdx = nextInput++; }
    parts.push(`[0:a]${AFORMAT},asetpts=PTS-STARTPTS[anat]`);
    parts.push(...audioMixChain({ bedIdx, bedGainDb }));
    args.push('-filter_complex', parts.join(';'), '-map', '0:v', '-map', '[aout]', ...AAC);
  } else if (!nativeAudio && audioTrack) {
    if (loopAudio) args.push('-stream_loop', '-1');
    args.push('-i', audioTrack);
    parts.push(`[${nextInput}:a]${LOUDNORM}[aout]`);
    args.push('-filter_complex', parts.join(';'), '-map', '0:v', '-map', '[aout]', ...AAC, '-shortest');
  } else {
    args.push('-map', '0:v'); // silent cut (or native audio asked for on a stitch that carries none)
  }

  args.push('-c:v', 'copy', '-movflags', '+faststart', outPath);
  return args;
}

/** Run the audio pass over the stitcher's output, writing the master. */
async function finishAudio(stitched, outPath, opts) {
  const { hasAudio } = await probeClip(stitched);
  if (opts.nativeAudio && !hasAudio) {
    log.warn('Seamless stitch carries no audio stream — the master will be silent.');
  }
  await runFfmpeg(audioFinishArgs({ ...opts, stitched, outPath, hasStitchedAudio: hasAudio }));
}

/** The stitch canvas: explicit VIDEO_WIDTH/HEIGHT wins; else the RUN'S aspect shapes it at
 *  VIDEO_SHORT_SIDE scale, CAPPED at the source clips' own short side (`srcShortSide`) — the
 *  stitch must never upscale. A ~496p Kling standard render must deliver a ~496p master: blowing
 *  it up to 1080 here made the delivered size lie, which disabled the approve-time Topaz upscale
 *  (the one REAL upscaler) as "already 1080p". A fixed portrait canvas also once center-cropped
 *  16:9 masters into 9:16.
 *
 *  The `n:m` math is generic on purpose, so it already covers every ratio the model registry
 *  exposes — 16:9, 9:16, 1:1 plus Seedance 2.5's 4:3, 3:4 and 21:9 — with the short side always on
 *  the correct axis. Anything unparseable (including 'adaptive'/'auto', which the registry never
 *  offers) falls back to the legacy portrait canvas. */
export function canvasFor(aspect, srcShortSide = null, scale = null) {
  if (V.width && V.height) return { w: V.width, h: V.height };
  // `scale` overrides VIDEO_SHORT_SIDE for THIS stitch: the paid-upscale path passes what Topaz
  // actually delivered, so a 4K upscale is not quietly stitched back down to the 1080 default.
  const s = srcShortSide ? Math.min(scale ?? V.shortSide, srcShortSide) : (scale ?? V.shortSide);
  const m = /^(\d+):(\d+)$/.exec(aspect ?? '');
  if (!m) return { w: even(s), h: even((s * 16) / 9) }; // unknown → legacy portrait
  const [aw, ah] = [Number(m[1]), Number(m[2])];
  return aw >= ah
    ? { w: even((s * aw) / ah), h: even(s) }   // landscape/square: height is the short side
    : { w: even(s), h: even((s * ah) / aw) };  // portrait: width is the short side
}

/**
 * Try the seam-invisible stitch (tools/seamstitch). Returns the path of a stitched, video-only-final
 * temp file, or null to fall back to the hard-cut concat.
 *
 * Every refusal path funnels through `decline`, so a fallback costs exactly ONE warning that names
 * the reason. Under STITCH_SEAMLESS=force the same reasons throw instead — that mode exists to make
 * a silent downgrade impossible in a pipeline that requires seamless output.
 */
async function trySeamlessStitch({ clipPaths, probes, continuity, canvas, targetFps, outPath }) {
  const cfg = config.stitch;
  const tmpOut = path.join(path.dirname(outPath), `.${path.basename(outPath, path.extname(outPath))}.seamstitch.mp4`);
  const decline = (why) => {
    fs.rmSync(tmpOut, { force: true });
    if (cfg.seamless === 'force') throw new Error(`Seamless stitch required (STITCH_SEAMLESS=force) but ${why}`);
    log.warn(`Seamless stitch skipped — ${why}. Stitching with a hard cut at every seam instead.`);
    return null;
  };

  const plan = planSeamstitch({ probes, continuity, canvas, targetFps, cfg });
  if (!plan.eligible) return decline(plan.reason);

  const avail = await seamstitchAvailable({ python: cfg.python });
  if (!avail.ok) return decline(`the stitcher is not runnable (${avail.reason})`);

  const res = await runSeamstitch([...clipPaths, '-o', tmpOut, ...plan.args], { python: cfg.python, timeoutMs: cfg.timeoutMs });
  const report = res.report;
  if (!report) return decline(res.reason ?? 'the stitcher wrote no JSON report');
  // Exit 2 means a verify gate failed. That is advisory under STITCH_VERIFY=warn (the seam is still
  // far better than a hard cut) and disqualifying under 'strict'; any other non-zero exit is fatal.
  const gateFailed = res.code === 2;
  if (res.code !== 0 && !(gateFailed && cfg.verify !== 'strict')) {
    return decline(`the stitcher exited ${res.code}${gateFailed ? ' (verify gate failed, STITCH_VERIFY=strict)' : ''}`);
  }
  if (!fs.existsSync(tmpOut)) return decline('the stitcher reported success but wrote no output file');

  // Cross-check the result against an INDEPENDENT re-derivation of §7.5 (src/lib/stitch-math.js): the
  // tool's own arithmetic and the file it actually wrote must both agree with it, or the timeline is
  // not what we asked for and a plain concat is the safer master.
  let expected;
  try {
    expected = computeOffsets(
      (report.segments ?? []).map((s) => s.nframes),
      report.fps,
      report.xfades,
      [false, ...(report.jointMatch ?? [])],
    ).expectedDuration;
  } catch (e) {
    return decline(`the stitcher's plan did not re-derive (${e.message})`);
  }
  let actual;
  try {
    actual = (await probeClip(tmpOut)).duration; // an unreadable stitch must fall back, not throw
  } catch (e) {
    return decline(`the stitch could not be probed (${e.message})`);
  }
  const tol = 1 / targetFps + 0.05; // one frame + AAC priming slack (spec §12.7)
  if (Math.abs(actual - expected) > tol) {
    return decline(`the stitch is ${actual.toFixed(2)}s but the plan expects ${expected.toFixed(2)}s`);
  }

  if (gateFailed) {
    const seam = report.verify?.seam?.filter((j) => !j.passed).map((j) => j.joint) ?? [];
    const geom = report.verify?.geometry?.filter((g) => g.verdict === 'FAIL').map((g) => g.joint) ?? [];
    log.warn(`Seamless stitch verify gate failed${seam.length ? ` — seam at joint(s) ${seam.join(', ')}` : ''}${geom.length ? ` — geometry at joint(s) ${geom.join(', ')}` : ''}. Keeping it (set STITCH_VERIFY=strict to fall back instead).`);
  }
  for (const w of report.warnings ?? []) log.debug(`seamstitch: ${w}`);
  return tmpOut;
}

export async function assembleVideo(clipPaths, outPath, {
  audioTrack, loopAudio = false, nativeAudio = false, bedTrack = null, bedGainDb = -15, aspect = null,
  continuity = null, canvasScale = null,
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
  const canvas = canvasFor(aspect, srcShorts.length ? Math.min(...srcShorts) : null, canvasScale);

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

  // SEAMLESS PATH — only when the caller can say which joints are CHAINED (each clip rendered from
  // the previous one's last frame). Those joints get colour-matched, their duplicated boundary frame
  // dropped and a short crossfade; scene cuts stay cuts. Anything at all going wrong here falls back
  // to the concat below with one warning, so this can never cost a master.
  if (continuity) {
    const stitched = await trySeamlessStitch({ clipPaths, probes, continuity, canvas, targetFps, outPath });
    if (stitched) {
      try {
        await finishAudio(stitched, outPath, {
          nativeAudio,
          audioTrack: !nativeAudio && audioTrack && fs.existsSync(audioTrack) ? audioTrack : null,
          loopAudio,
          bedTrack: nativeAudio && bedTrack && fs.existsSync(bedTrack) ? bedTrack : null,
          bedGainDb,
        });
      } finally {
        fs.rmSync(stitched, { force: true });
      }
      const matched = continuity.filter(Boolean).length;
      log.info(`Seamless stitch: ${clipPaths.length} clip(s) -> ${outPath} (${canvas.w}x${canvas.h}@${targetFps}fps, ${matched}/${continuity.length} joint(s) colour-matched)`);
      log.info(`Video ready: ${outPath}`);
      return { out: outPath, stitcher: 'seamless', joints: continuity.length, matched };
    }
  }

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
    parts.push(...audioMixChain({ bedIdx, bedGainDb }));
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
  return { out: outPath, stitcher: 'concat', joints: Math.max(0, clipPaths.length - 1), matched: 0 };
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

export default { assembleVideo, probeClip, extractAudio, clipsHaveNativeAudio, grabFrame, lastFrameOf, audioFinishArgs };
