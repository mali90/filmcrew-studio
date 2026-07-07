// Poll a run dir for NEW artifacts while a child is working there and emit typed events —
// the disk is the source of truth (a spec-03.json existing IS "agent 3 finished"), so this is
// what makes the monitor honest. Plain polling (500 ms, scoped to active runs only) beats
// fs.watch here: watch semantics differ across macOS/Linux and the poller self-terminates.
import fs from 'node:fs';
import path from 'node:path';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** Every artifact path (relative to dir) we announce: spec blocks, revision blocks, clips, render.json, cover. */
export function listArtifacts(dir) {
  const found = [];
  const push = (rel) => found.push(rel);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return found; }
  for (const name of entries) {
    if (/^spec(-r?\d{2}|-r?07-qc\d+)?\.json$/.test(name) || name === 'spec.json') push(name);
  }
  for (const sub of ['renders', 'revisions']) {
    const root = path.join(dir, sub);
    if (!exists(root)) continue;
    for (const takeName of fs.readdirSync(root)) {
      const takeDir = path.join(root, takeName);
      let inner = [];
      try { inner = fs.readdirSync(takeDir, { recursive: true }); } catch { continue; }
      for (const rel of inner) {
        const relStr = String(rel);
        if (/(^|\/|\\)(spec(-r\d{2}|-r07-qc\d+)?\.json|render\.json|cover\.png)$/.test(relStr) || /\.(mp4|mov|webm)$/i.test(relStr)) {
          push(path.join(sub, takeName, relStr));
        }
      }
    }
  }
  // cli-style nested render/ + root render.json
  if (exists(path.join(dir, 'render.json'))) push('render.json');
  const cliRender = path.join(dir, 'render');
  if (exists(cliRender)) {
    let inner = [];
    try { inner = fs.readdirSync(cliRender, { recursive: true }); } catch { inner = []; }
    for (const rel of inner) {
      const relStr = String(rel);
      if (/(^|\/|\\)render\.json$/.test(relStr) || /\.(mp4|mov|webm)$/i.test(relStr)) push(path.join('render', relStr));
    }
  }
  return found;
}

/**
 * Watch `dir` until stop() — emits {type:'artifact', file} once per new artifact (relative path).
 * By default the first sweep seeds the baseline WITHOUT emitting (existing files aren't news). Pass a
 * shared `seen` set to persist "already announced" across watcher restarts — then artifacts present at
 * startup that aren't yet in `seen` (e.g. a spec-00.json written before the watcher attached, a startup
 * race) ARE announced, exactly once.
 */
export function watchRun(dir, { intervalMs = 500, onEvent, seen = new Set(listArtifacts(dir)) } = {}) {
  const timer = setInterval(() => {
    for (const rel of listArtifacts(dir)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      onEvent?.({ type: 'artifact', file: rel });
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export default { listArtifacts, watchRun };
