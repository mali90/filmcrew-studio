import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../helpers/cli.js';
import { startFalServer } from '../helpers/fal-server.js';
import { mkTmp } from '../helpers/tmp.js';

const fal = await startFalServer({});
test.after(async () => { await fal.close(); });

test('mint-voice mints against the mock and writes voices.json', async () => {
  const { dir, cleanup } = mkTmp('mint-cli');
  try {
    const clip = path.join(dir, 'ref.wav'); fs.writeFileSync(clip, 'RIFFxxxxWAVE');
    const voicesDir = path.join(dir, 'voices');
    const { code, stderr } = await runCli('src/cli/mint-voice.js', ['host', clip], {
      env: {
        FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri',
        FAL_CREATE_VOICE_ENDPOINT: 'create-voice', FAL_MAX_RETRIES: '1', VOICES_DIR: voicesDir,
      },
    });
    assert.equal(code, 0, stderr);
    const reg = JSON.parse(fs.readFileSync(path.join(voicesDir, 'voices.json'), 'utf8'));
    assert.equal(reg.host.voice_id, 'voice_abc');
    // Seedance lip-sync depends on the clip surviving mint: a copy is kept next to the registry
    // and ref_clip must round-trip (repo-relative path → existing file with the same bytes).
    assert.ok(reg.host.ref_clip, 'ref_clip recorded');
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const kept = path.isAbsolute(reg.host.ref_clip) ? reg.host.ref_clip : path.resolve(repoRoot, reg.host.ref_clip);
    assert.ok(fs.existsSync(kept), `kept clip exists: ${kept}`);
    assert.equal(path.basename(kept), 'host.wav');
    assert.equal(fs.readFileSync(kept, 'utf8'), 'RIFFxxxxWAVE', 'copy preserves the clip bytes');
  } finally { cleanup(); }
});
