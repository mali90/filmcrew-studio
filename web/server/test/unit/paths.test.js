import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isRunId, safeChild } from '../../lib/paths.js';

test('isRunId: accepts CLI and web run-dir names, rejects anything path-like', () => {
  for (const ok of ['web-20260704120000-a1b2', 'engine-20260101-xy', 'render-1-2', 'test-sample', 'A.b_c-9']) {
    assert.equal(isRunId(ok), true, ok);
  }
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a..b/..', 'x'.repeat(200), 'a b', 'a%2fb', '-lead']) {
    assert.equal(isRunId(bad), false, JSON.stringify(bad));
  }
});

test('safeChild: joins inside the base, throws on any traversal escape', () => {
  const base = '/tmp/runs';
  assert.equal(safeChild(base, 'web-1', 'spec.json'), path.join(base, 'web-1/spec.json'));
  assert.equal(safeChild(base, 'web-1', 'renders/t1/K1/clip.mp4'), path.join(base, 'web-1/renders/t1/K1/clip.mp4'));
  for (const bad of [['..'], ['web-1', '../../etc/passwd'], ['web-1', '/abs'], ['web-1', 'a/../../..'], ['web-1', '..\\..\\x']]) {
    assert.throws(() => safeChild(base, ...bad), /outside|traversal|invalid/i, JSON.stringify(bad));
  }
});
