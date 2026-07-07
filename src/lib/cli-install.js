// npm mechanics for the web app's one-click provider-CLI install. Kept out of the route so the route
// stays thin and server.js can share the PATH plumbing. We install to npm's STANDARD global location
// (no --prefix): the CLI then lands on the user's normal PATH so the interactive `claude`/`codex login`
// step works in their own terminal too. If the global folder isn't writable (EACCES) we don't escalate
// — the UI shows the manual command with a sudo note.
import { spawn } from 'node:child_process';
import path from 'node:path';

/** The npm executable. Windows names it npm.cmd; FILMCREW_NPM_BIN lets tests inject a fake npm shim. */
export function npmBin() {
  return process.env.FILMCREW_NPM_BIN || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
}

/** spawn() needs a shell to launch npm.cmd on Windows (Node ≥20). Args are allowlisted constants
 *  (never user input), so shell:true here has no injection surface; POSIX stays shell:false. */
export const npmNeedsShell = () => process.platform === 'win32';

/** The global install command's args. Package comes from the trusted PROVIDER_NPM_PKG map. */
export const npmInstallArgs = (pkg) => ['install', '-g', pkg, '--no-fund', '--no-audit'];

let _globalBinDir; // resolved once: the dir npm puts `-g` binaries in, or null if npm is absent.
/** Where `npm install -g` drops binaries — `<prefix>/bin` on POSIX, `<prefix>` on Windows. Resolved
 *  by spawning `npm prefix -g` once and cached. null if npm can't be found/run. */
export async function npmGlobalBinDir() {
  if (_globalBinDir !== undefined) return _globalBinDir;
  _globalBinDir = await new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(npmBin(), ['prefix', '-g'], { stdio: ['ignore', 'pipe', 'ignore'], shell: npmNeedsShell() });
    } catch { return resolve(null); }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(null); }, 5000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(t);
      const prefix = out.trim();
      if (code !== 0 || !prefix) return resolve(null);
      resolve(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'));
    });
  });
  return _globalBinDir;
}

/** Prepend the npm global bin dir to a PATH string so spawned children (doctor, engine, the post-install
 *  re-probe) find a just-installed CLI without a server restart. No-op if unresolved or already present. */
export async function pathWithNpmGlobal(pathStr) {
  const dir = await npmGlobalBinDir();
  const base = pathStr || '';
  if (!dir || base.split(path.delimiter).includes(dir)) return base;
  return `${dir}${path.delimiter}${base}`;
}

/** Turn an npm failure (exit code + tail of output) into one actionable, plain-language sentence. */
export function npmFailureHint(code, tail) {
  const t = String(tail || '');
  if (/EACCES|EPERM|permission denied/i.test(t)) {
    return "npm couldn't write to its global folder — a permissions issue, not your fault. "
      + 'Run the command shown below in a terminal (it may need sudo), or set up a user-level npm prefix so global installs never need admin rights.';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|registry/i.test(t)) {
    return 'The download failed — the npm registry was unreachable. Check your connection and try again.';
  }
  return `npm exited with code ${code}. See the log above, or run the shown command in a terminal.`;
}

export default { npmBin, npmNeedsShell, npmInstallArgs, npmGlobalBinDir, pathWithNpmGlobal, npmFailureHint };
