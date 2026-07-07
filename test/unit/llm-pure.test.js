import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, renderTemplate } from '../../src/lib/llm.js';

test('extractJson: fenced block, bare object with prose, nested braces', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('here you go: {"x":{"y":2}} thanks'), { x: { y: 2 } });
  assert.deepEqual(extractJson('{"n":3}'), { n: 3 });
});

test('extractJson throws when there is no object', () => {
  assert.throws(() => extractJson('no json here'), /No JSON object/);
});

test('renderTemplate substitutes {{var}} and blanks missing vars', () => {
  assert.equal(renderTemplate('{{a}}-{{b}}', { a: 'x' }), 'x-');
  assert.equal(renderTemplate('none here', {}), 'none here');
});
