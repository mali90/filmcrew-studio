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

test('the demo seeds a cut with one whole join and one broken one', async () => {
  const port = await freePort();
  const { child, health } = await startDemo(port);
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    assert.equal(res.status, 200, `GET ${p}`);
    return res.json();
  };
  try {
    assert.equal(health.seededRun, 'web-demo-seam', 'health names the seeded run so a walkthrough can find it');
    const { run } = await get(`/api/runs/${health.seededRun}`);

    // It is a REVIEWABLE run: three clips on disk and a master to play them from. Without this the
    // review stage never mounts and none of the WS2 surfaces exist to be walked.
    assert.equal(run.status, 'review');
    assert.deepEqual(run.latestRender.jobs.map((j) => j.jobId), ['K1', 'K2', 'K3']);
    assert.ok(run.latestRender.jobs.every((j) => j.clipUrl), 'every segment has a playable clip');
    assert.ok(run.latestRender.masterUrl, 'the cut has a master');

    // The point of the fixture, read back through the same rule the review page draws from: K2 was
    // re-rendered under K3, so K2's own join holds and the one after it is broken. A seed that
    // drifted into an all-intact chain would still look fine on screen and quietly stop
    // demonstrating anything.
    assert.deepEqual(
      run.continuity.map((c) => [c.jobId, c.continuesFromPrev, c.reason]),
      [['K1', false, 'no-prev'], ['K2', true, 'source-matches'], ['K3', false, 'source-replaced']],
    );
    assert.ok(run.continuity.every((c) => c.confidence === 'recorded'), 'recorded lineage, not a reconstruction');
    // Ids only — the same contract every serialized run keeps.
    assert.ok(!JSON.stringify(run.continuity).includes('/'), 'no filesystem path reaches the client');

    // The prompt sheet has something to show for every segment, and K2 — the re-rendered one — can
    // be read back as it was sent in BOTH takes, which is what makes the version picker demoable.
    const prompts = await get(`/api/runs/${health.seededRun}/prompts`);
    assert.deepEqual(prompts.jobs, ['K1', 'K2', 'K3']);
    assert.ok(prompts.prompts.every((p) => p.bytes > 0 && p.maxBytes > 0), 'each prompt is metered');
    assert.deepEqual(prompts.prompts.find((p) => p.jobId === 'K2').availableTakes, ['t2', 't1']);
    const sent = await get(`/api/runs/${health.seededRun}/prompt?job=K2&take=t1`);
    assert.equal(sent.source, 'take');
    assert.ok(sent.prompt.length > 0);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});

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
