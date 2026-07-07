import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
neutralizeDotenv();
const { uniqueOutPath } = await import('../../src/lib/pipeline.js');

test('uniqueOutPath: first render gets the plain name, repeats get -2, -3, … (never overwrite)', () => {
  const { dir, cleanup } = mkTmp('outpath');
  try {
    assert.equal(uniqueOutPath(dir, 'ocean'), path.join(dir, 'ocean.mp4'));
    fs.writeFileSync(path.join(dir, 'ocean.mp4'), 'x');
    assert.equal(uniqueOutPath(dir, 'ocean'), path.join(dir, 'ocean-2.mp4'));
    fs.writeFileSync(path.join(dir, 'ocean-2.mp4'), 'x');
    assert.equal(uniqueOutPath(dir, 'ocean'), path.join(dir, 'ocean-3.mp4'));
    // unrelated names unaffected
    assert.equal(uniqueOutPath(dir, 'lighthouse'), path.join(dir, 'lighthouse.mp4'));
  } finally { cleanup(); }
});
