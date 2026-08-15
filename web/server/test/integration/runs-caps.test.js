// POST /api/runs is the second of the three cast-cap layers (engine → server → UI) and the place
// per-model aspect ratios are enforced for the web flow. Everything here must 400 BEFORE
// svc.createRun spawns a child: a rejected request must leave no run directory and start no process.
//
// It is also where the registry's config-free promise gets its teeth: routes/runs.js may statically
// import src/lib/render-models.js (zero imports, no env) but nothing in its static graph may reach
// config.js — the same leak canary as environments.test.js, walked transitively.
//
// TDD (red first): the route validates `['kling','seedance']` and `['9:16','16:9','1:1']` with no
// cast cap and no per-model aspect list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { buildApp } = await import('../../app.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-caps-'));
const dirs = {
  runs: path.join(tmpRoot, 'runs'),
  out: path.join(tmpRoot, 'out'),
  profiles: path.join(tmpRoot, 'profiles'),
  elements: path.join(tmpRoot, 'elements'),
  voices: path.join(tmpRoot, 'voices'),
  environments: path.join(tmpRoot, 'environments'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
for (const c of ['keeper', 'gull', 'crab', 'whale', 'squid']) {
  fs.writeFileSync(path.join(dirs.profiles, `${c}.md`), `# ${c}\n\nA character.\n`);
}
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

const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const runCount = () => fs.readdirSync(dirs.runs).length;
const create = (over = {}) => post('/api/runs', {
  idea: 'a lighthouse keeper at dusk', backend: 'kling', aspect: '9:16', durationS: null, ...over,
});

// ── the config-free canary, walked transitively ─────────────────────────────
test('routes/runs.js\'s STATIC import graph never reaches config.js or dotenv', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const specifiers = [
      ...src.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*export\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (!spec.startsWith('.')) continue; // node: builtins and npm deps carry no repo config
      const resolved = path.resolve(path.dirname(file), spec);
      assert.notEqual(path.basename(resolved), 'config.js',
        `${path.relative(HOST_ROOT, file)} statically imports config.js — the demo/e2e mock would be bypassed`);
      visit(resolved);
    }
    assert.ok(!/from\s+['"]dotenv/.test(src), `${path.relative(HOST_ROOT, file)} must not load dotenv`);
  };
  visit(path.join(HOST_ROOT, 'web/server/routes/runs.js'));
  assert.ok(seen.size > 1, 'the walker actually followed relative imports');
  // and the registry IS reachable — that is the intended pattern, not an accident
  assert.ok([...seen].some((f) => f.endsWith(path.join('src', 'lib', 'render-models.js'))),
    'routes/runs.js reads the caps from the zero-import registry');
  // …and the reason that import is safe: the registry pulls in nothing at all, so it can never
  // become a back door to config.js no matter what a later edit adds to src/lib.
  const registry = fs.readFileSync(path.join(HOST_ROOT, 'src/lib/render-models.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments talk ABOUT imports
  assert.ok(!/\bfrom\s+['"]|\bimport\s*[({]|\brequire\s*\(/.test(registry),
    'src/lib/render-models.js must keep ZERO imports — that is what makes it safe to import here');
});

// ── backend ids ─────────────────────────────────────────────────────────────
test('POST /api/runs accepts legacy AND compound backend ids, rejects anything else', async () => {
  const ok = await create({ backend: 'seedance-2.0@fal', aspect: '16:9' });
  assert.equal(ok.statusCode, 201, ok.body);

  const before = runCount();
  const bad = await create({ backend: 'runway' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /runway/);
  for (const v of ['kling-o3@fal', 'seedance-2.0@fal', 'kling', 'seedance']) {
    assert.ok(JSON.stringify(bad.json()).includes(v), `the 400 names ${v} as a valid choice`);
  }
  assert.equal(runCount(), before, 'a rejected backend spawns nothing and writes no run dir');
});

test('every id the UI picker can post is accepted — one create per registry backend', async () => {
  // The create page composes `<model>@<provider>` from the SAME registry this route validates
  // against, so every pair it can produce must be creatable; a pair the registry does not declare
  // (a provider that model does not run on) must be refused before anything spawns.
  const { BACKEND_IDS, capsFor } = await import('../../../../src/lib/render-models.js');
  for (const id of BACKEND_IDS) {
    const res = await create({ backend: id, aspect: capsFor(id).aspects[0] });
    assert.equal(res.statusCode, 201, `${id}: ${res.body}`);
  }

  const before = runCount();
  for (const bogus of ['kling-o3@segmind', 'seedance-2.5@runway', 'seedance-3.0@fal']) {
    const res = await create({ backend: bogus, aspect: '16:9' });
    assert.equal(res.statusCode, 400, `${bogus}: ${res.body}`);
    assert.match(res.json().error, /Unknown render backend/);
    assert.ok(res.json().hint.includes('seedance-2.5@segmind'), `the 400 for ${bogus} names the real ids`);
  }
  assert.equal(runCount(), before, 'a backend nothing can render spawns nothing and writes no run dir');
});

test('POST /api/runs persists a MEMBER of ALL_BACKENDS, never the raw spelling', async () => {
  // " seedance " normalizes fine at the gate, but the manifest must store a value the estimator's
  // exact price-table lookup accepts — persisting the raw spelling would fail every estimate and
  // paid action AFTER planning already spent money.
  const manifestOf = async (over) => {
    const before = new Set(fs.readdirSync(dirs.runs));
    const res = await create(over);
    assert.equal(res.statusCode, 201, res.body);
    const id = fs.readdirSync(dirs.runs).find((d) => !before.has(d));
    return JSON.parse(fs.readFileSync(path.join(dirs.runs, id, 'web.json'), 'utf8'));
  };
  const padded = await manifestOf({ backend: ' seedance ' });
  assert.equal(padded.backend, 'seedance', 'trimmed member spelling wins — legacy manifests stay legacy');
  const compound = await manifestOf({ backend: 'seedance-2.0@fal', aspect: '16:9' });
  assert.equal(compound.backend, 'seedance-2.0@fal', 'a canonical submission stays canonical ($alias-priced)');
});

// ── cast caps (layer 2 of 3) ────────────────────────────────────────────────
test('a cast over the model\'s limit is a 400 with a hint — before any child spawns', async () => {
  const before = runCount();
  const res = await create({ cast: ['keeper', 'gull'] }); // kling → 1
  assert.equal(res.statusCode, 400, res.body);
  const body = res.json();
  assert.match(JSON.stringify(body), /Kling 3\.0 Omni/, 'the message names the model, not the backend id');
  assert.match(JSON.stringify(body), /\b1\b/, 'and the limit');
  assert.ok(body.hint, 'a hint tells the user what to do');
  assert.equal(runCount(), before, 'nothing was created');
});

test('the cap is INCLUSIVE, and each model gets its own', async () => {
  const one = await create({ cast: ['keeper'] });                                     // kling: 1 of 1
  assert.equal(one.statusCode, 201, one.body);
  const two = await create({ backend: 'seedance', cast: ['keeper', 'gull'] });         // seedance-2.0: 2 of 2
  assert.equal(two.statusCode, 201, two.body);
  const three = await create({ backend: 'seedance', cast: ['keeper', 'gull', 'crab'] });
  assert.equal(three.statusCode, 400, three.body);
  assert.match(JSON.stringify(three.json()), /Seedance 2\.0/);
});

// ── per-model aspects ───────────────────────────────────────────────────────
test('an aspect outside the chosen model\'s list is a 400 naming that model\'s ratios', async () => {
  const before = runCount();
  const wide = await create({ backend: 'kling-o3@fal', aspect: '21:9' });
  assert.equal(wide.statusCode, 400, wide.body);
  assert.match(JSON.stringify(wide.json()), /21:9/);
  for (const a of ['16:9', '9:16', '1:1']) assert.ok(JSON.stringify(wide.json()).includes(a), a);
  assert.ok(!JSON.stringify(wide.json()).includes('4:3'), 'it must not offer a ratio this model cannot render');

  const four3 = await create({ backend: 'seedance', aspect: '4:3' });
  assert.equal(four3.statusCode, 400, four3.body);
  assert.equal(runCount(), before, 'no run dir for a rejected aspect');
});

test('every ratio the chosen model DOES list is accepted', async () => {
  for (const a of ['16:9', '9:16', '1:1']) {
    const res = await create({ backend: 'kling', aspect: a });
    assert.equal(res.statusCode, 201, `${a}: ${res.body}`);
  }
});

// ── per-model resolutions ───────────────────────────────────────────────────
// The pick must be refused at the gate when the model cannot render it — a 1080p pick surviving to
// a Seedance 2.5 render child would die (or silently drop) AFTER planning already spent money.
test('a resolution outside the chosen model\'s ladder is a 400 naming the model\'s tiers', async () => {
  const before = runCount();
  const hd = await create({ backend: 'seedance-2.5@fal', aspect: '16:9', resolution: '1080p' });
  assert.equal(hd.statusCode, 400, hd.body);
  assert.match(JSON.stringify(hd.json()), /1080p/);
  for (const r of ['480p', '720p']) assert.ok(JSON.stringify(hd.json()).includes(r), r);
  assert.ok(!hd.json().hint.includes('4k'), 'it must not offer a tier the model cannot render');

  const low = await create({ resolution: '480p' }); // kling's ladder starts at 720p
  assert.equal(low.statusCode, 400, low.body);
  const junk = await create({ resolution: 'max' });
  assert.equal(junk.statusCode, 400, junk.body);
  assert.equal(runCount(), before, 'nothing spawned, no run dir');
});

test('every ladder tier of every backend is creatable, and the pick lands on the manifest', async () => {
  const { BACKEND_IDS, capsFor } = await import('../../../../src/lib/render-models.js');
  const manifestOfNew = (beforeDirs) => {
    const dirName = fs.readdirSync(dirs.runs).find((d) => !beforeDirs.has(d));
    return JSON.parse(fs.readFileSync(path.join(dirs.runs, dirName, 'web.json'), 'utf8'));
  };
  for (const id of BACKEND_IDS) {
    const caps = capsFor(id);
    // A ladder-less model (Kling: the endpoint takes no resolution parameter) is the inverse
    // contract — ANY pick is refused before a spawn, and a pickless create still works.
    if (!caps.resolutions.length) {
      const refused = await create({ backend: id, aspect: caps.aspects[0], resolution: '1080p' });
      assert.equal(refused.statusCode, 400, `${id}: a tier pick on a ladder-less model must 400`);
      assert.match(JSON.parse(refused.body).hint ?? '', /no selectable resolution/, `${id} hint says why`);
      const beforeDirs = new Set(fs.readdirSync(dirs.runs));
      const ok = await create({ backend: id, aspect: caps.aspects[0] });
      assert.equal(ok.statusCode, 201, `${id}: ${ok.body}`);
      assert.equal(manifestOfNew(beforeDirs).resolution, null, `${id}: nothing to persist`);
      continue;
    }
    const beforeDirs = new Set(fs.readdirSync(dirs.runs));
    const res = await create({ backend: id, aspect: caps.aspects[0], resolution: caps.resolutions.at(-1) });
    assert.equal(res.statusCode, 201, `${id}: ${res.body}`);
    // the manifest is where run-service re-reads the pick on EVERY child spawn (and the estimator
    // prices it) — a pick that never lands here silently reverts to the .env default
    assert.equal(manifestOfNew(beforeDirs).resolution, caps.resolutions.at(-1), `${id} persists the pick`);
  }
  // absent = no pick: the configured default governs, recorded as null (never invented)
  const beforeDirs = new Set(fs.readdirSync(dirs.runs));
  const noPick = await create({});
  assert.equal(noPick.statusCode, 201, noPick.body);
  assert.equal(manifestOfNew(beforeDirs).resolution, null);
});

// ── environment single-select: REGRESSION ONLY (already enforced) ───────────
test('regression: environment must stay a single string — an array is a 400', async () => {
  const before = runCount();
  const asArray = await post('/api/runs', { idea: 'x', backend: 'kling', aspect: '9:16', durationS: null, environment: ['neon-city', 'skyline'] });
  assert.equal(asArray.statusCode, 400, asArray.body);
  const asEmpty = await post('/api/runs', { idea: 'x', backend: 'kling', aspect: '9:16', durationS: null, environment: '' });
  assert.equal(asEmpty.statusCode, 400, asEmpty.body);
  assert.equal(runCount(), before);
});
