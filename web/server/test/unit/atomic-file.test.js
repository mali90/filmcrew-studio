// writeFileAtomic — the tmp+rename primitive web.json and the prompt-overrides sidecar share.
// Both are read-modify-write state whose readers treat unparseable bytes as "nothing here", so a
// half-written file does not just lose ONE save: the next save writes over everything it could not
// read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { writeFileAtomic } = await import('../../lib/atomic-file.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-atomic-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('replaces the file and leaves no temp behind', () => {
  const file = path.join(tmpRoot, 'state.json');
  writeFileAtomic(file, '{"v":1}\n');
  writeFileAtomic(file, '{"v":2}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}\n');
  assert.deepEqual(fs.readdirSync(tmpRoot), ['state.json'], 'the temp file is renamed, never left');
});

test('a write that fails leaves the previous contents — and no debris', () => {
  const file = path.join(tmpRoot, 'keep.json');
  writeFileAtomic(file, '{"v":1}\n');

  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (f, data, ...rest) => {
    realWrite(f, String(data).slice(0, 3), ...rest); // the bytes that fit land…
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  try {
    assert.throws(() => writeFileAtomic(file, '{"v":2}\n'), /ENOSPC/);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}\n', 'the destination was never opened for writing');
  assert.ok(!fs.readdirSync(tmpRoot).some((f) => f.includes('keep.json.')), 'the half-written temp is cleaned up');
});
