// Quit/restart endpoints: wired only when the host process provides real lifecycle handlers —
// test/inject apps (no handlers) refuse honestly instead of killing the test runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildApp } = await import('../../app.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-life-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('without lifecycle handlers the endpoints answer 501 (never exit the process)', async () => {
  const app = await buildApp({ root: HOST_ROOT, runsDir: path.join(tmpRoot, 'r1'), outDir: path.join(tmpRoot, 'o1') });
  try {
    for (const kind of ['quit', 'restart']) {
      const res = await app.inject({ method: 'POST', url: `/api/app/${kind}` });
      assert.equal(res.statusCode, 501);
      assert.match(res.json().hint, /npm run web/);
    }
  } finally { await app.close(); }
});

test('with lifecycle handlers: the response flushes FIRST, then the handler fires', async () => {
  const calls = [];
  const app = await buildApp({
    root: HOST_ROOT, runsDir: path.join(tmpRoot, 'r2'), outDir: path.join(tmpRoot, 'o2'),
    lifecycle: { quit: () => calls.push('quit'), restart: () => calls.push('restart') },
  });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/app/restart' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, restart: true });
    assert.deepEqual(calls, [], 'the reply must be on the wire before the server dies');
    await sleep(250);
    assert.deepEqual(calls, ['restart']);
  } finally { await app.close(); }
});
