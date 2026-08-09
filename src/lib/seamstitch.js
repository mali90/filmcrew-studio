// Node wrapper around tools/seamstitch — the seam-invisible stitcher for CHAINED clips.
//
// The whole Node-side surface assemble.js needs — is the tool usable here (seamstitchAvailable),
// should we use it for THIS set of clips (readContinuity + planSeamstitch, both pure), and run it
// (runSeamstitch).
//
// readContinuity answers the question per JOINT, from the seam lineage the renderers record
// (schema:2), so a cut that mixes takes stitches the joints that really are continuations and
// hard-cuts the one that is not. See web/server/lib/lineage.js for the same rule on the UI side.
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

/** A non-empty string, or null — ids and paths arriving from JSON may be anything. */
const str = (v) => (typeof v === 'string' && v.length ? v : null);

/** Seam modes that pinned NOTHING: the clip opened fresh, so the joint before it is a real cut.
 *  'unsupported' is the provider having rejected the anchor we sent — no frame was shared. */
const UNPINNED_SEAM_MODES = new Set(['none', 'unsupported']);

/**
 * Did `next` really open on `prev`'s closing frame? Clip identity is the authoritative test, the same
 * rule as web/server/lib/lineage.js: a seam recorded against a clip that is no longer in this cut is
 * exactly the false continuation claim the check exists to catch (run b1nx — K1 re-rendered into a
 * new take, the cut still using the old take's K2, which opens on a frame nothing here contains).
 */
function jointChained(prev, next) {
  const seam = next?.seamIn;
  if (!seam || typeof seam !== 'object') return false;
  if (UNPINNED_SEAM_MODES.has(str(seam.mode) ?? 'none')) return false;
  const source = str(seam.from?.clip);
  const current = str(prev?.clip);
  return Boolean(source && current && source === current);
}

/**
 * Which joints of a finished run are CHAINED, from what the run recorded. Returns one flag per joint,
 * or null when the run cannot say — null is "unknown", and planSeamstitch declines on it rather than
 * guessing (guessing wrong drops a real frame at a scene cut).
 *
 * `render.jobs[]` is the cut in clip order, each entry the renderer's own record (schema:2) of the
 * seam it opened on. When those seams are present they are the answer, PER JOINT: joint j is chained
 * iff clip j+1 was pinned to a boundary frame at all AND the clip that frame came off is the clip
 * sitting at position j right now. That is what lets a mixed timeline — one segment re-rendered,
 * the rest untouched — stitch its intact joints and hard-cut the broken one, where the older
 * all-or-nothing `chained` flag could only claim everything or nothing.
 *
 * Runs made before the sidecar existed carry no per-job seams. For them the run-level `chained` flag
 * is the only record there is, and it still means exactly what it always did: renderSpec seeded every
 * job after the first with the previous clip's last frame, in one pass, so every joint is a chain.
 *
 * `STITCH_ASSUME_CONTINUOUS=1` forces all-true. It is a test/debug knob for driving the stitcher over
 * clips whose lineage nothing recorded — never a default, because it asserts a fact about the footage.
 *
 * @param render     `{ chained?:boolean, jobs?:{clip?:string, seamIn?:object}[] }` — render.json, or
 *                   the in-flight equivalent finishRender is about to write
 * @param clipCount  how many clips are actually being stitched
 * @returns one boolean per joint (length `clipCount - 1`), or null for "unknown"
 */
export function readContinuity(render, clipCount, cfg = config.stitch) {
  const joints = Math.max(0, (clipCount ?? 0) - 1);
  if (!joints) return null;
  if (cfg.assumeContinuous) return Array(joints).fill(true);

  // Only the clip-BEARING jobs, in the order they were handed over: a job that errored contributes
  // no clip and therefore no joint, so including it would shift every verdict by one.
  const jobs = (Array.isArray(render?.jobs) ? render.jobs : []).filter((j) => str(j?.clip));
  const recorded = jobs.some((j) => j?.seamIn && typeof j.seamIn === 'object');
  // The count guard is not paranoia: if the job list and the clip list disagree we cannot say WHICH
  // pair each joint describes, and a misaligned answer is worse than no answer.
  if (recorded && jobs.length === clipCount) {
    return Array.from({ length: joints }, (_, j) => jointChained(jobs[j], jobs[j + 1]));
  }

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
