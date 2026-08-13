// ffprobe as a RULE, with the BINARY handed in — config-free on purpose.
//
// Two processes need the same answer about a clip and they do NOT share an environment: the render
// child (which reads its own dotenv through config.js) and the web server's prompt PREVIEW, which
// must describe what that child will do without ever importing config.js (see the header of
// web/server/lib/prompt-service.js). A probe bound to the server's `FFPROBE_BIN` answers for the
// wrong machine's setup — and the answer is not cosmetic: `fitAudioRef` DROPS a voice clip under a
// model's per-clip minimum, so a duration read from the wrong binary changes the @AudioN labels,
// the prompt bytes and the reference budget the preview promises.
//
// So the args and the parsing live here, once, and each side supplies the binary it will really
// spawn: assemble.js binds `config.video.ffprobe`, the preview resolves the RUN's own via
// ffprobeBinFor.
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * The ffprobe binary the render CHILD will really spawn, from a value read out of the run's
 * environment (`FFPROBE_BIN`, as DATA — never sourced).
 *
 * config.js's whole rule is `env.FFPROBE_BIN || 'ffprobe'`; it applies no path resolution, and every
 * child this server spawns runs with `cwd` = the project root (run-service's spawns all pass
 * `cwd: root`). So the resolution the child gets for free from its cwd is reproduced here:
 *   · a BARE name ('ffprobe', 'ffprobe7') stays bare — that is a PATH lookup on both ends, and
 *     resolving it would probe `<root>/ffprobe`, which is a file on no machine.
 *   · a value carrying a separator ('./bin/ffprobe') resolves against ROOT, because the server's own
 *     cwd is not the child's and a relative binary has to mean the same file on both ends.
 *
 * @param {string} configured  the run's FFPROBE_BIN ('' when unset)
 * @param {string} root  the project root the render children are spawned in
 */
export function ffprobeBinFor(configured, root) {
  const bin = String(configured ?? '') || 'ffprobe';
  if (path.isAbsolute(bin)) return bin;
  return /[\\/]/.test(bin) ? path.resolve(root, bin) : bin;
}

function runFfprobe(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`Failed to spawn ffprobe (${bin}): ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffprobe exited ${code}:\n${err.slice(-1000)}`))));
  });
}

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

/** Probe a clip on `bin`: does it carry an audio stream, and how long is it (seconds)? */
export async function probeClipWith(bin, file) {
  const out = await runFfprobe(bin, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio:format=duration', '-of', 'json', file]);
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

export default { ffprobeBinFor, probeClipWith };
