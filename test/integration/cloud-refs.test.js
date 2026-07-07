import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';

// config.paths.cache is NOT env-overridable → mutate the config singleton BEFORE importing cloud-refs.
neutralizeDotenv();
const config = (await import('../../config.js')).default;
const { dir, cleanup } = mkTmp('cloudrefs');
config.paths.cache = dir;
const { setCloudRef, getCloudRef, loadCloudRefs } = await import('../../src/lib/cloud-refs.js');

test.after(() => cleanup());

test('set/get a cloud ref and invalidate when the local file changes', () => {
  const local = path.join(dir, 'img.png');
  fs.writeFileSync(local, 'A'); // size 1
  setCloudRef('kling:img.png', 'server_img.png', local);
  assert.equal(getCloudRef('kling:img.png', local), 'server_img.png'); // fresh
  assert.equal(getCloudRef('kling:img.png'), 'server_img.png');        // no localPath → returns file
  assert.equal(loadCloudRefs()['kling:img.png'].size, 1);

  fs.writeFileSync(local, 'AAAA'); // size 4 → fingerprint differs → stale
  assert.equal(getCloudRef('kling:img.png', local), null);
  assert.equal(getCloudRef('missing-key', local), null);
});
