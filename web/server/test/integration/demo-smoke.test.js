// The zero-spend demo harness, booted for real. demo-harness.test.js reads dev/demo.js as SOURCE
// (it starts servers on import, so it cannot be imported into a test process); this one runs it as
// the child process Playwright runs, on a port of its own, and asserts the two facts an e2e spec
// depends on before it can drive a Segmind run:
//   * /__demo/health names BOTH mock base urls — proof the Segmind mock actually came up, not just
//     that demo.js mentions it;
//   * /__demo/segmind-opts writes through to the mock's live `opts`, which is how a failure-mode
//     spec ("insufficient credits", "content policy") arms the Segmind side at runtime.
// The child is killed with SIGTERM at the end — which also exercises the handler that closes both
// mocks, the thing that otherwise wedges the next `npm run demo` on EADDRINUSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** An OS-assigned free port, released before the child claims it (demo.js takes a fixed port). */
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

/** Boot dev/demo.js and resolve once it answers, or reject with whatever it printed. */
async function startDemo(port) {
  const child = spawn(process.execPath, [path.join(HOST_ROOT, 'web/server/dev/demo.js')], {
    cwd: HOST_ROOT,
    env: { ...process.env, WEB_PORT: String(port), WEB_NO_OPEN: '1', LOG_LEVEL: 'error' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const url = `http://127.0.0.1:${port}/__demo/health`;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`demo.js exited early (${child.exitCode}): ${stderr.slice(-500)}`);
    try {
      const res = await fetch(url);
      if (res.ok) return { child, health: await res.json(), stderr: () => stderr };
    } catch { /* not listening yet */ }
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error(`demo.js never answered ${url}: ${stderr.slice(-500)}`);
}

test('the demo serves both provider mocks and lets e2e arm the Segmind one', async () => {
  const port = await freePort();
  const { child, health } = await startDemo(port);
  try {
    assert.equal(health.demo, true);
    for (const [provider, base] of [['fal', health.fal], ['segmind', health.segmind]]) {
      assert.match(String(base), /^http:\/\/127\.0\.0\.1:\d+$/, `${provider} mock is a local base url`);
    }
    assert.notEqual(health.fal, health.segmind, 'two servers, not one url reported twice');

    // Arm a Segmind failure mode the way a spec does, and read the mock's own opts back.
    const res = await fetch(`http://127.0.0.1:${port}/__demo/segmind-opts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ insufficientCredits: true, processingHits: 2 }),
    });
    assert.equal(res.status, 200);
    const { opts } = await res.json();
    assert.equal(opts.insufficientCredits, true);
    assert.equal(opts.processingHits, 2);

    // …and disarm it, so the harness is left the way it was found.
    const back = await fetch(`http://127.0.0.1:${port}/__demo/segmind-opts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ insufficientCredits: false, processingHits: 0 }),
    });
    assert.equal((await back.json()).opts.insufficientCredits, false);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});
