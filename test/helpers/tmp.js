// Temp-dir factory for tests. Uses the OS tmp dir; each dir is unique and cleaned up on request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let counter = 0;

/** Make a fresh temp dir; returns { dir, cleanup }. `cleanup()` removes it recursively. */
export function mkTmp(prefix = 'kva-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { dir, cleanup };
}

/** A unique subpath under `parent` (not created). */
export function uniquePath(parent, name = 'item') {
  return path.join(parent, `${name}-${process.pid}-${counter++}`);
}
