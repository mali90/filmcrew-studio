// src/lib/render-seed.js — the seed rules, and the ONE property that makes them shareable.
//
// Like the registry next door, this module must have ZERO IMPORTS and read no env: web/server
// computes the very seed a render child would compute (that is what makes "fix this take" honest),
// and every module in the server's static graph is walked by the config-free leak canaries. The
// canary below is the same one test/unit/render-models.test.js runs, pointed at this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neutralizeDotenv } from '../helpers/env.js';

// Belt and braces: were this module ever to grow an import of config.js, dotenv must not find a real
// .env. The zero-import canary is the real guard; this only protects the developer's machine.
neutralizeDotenv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src/lib/render-seed.js');

const { SEED_MODES, SEED_MIN, SEED_MAX, isSeed, seedForJob, randomSeed } = await import('../../src/lib/render-seed.js');

// ── 1. The zero-import canary ───────────────────────────────────────────────
test('render-seed.js has ZERO imports and reads no env (safe for web/server\'s static chain)', () => {
  const raw = fs.readFileSync(SRC, 'utf8');
  // strip comments first so prose about imports can never trip the canary
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.ok(!/^\s*import\s/m.test(src), 'no static import statements');
  assert.ok(!/^\s*export\s[^;]*\bfrom\s*['"]/m.test(src), 'no re-export-from (that is an import too)');
  assert.ok(!/\bimport\s*\(/.test(src), 'no dynamic import()');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require()');
  assert.ok(!/process\s*\.\s*env/.test(src), 'config-free: the seed rules never read env');
});

// ── 2. The wire vocabulary ──────────────────────────────────────────────────
test('SEED_MODES is exactly fix|fresh, and frozen — it is what the server 400s against', () => {
  assert.deepEqual(SEED_MODES, ['fix', 'fresh']);
  assert.ok(Object.isFrozen(SEED_MODES), 'a mutated list would widen the server\'s validation at runtime');
});

// ── 3. The accepted window ──────────────────────────────────────────────────
test('the window is 1…2^31-1: a seed is never 0, so nothing can read one as "no seed"', () => {
  assert.equal(SEED_MIN, 1);
  assert.equal(SEED_MAX, 2147483647);
});

test('isSeed accepts integers inside the window and nothing else', () => {
  for (const v of [SEED_MIN, SEED_MAX, 70000, 12345]) assert.equal(isSeed(v), true, String(v));
  for (const v of [0, -1, SEED_MAX + 1, 1.5, NaN, Infinity, '70000', null, undefined, {}, []]) {
    assert.equal(isSeed(v), false, JSON.stringify(v) ?? String(v));
  }
});

// ── 4. The deterministic default (moved here from pipeline.js, unchanged) ───
test('seedForJob is the SAME formula pipeline.js has always used', () => {
  assert.equal(seedForJob(0, 0), 70000);
  assert.equal(seedForJob(1, 0), 70100);
  assert.equal(seedForJob(0, 1), 70007);
  assert.equal(seedForJob(2, 3), 70221);
  assert.equal(seedForJob(1), 70100, 'no take = the base seed');
  assert.equal(seedForJob(1, undefined), 70100);
  assert.equal(seedForJob(1, 'nonsense'), 70100, 'a garbage take offsets by nothing rather than NaN');
});

test('every default seed a plan can produce is inside the accepted window', () => {
  // 100 jobs x 100 takes is far past anything this build renders, and still nowhere near 2^31.
  for (const i of [0, 1, 50, 99]) for (const t of [0, 1, 99]) assert.ok(isSeed(seedForJob(i, t)), `${i}/${t}`);
});

// ── 5. The draw ─────────────────────────────────────────────────────────────
test('randomSeed draws an integer inside the window, from the injected source', () => {
  assert.equal(randomSeed(() => 0), SEED_MIN, 'the bottom of the range is reachable');
  assert.equal(randomSeed(() => 0.5), SEED_MIN + Math.floor(0.5 * SEED_MAX));
  for (let i = 0; i < 200; i += 1) {
    const s = randomSeed();
    assert.ok(isSeed(s), `Math.random draw out of range: ${s}`);
  }
});

// A `rand` that returns exactly 1 is out of Math.random's contract but well inside what an injected
// one (or a stubbed test double) can do — and the number it produces would be a seed the endpoint
// rejects, on a render that has already been paid for.
test('a rand outside [0,1) is clamped rather than trusted', () => {
  assert.equal(randomSeed(() => 1), SEED_MAX);
  assert.equal(randomSeed(() => 2), SEED_MAX);
  assert.equal(randomSeed(() => -1), SEED_MIN);
});
