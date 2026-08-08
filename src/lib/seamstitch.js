// Node wrapper around tools/seamstitch — the seam-invisible stitcher for CHAINED clips.
//
// Nothing calls this yet: assemble.js still hard-cuts every seam. This module is the whole Node-side
// surface the wiring will need — is the tool usable here (seamstitchAvailable), should we use it for
// THIS set of clips (planSeamstitch, pure), and run it (runSeamstitch).
//
// The Python package uses relative imports, so it can only be started as `-m seamstitch` with
// PYTHONPATH pointing at tools/ — see tools/seamstitch/PROVENANCE.md.
import { spawn } from 'node:child_process';
import path from 'node:path';
import config from '../../config.js';
import log from './logger.js';

/** Absolute path of the directory that must be on PYTHONPATH for `-m seamstitch` to resolve. */
export const toolsDir = (root = config.root) => path.join(root, 'tools');

/** ADDENDUM_AR §4: beyond this the segment is genuinely framed differently and cropping it would be
 *  worse than not stitching at all. The Python side aborts on it; we decline before spawning. */
const MAX_FRAMING_DRIFT = 0.08;

const availability = new Map(); // python bin → Promise<{ok, reason}>

/**
 * Is the stitcher runnable? Spawns the interpreter once per binary and caches the answer, since the
 * pipeline may ask per render. Resolves { ok, reason } — never rejects, never throws.
 */
export function seamstitchAvailable({ python = config.stitch.python, root = config.root } = {}) {
  const key = JSON.stringify([python, root]);
  if (!availability.has(key)) availability.set(key, probeAvailability(python, root));
  return availability.get(key);
}

/** Test/dev hook: forget the memoized answers (e.g. after installing the deps). */
export function resetSeamstitchAvailability() {
  availability.clear();
}

function probeAvailability(python, root) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ['-c', 'import numpy, PIL, seamstitch'], {
        env: { ...process.env, PYTHONPATH: pythonPath(root) },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, reason: `could not spawn ${python}: ${e.message}` });
    }
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, reason: `could not spawn ${python}: ${e.message}` }));
    child.on('close', (code) => resolve(code === 0
      ? { ok: true, reason: null }
      : { ok: false, reason: (err.trim().split('\n').pop() || `${python} exited ${code}`) }));
  });
}

/** PYTHONPATH for the child: tools/ first, but never clobber an inherited one. */
function pythonPath(root) {
  return [toolsDir(root), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
}

/**
 * Which joints of a finished run are CHAINED, from what the run recorded. Returns one flag per joint,
 * or null when the run cannot say — null is "unknown", and planSeamstitch declines on it rather than
 * guessing (guessing wrong drops a real frame at a scene cut).
 *
 * TODAY a render is chained all-or-nothing: renderSpec seeds every job after the first with the
 * previous clip's last frame, and records that as `chained` in render.json. Per-JOINT lineage — which
 * seams actually got their frame, which clips were re-rendered since — is upcoming work; when it
 * lands this reads it and mixed timelines start stitching correctly on their own.
 *
 * `STITCH_ASSUME_CONTINUOUS=1` forces all-true. It is a test/debug knob for driving the stitcher over
 * clips whose lineage nothing recorded — never a default, because it asserts a fact about the footage.
 */
export function readContinuity(render, clipCount, cfg = config.stitch) {
  const joints = Math.max(0, (clipCount ?? 0) - 1);
  if (!joints) return null;
  if (cfg.assumeContinuous) return Array(joints).fill(true);
  return render?.chained === true ? Array(joints).fill(true) : null;
}

/**
 * Decide whether these clips can be stitched seamlessly, and with what flags. PURE — no I/O, no
 * spawning; it only reads the probes it is handed, so it is cheap to call and easy to test.
 *
 * @param probes      per clip, as returned by assemble.js's probeClip:
 *                    { width, height, duration, fps, sar, dar } — `dar` (display aspect) wins over
 *                    width/height when present, so non-square pixels are judged by their real shape
 * @param continuity  one flag per JOINT (probes.length - 1): true = clip j+1 was rendered from clip
 *                    j's last frame (a chained continuation), false = scene cut. Null/undefined means
 *                    the caller does not know, which is NOT the same as "all cuts" — we decline.
 * @param canvas      the stitch canvas { w, h } the caller already chose (assemble.js's canvasFor,
 *                    which caps at the source short side so a stitch never upscales)
 * @returns { eligible, reason, args } — `args` are the CLI flags only; the caller adds the input
 *          paths and `-o`.
 */
export function planSeamstitch({ probes, continuity, canvas, targetFps, cfg = config.stitch } = {}) {
  const decline = (reason) => ({ eligible: false, reason, args: null });

  if (cfg.seamless === 'off') return decline('seamless stitching is off (STITCH_SEAMLESS=off)');
  if (!Array.isArray(probes) || probes.length < 2) return decline('fewer than 2 clips — nothing to stitch');
  if (!canvas?.w || !canvas?.h) return decline('no stitch canvas');
  if (!(targetFps > 0)) return decline('no target frame rate');
  if (continuity == null) return decline('no continuity map — which joints are chained is unknown');
  if (!Array.isArray(continuity) || continuity.length !== probes.length - 1) {
    return decline(`continuity has ${Array.isArray(continuity) ? continuity.length : 'no'} entries, expected ${probes.length - 1} (one per joint)`);
  }
  if (!continuity.some(Boolean)) return decline('no chained joint — every seam is a cut, a plain concat is equivalent');

  // Geometry: refuse the clips the Python side would abort on anyway (ADDENDUM_AR §4). Compare
  // DISPLAY aspect ratios — a clip with non-square pixels is not the shape its WxH suggests, and the
  // canvas is always square-pixel.
  for (const [i, p] of probes.entries()) {
    if (!(p?.width > 0) || !(p?.height > 0)) return decline(`clip ${i + 1} has unknown dimensions`);
    const srcDar = p.dar > 0 ? p.dar : p.width / p.height;
    const d = canvas.w / canvas.h / srcDar;
    if (Math.abs(d - 1) > MAX_FRAMING_DRIFT) {
      const sar = p.sar && p.sar !== 1 ? `, SAR ${p.sar.toFixed(4)}` : '';
      return decline(`clip ${i + 1} is framed ${(Math.abs(d - 1) * 100).toFixed(1)}% off the ${canvas.w}x${canvas.h} canvas (${p.width}x${p.height}${sar}) — refitting it would crop real content`);
    }
  }

  // Length budget: every clip must outlast the fade on each of its sides plus one frame (§7.1).
  const fd = 1 / targetFps;
  const jointXfades = continuity.map((chained) => (chained ? Number(cfg.xfade) : Number(cfg.cutXfade)));
  // Budget with the values the tool will actually use: it promotes a 0 fade on a real joint to one
  // frame (ffmpeg's xfade rejects duration=0), so a 0 here still consumes a frame of the clip.
  const effXfade = (x) => (x === 0 ? fd : x);
  for (const [j, p] of probes.entries()) {
    const before = j > 0 ? effXfade(jointXfades[j - 1]) : 0;
    const after = j < jointXfades.length ? effXfade(jointXfades[j]) : 0;
    const need = before + after + fd;
    if (!(p.duration > 0)) return decline(`clip ${j + 1} has unknown duration`);
    if (p.duration + 1e-9 < need) {
      return decline(`clip ${j + 1} is ${p.duration.toFixed(2)}s, shorter than its crossfades need (${need.toFixed(2)}s)`);
    }
  }

  const args = [
    '--target-res', `${canvas.w}x${canvas.h}`,
    '--fps', String(targetFps),
    // Per joint, so one timeline can carry chained joints and scene cuts at once. A cutXfade of 0
    // becomes a single frame on the Python side (ffmpeg's xfade rejects duration=0).
    '--joint-match', continuity.map((c) => (c ? '1' : '0')).join(','),
    '--joint-xfade', jointXfades.map((x) => String(x)).join(','),
    '--fit', String(cfg.fit),
    '--method', String(cfg.method),
    '--ramp', String(cfg.ramp),
    '--crf', String(cfg.crf),
    '--preset', String(cfg.preset),
    '--json',
  ];
  if (cfg.desqueeze && cfg.desqueeze !== 'off') args.push('--desqueeze', String(cfg.desqueeze));
  if (cfg.deflicker) args.push('--deflicker');
  if (cfg.verify !== 'off') args.push('--verify');

  return { eligible: true, reason: null, args };
}

/**
 * Run the stitcher. Streams its stderr into the debug log (it is chatty: per-joint luma deltas,
 * ffmpeg progress) and parses the single JSON object it writes to stdout.
 *
 * Never rejects. Resolves { ok, report, code, reason }: `ok` means the tool both exited 0 and said so
 * (exit 2 = a verify gate failed, and the report explains which joint).
 */
export function runSeamstitch(args, { python = config.stitch.python, root = config.root, timeoutMs = config.stitch.timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ['-m', 'seamstitch', ...args], {
        env: { ...process.env, PYTHONPATH: pythonPath(root) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, report: null, code: null, reason: `could not spawn ${python}: ${e.message}` });
    }

    let out = '';
    let errTail = '';
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs) : null;

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      const s = String(d);
      errTail = (errTail + s).slice(-4000);
      for (const line of s.split('\n')) if (line.trim()) log.debug(`seamstitch: ${line.trim()}`);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, report: null, code: null, reason: `could not spawn ${python}: ${e.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, report: null, code, reason: `seamstitch timed out after ${timeoutMs}ms` });
      let report = null;
      try {
        report = JSON.parse(out.trim());
      } catch {
        return resolve({ ok: false, report: null, code, reason: `seamstitch wrote no JSON report (exit ${code})\n${errTail.slice(-800)}` });
      }
      const ok = code === 0 && report?.ok === true;
      resolve({ ok, report, code, reason: ok ? null : `seamstitch exit ${code}` });
    });
  });
}

export default { seamstitchAvailable, resetSeamstitchAvailability, readContinuity, planSeamstitch, runSeamstitch, toolsDir };
