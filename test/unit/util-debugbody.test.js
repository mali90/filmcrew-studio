// debugBody: error bodies for humans and manifests — echoed request inputs are dropped (fal's 422
// echoes the WHOLE body, base64 frames included) and the result is capped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { debugBody } from '../../src/lib/util.js';

test('drops echoed `input` payloads (a 422 must never write megabytes into render.json)', () => {
  const falBody = {
    detail: [{
      loc: ['body'],
      msg: 'multiPrompt[0].prompt: size must be between 0 and 512',
      type: 'input_value_error',
      input: { prompt: null, start_image_url: `data:image/png;base64,${'A'.repeat(5_000_000)}` },
    }],
  };
  const out = debugBody(falBody);
  assert.ok(out.length <= 2000, `capped (got ${out.length})`);
  assert.match(out, /size must be between 0 and 512/, 'the human-readable reason survives');
  assert.match(out, /\[input omitted\]/);
  assert.ok(!out.includes('base64'), 'no echoed payload');
});

test('strings pass through capped; null is empty', () => {
  assert.equal(debugBody('plain error'), 'plain error');
  assert.equal(debugBody('x'.repeat(3000)).length, 2000);
  assert.equal(debugBody(null), '');
});
