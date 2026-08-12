// WS2-P0 (WS2-02) — the pure prompt modules.
//
// src/lib/prompt-compose.js and src/lib/prompt-settings.js lift the prompt logic out of the two
// renderers into ZERO-CONFIG functions. Two things make that worth doing, and both are asserted
// here rather than assumed:
//
//   1. BYTE PARITY. The pure composer must produce, character for character, what the shipping
//      config-bound builders produce today — over the WHOLE golden matrix, not one happy case.
//      Without that, "the prompt preview shows what we send" (P3/P4) is a lie.
//   2. CONFIG-FREEDOM. web/server's prompt preview imports these modules. If either one reaches
//      config.js (and therefore dotenv, and therefore a developer's real .env) the demo/e2e mock is
//      bypassed and the server's static graph is poisoned — the same failure the runs-caps canary
//      guards on the server side. So the canary is walked here, at the source.
//
// TDD: red until src/lib/prompt-compose.js and src/lib/prompt-settings.js exist (see helpers/tdd.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { armed, pending } from '../helpers/tdd.js';
import { ROOT } from '../helpers/fixtures.js';
import { goldenCases, optsFor, goldenSpec, goldenSpecAudioOff, pinPromptEnv } from '../helpers/golden-spec.js';

pinPromptEnv();
const kling = await import('../../src/lib/kling.js');
const seedance = await import('../../src/lib/seedance.js');

const compose = await armed(
  () => import('../../src/lib/prompt-compose.js'),
  ['composeKlingStoryboard', 'composeSeedanceJobPrompt', 'promptFingerprint', 'pinBytesOf'],
);
const settingsMod = await armed(
  () => import('../../src/lib/prompt-settings.js'),
  ['klingPromptSettings', 'seedancePromptSettings', 'knobsFor'],
);
const P_COMPOSE = pending(compose, 'WS2-02: src/lib/prompt-compose.js');
const P_SETTINGS = pending(settingsMod, 'WS2-02: src/lib/prompt-settings.js');
const P_BOTH = pending(compose && settingsMod, 'WS2-02: prompt-compose.js + prompt-settings.js');

// The values pinPromptEnv() pins — passed IN, because the pure modules may not read config.js.
const KLING_DEFAULTS = {
  nativeAudio: true,
  segmentMaxBytes: 500,
  maxStoryboards: 6,
  maxJobSeconds: 15,
  defaultShotSeconds: 5,
  model: 'kling-v3-omni',
  resolution: '1080p',
  aspectRatio: '9:16',
};
const SEEDANCE_DEFAULTS = {
  generateAudio: true,
  // The value pinPromptEnv() pins, which is a cap the golden matrix SETS — not the shipped default
  // (uncapped). Both sides of the parity check must read the same number or the fixture moves.
  promptMaxBytes: 5000,
  defaultShotSeconds: 5,
  style: '',
  avoid: '',
  textRule: '',
  resolution: '480p',
  aspectRatio: '9:16',
};

const bytesEqual = (a, b, label) => assert.ok(
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) === 0,
  `${label}: pure composer diverged from the shipping builder\n  shim : ${JSON.stringify(b.slice(0, 160))}\n  pure : ${JSON.stringify(a.slice(0, 160))}`,
);

// ── 1. Byte parity over the entire golden matrix ────────────────────────────────────────────────

test('composeKlingStoryboard equals buildKlingStoryboard byte-for-byte on every golden case', P_BOTH, () => {
  for (const c of goldenCases().filter((x) => x.builder === 'kling')) {
    const spec = c.audioOff ? goldenSpecAudioOff() : goldenSpec();
    const job = spec.kling.jobs.find((j) => j.job_id === c.jobId);
    const opts = optsFor(c);
    const settings = settingsMod.klingPromptSettings(spec, KLING_DEFAULTS);
    const pure = compose.composeKlingStoryboard(job, spec, settings, opts);
    const shim = kling.buildKlingStoryboard(job, spec, opts);
    assert.equal(pure.totalDuration, shim.totalDuration, `${c.name}: totalDuration`);
    assert.equal(pure.segments.length, shim.segments.length, `${c.name}: segment count`);
    pure.segments.forEach((s, i) => {
      bytesEqual(s.prompt, shim.segments[i].prompt, `${c.name} segment ${i}`);
      assert.equal(s.duration, shim.segments[i].duration);
      assert.equal(s.speaker, shim.segments[i].speaker);
    });
  }
});

test('composeSeedanceJobPrompt equals buildSeedanceJobPrompt byte-for-byte on every golden case', P_BOTH, () => {
  for (const c of goldenCases().filter((x) => x.builder === 'seedance')) {
    const spec = c.audioOff ? goldenSpecAudioOff() : goldenSpec();
    const job = spec.kling.jobs.find((j) => j.job_id === c.jobId);
    const opts = optsFor(c);
    // The clause/budget knobs move from opts (today) to settings (P0). The shim keeps accepting them
    // as opts — that is what makes render-seedance.js's call site churn-free.
    const settings = {
      ...settingsMod.seedancePromptSettings(spec, null, SEEDANCE_DEFAULTS),
      ...(opts.style !== undefined ? { style: opts.style } : {}),
      ...(opts.avoidClause !== undefined ? { avoid: opts.avoidClause } : {}),
      ...(opts.textClause !== undefined ? { textRule: opts.textClause } : {}),
      ...(opts.maxBytes !== undefined ? { promptMaxBytes: opts.maxBytes } : {}),
    };
    const pure = compose.composeSeedanceJobPrompt(job, spec, settings, opts);
    const shim = seedance.buildSeedanceJobPrompt(job, spec, opts);
    bytesEqual(pure.prompt, shim.prompt, `${c.name} prompt`);
    assert.equal(pure.totalDuration, shim.totalDuration, `${c.name}: totalDuration`);
    assert.deepEqual(pure.speakers, shim.speakers, `${c.name}: speakers`);
    assert.equal(pure.shotPrompts.length, shim.shotPrompts.length, `${c.name}: shot count`);
    pure.shotPrompts.forEach((s, i) => bytesEqual(s, shim.shotPrompts[i], `${c.name} shotPrompt ${i}`));
  }
});

test('the composers throw the SAME errors as the builders (cap and lookup failures move too)', P_BOTH, () => {
  const spec = goldenSpec();
  const kSettings = settingsMod.klingPromptSettings(spec, KLING_DEFAULTS);
  const sSettings = settingsMod.seedancePromptSettings(spec, null, SEEDANCE_DEFAULTS);
  const overCap = { job_id: 'X', shots: ['S1', 'S1', 'S1', 'S1', 'S1', 'S1', 'S1'] };
  assert.throws(() => compose.composeKlingStoryboard(overCap, spec, kSettings, {}), /storyboard cap/);
  assert.throws(() => compose.composeKlingStoryboard({ job_id: 'X', shots: ['NOPE'] }, spec, kSettings, {}), /not found in spec\.shots/);
  assert.throws(() => compose.composeSeedanceJobPrompt({ job_id: 'X', shots: ['NOPE'] }, spec, sSettings, {}), /not found in spec\.shots/);
  const noPrompt = goldenSpec();
  delete noPrompt.shots[1].kling.content_prompt;
  assert.throws(() => compose.composeSeedanceJobPrompt(noPrompt.kling.jobs[0], noPrompt, sSettings, {}), /missing kling\.content_prompt/);
});

// ── 2. The config-free canary, walked transitively ──────────────────────────────────────────────

test('prompt-compose.js and prompt-settings.js never reach config.js, dotenv or process.env', P_BOTH, () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    assert.ok(!/from\s+['"]dotenv/.test(src), `${rel} must not load dotenv`);
    assert.ok(!/process\.env/.test(src), `${rel} reads process.env — the pure modules take every default as an argument`);
    const specifiers = [
      ...src.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*export\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g), // a lazy import would poison it just as well
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      assert.notEqual(path.basename(resolved), 'config.js',
        `${rel} imports config.js — web/server's prompt preview would drag a developer's .env into the server graph`);
      visit(resolved);
    }
  };
  visit(path.join(ROOT, 'src/lib/prompt-compose.js'));
  visit(path.join(ROOT, 'src/lib/prompt-settings.js'));
  assert.ok(seen.size >= 2, 'the walker found both modules');
});

// ── 3. prompt-settings precedence (the rules the renderers encode today) ────────────────────────

test('klingPromptSettings: spec values win, defaults fill in, generate_audio precedence intact', P_SETTINGS, () => {
  const spec = goldenSpec();
  const s = settingsMod.klingPromptSettings(spec, KLING_DEFAULTS);
  assert.equal(s.model, 'kling-v3-omni');
  assert.equal(s.resolution, '1080p');
  assert.equal(s.aspectRatio, '9:16');
  assert.equal(s.generateAudio, true);
  assert.equal(s.audioOn, true);
  assert.equal(s.segmentMaxBytes, 500);
  assert.equal(s.maxStoryboards, 6);
  assert.equal(s.maxJobSeconds, 15);
  assert.equal(s.defaultShotSeconds, 5);

  // spec.kling.generate_audio === false must WIN over a defaults.nativeAudio of true (the branch
  // that decides whether a paid render carries dialogue at all).
  const off = { ...spec, kling: { ...spec.kling, generate_audio: false } };
  assert.equal(settingsMod.klingPromptSettings(off, KLING_DEFAULTS).audioOn, false);
  // …and an ABSENT flag falls back to the default, rather than reading as false.
  const bare = { kling: {} };
  assert.equal(settingsMod.klingPromptSettings(bare, KLING_DEFAULTS).audioOn, true);
  assert.equal(settingsMod.klingPromptSettings(bare, { ...KLING_DEFAULTS, nativeAudio: false }).audioOn, false);
  assert.equal(settingsMod.klingPromptSettings(bare, KLING_DEFAULTS).model, 'kling-v3-omni');
});

test('seedancePromptSettings: kling.resolution NEVER leaks into Seedance (the 480p→1080p billing bug)', P_SETTINGS, () => {
  const spec = goldenSpec(); // carries kling.resolution = '1080p'
  const s = settingsMod.seedancePromptSettings(spec, null, SEEDANCE_DEFAULTS);
  assert.equal(s.resolution, '480p', 'the KLING block\'s resolution must not become the Seedance render size');
  assert.equal(s.aspectRatio, '9:16', 'aspect DOES come from spec.kling.aspect_ratio');
  assert.equal(s.audioOn, true);
  assert.equal(s.promptMaxBytes, 5000);
  assert.equal(s.defaultShotSeconds, 5, 'the duration derivation needs it — totalDuration must not silently become 1s/shot');
  assert.equal(s.style, '');
  assert.equal(s.avoid, '');
  assert.equal(s.textRule, '');

  const pinned = { ...spec, seedance: { resolution: '720p' } };
  assert.equal(settingsMod.seedancePromptSettings(pinned, null, SEEDANCE_DEFAULTS).resolution, '720p', 'an explicit spec.seedance pin wins');
});

test('knobsFor: own-property lookup only — a caps bundle naming __proto__ resolves to null', P_SETTINGS, () => {
  const bag = { seedance: { resolution: '480p' }, seedance25: { resolution: '720p' } };
  assert.equal(settingsMod.knobsFor({ knobsKey: 'seedance25' }, bag).resolution, '720p');
  assert.equal(settingsMod.knobsFor({ knobsKey: 'seedance' }, bag).resolution, '480p');
  assert.equal(settingsMod.knobsFor({}, bag), null);
  assert.equal(settingsMod.knobsFor(null, bag), null);
  for (const evil of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(settingsMod.knobsFor({ knobsKey: evil }, bag), null, `${evil} must never resolve to an inherited object`);
  }
});

test("seedancePromptSettings honours a model's own knobs block, falling back to the shared one", P_SETTINGS, () => {
  const spec = goldenSpec();
  const bag = { seedance: SEEDANCE_DEFAULTS, seedance25: { resolution: '720p' } };
  const caps25 = { knobsKey: 'seedance25' };
  const s = settingsMod.seedancePromptSettings(spec, caps25, { ...SEEDANCE_DEFAULTS, knobs: bag });
  assert.equal(s.resolution, '720p', "Seedance 2.5's own block wins over the shared default");
  assert.equal(s.promptMaxBytes, 5000, 'what the model does NOT redeclare keeps falling back');
});

// ── 4. promptFingerprint — the staleness oracle P4's banner is built on ─────────────────────────

test('promptFingerprint is stable, per-job, and sensitive to exactly the authored inputs', P_COMPOSE, () => {
  const base = goldenSpec();
  const fp = (spec, jobId = 'K1') => compose.promptFingerprint(spec, jobId);
  const ref = fp(base);
  assert.equal(typeof ref, 'string');
  assert.ok(ref.length >= 8, 'a fingerprint is a stable hash string');
  assert.equal(fp(goldenSpec()), ref, 'same authored inputs → same fingerprint (deterministic)');

  // Irrelevant edits must NOT invalidate a user's prompt override.
  const cosmetic = goldenSpec();
  cosmetic.project.title = 'Something Else';
  cosmetic.project.logline = 'rewritten by a revise pass';
  cosmetic.qc = { status: 'fail', checks: [] };
  assert.equal(fp(cosmetic), ref, 'title/logline/QC churn must not mark an edited prompt stale');

  // Every authored input the composed prompt is made of MUST move it.
  for (const mutate of [
    (s) => { s.shots[0].kling.content_prompt += ' Extra prose.'; },
    (s) => { s.shots[0].kling.shot_size = 'close_up'; },
    (s) => { s.shots[0].kling.perspective = 'from above'; },
    (s) => { s.shots[0].kling.camera_move = 'crash zoom'; },
    (s) => { s.shots[0].duration_s = 7; },
    (s) => { s.audio.voice.lines[0].text = 'Thirty years, then.'; },
    (s) => { s.audio.voice.lines[0].speaker = 'gull'; },
    (s) => { s.assembly.transitions[0].type = 'crossfade'; },
  ]) {
    const s = goldenSpec();
    mutate(s);
    assert.notEqual(fp(s), ref, `an authored change must invalidate the fingerprint: ${mutate}`);
  }

  // The CAST is an authored input too: characterGroups turns it into the Seedance identity clause
  // and the Kling @ElementN speaker mapping, so a re-cast that never touches a shot still rewrites
  // this job's prompt — and an override written before it really is stale.
  const GULL = { id: 'gull-01', role: 'subject', image: 'elements/references/gull-01.png', character: 'Gull' };
  for (const mutate of [
    (s) => { s.kling.elements[0].character = 'Keeper'; },                          // the group is renamed
    (s) => { s.kling.jobs[0].elements = ['subject', 'gull-01']; s.kling.elements.push(GULL); }, // a second group
  ]) {
    const s = goldenSpec();
    mutate(s);
    assert.notEqual(fp(s), ref, `a cast change must invalidate the fingerprint: ${mutate}`);
  }
  // …but only this job's cast. A roster entry no job of K1's names is not K1's prompt.
  const otherCast = goldenSpec();
  otherCast.kling.elements.push(GULL);
  assert.equal(fp(otherCast), ref, 'a roster addition K1 does not name leaves K1 alone');
  // …unless K1 named no subset at all, in which case the roster IS its cast (characterGroups).
  const inherits = (extra) => {
    const s = goldenSpec();
    s.kling.jobs[0].elements = [];
    if (extra) s.kling.elements.push(extra);
    return fp(s);
  };
  assert.equal(inherits(null), ref, 'inheriting a one-element roster composes exactly what naming it does');
  assert.notEqual(inherits(GULL), ref, 'a roster addition an inheriting job WILL send must stale its override');

  // Per-JOB scope: editing K2's shots must not stale K1's saved override.
  const otherJob = goldenSpec();
  otherJob.shots.find((s) => s.shot_id === 'S4').kling.content_prompt = 'A different scene entirely.';
  assert.equal(fp(otherJob, 'K1'), ref, "K2's shots are not part of K1's fingerprint");
  assert.notEqual(fp(otherJob, 'K2'), fp(base, 'K2'));
});

// ── 5. pinBytesOf — the denominator of P4's byte meter ──────────────────────────────────────────

test('pinBytesOf reports the SYSTEM front matter/pin bytes a user edit cannot spend', P_BOTH, () => {
  const spec = goldenSpec();
  const job = spec.kling.jobs[0];
  const settings = settingsMod.seedancePromptSettings(spec, null, SEEDANCE_DEFAULTS);
  const opts = { refGroups: [{ name: 'keeper', refs: ['@Image1'] }], startFrameRef: '@Image2' };

  const pins = compose.pinBytesOf('seedance', job, spec, settings, opts);
  assert.equal(typeof pins, 'number');
  assert.ok(pins > 0, 'the identity clause, text rule, speech rule and frame pin all cost bytes');
  const whole = Buffer.byteLength(compose.composeSeedanceJobPrompt(job, spec, settings, opts).prompt, 'utf8');
  assert.ok(pins < whole, 'pins are a PART of the prompt, never the whole of it');

  // The meter's headroom must be honest: adding a frame pin shrinks what the user may type.
  const noPin = compose.pinBytesOf('seedance', job, spec, settings, { ...opts, startFrameRef: null });
  assert.ok(pins > noPin, 'a first-frame pin costs the editor real headroom');

  // Kling budgets PER SEGMENT (500 B each), so its answer is per-segment, not one number.
  const kSettings = settingsMod.klingPromptSettings(spec, KLING_DEFAULTS);
  const kPins = compose.pinBytesOf('kling', job, spec, kSettings, { leadRef: '@Element1' });
  assert.ok(Array.isArray(kPins), 'Kling reports one pin size per segment — the editor draws one meter per shot');
  assert.equal(kPins.length, job.shots.length);
  for (const n of kPins) assert.ok(n > 0 && n < kSettings.segmentMaxBytes);
});

// ── 6. The shims: zero call-site churn ──────────────────────────────────────────────────────────

test('kling.js and seedance.js still export everything their importers use today', () => {
  for (const name of ['buildKlingStoryboard', 'klingConfigFor', 'SHOT_SIZE_WORDS', 'speakerName', 'lineForShot']) {
    assert.equal(typeof kling[name] !== 'undefined', true, `src/lib/kling.js must keep exporting ${name}`);
  }
  for (const name of ['buildSeedanceJobPrompt', 'seedanceConfigFor', 'modelKnobs', 'clampBytes', 'HOOK_PREFIX', 'TRANSITION_WORDS', 'SEEDANCE_TTV_GUIDANCE']) {
    assert.equal(typeof seedance[name] !== 'undefined', true, `src/lib/seedance.js must keep exporting ${name}`);
  }
  assert.equal(typeof kling.default.buildKlingStoryboard, 'function');
  assert.equal(typeof seedance.default.buildSeedanceJobPrompt, 'function');
});

test('prompt-compose re-exports the shared helpers both renderers import', P_COMPOSE, () => {
  for (const name of ['utf8Bytes', 'trimToBytes', 'clampBytes', 'promptCapOf', 'lineForShot', 'speakerName', 'SHOT_SIZE_WORDS', 'HOOK_PREFIX', 'TRANSITION_WORDS', 'identityClause', 'shotBlock']) {
    assert.notEqual(compose[name], undefined, `prompt-compose.js must export ${name}`);
  }
  // The helpers must be the SAME implementations the shims serve, not a second copy that can drift.
  assert.equal(compose.HOOK_PREFIX, seedance.HOOK_PREFIX);
  assert.deepEqual(compose.TRANSITION_WORDS, seedance.TRANSITION_WORDS);
  assert.deepEqual(compose.SHOT_SIZE_WORDS, kling.SHOT_SIZE_WORDS);
});

// ── 7. The whole-prompt cap: one normalizer, uncapped by default, no bleed into Kling ───────────
//
// `Number(settings.promptMaxBytes) || DEFAULT` lived at three Seedance sites and collapsed an
// explicit 0 back into the ambient default — with 0 as the uncapped sentinel that is the difference
// between sending a prompt and silently shortening it. So the decision lives in ONE exported
// function and the sites read it, which is what these cases hold in place.

test('promptCapOf is the one place a Seedance cap is decided — 0 and absent both mean uncapped', P_COMPOSE, () => {
  // No DEFAULT_* constant to fall back to, deliberately: `Number(x) || DEFAULT_PROMPT_MAX_BYTES`
  // still reads as working code when the default is 0, so the name alone invites the bug back.
  assert.equal(compose.DEFAULT_PROMPT_MAX_BYTES, undefined, 'nothing defaults a cap for a caller');
  for (const v of [undefined, null, '', 0, '0', -1, -1200, []]) {
    assert.equal(compose.promptCapOf({ promptMaxBytes: v }), 0, `${JSON.stringify(v) ?? String(v)} is not a cap`);
  }
  assert.equal(compose.promptCapOf({}), 0);
  assert.equal(compose.promptCapOf(null), 0);
  assert.equal(compose.promptCapOf(undefined), 0);
  assert.equal(compose.promptCapOf({ promptMaxBytes: 1200 }), 1200);
  assert.equal(compose.promptCapOf({ promptMaxBytes: '1200' }), 1200, 'a knob read from a run\'s .env arrives as text');
});

// NaN/'nonsense'/Infinity used to answer 0 here, alongside the genuinely-unset values above. That
// was harmless while 0 meant "fall back to 5000" and is not now: with the clamp shipped off, a knob
// nobody can read would be indistinguishable from a knob nobody set, so `SEEDANCE_PROMPT_MAX_BYTES=5,000`
// would answer a provider's 422 by doing exactly nothing, twice.
test('promptCapOf REFUSES a cap that was set to something unreadable — silence is the one wrong answer', P_COMPOSE, () => {
  for (const v of ['5,000', '5kb', '5 000', 'nonsense', NaN, Infinity, {}]) {
    assert.throws(
      () => compose.promptCapOf({ promptMaxBytes: v }),
      /SEEDANCE_PROMPT_MAX_BYTES is not a number of bytes/,
      `${JSON.stringify(v) ?? String(v)} is unreadable, not uncapped`,
    );
  }
  // …and it refuses on the paid path too, before a single byte is composed.
  const spec = goldenSpec();
  const settings = { ...settingsMod.seedancePromptSettings(spec, null, SEEDANCE_DEFAULTS), promptMaxBytes: Number('5,000') };
  assert.throws(
    () => compose.composeSeedanceJobPrompt(spec.kling.jobs[0], spec, settings, { refGroups: [{ name: 'keeper', refs: ['@Image1'] }] }),
    /not a number/,
  );
});

test('an uncapped composer neither clamps the plan nor overflows an override', P_COMPOSE, () => {
  const spec = goldenSpec();
  const job = spec.kling.jobs.find((j) => j.job_id === 'K2'); // the byte-trim shots (~740 B + multibyte)
  const settings = { ...settingsMod.seedancePromptSettings(spec, null, SEEDANCE_DEFAULTS), promptMaxBytes: 0 };
  const opts = { refGroups: [{ name: 'keeper', refs: ['@Image1'] }], startFrameRef: '@Image2' };

  const planned = compose.composeSeedanceJobPrompt(job, spec, settings, opts);
  // Byte equality is the real proof; `endsWith` names the failure. Never `includes('…')` — the
  // speech rule quotes a literal `says: "…"`, so it is in every audio-on prompt by design.
  assert.equal(planned.prompt, `${planned.front}\n\n${planned.shotPrompts.join('\nWhip pan to: ')}`,
    'the prompt is the assembled document, byte for byte');
  assert.ok(!planned.prompt.endsWith('…'), 'nothing was cut, so nothing marks a cut');

  const mine = 'z'.repeat(30000);
  const got = compose.applyOverride(planned, { prompt: mine }, settings);
  assert.ok(got.prompt.endsWith(mine), 'a 30 KB edit rides whole');
  assert.equal(got.overflowBytes, 0);
  assert.equal(compose.assertOverrideFits(got, 'K2'), got);
});

test('trimToBytes keeps its Kling semantics — the no-cap rule belongs to clampBytes alone', P_COMPOSE, () => {
  // klingSegmentPrompt budgets the authored body with trimToBytes. Giving IT an uncapped escape
  // would hand a 500-byte segment an unlimited body, and fal rejects the render at 512.
  assert.equal(compose.trimToBytes('abcdef', 0), '', 'a zero budget still trims to nothing');
  assert.equal(compose.trimToBytes('abcdef', 3), 'abc');
  assert.equal(compose.trimToBytes('abcdef', 99), 'abcdef');
});

test('a model\'s OWN promptMaxBytes of 0 stays uncapped — `||` would swallow it', P_SETTINGS, () => {
  const spec = goldenSpec();
  const bag = { seedance: SEEDANCE_DEFAULTS, seedance25: { resolution: '720p', promptMaxBytes: 0 } };
  const s = settingsMod.seedancePromptSettings(spec, { knobsKey: 'seedance25' }, { ...SEEDANCE_DEFAULTS, knobs: bag });
  assert.equal(s.promptMaxBytes, 0, "a model that declares itself uncapped must not inherit the shared cap");
  // …and a model that redeclares nothing still inherits, exactly as before.
  const shared = settingsMod.seedancePromptSettings(spec, { knobsKey: 'seedance25' }, {
    ...SEEDANCE_DEFAULTS, knobs: { seedance25: { resolution: '720p' } },
  });
  assert.equal(shared.promptMaxBytes, 5000);
});
