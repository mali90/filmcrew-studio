// The ONE filename→character rule (src/lib/cast-refs.js), which the engine top-up, the Casting
// agent's inventory listing and the web cast API all resolve ownership through.
//
// The bug it exists to end: ownership asked one name at a time. With two real profiles whose slugs
// prefix one another (ann / ann-marie, jack / jack-jr), "ann-marie-01" answered yes for "ann" too —
// so the top-up attached Ann Marie's face, stamped it `character: 'Ann'`, uploaded it and rendered
// it. Paid, and with nothing on screen to say whose face it was.
import test from 'node:test';
import assert from 'node:assert/strict';

const { refOwner, refBelongsTo } = await import('../../src/lib/cast-refs.js');

test('the id itself, or a dash-bounded prefix of it, is what links a file to a character', () => {
  assert.equal(refOwner('ann', ['ann']), 'ann');
  assert.equal(refOwner('ann-01', ['ann']), 'ann');
  assert.equal(refOwner('annabel-01', ['ann']), null, 'the prefix match is dash-bounded');
  assert.equal(refOwner('prop-cheese', ['ann']), null);
  assert.equal(refOwner('ann-01', []), null, 'an empty roster claims nothing');
});

test('the LONGEST matching slug owns the file', () => {
  const roster = ['ann', 'ann-marie'];
  assert.equal(refOwner('ann-marie-01', roster), 'ann-marie');
  assert.equal(refOwner('ann-marie', roster), 'ann-marie');
  assert.equal(refOwner('ann-01', roster), 'ann');
  // …and roster ORDER cannot change the answer (a `find` over the list could).
  assert.equal(refOwner('ann-marie-01', [...roster].reverse()), 'ann-marie');
});

test('refBelongsTo answers for one character but is asked against the whole roster', () => {
  const roster = ['jack', 'jack-jr'];
  assert.equal(refBelongsTo('jack-jr-01', 'jack', roster), false, 'never the other character\'s face');
  assert.equal(refBelongsTo('jack-jr-01', 'jack-jr', roster), true);
  assert.equal(refBelongsTo('jack-02', 'jack', roster), true);
  // The subject always counts as known — a character owns its images before it owns a profile file,
  // and the cast API deletes a profile while its references stay on disk.
  assert.equal(refBelongsTo('jack-02', 'jack', []), true);
  assert.equal(refBelongsTo('jack-02', '', roster), false, 'no character, no ownership');
  assert.equal(refBelongsTo('jack-02', null, roster), false);
});

test('a Set (what the engine builds) is as good a roster as an array', () => {
  assert.equal(refOwner('ann-marie-02', new Set(['ann', 'ann-marie'])), 'ann-marie');
  assert.equal(refBelongsTo('ann-marie-02', 'ann', new Set(['ann', 'ann-marie'])), false);
});
