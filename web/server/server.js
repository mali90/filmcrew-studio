#!/usr/bin/env node
// Entry point: serve the API + the built UI on one localhost port.
//   node web/server/server.js            (or: npm run web  from the repo root)
//   WEB_PORT=5177 node web/server/server.js
// Children (engine/render/doctor CLIs) are spawned with a MINIMAL env so they read the repo's
// .env fresh on every job — that is how settings changes apply without restarting the server.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathWithNpmGlobal, pathWithSystemBins } from '../../src/lib/cli-install.js';

// a fresh clone hasn't installed the server workspace yet — fail with the fix, not a stack trace
let buildApp;
try {
  ({ buildApp } = await import('./app.js'));
} catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('\nThe web server needs its dependencies installed first:\n\n  npm run web:install\n\n(then re-run: npm run web)\n');
    console.error(`  underlying error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PORT = Number(process.env.WEB_PORT) || 5177;

// Put npm's global bin dir AND the standard system tool dirs (Homebrew's /opt/homebrew/bin, /usr/local/bin,
// ~/.local/bin) on the children's PATH, so a provider CLI installed from the UI (npm install -g) and a
// Homebrew-installed ffmpeg are found by the next spawned child — doctor, engine, render/stitch — even when
// the server booted from a GUI/launchd context without brew's shellenv. Resolved once here.
const childPath = pathWithSystemBins(await pathWithNpmGlobal(process.env.PATH));

const app = await buildApp({
  root: ROOT,
  runsDir: process.env.RUNS_DIR ? path.resolve(ROOT, process.env.RUNS_DIR) : path.join(ROOT, 'runs'),
  outDir: process.env.OUT_DIR ? path.resolve(ROOT, process.env.OUT_DIR) : path.join(ROOT, 'out'),
  // USER/LOGNAME matter: on macOS the `claude` CLI keeps its login in the Keychain, and the
  // Security framework needs the user identity — without USER a spawned child sees "Not logged in".
  childEnv: {
    PATH: childPath, HOME: process.env.HOME, USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '',
    TERM: process.env.TERM ?? '', TMPDIR: process.env.TMPDIR ?? '',
  },
  uiDist: path.join(HERE, '../ui/dist'),
  logger: process.env.LOG_LEVEL === 'debug',
  lifecycle: {
    async quit() {
      console.error('\nQuit requested from the UI — shutting down…');
      await appRef.close();
      process.exit(0);
    },
    async restart() {
      console.error('\nRestart requested from the UI — respawning…');
      await appRef.close(); // release the port before the successor binds it
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true, stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, WEB_NO_OPEN: '1' },
      });
      child.unref();
      process.exit(0);
    },
  },
});
const appRef = app;

const close = async (signal) => {
  console.error(`\n${signal} — shutting down (children get 5s to stop)…`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => close('SIGINT'));
process.on('SIGTERM', () => close('SIGTERM'));

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\n✗ Port ${PORT} is already in use — the studio is probably already running.\n` +
      `  Open it:            http://127.0.0.1:${PORT}\n` +
      `  Stop it in the app: Settings → Application → Shut down\n` +
      `  Or from here:       lsof -ti :${PORT} | xargs kill\n` +
      `  (A different port:  WEB_PORT=5180 npm run web)`,
    );
    process.exit(1);
  }
  throw e;
}
const url = `http://127.0.0.1:${PORT}`;
console.error(`\n▶ Filmcrew Studio web — ${url}\n  (UI dev mode: npm --prefix web/ui run dev — proxies to this port)`);

// Open the browser when started from a real terminal. Piped/CI runs (tests, supervisors) have no
// TTY and stay headless; WEB_NO_OPEN=1 opts out explicitly.
if (process.stderr.isTTY && !process.env.WEB_NO_OPEN) {
  const opener = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* headless box */ }
}
