import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { nativeInstallSpec, pathWithLocalBin, localBinDir, pathWithSystemBins } from '../../src/lib/cli-install.js';

test('nativeInstallSpec: Claude → the official native installer; other providers → null', () => {
  const claude = nativeInstallSpec('claude');
  assert.ok(claude, 'claude has a native installer');
  assert.match(claude.display, /claude\.ai\/install\.(sh|ps1)/);
  if (process.platform === 'win32') {
    assert.equal(claude.file, 'powershell');
  } else {
    assert.equal(claude.file, 'sh');
    assert.equal(claude.args[0], '-c');
    assert.equal(claude.display, 'curl -fsSL https://claude.ai/install.sh | bash');
  }
  assert.equal(nativeInstallSpec('openai'), null);
  assert.equal(nativeInstallSpec('gemini'), null);
  assert.equal(nativeInstallSpec('copilot'), null);
});

test('nativeInstallSpec: FILMCREW_INSTALL_SH overrides the RUN command, not the DISPLAYED one', { skip: process.platform === 'win32' ? 'POSIX only' : false }, () => {
  const prev = process.env.FILMCREW_INSTALL_SH;
  process.env.FILMCREW_INSTALL_SH = 'echo hi';
  try {
    const s = nativeInstallSpec('claude');
    assert.equal(s.args[1], 'echo hi', 'runs the injected fake command (keeps CI off the network)');
    assert.equal(s.display, 'curl -fsSL https://claude.ai/install.sh | bash', 'still shows the real command');
  } finally {
    if (prev === undefined) delete process.env.FILMCREW_INSTALL_SH; else process.env.FILMCREW_INSTALL_SH = prev;
  }
});

test('pathWithLocalBin prepends ~/.local/bin exactly once (idempotent)', () => {
  const dir = localBinDir();
  assert.equal(dir, path.join(os.homedir(), '.local', 'bin'));
  const out = pathWithLocalBin('/usr/bin');
  assert.equal(out, `${dir}${path.delimiter}/usr/bin`);
  assert.equal(pathWithLocalBin(out), out, 'already present → no duplicate');
});

test('pathWithSystemBins prepends existing tool dirs, skips missing + already-present (idempotent)', () => {
  const real = os.tmpdir(); // guaranteed to exist — stands in for /opt/homebrew/bin
  const out = pathWithSystemBins('/usr/bin', [real, '/no/such/dir-xyz-123', '/usr/bin']);
  assert.equal(out, `${real}${path.delimiter}/usr/bin`); // existing prepended; missing + already-present skipped
  assert.equal(pathWithSystemBins(out, [real]), out, 'already present → no duplicate (idempotent)');
});
