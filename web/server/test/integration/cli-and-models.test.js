// The provider-CLI + model-list routes: cli-status (probe via a fake `claude` on PATH), models
// (curated + degradation reasons), and install-cli (NDJSON stream over a fake npm). No real network
// or real global install — everything is shimmed. POSIX-only shims (server CI is POSIX).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildApp } = await import('../../app.js');

const isWin = process.platform === 'win32';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-cli-'));
const binDir = path.join(tmpRoot, 'bin');
const envRoot = path.join(tmpRoot, 'envroot');
for (const d of [binDir, envRoot, path.join(tmpRoot, 'runs'), path.join(tmpRoot, 'out')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(envRoot, '.env'), '# isolated test env — no keys\n');

const shim = (name, body) => {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, `${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
};
// a fake `claude` CLI so cli-status sees it installed with a known version
shim('claude', '#!/bin/sh\necho "claude-test 9.9.9"\nexit 0');
// fake npm: `prefix -g` returns tmpRoot (→ global bin resolves to binDir); install prints then exits
const fakeNpmOk = shim('fake-npm-ok', `#!/bin/sh\nif [ "$1" = "prefix" ]; then echo "${tmpRoot}"; exit 0; fi\necho "npm: reticulating splines"\necho "added 1 package in 2s"\nexit 0`);
const fakeNpmFail = shim('fake-npm-fail', `#!/bin/sh\nif [ "$1" = "prefix" ]; then echo "${tmpRoot}"; exit 0; fi\necho "npm ERR! code EACCES: permission denied" 1>&2\nexit 1`);

process.env.FILMCREW_NPM_BIN = fakeNpmOk; // the install route reads this from the server process env

const childEnv = { HOME: process.env.HOME, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli' };
const app = await buildApp({ root: HOST_ROOT, runsDir: path.join(tmpRoot, 'runs'), outDir: path.join(tmpRoot, 'out'), childEnv, envRoot });
test.after(async () => { await app.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); delete process.env.FILMCREW_NPM_BIN; });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const ndjson = (body) => body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('cli-status: the shimmed provider reads as installed with its version', async () => {
  const res = await get('/api/setup/cli-status?provider=claude');
  assert.equal(res.statusCode, 200, res.body);
  const s = res.json();
  assert.equal(s.provider, 'claude');
  assert.equal(s.bin, 'claude');
  assert.equal(s.npmPackage, '@anthropic-ai/claude-code');
  assert.equal(s.installed, true);
  assert.match(s.version, /9\.9\.9/);
  assert.equal(s.installMethod, 'native'); // Claude installs via the official native script, not npm
  assert.match(s.installCmd, /claude\.ai\/install\.(sh|ps1)/);
});

test('cli-status: no param lists all four providers; unknown provider → 400', async () => {
  const all = (await get('/api/setup/cli-status')).json();
  assert.equal(all.providers.length, 4);
  assert.equal(all.providers.find((p) => p.provider === 'claude').installed, true);
  assert.equal((await get('/api/setup/cli-status?provider=bogus')).statusCode, 400);
});

test('models: copilot has no live API — curated only + cli-only', async () => {
  const m = (await get('/api/setup/models?provider=copilot')).json();
  assert.equal(m.default, '');
  assert.ok(m.options.some((o) => o.id === 'claude-sonnet-4.5'));
  assert.equal(m.live, null);
  assert.equal(m.liveError, 'cli-only');
});

test('models: no key → curated default + options, liveError no-key', async () => {
  const m = (await get('/api/setup/models?provider=claude')).json();
  assert.equal(m.default, 'claude-opus-4-8');
  assert.ok(m.options.some((o) => o.id === 'claude-sonnet-5'));
  assert.equal(m.live, null);
  assert.equal(m.liveError, 'no-key');
  assert.equal((await get('/api/setup/models?provider=bogus')).statusCode, 400);
});

test('install-cli (npm provider): streams start → log → done over a fake npm (exit 0)', { skip: isWin ? 'POSIX shims' : false }, async () => {
  process.env.FILMCREW_NPM_BIN = fakeNpmOk;
  const res = await post('/api/setup/install-cli', { provider: 'gemini' });
  assert.equal(res.statusCode, 200, res.body);
  const events = ndjson(res.body);
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].pkg, '@google/gemini-cli');
  assert.ok(events.some((e) => e.type === 'log'), 'streamed at least one log line');
  const last = events.at(-1);
  assert.equal(last.type, 'done');
  assert.equal(last.ok, true);
});

test('install-cli (npm provider): a failing npm yields a terminal error with an actionable hint', { skip: isWin ? 'POSIX shims' : false }, async () => {
  process.env.FILMCREW_NPM_BIN = fakeNpmFail;
  const res = await post('/api/setup/install-cli', { provider: 'gemini' });
  const last = ndjson(res.body).at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.ok, false);
  assert.match(last.hint, /permission|terminal|npm/i);
});

test('install-cli (native): Claude uses the official installer, not npm — streams start → done', { skip: isWin ? 'POSIX shims' : false }, async () => {
  process.env.FILMCREW_INSTALL_SH = 'echo "downloading claude"; echo "installed"'; // fake the curl|bash so CI never hits the network
  const res = await post('/api/setup/install-cli', { provider: 'claude' });
  assert.equal(res.statusCode, 200, res.body);
  const events = ndjson(res.body);
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(events[0].pkg, undefined, 'the native path carries no npm package');
  assert.ok(events.some((e) => e.type === 'log'), 'streamed installer output');
  const last = events.at(-1);
  assert.equal(last.type, 'done');
  assert.equal(last.ok, true);
  delete process.env.FILMCREW_INSTALL_SH;
});

test('install-cli (native): a failing installer yields a terminal error with a hint', { skip: isWin ? 'POSIX shims' : false }, async () => {
  process.env.FILMCREW_INSTALL_SH = 'echo "boom" 1>&2; exit 1';
  const res = await post('/api/setup/install-cli', { provider: 'claude' });
  const last = ndjson(res.body).at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.ok, false);
  assert.match(last.hint, /terminal|installer|connection/i);
  delete process.env.FILMCREW_INSTALL_SH;
});

test('install-cli: unknown provider → 400 before any spawn', async () => {
  assert.equal((await post('/api/setup/install-cli', { provider: 'bogus' })).statusCode, 400);
});
