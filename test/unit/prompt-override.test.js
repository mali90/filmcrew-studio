// WS2-P4 — prompt overrides, the pure half.
//
// A prompt override is the user's WORDS. It is not the prompt. The difference is the whole design:
//
//   · the words are stored verbatim in <runDir>/prompt-overrides.json and never touched again;
//   · the CONTRACT — style, identity clause, text/speech rules, seam pin sentences, byte clamp — is
//     re-composed on top of them at render time, from that render's own settings.
//
// The reason is concrete, not stylistic: a seam pin names a reference LABEL ("@Image3") that only
// exists once a particular render has laid its references out. Freezing one into the sidecar would
// point a future take at whatever ref happened to land in slot 3 — a stranger's face, pinned as the
// opening frame. So this file asserts, for both backends: the pins come back, the stored text never
// contains one, and the byte budget is honoured by the SAME clamp the plan path uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { armed, pending } from '../helpers/tdd.js';
import { goldenSpec, pinPromptEnv } from '../helpers/golden-spec.js';

pinPromptEnv();
const compose = await armed(() => import('../../src/lib/prompt-compose.js'), ['applyOverride']);
const overrides = await armed(() => import('../../src/lib/prompt-overrides.js'), ['readJobOverride']);
const settingsMod = await armed(() => import('../../src/lib/prompt-settings.js'), ['klingPromptSettings']);
const PENDING = pending(compose && settingsMod, 'WS2-P4: src/lib/prompt-compose.js#applyOverride');
const PENDING_SIDECAR = pending(overrides, 'WS2-P4: src/lib/prompt-overrides.js#readJobOverride');

const KLING_DEFAULTS = {
  nativeAudio: true, segmentMaxBytes: 500, maxStoryboards: 6, maxJobSeconds: 15,
  defaultShotSeconds: 5, model: 'kling-v3-omni', resolution: '1080p', aspectRatio: '9:16',
};
const SEEDANCE_DEFAULTS = {
  generateAudio: true, promptMaxBytes: 5000, defaultShotSeconds: 5,
  style: 'Cinematic, natural light.', avoid: 'No extra limbs.', textRule: '', resolution: '480p', aspectRatio: '9:16',
};

const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const spec = () => goldenSpec();
const jobOf = (s, id) => s.kling.jobs.find((j) => j.job_id === id);

/** The Seedance opts a real render passes when BOTH boundary frames are soft-pinned. */
const SEEDANCE_OPTS = {
  refGroups: [{ name: 'keeper', refs: ['@Image1', '@Image2'] }],
  audioRefFor: () => null,
  startFrameRef: '@Image3',
  endFrameRef: '@Image4',
  shotSyntax: 'connectors',
};

const seedanceSettings = (s) => settingsMod.seedancePromptSettings(s, null, SEEDANCE_DEFAULTS);
const klingSettings = (s) => settingsMod.klingPromptSettings(s, KLING_DEFAULTS);

// ── Seedance: one document per job ──────────────────────────────────────────────────────────────

test('a Seedance override keeps the user\'s words and re-composes the system front matter over them', PENDING, () => {
  const s = spec();
  const job = jobOf(s, 'K1');
  const settings = seedanceSettings(s);
  const planned = compose.composeSeedanceJobPrompt(job, s, settings, SEEDANCE_OPTS);
  const mine = 'A much quieter version of the same three shots, held longer on the lamp.';

  const got = compose.applyOverride(planned, { prompt: mine }, settings);

  assert.ok(got.prompt.includes(mine), 'the user\'s words are what the model is asked to shoot');
  assert.ok(!got.prompt.includes(job.shots[0] ? s.shots[0].kling.content_prompt : ''), 'the agents\' scene body is gone — that is what an override MEANS');
  // Every clause the system owns comes back, from THIS render's settings.
  assert.ok(got.prompt.startsWith(planned.front), 'the front matter leads, exactly as composed');
  assert.match(got.prompt, /Cinematic, natural light\./, 'the style directive survives');
  assert.match(got.prompt, /No extra limbs\./, 'the avoid clause survives');
  assert.match(got.prompt, /No on-screen text/, 'the default text rule survives');
  assert.equal(got.shotPrompts.length, 1, 'one authored body was sent, and the record says so');
  assert.equal(got.shotPrompts[0], mine);
});

test('BOTH seam pins are re-composed over an override — a pinned joint stays pinned', PENDING, () => {
  const s = spec();
  const settings = seedanceSettings(s);
  const planned = compose.composeSeedanceJobPrompt(jobOf(s, 'K1'), s, settings, SEEDANCE_OPTS);
  const got = compose.applyOverride(planned, { prompt: 'one held shot of the lamp' }, settings);

  assert.ok(got.prompt.includes(compose.seamPinSentence('@Image3', 'in')), 'the opening pin is back, naming THIS render\'s label');
  assert.ok(got.prompt.includes(compose.seamPinSentence('@Image4', 'out')), 'the closing pin is back');
  // The order is the composer's, not the override's — a prompt built either way reads identically.
  assert.ok(got.prompt.indexOf('@Image3') < got.prompt.indexOf('@Image4'), 'opening pin before closing pin');
});

test('the SAME stored text under DIFFERENT reference layouts pins different labels', PENDING, () => {
  // This is why a pin may never be stored: the label depends on how many cast refs this render kept.
  const s = spec();
  const settings = seedanceSettings(s);
  const stored = { prompt: 'the lamp house at dusk, unmoving' };
  const one = compose.applyOverride(
    compose.composeSeedanceJobPrompt(jobOf(s, 'K1'), s, settings, { ...SEEDANCE_OPTS, startFrameRef: '@Image3' }),
    stored, settings,
  );
  const two = compose.applyOverride(
    compose.composeSeedanceJobPrompt(jobOf(s, 'K1'), s, settings, { ...SEEDANCE_OPTS, refGroups: [{ name: 'keeper', refs: ['@Image1'] }], startFrameRef: '@Image2', endFrameRef: null }),
    stored, settings,
  );
  assert.ok(one.prompt.includes('Use @Image3 as the literal first frame'));
  assert.ok(two.prompt.includes('Use @Image2 as the literal first frame'));
  assert.ok(!two.prompt.includes('@Image4'), 'a render with no closing pin must not inherit one from a stored sentence');
});

test('the byte clamp still applies — an oversized override is clamped, never sent over cap', PENDING, () => {
  const s = spec();
  const settings = { ...seedanceSettings(s), promptMaxBytes: 900 };
  const planned = compose.composeSeedanceJobPrompt(jobOf(s, 'K1'), s, settings, SEEDANCE_OPTS);
  const got = compose.applyOverride(planned, { prompt: 'x'.repeat(4000) }, settings);

  assert.ok(utf8(got.prompt) <= 900, `clamped to the model's cap (got ${utf8(got.prompt)})`);
  assert.ok(got.prompt.endsWith('…'), 'the clamp marks where it cut, exactly as it does on the plan path');
  // …and the STORED value is untouched: applyOverride is pure, the sidecar is the caller's.
  const stored = { prompt: 'x'.repeat(4000) };
  compose.applyOverride(planned, stored, settings);
  assert.equal(stored.prompt.length, 4000, 'the user\'s own text was not truncated behind their back');
});

test('a blank or absent override changes nothing at all', PENDING, () => {
  const s = spec();
  const settings = seedanceSettings(s);
  const planned = compose.composeSeedanceJobPrompt(jobOf(s, 'K1'), s, settings, SEEDANCE_OPTS);
  for (const o of [null, undefined, {}, { prompt: '' }, { prompt: '   \n ' }]) {
    const got = compose.applyOverride(planned, o, settings);
    assert.equal(got.prompt, planned.prompt, `override ${JSON.stringify(o)} must leave the plan's bytes alone`);
  }
});

// ── Kling: one ≤500-byte segment per shot ───────────────────────────────────────────────────────

test('a Kling override replaces the scene body per segment, keeping framing, line and camera', PENDING, () => {
  const s = spec();
  const job = jobOf(s, 'K1');
  const settings = klingSettings(s);
  const opts = { lowercaseSpeech: true, leadRef: '@Element1', voiceTokenFor: () => '@Element1' };
  const planned = compose.composeKlingStoryboard(job, s, settings, opts);
  const mine = 'the lamp house, seen from the stairwell, nothing moving';

  const got = compose.applyOverride(planned, { segments: [mine, '', ''] }, settings);

  assert.ok(got.segments[0].prompt.includes(mine), 'shot 1 says what the user wrote');
  assert.ok(got.segments[0].prompt.startsWith('@Element1 '), 'the identity lead is re-composed, not stored');
  assert.equal(got.segments[1].prompt, planned.segments[1].prompt, 'a blank entry leaves that shot on the agents\' text');
  assert.equal(got.segments[0].duration, planned.segments[0].duration, 'editing words does not change the shot length');
  assert.equal(got.segments[0].speaker, planned.segments[0].speaker);
  // Whatever the plan's segment carried after the body (spoken line / no-dialogue directive, camera)
  // is still there — those bytes belong to the render contract, not to the edit.
  const tail = planned.segments[0].prompt.slice(planned.segments[0].prompt.indexOf(s.shots[0].kling.content_prompt.trim()) + s.shots[0].kling.content_prompt.trim().length);
  assert.ok(got.segments[0].prompt.endsWith(tail), `the system tail survives (${JSON.stringify(tail.slice(0, 60))})`);
});

test('a Kling override obeys the per-segment cap through the same trim the plan path uses', PENDING, () => {
  const s = spec();
  const settings = klingSettings(s);
  const opts = { lowercaseSpeech: true, leadRef: '@Element1', voiceTokenFor: () => '@Element1' };
  const planned = compose.composeKlingStoryboard(jobOf(s, 'K1'), s, settings, opts);
  const got = compose.applyOverride(planned, { segments: ['y'.repeat(4000)] }, settings);

  assert.ok(utf8(got.segments[0].prompt) <= 500, `≤500 bytes (got ${utf8(got.segments[0].prompt)})`);
  assert.ok(got.segments[0].prompt.includes('...'), 'the scene body was trimmed with the plan path\'s marker');
  assert.ok(!got.segments[0].prompt.includes('�'), 'never split a multi-byte character');
});

test('a single-shot Kling job accepts a whole-job override', PENDING, () => {
  const s = spec();
  const settings = klingSettings(s);
  const opts = { lowercaseSpeech: true, leadRef: '@Element1', voiceTokenFor: () => '@Element1' };
  const job = { ...jobOf(s, 'K1'), shots: [jobOf(s, 'K1').shots[0]] };
  const planned = compose.composeKlingStoryboard(job, s, settings, opts);
  const got = compose.applyOverride(planned, { prompt: 'a single held frame of the lamp' }, settings);
  assert.ok(got.segments[0].prompt.includes('a single held frame of the lamp'));
});

// ── The sidecar itself ──────────────────────────────────────────────────────────────────────────

test('the stored sidecar carries the WORDS ONLY — no pin sentence, no front matter', PENDING_SIDECAR, async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'kva-ovr-'));
  try {
    // Exactly what web/server writes on PUT: the user's text, the fingerprint it was written
    // against, and when. Nothing composed.
    const sidecar = {
      schema: 1,
      jobs: { K1: { prompt: 'a much quieter version, held longer on the lamp', fingerprint: 'abc123', updatedAt: new Date().toISOString() } },
    };
    fs.writeFileSync(pathMod.join(dir, 'prompt-overrides.json'), JSON.stringify(sidecar, null, 2));

    const raw = fs.readFileSync(pathMod.join(dir, 'prompt-overrides.json'), 'utf8');
    assert.ok(!/literal first frame|literal last frame/.test(raw), 'a seam pin sentence must NEVER be stored — its @ImageN label belongs to one render');
    assert.ok(!/No on-screen text/.test(raw), 'the text rule is the system\'s, re-composed every time');
    assert.ok(!/@Image\d|@Element\d|@Audio\d/.test(raw), 'no reference label is frozen into a stored edit');

    const got = overrides.readJobOverride(dir, 'K1');
    assert.equal(got.prompt, sidecar.jobs.K1.prompt, 'read back byte for byte');
    assert.equal(overrides.readJobOverride(dir, 'K9'), null, 'a job with no edit reads as null, not as empty text');
    assert.equal(overrides.readJobOverride(pathMod.join(dir, 'nope'), 'K1'), null, 'no sidecar at all is simply no override');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed sidecar THROWS rather than quietly rendering the plan', PENDING_SIDECAR, async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'kva-ovr-bad-'));
  try {
    fs.writeFileSync(pathMod.join(dir, 'prompt-overrides.json'), '{ not json');
    // Silently ignoring an edit is the one failure a user cannot see in the output — and this fires
    // before anything is submitted, so it costs nothing.
    assert.throws(() => overrides.readJobOverride(dir, 'K1'), /not valid JSON/);
    fs.writeFileSync(pathMod.join(dir, 'prompt-overrides.json'), JSON.stringify({ schema: 1, jobs: { K1: { prompt: 42 } } }));
    assert.throws(() => overrides.readJobOverride(dir, 'K1'), /must be a string/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
