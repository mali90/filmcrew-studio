import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { neutralizeDotenv } from '../helpers/env.js';
import { ROOT, loadGoldenSpec } from '../helpers/fixtures.js';
neutralizeDotenv();
// This file pins the DEFAULT whole-prompt path, which is now uncapped. config.js snapshots the
// environment at import, so an inherited shell value would silently re-cap it and the assertions
// below would pass for the wrong reason. The env-SET half lives in seedance-prompt-cap.test.js:
// one process can only snapshot one value.
delete process.env.SEEDANCE_PROMPT_MAX_BYTES;
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

// ── The whole-prompt clamp is OFF by default ────────────────────────────────────────────────────
// Nothing checkable documents a prompt-length limit for Seedance (Segmind's 2.0/2.5 API pages state
// none, fal's published Seedance schemas put no maxLength on `prompt`, and ByteDance only
// RECOMMENDS staying under ~1000 words), so the 5000-byte default was self-imposed
// and long multi-shot prompts were being shortened before anyone could see it. Uncapped is now the
// default; SEEDANCE_PROMPT_MAX_BYTES remains the lever for anyone who meets a provider 422.

/** The golden spec's K1 with ~7 KB of scene prose per shot — a prompt no 5000-byte cap survives. */
function hugeSpec() {
  const spec = loadGoldenSpec();
  for (const shot of spec.shots) {
    shot.kling.content_prompt = `${shot.kling.content_prompt} ${'The rain keeps coming in off the water. '.repeat(175)}`.trim();
  }
  return spec;
}

test('UNCAPPED by default: a ~20 KB multi-shot prompt reaches the wire byte for byte', () => {
  const spec = hugeSpec();
  const { prompt, front, shotPrompts } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS });

  // The exact document the composer assembles — front matter, blank line, the shot blocks joined by
  // their connectors. Nothing between that and the provider may re-cut it.
  assert.equal(prompt, `${front}\n\n${shotPrompts.join('\nCut to: ')}`, 'the prompt IS the assembled document, unclamped');
  assert.ok(Buffer.byteLength(prompt, 'utf8') > 20000, `a 20 KB prompt survives whole (got ${Buffer.byteLength(prompt, 'utf8')} B)`);
  // The clamp's marker only ever lands at the END — the speech rule quotes a literal `says: "…"`, so
  // an `includes` here would report a cut that never happened.
  assert.ok(!prompt.endsWith('…'), 'nothing was cut, so nothing marks a cut');
  for (const block of shotPrompts) assert.ok(prompt.includes(block), 'every shot body is present verbatim');
});

test('docs/PROMPTS.md does not still publish a Seedance byte cap the code no longer applies', () => {
  // A number in the docs outlives the code that produced it, and this one is the whole promise:
  // a user who reads "capped at 5000" writes short prompts for a limit that is not there.
  const doc = fs.readFileSync(path.join(ROOT, 'docs/PROMPTS.md'), 'utf8');
  const seedanceRows = doc.split('\n').filter((l) => /^\|\s*`seedance-/.test(l));
  assert.ok(seedanceRows.length >= 2, 'the byte-budget table still has a row per Seedance model');
  for (const row of seedanceRows) {
    assert.ok(!/\d+\s*B\b/.test(row), `a Seedance row still quotes a byte budget: ${row.trim()}`);
    assert.match(row, /SEEDANCE_PROMPT_MAX_BYTES/, 'and the knob is still named — it is the lever for a provider 422');
  }
  // Kling's row is a REAL cap (fal's o3 schema) and must survive untouched.
  const klingRow = doc.split('\n').find((l) => /^\|\s*`kling-o3@fal`/.test(l));
  assert.match(klingRow ?? '', /500 B per shot segment/);
  assert.match(klingRow ?? '', /KLING_SEGMENT_MAX_BYTES/);
  assert.ok(!/`SEEDANCE_PROMPT_MAX_BYTES`,?\s*default 5000/.test(doc), 'the removed default is not still described as one');
});

test('clampBytes with NO cap is a no-op — 0 or a missing budget must never empty a paid prompt', () => {
  // Belt and braces behind promptCapOf: 0 is the uncapped sentinel now, and the old arithmetic
  // turned it into a lone ellipsis. clampBytes is re-exported publicly (src/lib/seedance.js), so a
  // caller outside this repo can hand it either shape.
  const long = 'x'.repeat(9000);
  for (const noCap of [0, undefined, null, NaN, -1, '', 'nonsense']) {
    assert.equal(clampBytes(long, noCap), long, `clampBytes(s, ${JSON.stringify(noCap)}) must return s untouched`);
  }
  assert.equal(clampBytes('short', 0), 'short');
});

// ── shot syntax: 'connectors' (Seedance 2.0) vs 'numbered' (Seedance 2.5, BOTH providers) ────────
// Seedance 2.5's documented prompt form numbers its shots ("Shot 1: …", "Shot 2: …") instead of
// joining them with transition connectors. Which form a model wants is DATA (caps.shotSyntax) that
// render-seedance.js forwards — so this pure builder learns one option and no renderer forks.

test('shotSyntax "numbered": Shot N: prefixes, no connector words, raw shotPrompts unchanged', () => {
  const spec = loadGoldenSpec();
  const { prompt, shotPrompts, totalDuration } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, {
    refGroups: REFS, shotSyntax: 'numbered',
  });
  assert.equal(shotPrompts.length, 3);
  assert.match(prompt, /\bShot 1: /);
  assert.match(prompt, /\nShot 2: /);
  assert.match(prompt, /\nShot 3: /);
  assert.ok(!prompt.includes('\nCut to: '), 'numbered shots carry no connector word');
  assert.equal((prompt.match(/Shot \d+: /g) ?? []).length, 3, 'exactly one prefix per shot');
  // the sidecar/preview contract: shotPrompts stay the RAW blocks — the numbering is a joining
  // decision, not part of a shot's authored prose.
  for (const b of shotPrompts) assert.ok(!/^Shot \d+: /.test(b), `"${b.slice(0, 24)}…" must not carry the prefix`);
  assert.ok(prompt.includes(shotPrompts[1]), 'the raw block text still appears verbatim in the prompt');
  assert.equal(totalDuration, 13, 'the duration derivation is untouched by the syntax');
});

test('numbered mode keeps every front-matter clause and the hook directive', () => {
  const spec = loadGoldenSpec();
  const { prompt } = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, {
    refGroups: REFS, shotSyntax: 'numbered', startFrameRef: '[Image3]',
  });
  assert.match(prompt, /All shots feature the SAME character — Keeper/);
  assert.match(prompt, /No on-screen text/);
  assert.match(prompt, /Use \[Image3\] as the literal first frame of this clip/);
  assert.ok(prompt.includes(HOOK_PREFIX));
  // authored transitions are IGNORED in numbered mode — the model's own syntax wins
  const withTrans = loadGoldenSpec();
  withTrans.assembly = { transitions: [{ after_shot: 'S1', type: 'match_cut' }] };
  const t = buildSeedanceJobPrompt(withTrans.kling.jobs[0], withTrans, { refGroups: REFS, shotSyntax: 'numbered' });
  assert.ok(!t.prompt.includes('Match cut to:'));
  assert.match(t.prompt, /\nShot 2: /);
});

// ── BYTE-COMPAT GATE for the fal Seedance 2.0 payload ────────────────────────
// Adding an option must not move the shipping prompt by a single byte. The hash pins the golden
// spec's prompt as it is TODAY; `shotSyntax` omitted and `shotSyntax:'connectors'` must both
// reproduce it. If this fails, the fal 2.0 render payload changed — that is a regression, not a
// test to update (regenerate the hash only when a deliberate prompt change is being shipped).
test('shotSyntax omitted / "connectors" is byte-identical to the shipped Seedance 2.0 prompt', () => {
  const spec = loadGoldenSpec();
  const shipped = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS }).prompt;
  const sha = createHash('sha256').update(shipped, 'utf8').digest('hex');
  assert.equal(sha, 'c5b81fb820e5c3f8f6309d5fd118eb87ca85a626865836033615f1fe5a56c5a5', 'the fal Seedance 2.0 prompt must not move');
  assert.equal(Buffer.byteLength(shipped, 'utf8'), 1353);

  const explicit = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, shotSyntax: 'connectors' }).prompt;
  assert.equal(explicit, shipped, "'connectors' is the default, stated");
  // an unknown syntax degrades to the shipping form rather than emitting a broken prompt
  const unknown = buildSeedanceJobPrompt(spec.kling.jobs[0], spec, { refGroups: REFS, shotSyntax: 'nonsense' }).prompt;
  assert.equal(unknown, shipped);
});

test('throws on unknown shot id / missing content_prompt', () => {
  const spec = loadGoldenSpec();
  assert.throws(() => buildSeedanceJobPrompt({ job_id: 'X', shots: ['NOPE'] }, spec), /not found in spec\.shots/);
  const spec2 = loadGoldenSpec();
  delete spec2.shots[1].kling.content_prompt;
  assert.throws(() => buildSeedanceJobPrompt(spec2.kling.jobs[0], spec2), /missing kling\.content_prompt/);
});

// Only a cap that is SET can endanger a saved edit, and then only through front matter the SAVE
// could not see coming — so this case pins its own cap (MAX) rather than leaning on a default.
// `--take`/`--feedback` are exactly that unseeable growth: they are re-render knobs, so the editor's
// byte meter (a full render from the plan) never charged for them.
test('an edit that fills the plan render\'s budget is REFUSED on a re-render that grows the front matter', () => {
  const spec = loadGoldenSpec();
  const job = spec.kling.jobs[0];
  const MAX = 1200;
  const base = { refGroups: REFS, maxBytes: MAX };
  const utf8 = (s) => Buffer.byteLength(s, 'utf8');

  // An edit written right up to the room the editor showed for a full render from the plan.
  const room = MAX - utf8(buildSeedanceJobPrompt(job, spec, base).front) - utf8('\n\n');
  const override = { prompt: 'z'.repeat(room) };

  const fits = buildSeedanceJobPrompt(job, spec, { ...base, override });
  assert.equal(utf8(fits.prompt), MAX, 'it fits the cap exactly');
  assert.ok(fits.prompt.endsWith('z'.repeat(room)), 'and every byte of it is what gets sent');

  // The SAME words on an "Alternate take 2" with a director note: the front matter grew underneath
  // them. Clamping would drop the tail of a paid prompt, so the render refuses before it submits.
  assert.throws(
    () => buildSeedanceJobPrompt(job, spec, { ...base, override, nonce: 2, feedback: 'hold the last beat longer' }),
    /K1: the saved prompt edit no longer fits — it is \d+ byte\(s\) over/,
  );
});
