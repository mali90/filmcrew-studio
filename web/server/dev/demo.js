#!/usr/bin/env node
// ZERO-SPEND dev harness — the whole app drivable end-to-end for free (a dev/test tool, not a
// user-facing mode; it never produces a real video):
//   node web/server/dev/demo.js   (from the repo root)
// Boots the test-suite's mock servers for BOTH render providers — fal and Segmind (real tiny
// ffmpeg clips, so stitching and the player work) + the fake LLM (golden spec), points an isolated
// workspace (runs-demo/, out-demo/) at them, and serves the app. Playwright e2e starts and runs
// against exactly this. Every backend the UI offers must be drivable here: a Segmind entry in the
// picker with no mock behind it would reach for the vendor's live queue — hanging on a fake key,
// or billing on a real one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PORT = Number(process.env.WEB_PORT) || 5178;

const { startFalServer } = await import(path.join(ROOT, 'test/helpers/fal-server.js'));
const { startSegmindServer } = await import(path.join(ROOT, 'test/helpers/segmind-server.js'));
const { hasFfmpeg, tinyMp4Bytes } = await import(path.join(ROOT, 'test/helpers/ffmpeg-clips.js'));

const FF = await hasFfmpeg();
if (!FF) console.error('⚠ ffmpeg not found — clips will be fake bytes; stitching and playback will not work.');
const videoBytes = FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4');
const fal = await startFalServer({ videoBytes });
// Same real bytes on both providers: a Segmind-rendered demo run has to stitch and play exactly
// like a fal one, or "Segmind works end to end" is only true on paper.
const segmind = await startSegmindServer({ videoBytes });

const FAKE_LLM = path.join(ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE_LLM, 0o755);

// Isolated env root: the wizard e2e writes ITS .env here — the repo's real .env is never touched.
const envRoot = path.join(ROOT, 'runs-demo', 'env-root');
fs.mkdirSync(envRoot, { recursive: true });
fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(envRoot, '.env.example'));
const seedDemoEnv = () => fs.writeFileSync(path.join(envRoot, '.env'),
  'LLM_PROVIDER=claude\nLLM_TRANSPORT=cli\nFAL_KEY=demo-key\n');
seedDemoEnv();

// In-process validators (validate-fal / validate-llm) must hit the mock too — set BEFORE any
// lazy host-lib import snapshots config.
Object.assign(process.env, {
  FAL_BASE_URL: fal.baseUrl, FAL_CREATE_VOICE_ENDPOINT: 'create-voice',
  // Segmind is pinned here too, so any in-process code that ever reaches for the provider (a key
  // validator, a probe) lands on the mock rather than the vendor — the demo promises zero spend.
  SEGMIND_BASE_URL: segmind.baseUrl, SEGMIND_API_KEY: 'demo-key',
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE_LLM,
});

const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE_LLM, LLM_MODEL: 'fake-demo',
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'demo-key', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_STORAGE_INITIATE_URL: `${fal.baseUrl}/storage/upload/initiate`, // approve+upscale must hit the mock, never the real CDN
  FAL_KLING_ENDPOINT: 'submit', FAL_CREATE_VOICE_ENDPOINT: 'create-voice',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  FAL_SEEDANCE25_ENDPOINT: 'seedance25-submit', FAL_SEEDANCE25_PROBE_ENDPOINT: 'seedance25-probe',
  SEEDANCE_UPLOAD_MODE: 'data-uri',
  // Segmind: the second provider, mocked the same way. Slugs stay the REAL ones (the mock routes
  // any /v2/<slug>), so the demo exercises the same paths a live install posts to. data-uri uploads
  // keep the demo keyless-fal, which is also the setup docs/PROVIDERS.md tells a Segmind-only user
  // to run; MAX_RETRIES=1 matches the fal mock (a demo should never sit in a backoff loop).
  SEGMIND_BASE_URL: segmind.baseUrl, SEGMIND_API_KEY: 'demo-key',
  SEGMIND_SEEDANCE25_SLUG: 'seedance-2.5', SEGMIND_SEEDANCE20_SLUG: 'seedance-2.0',
  SEGMIND_TOPAZ_SLUG: 'topaz-video-upscale',
  SEGMIND_UPLOAD_MODE: 'data-uri', SEGMIND_MAX_RETRIES: '1',
  VIDEO_SHORT_SIDE: '270', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false', // canvas shape follows each run's aspect
  ...(process.env.FAKE_LLM_SLEEP_MS ? { FAKE_LLM_SLEEP_MS: process.env.FAKE_LLM_SLEEP_MS } : {}), // probes: hold completions open
};

const app = await buildApp({
  root: ROOT,
  runsDir: path.join(ROOT, 'runs-demo'),
  outDir: path.join(ROOT, 'out-demo'),
  envRoot,
  // the demo's cast workspace is isolated too — creating characters, uploading refs and
  // re-keying voices must never write into the real repo's profiles/, elements/ or voices/
  profilesDir: path.join(ROOT, 'runs-demo', 'cast', 'profiles'),
  environmentsDir: path.join(ROOT, 'runs-demo', 'cast', 'environments'),
  elementsRoot: path.join(ROOT, 'runs-demo', 'cast', 'elements'),
  voicesFile: path.join(ROOT, 'runs-demo', 'cast', 'voices', 'voices.json'),
  childEnv,
  uiDist: path.join(HERE, '../../ui/dist'),
});

// e2e control endpoints: flip either mock's failure modes / reset the isolated .env at runtime
app.post('/__demo/fal-opts', async (req) => { Object.assign(fal.opts, req.body ?? {}); return { opts: fal.opts }; });
app.post('/__demo/segmind-opts', async (req) => { Object.assign(segmind.opts, req.body ?? {}); return { opts: segmind.opts }; });
app.post('/__demo/env-reset', async (req) => {
  if (req.body?.complete === false) fs.rmSync(path.join(envRoot, '.env'), { force: true });
  else seedDemoEnv();
  return { complete: req.body?.complete !== false };
});
app.get('/__demo/health', async () => ({ demo: true, fal: fal.baseUrl, segmind: segmind.baseUrl }));

// Both mocks must go down with the app: a leaked listener wedges the next `npm run demo`.
process.on('SIGINT', async () => { await app.close(); await fal.close(); await segmind.close(); process.exit(0); });
process.on('SIGTERM', async () => { await app.close(); await fal.close(); await segmind.close(); process.exit(0); });

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
} catch (e) {
  await fal.close(); await segmind.close(); // never leave two orphaned mock servers behind
  if (e.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} is already in use — a demo server is probably already running at http://127.0.0.1:${PORT}\n  Stop it: lsof -ti :${PORT} | xargs kill`);
    process.exit(1);
  }
  throw e;
}
console.error(`\n▶ DEMO (zero spend) — http://127.0.0.1:${PORT}\n  mock fal: ${fal.baseUrl} · mock segmind: ${segmind.baseUrl} · fake LLM: golden spec · workspace: runs-demo/\n  Nothing here talks to real APIs or costs money.`);

// hand-driven demos open the browser too; Playwright pipes stdio (no TTY) so e2e stays headless
if (process.stderr.isTTY && !process.env.WEB_NO_OPEN) {
  const { spawn } = await import('node:child_process');
  const url = `http://127.0.0.1:${PORT}`;
  const opener = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* headless box */ }
}
