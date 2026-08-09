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
  // WS2-P6 — the delivery lifecycle: never reopened, nothing delivered yet, no markers
  assert.equal(m.reopenedAt, null);
  assert.deepEqual(m.finals, []);
  assert.deepEqual(m.history, []);
});

test('the delivery-lifecycle fields are ADDITIVE — a manifest saved before they existed still reads', () => {
  const t = mkTmp();
  try {
    // exactly what a run delivered before WS2-P6 has on disk: approved, no reopenedAt/finals/history
    const legacy = {
      v: 1, idea: 'a keeper at dusk', backend: 'kling', aspect: '9:16', durationS: null, cast: [], environment: null,
      createdAt: '2026-07-04T10:00:00.000Z', revisions: [], takes: [{ id: 't1', mode: 'full', createdAt: 'x' }],
      cuts: [], costLedger: [], approved: { cut: 'c1', final: '/out/keeper.mp4', upscaled: false, at: '2026-07-04T11:00:00.000Z' },
      lastError: null, activeJob: null,
    };
    fs.writeFileSync(path.join(t.dir, 'web.json'), JSON.stringify(legacy, null, 2));
    const read = readManifest(t.dir);
    assert.deepEqual(read, legacy, 'read back byte-for-byte — nothing is migrated on disk');
    assert.equal(read.reopenedAt, undefined);
    assert.equal(read.finals, undefined);
    assert.equal(read.history, undefined);
    // and the fields can be added later without disturbing anything already recorded
    const after = updateManifest(t.dir, (m) => { m.reopenedAt = '2026-07-05T09:00:00.000Z'; return m; });
    assert.equal(after.approved.final, '/out/keeper.mp4');
    assert.equal(readManifest(t.dir).reopenedAt, '2026-07-05T09:00:00.000Z');
  } finally { t.cleanup(); }
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
