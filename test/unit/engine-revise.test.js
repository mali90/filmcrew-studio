import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeDotenv } from '../helpers/env.js';
import { loadGoldenSpec } from '../helpers/fixtures.js';
neutralizeDotenv();
const { ownersForScope, parseRouterTags, scopeShots } = await import('../../src/lib/engine.js');

test('ownersForScope: block names map to their owning agent, whole/unknown → null (use the router)', () => {
  assert.deepEqual(ownersForScope('jobs'), [6]);
  assert.deepEqual(ownersForScope('audio'), [5]);
  assert.deepEqual(ownersForScope('content'), [2]);
  assert.deepEqual(ownersForScope('project'), [0]);
  assert.equal(ownersForScope('whole'), null);
  assert.equal(ownersForScope(undefined), null);
  assert.equal(ownersForScope('K2'), null); // a job id is a WHERE, not a WHO — router decides
});

test('parseRouterTags: JSON {tags:[...]} wins, inline [tag] markers fall back, garbage → []', () => {
  assert.deepEqual(parseRouterTags('{"tags":["content","camera"]}'), [2, 3]);
  assert.deepEqual(parseRouterTags('Sure! {"tags": ["audio"]}'), [5]);
  assert.deepEqual(parseRouterTags('route to [shots] and [audio] please'), [1, 5]);
  assert.deepEqual(parseRouterTags('{"tags":["nonsense","shots"]}'), [1], 'unknown tags dropped');
  assert.deepEqual(parseRouterTags('no tags anywhere'), []);
  assert.deepEqual(parseRouterTags(''), []);
  assert.deepEqual(parseRouterTags('{"tags":["content","content","shots"]}'), [1, 2], 'de-duped and sorted');
});

test('scopeShots: a job id resolves to its shots, anything else → null', () => {
  const spec = loadGoldenSpec();
  assert.deepEqual(scopeShots(spec, 'K1'), ['S1', 'S2', 'S3']);
  assert.equal(scopeShots(spec, 'K9'), null);
  assert.equal(scopeShots(spec, 'whole'), null);
  assert.equal(scopeShots(spec, undefined), null);
});
