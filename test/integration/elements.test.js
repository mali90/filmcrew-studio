import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { ONE_PX_PNG } from '../helpers/fixtures.js';

// elements dirs read config.elements.*Dir at call time → point them at temp dirs via the config singleton.
neutralizeDotenv();
const config = (await import('../../config.js')).default;
const { dir, cleanup } = mkTmp('elements');
const refs = path.join(dir, 'refs');
fs.mkdirSync(refs, { recursive: true });
fs.writeFileSync(path.join(refs, 'hero.png'), ONE_PX_PNG);
fs.writeFileSync(path.join(refs, 'hero.txt'), 'a brave hero\nignored second line');
config.elements.referencesDir = refs;
config.elements.firstFrameDir = path.join(dir, 'ff'); // empty/absent
config.elements.lastFrameDir = path.join(dir, 'lf');
const { buildInventory, inventoryText, resolveImage } = await import('../../src/lib/elements.js');

test.after(() => cleanup());

test('buildInventory scans references, slugs the id, reads the sidecar description', () => {
  const inv = buildInventory();
  const ref = inv.filter((e) => e.type === 'reference');
  assert.equal(ref.length, 1);
  assert.equal(ref[0].id, 'hero');
  assert.equal(ref[0].description, 'a brave hero');
  assert.match(inventoryText(inv), /id: hero/);
});

test('resolveImage returns an abs path and throws when missing', () => {
  const abs = resolveImage(path.join(refs, 'hero.png'));
  assert.ok(path.isAbsolute(abs) && fs.existsSync(abs));
  assert.throws(() => resolveImage(path.join(refs, 'nope.png')), /not found/);
});
