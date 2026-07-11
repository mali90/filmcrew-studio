// Environments: a descriptive-only world/mood/style bible (environments/<slug>.md), selectable per
// idea. CRUD parity with cast profiles, run-creation threading (validate before spend, record on
// manifest + spec), and the bundled sample. All roots are isolated tmp dirs — the real repo's
// environments/ is only ever READ (never written) by the one bundled-sample case.
//
// TDD (red first): the /api/environments route, ctx.environmentsDir plumbing, run threading and the
// bundled sample do not exist yet — these tests pin the contract the implementation must satisfy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildApp } = await import('../../app.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-'));
const dirs = {
  runs: path.join(tmpRoot, 'runs'),
  out: path.join(tmpRoot, 'out'),
  profiles: path.join(tmpRoot, 'profiles'),
  elements: path.join(tmpRoot, 'elements'),
  voices: path.join(tmpRoot, 'voices'),
  environments: path.join(tmpRoot, 'environments'),
};
const FAKE = path.join(HOST_ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);

const app = await buildApp({
  root: HOST_ROOT,
  runsDir: dirs.runs,
  outDir: dirs.out,
  profilesDir: dirs.profiles,
  elementsRoot: dirs.elements,
  voicesFile: path.join(dirs.voices, 'voices.json'),
  environmentsDir: dirs.environments,
  childEnv: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
  },
});

test.after(async () => { await app.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: 'GET', url });
const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const put = (url, payload) => app.inject({ method: 'PUT', url, payload });
const del = (url) => app.inject({ method: 'DELETE', url });

/** Poll a run to plan-ready (fake LLM converges the golden spec fast). */
async function waitPlanReady(runId) {
  for (let t = 0; ; t += 150) {
    const run = (await get(`/api/runs/${runId}`)).json().run;
    if (run.status === 'plan-ready') return run;
    if (run.status === 'attention') assert.fail(`plan failed: ${JSON.stringify(run.error)}`);
    if (t > 60000) assert.fail(`timeout (last status: ${run.status})`);
    await sleep(150);
  }
}

// ── The route is config-free (the demo/e2e leak canary, enforced at the source level) ──
test('the environments route statically imports ONLY node:fs and node:path (config-free)', () => {
  const src = fs.readFileSync(path.join(HOST_ROOT, 'web/server/routes/environments.js'), 'utf8');
  const specifiers = [...src.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, 'the route module has static imports to inspect');
  for (const spec of specifiers) {
    assert.ok(
      spec === 'node:fs' || spec === 'node:path',
      `only node:fs / node:path may be statically imported (host lib is dynamic-imported via app.ctx.root); found: ${spec}`,
    );
  }
});

// ── CRUD (ST1) ──
test('CRUD: create → list/read, 409 duplicate, 400 bad/empty name', async () => {
  const created = await post('/api/environments', { name: 'Neon City', description: 'Rain-slicked neon streets at 3am.' });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().slug, 'neon-city');
  assert.ok(fs.existsSync(path.join(dirs.environments, 'neon-city.md')), 'the same artifact a CLI user would hand-write');

  const list = (await get('/api/environments')).json().environments;
  const neon = list.find((e) => e.slug === 'neon-city');
  assert.ok(neon, 'the new environment is listed');
  assert.equal(neon.name, 'Neon City', 'name = the first # heading');
  assert.match(neon.description, /Rain-slicked neon streets/, 'description = the full markdown body');

  // slug-insensitive uniqueness, and bad/empty names are rejected before anything is written
  assert.equal((await post('/api/environments', { name: 'neon city' })).statusCode, 409, 'slug-insensitive uniqueness');
  assert.equal((await post('/api/environments', { name: '../evil' })).statusCode, 400);
  assert.equal((await post('/api/environments', { name: '' })).statusCode, 400);
});

test('PUT updates the description but keeps the name/heading immutable; DELETE removes the file', async () => {
  await post('/api/environments', { name: 'Foghold', description: 'Grey harbour, foghorns, wet cobbles.' });

  const updated = await put('/api/environments/foghold', { description: 'Now the fog lifts at noon.' });
  assert.equal(updated.statusCode, 200, updated.body);
  const view = (await get('/api/environments')).json().environments.find((e) => e.slug === 'foghold');
  assert.match(view.description, /the fog lifts at noon/);
  assert.equal(view.name, 'Foghold', 'the display name survives a description-only update');

  // PUT is idempotent — saving from the editor must not grow one "# Foghold" heading per save
  const onDisk = fs.readFileSync(path.join(dirs.environments, 'foghold.md'), 'utf8');
  assert.equal((onDisk.match(/^# Foghold$/gm) ?? []).length, 1, `PUT doubled the heading:\n${onDisk}`);

  const gone = await del('/api/environments/foghold');
  assert.equal(gone.statusCode, 200, gone.body);
  assert.equal(gone.json().deleted, 'foghold');
  assert.ok(!fs.existsSync(path.join(dirs.environments, 'foghold.md')), 'the file is removed');
  assert.equal((await put('/api/environments/foghold', { description: 'x' })).statusCode, 404, '404 after delete');
  assert.equal((await del('/api/environments/foghold')).statusCode, 404);
});

test('empty description is allowed (name-only create) — the card nudges, the API does not reject', async () => {
  const created = await post('/api/environments', { name: 'Bare Room' });
  assert.equal(created.statusCode, 201, created.body);
  const view = (await get('/api/environments')).json().environments.find((e) => e.slug === 'bare-room');
  assert.equal(view.name, 'Bare Room');
  // description holds just the heading (no body) — the UI shows the warn-coloured "no description"
  assert.doesNotMatch(view.description.replace(/^#.*$/m, '').trim(), /\S/, 'no body beyond the heading');
  await del('/api/environments/bare-room');
});

// ── Run-creation threading (ST3): validate before spend, record on manifest + spec ──
test('POST /api/runs with a valid environment records it on the manifest AND the stamped spec', async () => {
  await post('/api/environments', { name: 'Skyline', description: 'Chrome towers, sodium haze.' });

  const res = await post('/api/runs', { idea: 'a courier races the last train', backend: 'kling', aspect: '9:16', durationS: null, environment: 'skyline' });
  assert.equal(res.statusCode, 201, res.body);
  const run = await waitPlanReady(res.json().runId);
  assert.equal(run.manifest.environment, 'skyline', 'the manifest remembers the selected environment');
  assert.equal(run.spec.environment, 'skyline', 'the engine stamped spec.environment (revisions can re-inject it)');
});

test('POST /api/runs with an unknown environment is rejected 400 BEFORE any LLM spend', async () => {
  const res = await post('/api/runs', { idea: 'x', backend: 'kling', aspect: '9:16', durationS: null, environment: 'atlantis' });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().hint, /Cast page/i, 'the hint points the user at creating it first');
});

test('environment + cast selected together: BOTH land on the manifest and the spec', async () => {
  await post('/api/cast/profiles', { name: 'Runner' });
  await post('/api/environments', { name: 'Backlot', description: 'Wet asphalt, flickering signage.' });

  const res = await post('/api/runs', { idea: 'the runner at midnight', backend: 'kling', aspect: '9:16', durationS: null, cast: ['runner'], environment: 'backlot' });
  assert.equal(res.statusCode, 201, res.body);
  const run = await waitPlanReady(res.json().runId);
  assert.deepEqual(run.manifest.cast, ['runner']);
  assert.equal(run.manifest.environment, 'backlot');
  assert.deepEqual(run.spec.cast, ['runner']);
  assert.equal(run.spec.environment, 'backlot');
});

test('subtle coupling: Seedance + no cast + no refs + environment STILL plans as text-to-video (never flips render mode)', async () => {
  // The isolated elements dir is empty ⇒ refCount 0; no cast ⇒ Casting has nothing to attach. An
  // environment carries NO reference image, so this must stay a text-to-video plan and NOT error.
  await post('/api/environments', { name: 'Undercity', description: 'Neon-lit tunnels, no daylight.' });
  const res = await post('/api/runs', { idea: 'a drone drifts through the undercity', backend: 'seedance', aspect: '9:16', durationS: null, environment: 'undercity' });
  assert.equal(res.statusCode, 201, res.body);
  const run = await waitPlanReady(res.json().runId);
  assert.equal(run.spec.render_backend, 'seedance', 'it planned for seedance and did not fall back');
  assert.equal(run.spec.environment, 'undercity', 'the environment enriched the t2v prompt and was stamped');
});

// ── Single-select enforcement (ST3 edge): the API is the last line of defence for "exactly one" ──
test('POST /api/runs rejects a non-string or empty environment (single-select is enforced server-side)', async () => {
  // an array is a multi-select attempt (the model is exactly ONE world bible per idea) — reject it
  // BEFORE any run dir is created, so no half-planned run leaks; an empty string is rejected too.
  const asArray = await post('/api/runs', { idea: 'x', backend: 'kling', aspect: '9:16', durationS: null, environment: ['neon-city', 'skyline'] });
  assert.equal(asArray.statusCode, 400, asArray.body);
  assert.match(asArray.json().error, /single environment/i);
  const asEmpty = await post('/api/runs', { idea: 'x', backend: 'kling', aspect: '9:16', durationS: null, environment: '' });
  assert.equal(asEmpty.statusCode, 400, asEmpty.body);
  assert.match(asEmpty.json().error, /single environment/i);
});

test('POST /api/runs accepts an environment DISPLAY NAME and threads the NORMALISED slug (not the raw name)', async () => {
  // the guard slug-normalises exactly as the engine will, so a client that sends "Rooftop Bar" (a
  // name, not a slug) still resolves to environments/rooftop-bar.md — and the slug, never the raw
  // display name, is what lands on the manifest and the spec (parity across web + CLI artifacts).
  await post('/api/environments', { name: 'Rooftop Bar', description: 'Neon skyline, warm bulbs, city hum.' });
  const res = await post('/api/runs', { idea: 'a toast above the city', backend: 'kling', aspect: '9:16', durationS: null, environment: 'Rooftop Bar' });
  assert.equal(res.statusCode, 201, res.body);
  const run = await waitPlanReady(res.json().runId);
  assert.equal(run.manifest.environment, 'rooftop-bar', 'the manifest stores the slug, not "Rooftop Bar"');
  assert.equal(run.spec.environment, 'rooftop-bar', 'the stamped spec carries the same normalised slug');
});

// ── Path-traversal defence on the :slug route param (envPath's SLUG_FILE guard, ST1 edge) ──
test('PUT/DELETE reject a non-slug :slug param with 400 before touching disk (path-traversal defence)', async () => {
  // an uppercase/underscore segment can never be a real environments/<slug>.md id — the guard rejects
  // it up front (400 "not an environment id"), never letting a crafted param reach path.join on disk.
  const badPut = await put('/api/environments/Not_A_Slug', { description: 'x' });
  assert.equal(badPut.statusCode, 400, badPut.body);
  assert.match(badPut.json().error, /not an environment id/i);
  assert.equal((await del('/api/environments/Not_A_Slug')).statusCode, 400);
});

// ── Bundled sample (ST4): the real repo's environments/ ships at least one discoverable sample ──
test('the bundled sample environment loads from the repo environments/ dir (Home "Set in" is never empty on first run)', async () => {
  const sampleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-sample-'));
  const real = await buildApp({
    root: HOST_ROOT,
    runsDir: path.join(sampleRoot, 'runs'),
    outDir: path.join(sampleRoot, 'out'),
    environmentsDir: path.join(HOST_ROOT, 'environments'), // the committed, shipped dir
    childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  try {
    const list = (await real.inject({ method: 'GET', url: '/api/environments' })).json().environments;
    assert.ok(Array.isArray(list) && list.length >= 1, 'the repo ships at least one sample environment');
    const sample = list.find((e) => e.name && e.description && e.description.replace(/^#.*$/m, '').trim().length > 20);
    assert.ok(sample, 'a shipped sample has a display name and a meaningful (non-empty) description');
  } finally {
    await real.close();
    fs.rmSync(sampleRoot, { recursive: true, force: true });
  }
});

// ── Codex cross-review regressions (P2s, both confirmed) ────────────────────────────────────────

// A hand-authored file whose NAME isn't canonical ("Rain_City.md") is listed under its slug
// ("rain-city") — the engine's loadEnvironment slug-maps it, so the API and the run guard must
// resolve it the same way, or a listed environment can't be edited, deleted, or planned with.
test('a hand-authored non-canonical filename round-trips: list → edit → run → delete by its slug', async () => {
  fs.mkdirSync(dirs.environments, { recursive: true });
  const handFile = path.join(dirs.environments, 'Rain_City.md');
  fs.writeFileSync(handFile, '# Rain City\n\nA drowned town where it never stops raining.\n');
  try {
    const list = (await get('/api/environments')).json().environments;
    const listed = list.find((e) => e.slug === 'rain-city');
    assert.ok(listed, 'hand-authored file is listed under its normalised slug');

    // edit by the listed slug — must hit the ACTUAL file, keeping its heading
    const up = await put('/api/environments/rain-city', { description: 'Now with thunder.' });
    assert.equal(up.statusCode, 200);
    assert.match(fs.readFileSync(handFile, 'utf8'), /^# Rain City\n\nNow with thunder\.\n$/);

    // creating a name that slug-collides with the hand-authored file is a 409, not a shadow file
    const dup = await post('/api/environments', { name: 'Rain City', description: 'shadow' });
    assert.equal(dup.statusCode, 409);
    assert.ok(!fs.existsSync(path.join(dirs.environments, 'rain-city.md')), 'no duplicate-slug file created');

    // the run guard accepts it AND the engine plans with it (loadEnvironment slug-maps identically)
    const run = post('/api/runs', { idea: 'a storm rolls in', backend: 'kling', aspect: '9:16', durationS: null, environment: 'rain-city' });
    assert.equal((await run).statusCode, 201);
    const ready = await waitPlanReady((await run).json().runId);
    assert.equal(ready.manifest.environment, 'rain-city');
    assert.equal(ready.spec.environment, 'rain-city');

    // delete by the listed slug removes the actual file
    const rm = await del('/api/environments/rain-city');
    assert.equal(rm.statusCode, 200);
    assert.ok(!fs.existsSync(handFile));
  } finally {
    fs.rmSync(handFile, { force: true });
  }
});

// The server process never loads .env, but engine children re-read it fresh — so childEnv must
// ALWAYS pin ENVIRONMENTS_DIR (even at the default dir), or an .env override would steer children
// to a different dir than the API lists/validates and every "Set in" run would 400 as unknown.
test('childEnv always pins ENVIRONMENTS_DIR so the API and engine children agree regardless of .env', async () => {
  assert.equal(app.ctx.childEnv.ENVIRONMENTS_DIR, dirs.environments); // isolated app: pinned

  const defRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-default-'));
  const def = await buildApp({
    root: HOST_ROOT,
    runsDir: path.join(defRoot, 'runs'),
    outDir: path.join(defRoot, 'out'),
    envRoot: defRoot, // no .env in here — a developer's real repo .env must not steer this test
    childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  try {
    assert.equal(def.ctx.childEnv.ENVIRONMENTS_DIR, path.resolve(HOST_ROOT, 'environments')); // default dir: STILL pinned
  } finally {
    await def.close();
    fs.rmSync(defRoot, { recursive: true, force: true });
  }
});

// Two files that NORMALIZE to the same slug must collapse to the engine's winner everywhere:
// loadEnvironment builds a Map over sorted files (last set wins), so the API must list ONE card
// and edit/delete that same file — never .find()'s first match while the engine plans with the last.
test('duplicate-normalizing filenames collapse to the engine\'s (last-sorted) winner in list and CRUD', async () => {
  fs.mkdirSync(dirs.environments, { recursive: true });
  const loser = path.join(dirs.environments, 'Rain_City.md');   // sorts first ("R" < "r") — engine ignores it
  const winner = path.join(dirs.environments, 'rain-city.md');  // sorts last — engine loads THIS one
  fs.writeFileSync(loser, '# Rain City\n\nThe loser copy.\n');
  fs.writeFileSync(winner, '# Rain City\n\nThe winner copy.\n');
  try {
    const list = (await get('/api/environments')).json().environments;
    const cards = list.filter((e) => e.slug === 'rain-city');
    assert.equal(cards.length, 1, 'one card per slug, never duplicate-key cards');
    assert.match(cards[0].description, /winner copy/, 'the listed card is the engine\'s winner');

    const up = await put('/api/environments/rain-city', { description: 'Edited.' });
    assert.equal(up.statusCode, 200);
    assert.match(fs.readFileSync(winner, 'utf8'), /Edited\./, 'PUT edits the engine\'s winner');
    assert.match(fs.readFileSync(loser, 'utf8'), /loser copy/, 'the shadowed file is untouched');

    // DELETE removes EVERY file behind the slug — a shadowed copy must not resurrect it on next list
    const rm = await del('/api/environments/rain-city');
    assert.equal(rm.statusCode, 200);
    assert.ok(!fs.existsSync(winner) && !fs.existsSync(loser), 'both slug-collapsed files are gone');
    const after = (await get('/api/environments')).json().environments;
    assert.ok(!after.some((e) => e.slug === 'rain-city'), 'the slug no longer lists');
  } finally {
    fs.rmSync(loser, { force: true });
    fs.rmSync(winner, { force: true });
  }
});

// The documented override: launching the server with ENVIRONMENTS_DIR in its own env must steer
// the API (and, via the always-pin, the children) to that dir — param (demo/tests) still wins.
test('buildApp honors a process-env ENVIRONMENTS_DIR when no explicit param overrides it', async () => {
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-envvar-'));
  process.env.ENVIRONMENTS_DIR = envDir;
  try {
    const viaEnv = await buildApp({
      root: HOST_ROOT,
      runsDir: path.join(envDir, 'runs'),
      outDir: path.join(envDir, 'out'),
      childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    try {
      assert.equal(viaEnv.ctx.environmentsDir, path.resolve(envDir));
      assert.equal(viaEnv.ctx.childEnv.ENVIRONMENTS_DIR, path.resolve(envDir)); // children pinned to the same dir
    } finally { await viaEnv.close(); }
  } finally {
    delete process.env.ENVIRONMENTS_DIR;
    fs.rmSync(envDir, { recursive: true, force: true });
  }
});

// The project's .env (at envRoot) is the documented override channel — buildApp reads it as DATA
// (the server process still never loads .env) and steers both the API dir and the child pin.
test('buildApp honors ENVIRONMENTS_DIR from the project .env when neither param nor process env set it', async () => {
  const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-dotenv-'));
  const target = path.join(envRoot, 'worlds');
  fs.writeFileSync(path.join(envRoot, '.env'), `ENVIRONMENTS_DIR=${target}\n`);
  const viaFile = await buildApp({
    root: HOST_ROOT,
    runsDir: path.join(envRoot, 'runs'),
    outDir: path.join(envRoot, 'out'),
    envRoot,
    childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  try {
    assert.equal(viaFile.ctx.environmentsDir, path.resolve(target));
    assert.equal(viaFile.ctx.childEnv.ENVIRONMENTS_DIR, path.resolve(target)); // children pinned to it too
  } finally {
    await viaFile.close();
    fs.rmSync(envRoot, { recursive: true, force: true });
  }
});

// dotenv semantics: a QUOTED path (spaces) with a trailing comment is valid .env syntax — children
// parse it with dotenv, so buildApp's data-read must resolve the same directory, not the raw text.
test('buildApp reads a quoted/commented ENVIRONMENTS_DIR from .env with dotenv semantics', async () => {
  const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-dotenvq-'));
  const target = path.join(envRoot, 'my worlds');
  fs.writeFileSync(path.join(envRoot, '.env'), `ENVIRONMENTS_DIR="${target}" # reusable settings\n`);
  const viaFile = await buildApp({
    root: HOST_ROOT,
    runsDir: path.join(envRoot, 'runs'),
    outDir: path.join(envRoot, 'out'),
    envRoot,
    childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  try {
    assert.equal(viaFile.ctx.environmentsDir, path.resolve(target), 'quotes stripped, comment dropped');
    assert.equal(viaFile.ctx.childEnv.ENVIRONMENTS_DIR, path.resolve(target));
  } finally {
    await viaFile.close();
    fs.rmSync(envRoot, { recursive: true, force: true });
  }
});

// dotenv ends an unquoted value at the FIRST '#' even with no whitespace before it —
// `ENVIRONMENTS_DIR=./worlds#local` must resolve "./worlds", exactly as children will read it.
test('buildApp cuts an unspaced dotenv comment from the .env ENVIRONMENTS_DIR value', async () => {
  const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-dotenvh-'));
  fs.writeFileSync(path.join(envRoot, '.env'), 'ENVIRONMENTS_DIR=./worlds#local\n');
  const viaFile = await buildApp({
    root: HOST_ROOT,
    runsDir: path.join(envRoot, 'runs'),
    outDir: path.join(envRoot, 'out'),
    envRoot,
    childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  try {
    assert.equal(viaFile.ctx.environmentsDir, path.resolve(HOST_ROOT, './worlds'), 'the unspaced #comment is not part of the path');
  } finally {
    await viaFile.close();
    fs.rmSync(envRoot, { recursive: true, force: true });
  }
});

// dotenv precedence: when .env assigns ENVIRONMENTS_DIR twice, the LAST assignment wins — a
// directly-invoked engine (dotenv) and the web server must land on the same directory.
test('buildApp honors the LAST .env ENVIRONMENTS_DIR assignment, like dotenv', async () => {
  const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-dotenvl-'));
  fs.writeFileSync(path.join(envRoot, '.env'), 'ENVIRONMENTS_DIR=./stale\nENVIRONMENTS_DIR=./current\n');
  const viaFile = await buildApp({
    root: HOST_ROOT,
    runsDir: path.join(envRoot, 'runs'),
    outDir: path.join(envRoot, 'out'),
    envRoot,
    childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  try {
    assert.equal(viaFile.ctx.environmentsDir, path.resolve(HOST_ROOT, './current'));
  } finally {
    await viaFile.close();
    fs.rmSync(envRoot, { recursive: true, force: true });
  }
});

// The reader IS dotenv now — shell-style `export KEY=value` lines (valid for dotenv) must work too.
test('buildApp reads an export-prefixed ENVIRONMENTS_DIR from .env (full dotenv grammar)', async () => {
  const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-dotenvx-'));
  fs.writeFileSync(path.join(envRoot, '.env'), 'export ENVIRONMENTS_DIR=./worlds\n');
  const viaFile = await buildApp({
    root: HOST_ROOT,
    runsDir: path.join(envRoot, 'runs'),
    outDir: path.join(envRoot, 'out'),
    envRoot,
    childEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  try {
    assert.equal(viaFile.ctx.environmentsDir, path.resolve(HOST_ROOT, './worlds'));
  } finally {
    await viaFile.close();
    fs.rmSync(envRoot, { recursive: true, force: true });
  }
});
