import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
neutralizeDotenv();
const { buildSeedanceJobPrompt, seedanceConfigFor, clampBytes, HOOK_PREFIX, TRANSITION_WORDS } = await import('../../src/lib/seedance.js');

const REFS = [{ name: 'keeper', refs: ['@Image1', '@Image2'] }];

test('seedanceConfigFor: seedance pin overrides, kling.resolution NEVER does (it is the Kling default)', () => {
  const spec = loadGoldenSpec(); // golden spec carries kling.resolution=1080p — must not leak into seedance
  assert.deepEqual(seedanceConfigFor(spec), { resolution: '480p', aspectRatio: '9:16', generateAudio: true });
  const pinned = { ...spec, seedance: { resolution: '720p' } };
  assert.equal(seedanceConfigFor(pinned).resolution, '720p');
  const d = seedanceConfigFor({ kling: {} });
  assert.equal(d.resolution, '480p'); // config default: cheap path — Topaz on approve lifts to 1080p
  assert.equal(d.aspectRatio, '9:16');
  assert.equal(d.generateAudio, true);
});

test('one job → one multi-shot prompt: identity front matter, hook lead, folded dialogue, Cut to: joins', () => {
  const spec = loadGoldenSpec();
  const { prompt, shotPrompts, totalDuration, speakers } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });
  assert.equal(shotPrompts.length, 3);
  assert.equal(totalDuration, 13); // 5 + 4 + 4 — same derivation as the Kling storyboard
  assert.match(prompt, /All shots feature the SAME character — Keeper, given as @Image1\/@Image2 \(multiple reference angles\)/);
  assert.match(prompt, /No on-screen text/); // strict default text rule
  assert.ok(shotPrompts[0].startsWith(HOOK_PREFIX), 'opening hook shot leads with the hook directive');
  assert.match(shotPrompts[0], /Extreme wide shot, distant eye level from the water\./);
  assert.match(shotPrompts[0], /Camera: slow push in toward the tower\./);
  assert.match(prompt, /The character says: "Forty years I kept this light\."/); // no speaker on the golden line
  assert.equal((prompt.match(/\nCut to: /g) ?? []).length, 2, 'default connector between the 3 shots');
  assert.deepEqual(speakers, []); // line has no speaker field
});

test('hook prefix only when the job opens on the spec\'s authored hook shot', () => {
  const spec = loadGoldenSpec();
  const tail = { job_id: 'K2', shots: ['S2', 'S3'] };
  const { shotPrompts } = buildSeedanceJobPrompt(tail, spec, { refGroups: REFS });
  assert.ok(!shotPrompts[0].includes(HOOK_PREFIX));
  // hook beat but NOT the episode's first shot → still no prefix
  const spec2 = loadGoldenSpec();
  spec2.shots[1].beat = 'hook';
  const { shotPrompts: sp2 } = buildSeedanceJobPrompt(tail, spec2, { refGroups: REFS });
  assert.ok(!sp2[0].includes(HOOK_PREFIX));
});

test('speaker + tone + @Audio VOICE-IDENTITY note (not "lip-sync to the clip"); skipped when no ref resolves', () => {
  const spec = loadGoldenSpec();
  spec.audio.voice.lines[0].speaker = 'keeper';
  spec.audio.voice.lines[0].tone = 'weary';
  const withRef = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, audioRefFor: (sp) => (sp === 'keeper' ? '@Audio1' : null) });
  assert.match(withRef.prompt, /Keeper says: "Forty years I kept this light\." \(tone: weary\)\./);
  // voice-identity framing keeps the clip (@Audio1) but does NOT tell the model to reproduce it
  assert.match(withRef.prompt, /@Audio1 is the sound of Keeper's voice/);
  assert.match(withRef.prompt, /Keeper speaks ONLY the "…" lines written in the shots below/);
  assert.ok(!/lip-sync Keeper's mouth to it/.test(withRef.prompt), 'the old reproduce-the-clip phrasing is gone');
  assert.deepEqual(withRef.speakers, ['keeper']);
  const noRef = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });
  assert.ok(!noRef.prompt.includes('@Audio'), 'no voice-ref note without an uploaded voice ref');
});

test('multi-character identity clause + per-speaker voice-identity notes', () => {
  const spec = loadGoldenSpec();
  spec.audio.voice.lines = [
    { shot_id: 'S1', text: 'Forty years.', speaker: 'keeper' },
    { shot_id: 'S2', text: 'Time to go.', speaker: 'gull' },
  ];
  const groups = [{ name: 'keeper', refs: ['@Image1'] }, { name: 'gull', refs: ['@Image2'] }];
  const refs = { keeper: '@Audio1', gull: '@Audio2' };
  const { prompt } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: groups, audioRefFor: (sp) => refs[sp] ?? null });
  assert.match(prompt, /Recurring characters: Keeper = @Image1; Gull = @Image2\. Keep each exactly on-model/);
  assert.match(prompt, /@Audio1 is the sound of Keeper's voice/);
  assert.match(prompt, /@Audio2 is the sound of Gull's voice/);
});

test('generate_audio=false drops dialogue, speakers, and voice notes', () => {
  const spec = loadGoldenSpec();
  spec.audio.voice.lines[0].speaker = 'keeper';
  spec.kling.generate_audio = false;
  const { prompt, speakers } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, audioRefFor: () => '@Audio1' });
  assert.ok(!prompt.includes('says:'));
  assert.ok(!prompt.includes('@Audio'));
  assert.deepEqual(speakers, []);
});

test('first-frame pin sentence present only with startFrameRef', () => {
  const spec = loadGoldenSpec();
  const pinned = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, startFrameRef: '@Image3' });
  assert.match(pinned.prompt, /Use @Image3 as the literal first frame of this clip and continue its motion seamlessly forward\./);
  const plain = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });
  assert.ok(!plain.prompt.includes('literal first frame'));
});

test('style, avoid, and text clauses fold into the front matter; textClause replaces the default', () => {
  const spec = loadGoldenSpec();
  const { prompt } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, {
    refGroups: REFS,
    style: 'Rendered in hand-painted watercolor.',
    avoidClause: 'The keeper never wears a hat.',
    textClause: 'Only the word "FIN" may appear on screen.',
  });
  assert.ok(prompt.startsWith('Rendered in hand-painted watercolor.'), 'style directive leads the prompt');
  assert.match(prompt, /The keeper never wears a hat\./);
  assert.match(prompt, /Only the word "FIN" may appear on screen\./);
  assert.ok(!prompt.includes('No on-screen text'), 'custom text rule replaces the strict default');
});

test('spec.assembly.transitions map to connector words', () => {
  const spec = loadGoldenSpec();
  spec.assembly = { transitions: [{ after_shot: 'S1', type: 'match_cut' }, { after_shot: 'S2', type: 'whip' }] };
  const { prompt } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });
  assert.match(prompt, /\nMatch cut to: /);
  assert.match(prompt, /\nWhip pan to: /);
  assert.ok(!prompt.includes('\nCut to: '));
  assert.equal(TRANSITION_WORDS.none, 'Then:');
});

test('nonce: 0 is byte-stable and take-free; >0 injects a deterministic Alternate take directive', () => {
  const spec = loadGoldenSpec();
  const a = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });
  const b = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });
  assert.equal(a.prompt, b.prompt);
  assert.ok(!a.prompt.includes('Alternate take'));
  const t2 = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, nonce: 2 });
  assert.match(t2.prompt, /Alternate take 2: vary the staging, camera framing, and timing/);
  assert.notEqual(t2.prompt, a.prompt);
  const t2again = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, nonce: 2 });
  assert.equal(t2.prompt, t2again.prompt, 'same nonce → same prompt (regen is deterministic)');
});

test('byte clamp: whole prompt fits the budget, front matter survives, tail yields', () => {
  const spec = loadGoldenSpec();
  const full = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });
  const maxBytes = Buffer.byteLength(full.prompt, 'utf8') - 100; // force a trim into the shot tail
  const clamped = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, maxBytes });
  assert.ok(Buffer.byteLength(clamped.prompt, 'utf8') <= maxBytes);
  assert.ok(clamped.prompt.endsWith('…'));
  assert.match(clamped.prompt, /@Image1\/@Image2/); // identity front matter intact
  assert.ok(clamped.prompt.includes(HOOK_PREFIX), 'hook survives — it leads the shot bodies');
});

test('clampBytes never splits a multibyte char and is a no-op under budget', () => {
  assert.equal(clampBytes('short', 100), 'short');
  const s = 'é'.repeat(50); // 2 bytes each
  const out = clampBytes(s, 21);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 21);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('�'));
});

test('throws on unknown shot id / missing content_prompt', () => {
  const spec = loadGoldenSpec();
  assert.throws(() => buildSeedanceJobPrompt({ job_id: 'X', shots: ['NOPE'] }, spec), /not found in spec\.shots/);
  const spec2 = loadGoldenSpec();
  delete spec2.shots[1].kling.content_prompt;
  assert.throws(() => buildSeedanceJobPrompt(spec2.kling.jobs[0], spec2), /missing kling\.content_prompt/);
});
