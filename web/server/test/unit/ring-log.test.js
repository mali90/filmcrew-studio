import test from 'node:test';
import assert from 'node:assert/strict';
import { createRingLog } from '../../lib/ring-log.js';

test('cursors are monotone from 1; since(cursor) returns strictly-later lines', () => {
  const log = createRingLog(10);
  assert.equal(log.append('a'), 1);
  assert.equal(log.append('b'), 2);
  assert.equal(log.append('c'), 3);
  assert.deepEqual(log.since(0), [{ cursor: 1, line: 'a' }, { cursor: 2, line: 'b' }, { cursor: 3, line: 'c' }]);
  assert.deepEqual(log.since(2), [{ cursor: 3, line: 'c' }]);
  assert.deepEqual(log.since(3), []);
  assert.equal(log.lastCursor, 3);
});

test('eviction: bounded to max lines, cursors keep increasing, since() never rewinds', () => {
  const log = createRingLog(3);
  for (let i = 1; i <= 5; i++) log.append(`l${i}`);
  assert.equal(log.size, 3);
  assert.deepEqual(log.since(0).map((e) => e.line), ['l3', 'l4', 'l5']);
  assert.deepEqual(log.since(0).map((e) => e.cursor), [3, 4, 5]);
  assert.deepEqual(log.since(4).map((e) => e.line), ['l5']);
  // a cursor older than retention just returns what is retained (no error, no duplicates)
  assert.equal(log.since(1).length, 3);
});
