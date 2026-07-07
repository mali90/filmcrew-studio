// npm mechanics for the web app's one-click provider-CLI install. Kept out of the route so the route
// stays thin and server.js can share the PATH plumbing. We install to npm's STANDARD global location
// (no --prefix): the CLI then lands on the user's normal PATH so the interactive `claude`/`codex login`
// step works in their own terminal too. If the global folder isn't writable (EACCES) we don't escalate
// — the UI shows the manual command with a sudo note.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
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

/** Anthropic's official native Claude Code installer — its recommended install (bundles its own
 *  runtime, auto-updates, avoids npm global-permission/sudo issues; releases ship a GPG-signed
 *  manifest with SHA256 per binary). Only Claude ships one; other providers install via npm. Returns
 *  null for providers without a native installer. FILMCREW_INSTALL_SH injects a fake command in tests
 *  so CI never runs the real curl|bash. */
export function nativeInstallSpec(provider) {
  if (provider !== 'claude') return null;
  if (process.platform === 'win32') {
    const cmd = 'irm https://claude.ai/install.ps1 | iex';
    return { file: 'powershell', args: ['-NoProfile', '-Command', cmd], shell: false, display: cmd };
  }
  const display = 'curl -fsSL https://claude.ai/install.sh | bash';
  return { file: 'sh', args: ['-c', process.env.FILMCREW_INSTALL_SH || display], shell: false, display };
}

/** Where the native installer drops `claude` (`~/.local/bin`). */
export const localBinDir = () => path.join(os.homedir(), '.local', 'bin');

/** Prepend `~/.local/bin` to a PATH so the post-install probe + CLI-login validation find a natively
 *  installed CLI without a server restart. No-op if already present. */
export function pathWithLocalBin(pathStr) {
  const dir = localBinDir();
  const base = pathStr || '';
  if (base.split(path.delimiter).includes(dir)) return base;
  return `${dir}${path.delimiter}${base}`;
}

/** Turn a native-installer failure (exit code + tail of output) into one actionable sentence. */
export function nativeFailureHint(code, tail) {
  const t = String(tail || '');
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|could not resolve|curl/i.test(t)) {
    return 'The download failed — https://claude.ai was unreachable. Check your connection and try again.';
  }
  return `The installer exited with code ${code}. See the log above, or run the shown command in a terminal.`;
}

// Standard dirs where user-installed tools (ffmpeg via Homebrew, etc.) live but which a GUI/launchd-
// spawned server's PATH often omits — Apple Silicon Homebrew's /opt/homebrew/bin especially. Prepend the
// ones that EXIST and aren't already present, so the health check AND the render pipeline find brew-
// installed ffmpeg even when the server booted without brew's shellenv. `dirs` is injectable for tests.
export const SYSTEM_BIN_DIRS = process.platform === 'win32'
  ? []
  : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', path.join(os.homedir(), '.local', 'bin')];
export function pathWithSystemBins(pathStr, dirs = SYSTEM_BIN_DIRS) {
  const base = (pathStr || '').split(path.delimiter).filter(Boolean);
  const add = dirs.filter((d) => !base.includes(d) && existsSync(d));
  return [...add, ...base].join(path.delimiter);
}

export default { npmBin, npmNeedsShell, npmInstallArgs, npmGlobalBinDir, pathWithNpmGlobal, npmFailureHint, nativeInstallSpec, localBinDir, pathWithLocalBin, nativeFailureHint, SYSTEM_BIN_DIRS, pathWithSystemBins };
