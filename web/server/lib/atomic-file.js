// Replacing a file on disk without ever showing a half-written one.
//
// `fs.writeFileSync` TRUNCATES the destination and then fills it: a process killed (or a disk
// filled) between those two leaves the file short, and every reader here treats an unparseable
// sidecar as "no content" — so the next write happily overwrites what the user had. The manifest
// (web.json) and the prompt-overrides sidecar are both read-modify-write state that has to survive
// that, so they share this one primitive rather than each getting its own tmp/rename dance.
//
// Config-free (node builtins only): both callers sit in web/server's static import graph.
import fs from 'node:fs';
import path from 'node:path';

/** Write `data` to `file` via a sibling temp file + rename — the destination is either the old
 *  bytes or the new ones, never a mixture. The temp name is pid-scoped so two processes writing the
 *  same run cannot land on each other's, and dot-prefixed so a directory scan skips it. */
export function writeFileAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    // rename(2) is atomic within a filesystem, which is why the temp file is a SIBLING.
    fs.renameSync(tmp, file);
  } catch (e) {
    // The destination was never touched; don't leave the half-written temp behind either.
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    throw e;
  }
}

export default { writeFileAtomic };
