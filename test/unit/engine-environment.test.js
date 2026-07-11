// Environment injection into the 8-agent plan: a selected environments/<slug>.md becomes a REQUIRED
// world/mood/style bible that takes PRECEDENCE over a character's own "## World & style" notes, is
// stamped onto the spec, and — crucially — never flips a text-to-video render into image-to-video
// (an environment carries no reference image). Env discipline: config.js snapshots the dirs at
// import, so ENVIRONMENTS_DIR / ELEMENTS_REFERENCES_DIR are set BEFORE the dynamic import.
//
// TDD (red first): loadEnvironment / buildCtx's environment plumbing / the contextBlock environment
// section do not exist yet. `contextBlock` and `isTextToVideoPlan` are already exported; buildCtx is
// exported alongside them so its ctx (textToVideo, environmentText/Name/Slug) is observable here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';

neutralizeDotenv();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-env-unit-'));
const ENV_DIR = path.join(tmpRoot, 'environments');
const REFS_DIR = path.join(tmpRoot, 'refs'); // empty ⇒ refCount 0 (guaranteed text-to-video)
fs.mkdirSync(ENV_DIR, { recursive: true });
fs.mkdirSync(REFS_DIR, { recursive: true });
const SAMPLE = 'neon-city';
const SENTINEL = 'RAIN_SLICKED_SENTINEL';
fs.writeFileSync(path.join(ENV_DIR, `${SAMPLE}.md`),
  `# Neon City\n\n${SENTINEL} — a synth-noir night city, sodium haze and wet asphalt.\n\n## Avoid\n\nDaylight, pastoral calm.\n`);
Object.assign(process.env, { ENVIRONMENTS_DIR: ENV_DIR, ELEMENTS_REFERENCES_DIR: REFS_DIR });

const { buildCtx, contextBlock, isTextToVideoPlan } = await import('../../src/lib/engine.js');

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const baseCtx = (over) => ({
  brief: 'a courier races the last train', aspectRatio: '9:16', durationTargetS: 13,
  backend: 'seedance', castNames: null, textToVideo: false, inventoryText: '(none)', voicesText: '(none)', profilesText: '',
  ...over,
});

// ── isTextToVideoPlan is byte-for-byte unchanged: environment is NOT one of its inputs ──
test('isTextToVideoPlan: signature/behaviour unchanged — environment never enters render-mode selection', () => {
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: undefined, refCount: 0 }), true);
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: [], refCount: 0 }), true);
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: [], refCount: 20 }), false);
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: ['wren'], refCount: 0 }), false);
  assert.equal(isTextToVideoPlan({ backend: 'kling', cast: [], refCount: 0 }), false);
  // an environment argument, if any caller ever passed one, must be ignored (it is not a param)
  assert.equal(isTextToVideoPlan({ backend: 'seedance', cast: undefined, refCount: 0, environment: SAMPLE }), true);
});

// ── contextBlock renders the environment as a REQUIRED bible with explicit precedence ──
test('contextBlock injects the REQUIRED environment bible and states it OVERRIDES character world notes', () => {
  const envText = `# Neon City\n\n${SENTINEL} — a synth-noir night city.`;
  const block = contextBlock(baseCtx({ environmentText: envText, environmentName: 'Neon City' }));
  assert.match(block, /REQUIRED/, 'the environment is presented as REQUIRED, like the featured cast');
  assert.ok(block.includes(SENTINEL), 'the environment markdown is embedded verbatim');
  // precedence: it must explicitly beat a character's own "## World & style" notes when they conflict
  assert.match(block, /World & style/, 'it names the character section it overrides');
  assert.match(block, /overrid|precedence|take[s]? priority|wins/i, 'it states the environment takes precedence');
});

test('contextBlock omits the environment section entirely when no environment is selected', () => {
  const block = contextBlock(baseCtx({ environmentText: '' }));
  assert.ok(!block.includes(SENTINEL), 'no environment prose leaks in');
  assert.doesNotMatch(block, /takes precedence over/i, 'no precedence directive without an environment');
});

test('an environment coexists with the Seedance text-to-video guidance (both blocks render together)', () => {
  const envText = `# Neon City\n\n${SENTINEL}`;
  const block = contextBlock(baseCtx({ textToVideo: true, environmentText: envText, environmentName: 'Neon City' }));
  assert.ok(block.includes('Seedance text-to-video — prompt style'), 't2v guidance still present');
  assert.ok(block.includes(SENTINEL), 'the environment bible is present alongside it');
});

// ── buildCtx: throw-before-spend on unknown slug, and enrich-without-flipping-render-mode ──
test('buildCtx throws on an unknown environment slug (BEFORE any LLM spend)', async () => {
  await assert.rejects(
    () => buildCtx({ brief: 'x', backend: 'seedance', environment: 'atlantis' }),
    /Unknown environment "atlantis"/,
  );
});

test('a selected environment enriches ctx (text/name/slug) but keeps a no-cast/no-ref Seedance plan text-to-video', async () => {
  const ctx = await buildCtx({ brief: 'x', backend: 'seedance', cast: undefined, environment: SAMPLE });
  assert.equal(ctx.textToVideo, true, 'seedance + no cast + no refs stays text-to-video WITH an environment');
  assert.ok(ctx.environmentText.includes(SENTINEL), 'the environment markdown is loaded into ctx');
  assert.equal(ctx.environmentSlug, SAMPLE, 'the slug is carried for stamping onto the spec');
  assert.match(ctx.environmentName, /Neon City/, 'the display name is derived from the # heading');
  // the enriched ctx still turns the t2v guidance on (textToVideo drives it, untouched by environment)
  assert.ok(contextBlock(ctx).includes('Seedance text-to-video — prompt style'));
});

test('no environment ⇒ ctx carries no environment text/slug (unchanged planning path)', async () => {
  const ctx = await buildCtx({ brief: 'x', backend: 'seedance', cast: undefined });
  assert.ok(!ctx.environmentText, 'no environment prose when none is selected');
  assert.equal(ctx.environmentSlug ?? null, null, 'no slug to stamp');
});
