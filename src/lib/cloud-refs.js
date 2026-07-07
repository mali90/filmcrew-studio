// Persistent map of reference-image key -> the uploaded fal CDN URL (used when FAL_UPLOAD_MODE=storage).
// Uploading the same reference every run is wasteful, so we upload ONCE and reuse the saved URL.
// Stored under config.paths.cache so it survives between runs. Keys are transport-scoped by prefix
// (e.g. `fal:<basename>`) so different upload targets never collide.
import fs from 'node:fs';
import path from 'node:path';
import config, { resolvePath } from '../../config.js';

export const CLOUD_REFS_FILE = path.join(resolvePath(config.paths.cache), 'cloud-refs.json');

export function loadCloudRefs() {
  try {
    return JSON.parse(fs.readFileSync(CLOUD_REFS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Cached cloud filename for `key`, or null if absent OR STALE. When `localPath` is given, the
 * cache is invalidated if the local reference changed since it was uploaded (mtime newer or size
 * differs) — so replacing a reference image forces a fresh upload. Entries are { file, mtimeMs, size }.
 */
export function getCloudRef(key, localPath) {
  const entry = loadCloudRefs()[key];
  if (!entry) return null;
  if (typeof entry === 'string') return localPath ? null : entry; // legacy, no fingerprint
  if (!entry.file) return null;
  if (localPath) {
    try {
      const st = fs.statSync(localPath);
      if (Math.floor(st.mtimeMs) > Math.floor(entry.mtimeMs ?? 0) || (entry.size != null && st.size !== entry.size)) {
        return null; // local reference changed -> stale
      }
    } catch { /* local file unstattable: fall through and reuse the cached upload */ }
  }
  return entry.file;
}

export function setCloudRef(key, filename, localPath) {
  const map = loadCloudRefs();
  let fingerprint = {};
  if (localPath) {
    try { const st = fs.statSync(localPath); fingerprint = { mtimeMs: Math.floor(st.mtimeMs), size: st.size }; } catch {}
  }
  map[key] = { file: filename, ...fingerprint };
  fs.mkdirSync(path.dirname(CLOUD_REFS_FILE), { recursive: true });
  fs.writeFileSync(CLOUD_REFS_FILE, JSON.stringify(map, null, 2) + '\n');
  return filename;
}

export default { CLOUD_REFS_FILE, loadCloudRefs, getCloudRef, setCloudRef };
