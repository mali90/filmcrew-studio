// src/lib/cast-groups.js — "who speaks in this job?" and "which images belong to which character?",
// extracted out of fal-kling.js so a provider-neutral renderer can ask them without importing a fal
// module (that import is what dragged config.fal into render-seedance.js's graph).
//
// Two things need pinning that nothing else in the suite asserts directly:
//   1. the extraction is a PURE MOVE — fal-kling.js re-exports the very same function objects, so
//      every existing import path keeps resolving to one implementation;
//   2. the module stays provider-neutral, i.e. it imports no transport. Otherwise the extraction
//      bought nothing.
// The grouping/dedup rules themselves are exercised end to end by the Kling and Seedance render
// tests; they are stated here as unit facts so a regression names the rule it broke.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neutralizeDotenv } from '../helpers/env.js';
neutralizeDotenv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cg = await import('../../src/lib/cast-groups.js');
const falKling = await import('../../src/lib/fal-kling.js');

const spec = (elements, lines = []) => ({ kling: { elements }, audio: { voice: { lines } } });
const JOB = { job_id: 'K1', shots: ['S1', 'S2'] };

// ── the extraction contract ────────────────────────────────────────────────
test('fal-kling.js re-exports the SAME function objects — a pure move, not a copy', () => {
  assert.equal(falKling.characterGroups, cg.characterGroups);
  assert.equal(falKling.jobSpeakers, cg.jobSpeakers);
});

test('cast-groups.js imports no provider transport and no config', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/cast-groups.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')            // strip comments first — the header names fal in prose
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const spec of [...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1])) {
    assert.ok(!/(^|\/)(fal|segmind)[-.]/.test(spec), `must not import "${spec}"`);
    assert.ok(!/config\.js$/.test(spec), `must not import "${spec}"`);
  }
});

// ── jobSpeakers ────────────────────────────────────────────────────────────
test('jobSpeakers: first-seen order and casing, deduped by SLUG, this job\'s shots only', () => {
  const lines = [
    { shot_id: 'S1', speaker: 'The Keeper', text: 'one' },
    { shot_id: 'S2', speaker: 'the keeper', text: 'two' },   // same character, different casing
    { shot_id: 'S2', speaker: 'Gull', text: 'three' },
    { shot_id: 'S9', speaker: 'Crab', text: 'four' },        // another job's shot
  ];
  assert.deepEqual(cg.jobSpeakers(JOB, spec([], lines)), ['The Keeper', 'Gull']);
});

test('jobSpeakers ignores blank lines, missing speakers and a spec with no audio block', () => {
  const lines = [
    { shot_id: 'S1', speaker: 'Keeper', text: '   ' },  // nothing said
    { shot_id: 'S1', speaker: '', text: 'orphan' },     // nobody said it
    { shot_id: 'S1', text: 'no speaker key' },
    { shot_id: 'S1', speaker: 'Gull', text: 'said' },
  ];
  assert.deepEqual(cg.jobSpeakers(JOB, spec([], lines)), ['Gull']);
  assert.deepEqual(cg.jobSpeakers(JOB, { kling: { elements: [] } }), []);
});

// ── characterGroups ────────────────────────────────────────────────────────
test('characterGroups: no `character` field ⇒ ONE group, named after the job\'s sole speaker', () => {
  const els = [{ id: 'a', image: 'a.png' }, { id: 'b', image: 'b.png' }];
  const solo = cg.characterGroups({ ...JOB, elements: ['a', 'b'] }, spec(els, [{ shot_id: 'S1', speaker: 'Keeper', text: 'hi' }]));
  assert.deepEqual(solo, [{ name: 'Keeper', els }]);

  // two speakers (or none) is not a name — the group falls back to 'subject'
  const duet = cg.characterGroups({ ...JOB, elements: ['a', 'b'] }, spec(els, [
    { shot_id: 'S1', speaker: 'Keeper', text: 'hi' }, { shot_id: 'S2', speaker: 'Gull', text: 'ho' },
  ]));
  assert.equal(duet[0].name, 'subject');
  assert.equal(cg.characterGroups({ ...JOB, elements: ['a'] }, spec(els)).length, 1);
});

test('characterGroups: any `character` field ⇒ grouped by character, in first-seen order', () => {
  const els = [
    { id: 'k1', character: 'Keeper', image: 'k1.png' },
    { id: 'g1', character: 'Gull', image: 'g1.png' },
    { id: 'k2', character: 'Keeper', image: 'k2.png' },
    { id: 'x', image: 'x.png' },                          // no character ⇒ grouped under its own id
  ];
  const groups = cg.characterGroups({ ...JOB, elements: ['k1', 'g1', 'k2', 'x'] }, spec(els));
  assert.deepEqual(groups.map((g) => g.name), ['Keeper', 'Gull', 'x']);
  assert.deepEqual(groups[0].els.map((e) => e.id), ['k1', 'k2'], 'a character\'s images stay together');
});

test('characterGroups: an empty job.elements means the WHOLE roster, and a ghost id throws', () => {
  const els = [{ id: 'a', image: 'a.png' }, { id: 'b', image: 'b.png' }];
  assert.deepEqual(cg.characterGroups(JOB, spec(els))[0].els.map((e) => e.id), ['a', 'b']);
  assert.throws(
    () => cg.characterGroups({ ...JOB, elements: ['ghost'] }, spec(els)),
    // the message is provider-neutral now (it used to say "fal job"), and still names both the job
    // and the offending id — a renderer must never silently drop a reference the plan asked for.
    /job K1: element id "ghost" not in spec\.kling\.elements/,
  );
});
