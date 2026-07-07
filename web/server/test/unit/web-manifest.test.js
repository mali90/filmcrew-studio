import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MANIFEST_V, newManifest, readManifest, writeManifest, updateManifest } from '../../lib/web-manifest.js';

const mkTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-manifest-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('newManifest: versioned, seeded, with empty collections and null markers', () => {
  const m = newManifest({ idea: 'a keeper at dusk', backend: 'kling', aspect: '9:16', durationS: null }, '2026-07-04T10:00:00.000Z');
  assert.equal(m.v, MANIFEST_V);
  assert.equal(m.idea, 'a keeper at dusk');
  assert.equal(m.durationS, null); // null = "auto" — the engine decides
  assert.equal(m.createdAt, '2026-07-04T10:00:00.000Z');
  assert.deepEqual(m.revisions, []);
  assert.deepEqual(m.takes, []);
  assert.deepEqual(m.cuts, []);
  assert.deepEqual(m.costLedger, []);
  assert.equal(m.approved, null);
  assert.equal(m.lastError, null);
  assert.equal(m.activeJob, null);
});

test('write/read round-trip; corrupt or absent file reads as null (never throws)', () => {
  const t = mkTmp();
  try {
    assert.equal(readManifest(t.dir), null);
    const m = newManifest({ idea: 'x', backend: 'seedance', aspect: '16:9', durationS: 20 });
    writeManifest(t.dir, m);
    assert.deepEqual(readManifest(t.dir), m);
    assert.ok(!fs.readdirSync(t.dir).some((f) => f.includes('.tmp')), 'atomic write leaves no tmp file');
    fs.writeFileSync(path.join(t.dir, 'web.json'), '{not json');
    assert.equal(readManifest(t.dir), null);
  } finally { t.cleanup(); }
});

test('updateManifest: read-modify-write returns the new manifest; throws when absent', () => {
  const t = mkTmp();
  try {
    assert.throws(() => updateManifest(t.dir, (m) => m), /no web\.json/i);
    writeManifest(t.dir, newManifest({ idea: 'x', backend: 'kling', aspect: '9:16', durationS: null }));
    const after = updateManifest(t.dir, (m) => { m.takes.push({ id: 't1' }); return m; });
    assert.equal(after.takes.length, 1);
    assert.equal(readManifest(t.dir).takes[0].id, 't1');
  } finally { t.cleanup(); }
});
