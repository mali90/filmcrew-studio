// WS2-P3 — the duplicated prompt defaults in web/server/lib/prompt-service.js, pinned to config.js.
//
// THE GAP THIS FILLS. prompt-service.js may not import config.js (that would run `dotenv/config`
// inside the server process and let a request reconfigure it), so it re-declares config.js's
// prompt-relevant defaults by hand. Its own comment says a drifted default "shows up as a preview
// that differs from the render, which the byte-parity test in prompt-read.test.js catches" — but
// that test writes an explicit .env, so both sides read the SAME value and the DEFAULT is never
// exercised. Bump `SEEDANCE_PROMPT_MAX_BYTES`'s default in config.js alone and every existing test
// still passes, while a user with no .env gets a preview that lies about what is sent.
//
// So this file exercises the defaults path directly: compose the same spec twice — once against an
// .env that spells out config.js's defaults, once against NO .env at all (prompt-service's own
// fallbacks) — and compare the resulting prompts BYTE FOR BYTE. Every prompt-moving knob is covered
// at once, so a knob added to config.js and forgotten here goes red the day it moves a byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { neutralizeDotenv } = await import(path.join(HOST_ROOT, 'test/helpers/env.js'));
neutralizeDotenv(); // config.js runs `import 'dotenv/config'`: never let a real .env near this
const { goldenSpec } = await import(path.join(HOST_ROOT, 'test/helpers/golden-spec.js'));
const { buildConfig } = await import(path.join(HOST_ROOT, 'config.js'));
const { buildPromptViews } = await import('../../lib/prompt-service.js');

// buildConfig takes its environment as an ARGUMENT, so `{}` is config.js's defaults exactly — no
// shell, no .env, no import-time snapshot.
const cfg = buildConfig({});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-prompt-defaults-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const runDir = path.join(tmpRoot, 'run');   // no prompt-overrides.json: the plan path, unmodified
const bareRoot = path.join(tmpRoot, 'bare'); // no .env at all → prompt-service's own defaults
const spelledRoot = path.join(tmpRoot, 'spelled');
for (const d of [runDir, bareRoot, spelledRoot]) fs.mkdirSync(d, { recursive: true });

/**
 * config.js's defaults, written out as the .env keys prompt-service reads. Every entry is a default
 * that prompt-service.js re-declares; keep the two lists in step (that is the point of the file).
 */
const SPELLED_OUT = {
  KLING_MODEL: cfg.kling.model,
  KLING_ASPECT: cfg.kling.aspectRatio,
  KLING_RESOLUTION: cfg.kling.resolution,
  KLING_GENERATE_AUDIO: String(cfg.kling.nativeAudio),
  KLING_SEGMENT_MAX_BYTES: String(cfg.kling.segmentMaxBytes),
  KLING_DEFAULT_SHOT_SECONDS: String(cfg.kling.defaultShotSeconds),
  KLING_CHAIN_FRAMES: String(cfg.kling.chainFrames),
  SEEDANCE_RESOLUTION: cfg.seedance.resolution,
  SEEDANCE_GENERATE_AUDIO: String(cfg.seedance.generateAudio),
  SEEDANCE_VOICE_MODE: cfg.seedance.voiceMode,
  SEEDANCE_PROMPT_MAX_BYTES: String(cfg.seedance.promptMaxBytes),
  SEEDANCE_STYLE: cfg.seedance.style,
  SEEDANCE_AVOID: cfg.seedance.avoid,
  SEEDANCE_TEXT_RULE: cfg.seedance.textRule,
  SEEDANCE25_RESOLUTION: cfg.seedance25.resolution,
};
fs.writeFileSync(
  path.join(spelledRoot, '.env'),
  Object.entries(SPELLED_OUT).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
);

const spec = goldenSpec();
const view = (envRoot, backend) => buildPromptViews({
  root: HOST_ROOT, envRoot, childEnv: {}, runDir, spec, backend, voicesDir: path.join(HOST_ROOT, 'voices'),
});

/** Byte-level compare with a readable first divergence (a 5 KB assert.equal diff is unusable). */
function assertBytesEqual(actual, expected, label) {
  const a = Buffer.from(actual ?? '', 'utf8');
  const b = Buffer.from(expected ?? '', 'utf8');
  if (Buffer.compare(a, b) === 0) return;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = (buf) => JSON.stringify(buf.slice(Math.max(0, i - 40), i + 40).toString('utf8'));
  assert.fail(
    `${label}: prompt bytes differ (${b.length} → ${a.length}) at byte ${i}\n`
    + `  config.js default …${ctx(b)}…\n`
    + `  prompt-service    …${ctx(a)}…\n`
    + '  A prompt default drifted: reconcile promptDefaults() in web/server/lib/prompt-service.js\n'
    + '  with the kling/seedance blocks in config.js.',
  );
}

for (const backend of ['kling', 'seedance-2.0@fal', 'seedance-2.5@fal']) {
  test(`${backend}: the preview's OWN defaults compose the same bytes as config.js's defaults`, async () => {
    const bare = await view(bareRoot, backend);
    const spelled = await view(spelledRoot, backend);

    assert.ok(bare.prompts.length > 0, 'the golden spec previews at least one job');
    assert.deepEqual(bare.jobs, spelled.jobs, 'both runs preview the same jobs');

    bare.prompts.forEach((got, i) => {
      const want = spelled.prompts[i];
      assert.equal(got.error ?? null, null, `${got.jobId}: the preview must compose, not error (${got.error})`);
      assertBytesEqual(got.prompt, want.prompt, `${backend} ${got.jobId} prompt`);
      assert.equal(got.bytes, want.bytes, `${backend} ${got.jobId}: byte count`);
      assert.equal(got.maxBytes, want.maxBytes, `${backend} ${got.jobId}: the byte-meter DENOMINATOR drifted`);
      assert.equal(got.segmentMaxBytes, want.segmentMaxBytes, `${backend} ${got.jobId}: per-segment cap drifted`);
      assert.equal(got.pinBytes, want.pinBytes, `${backend} ${got.jobId}: reserved system-pin bytes drifted`);
      // Kling previews one metered segment per shot; a drifted default moves these too.
      assert.equal(got.segments?.length ?? null, want.segments?.length ?? null, `${backend} ${got.jobId}: segment count`);
      (got.segments ?? []).forEach((seg, s) => {
        assertBytesEqual(seg.prompt, want.segments[s].prompt, `${backend} ${got.jobId} segment ${s}`);
        assert.equal(seg.maxBytes, want.segments[s].maxBytes, `${backend} ${got.jobId} segment ${s}: cap`);
      });
      (got.shotPrompts ?? []).forEach((sp, s) => {
        assertBytesEqual(sp, want.shotPrompts[s], `${backend} ${got.jobId} shotPrompt ${s}`);
      });
    });
  });
}

// The byte-parity above only catches a default that MOVES A BYTE. These two are budgets: a drift in
// either silently changes what the editor's meter allows before the composed bytes ever change.
//
// The Seedance assertion is deliberately a MAPPING rather than raw equality, and the reason is the
// wire contract: config.js says "uncapped" with 0, the PromptView says it with `null` (0 would meter
// every edit as instantly over, and `maxBytes − pinBytes` would go negative). The lockstep is
// unchanged in force — config.js and prompt-service.js must still agree about whether a cap exists
// at all — only its shape moved.
test('the byte budgets themselves come from config.js, not from a second opinion', async () => {
  const seedance = (await view(bareRoot, 'seedance-2.0@fal')).prompts[0];
  assert.equal(cfg.seedance.promptMaxBytes, 0,
    'config.js ships the Seedance whole-prompt clamp OFF — no provider documents a prompt-length limit');
  assert.equal(seedance.maxBytes, null,
    'and prompt-service.js must mirror "no cap" as null, never as 0 or NaN');
  assert.equal(typeof seedance.pinBytes, 'number',
    'the system\'s own share is still a measured number — it just has no budget to be subtracted from');

  const kling = (await view(bareRoot, 'kling')).prompts[0];
  assert.equal(kling.segmentMaxBytes, cfg.kling.segmentMaxBytes,
    'the Kling per-segment budget must be config.js\'s KLING_SEGMENT_MAX_BYTES default');
  assert.equal(kling.segmentMaxBytes, 500, 'fal\'s o3 schema really enforces this one — it does not move');
});

// The knob is the lever for anyone who meets a provider 422 on a very long prompt. A removed default
// and a knob that quietly stopped clamping look identical from the outside, so the SET path is
// pinned through the same mirror.
test('a run that SETS SEEDANCE_PROMPT_MAX_BYTES gets that number as its meter denominator', async () => {
  const cappedRoot = path.join(tmpRoot, 'capped');
  fs.mkdirSync(cappedRoot, { recursive: true });
  fs.writeFileSync(path.join(cappedRoot, '.env'), 'SEEDANCE_PROMPT_MAX_BYTES=1200\n');
  const capped = (await view(cappedRoot, 'seedance-2.0@fal')).prompts[0];
  assert.equal(capped.maxBytes, 1200, "the run's own knob reaches the preview");
  assert.equal(buildConfig({ SEEDANCE_PROMPT_MAX_BYTES: '1200' }).seedance.promptMaxBytes, 1200,
    'and config.js reads it the same way — the two mirrors still agree');
});

// The preview and the render child read the SAME file — and the promise only holds if they read it
// the same WAY. The child reads it through dotenv (`import 'dotenv/config'`), which drops a trailing
// `# comment`, accepts an `export ` prefix, and keeps the LAST assignment. Reading it as the
// wizard's ordered entries instead answered all three differently, so an ordinary .env previewed one
// prompt and paid for another.
test('a dotenv-valid .env previews exactly what the render child will read from it', async () => {
  const { parse } = await import('dotenv');
  const quirkyRoot = path.join(tmpRoot, 'quirky');
  const plainRoot = path.join(tmpRoot, 'plain');
  for (const d of [quirkyRoot, plainRoot]) fs.mkdirSync(d, { recursive: true });
  const quirky = [
    'export SEEDANCE_PROMPT_MAX_BYTES=1200',
    'SEEDANCE_STYLE=hand-held documentary # the look for this run',
    'SEEDANCE_AVOID=the guard that was replaced',
    'SEEDANCE_AVOID=the guard that wins',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(quirkyRoot, '.env'), quirky);
  // What the CHILD gets, from dotenv's own parser — never a second reading of ours.
  const child = parse(quirky);
  assert.deepEqual(child, {
    SEEDANCE_PROMPT_MAX_BYTES: '1200',
    SEEDANCE_STYLE: 'hand-held documentary',
    SEEDANCE_AVOID: 'the guard that wins',
  }, 'dotenv itself reads it this way');
  fs.writeFileSync(path.join(plainRoot, '.env'), Object.entries(child).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  const got = (await view(quirkyRoot, 'seedance-2.0@fal')).prompts[0];
  const want = (await view(plainRoot, 'seedance-2.0@fal')).prompts[0];
  assertBytesEqual(got.prompt, want.prompt, 'the preview of a dotenv-valid .env');
  assert.equal(got.maxBytes, 1200, 'an `export`ed budget is still the budget the render will apply');
  assert.ok(got.prompt.includes('the guard that wins'), 'the assignment dotenv keeps is the one previewed');
  assert.ok(!got.prompt.includes('# the look'), 'a trailing comment is not part of the value');
});

// Same rule, one layer down: reading the .env the same WAY is not enough if the two sides then
// COERCE the value differently. dotenv keeps the padding INSIDE a quoted value, and config.js trims
// a boolean before testing it — so `" true "` is the flag ON in the render child. A mirror that
// tests the raw value reads it OFF, and the preview then describes a render nobody is going to pay
// for: no chained opening pin, no speech rule, no dialogue. The coercion is therefore ONE shared
// rule (src/lib/env-file.js `envBool`), pinned here from the outside, through the preview.
test('a dotenv-valid PADDED boolean previews the flag the render child will really apply', async () => {
  const { parse } = await import('dotenv');
  const paddedRoot = path.join(tmpRoot, 'padded');
  const bareBoolRoot = path.join(tmpRoot, 'plain-bool');
  for (const d of [paddedRoot, bareBoolRoot]) fs.mkdirSync(d, { recursive: true });

  // Both knobs default to TRUE, so a padded `" true "` is the case that separates the two readings:
  // trimmed it is the default the child renders with, untrimmed it silently flips the preview off.
  const padded = 'KLING_CHAIN_FRAMES=" true "\nSEEDANCE_GENERATE_AUDIO=" true "\n';
  fs.writeFileSync(path.join(paddedRoot, '.env'), padded);
  assert.deepEqual(parse(padded), { KLING_CHAIN_FRAMES: ' true ', SEEDANCE_GENERATE_AUDIO: ' true ' },
    'dotenv keeps the padding inside a quoted value — this is what the child gets');
  const child = buildConfig(parse(padded));
  assert.equal(child.kling.chainFrames, true, 'and config.js trims it: the child DOES chain frames');
  assert.equal(child.seedance.generateAudio, true, 'and the child DOES render native audio');

  fs.writeFileSync(path.join(bareBoolRoot, '.env'), 'KLING_CHAIN_FRAMES=true\nSEEDANCE_GENERATE_AUDIO=true\n');

  // Kling: chaining is what hands job 2 its opening frame, so the seam the sheet PROMISES moves.
  const gotKling = await view(paddedRoot, 'kling');
  const wantKling = await view(bareBoolRoot, 'kling');
  assert.equal(gotKling.prompts[1].seam.in, wantKling.prompts[1].seam.in,
    'the opening pin the preview promises must be the one the render will apply');
  assert.equal(wantKling.prompts[1].seam.in, 'native',
    '…which for a chained Kling job is a real anchor, not a guess');

  // Seedance: the audio flag rides through voice-refs.js (the ONE mirror run-service budgets from),
  // and it moves prompt BYTES — the speech rule, every dialogue clause and the speaker list.
  const got = (await view(paddedRoot, 'seedance-2.0@fal')).prompts[0];
  const want = (await view(bareBoolRoot, 'seedance-2.0@fal')).prompts[0];
  assertBytesEqual(got.prompt, want.prompt, 'the preview of a padded SEEDANCE_GENERATE_AUDIO');
  assert.ok(want.prompt.includes('Speech rule'), 'audio ON is what the child renders, so the speech rule rides');
});

// A knob that is NOT env-tunable cannot drift by .env, only by edit — so it is asserted directly.
test('the hard model caps prompt-service mirrors are still config.js\'s hard caps', () => {
  assert.equal(cfg.kling.maxStoryboards, 6, 'prompt-service.js hardcodes maxStoryboards: 6');
  assert.equal(cfg.kling.maxJobSeconds, 15, 'prompt-service.js hardcodes maxJobSeconds: 15');
});
