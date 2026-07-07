// Path safety for everything the API touches on disk. Run ids come from URLs; every file the
// server reads or serves is resolved through safeChild so a crafted id/segment can never escape
// the runs/out directories.
import path from 'node:path';

// A run id is a plain directory name: starts alphanumeric, then a conservative charset, no
// separators, no leading dot (hidden dirs are never runs), bounded length.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** True when `id` is a safe run-directory name (CLI- or web-created). */
export function isRunId(id) {
  return typeof id === 'string' && RUN_ID.test(id) && !id.includes('..');
}

/**
 * Join `segs` under `base` and assert the result stays inside it. Segments may contain forward
 * slashes (relative media paths); absolute segments, backslashes, and any `..` escape throw.
 */
export function safeChild(base, ...segs) {
  for (const s of segs) {
    if (typeof s !== 'string' || !s.length || path.isAbsolute(s) || s.includes('\\')) {
      throw new Error(`invalid path segment: ${JSON.stringify(s)}`);
    }
  }
  const abs = path.resolve(base, ...segs);
  const rel = path.relative(path.resolve(base), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path escapes base (traversal): ${segs.join('/')}`);
  return abs;
}

export default { isRunId, safeChild };
