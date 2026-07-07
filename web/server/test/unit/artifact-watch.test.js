import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { listArtifacts, watchRun } from '../../lib/artifact-watch.js';

const mkTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-watch-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const write = (dir, rel, content = 'x') => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

test('listArtifacts: spec blocks, take clips/render.json/cover, revision blocks — nothing else', () => {
  const t = mkTmp();
  try {
    write(t.dir, 'spec-00.json');
    write(t.dir, 'spec-07-qc1.json');
    write(t.dir, 'spec.json');
    write(t.dir, 'web.json');                       // manifest is not an announced artifact
    write(t.dir, 'renders/t1/K1/clip.mp4');
    write(t.dir, 'renders/t1/render.json');
    write(t.dir, 'renders/t1/cover.png');
    write(t.dir, 'renders/t1/K1/prompts.json');      // sidecar: not announced
    write(t.dir, 'revisions/r1/spec-r02.json');
    const got = listArtifacts(t.dir).sort();
    assert.deepEqual(got, [
      'renders/t1/K1/clip.mp4',
      'renders/t1/cover.png',
      'renders/t1/render.json',
      'revisions/r1/spec-r02.json',
      'spec-00.json',
      'spec-07-qc1.json',
      'spec.json',
    ].sort());
  } finally { t.cleanup(); }
});

test('watchRun: emits once per NEW artifact; the baseline sweep is silent; stop() stops', async () => {
  const t = mkTmp();
  try {
    write(t.dir, 'spec-00.json');
    const events = [];
    const w = watchRun(t.dir, { intervalMs: 25, onEvent: (e) => events.push(e) });
    await sleep(60);
    assert.equal(events.length, 0, 'existing files are not news');
    write(t.dir, 'spec-01.json');
    write(t.dir, 'renders/t1/K1/clip.mp4');
    await sleep(80);
    const files = events.map((e) => e.file).sort();
    assert.deepEqual(files, ['renders/t1/K1/clip.mp4', 'spec-01.json']);
    w.stop();
    write(t.dir, 'spec-02.json');
    await sleep(60);
    assert.equal(events.length, 2, 'no events after stop');
  } finally { t.cleanup(); }
});
