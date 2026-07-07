import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../src/lib/args.js';

test('flags with values, boolean flags, and positionals', () => {
  assert.deepEqual(parseArgs(['--brief', 'hello', '--render', '--probe']), { _: [], brief: 'hello', render: true, probe: true });
  assert.deepEqual(parseArgs(['file.json', '--upscale']), { _: ['file.json'], upscale: true });
  assert.deepEqual(parseArgs(['--factor', '2']), { _: [], factor: '2' });
  assert.deepEqual(parseArgs([]), { _: [] });
});

test('a trailing --flag (no following value) is true', () => {
  assert.deepEqual(parseArgs(['--x']), { _: [], x: true });
});

test('a --flag followed by another --flag is true (not consumed)', () => {
  const a = parseArgs(['--a', '--b', 'val']);
  assert.equal(a.a, true);
  assert.equal(a.b, 'val');
});
