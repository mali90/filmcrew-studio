// WHOSE ffprobe answers for a voice clip — the render child's, never this server's.
//
// Seedance 2.5 on Segmind states a 2s FLOOR for a reference audio clip (render-models.js
// `audioPerClipS`), so `fitAudioRef` DROPS a shorter one rather than pay for a 422. That makes a
// clip's duration a PROMPT input: it decides the @Audio labels, the bytes, and how many of the
// model's reference slots the job spends. The preview's whole claim is that those are the ones the
// paid render will carry.
//
// The two processes do not share an environment. The render child reads `FFPROBE_BIN` out of the
// run's .env (through dotenv + config.js); this server started with whatever the developer's shell
// had. Where only the configured binary can read the clip — an ffmpeg build kept outside PATH, the
// usual reason to set the knob at all — a probe bound to the SERVER's config answers for the wrong
// machine, and the preview keeps an @Audio reference the render deterministically drops.
//
// The fakes below are the whole point: each one is a working ffprobe for exactly one answer, and it
// records that it was called. A test that only asserted the drop could pass on a machine whose real
// ffprobe happens to fail — the call log is what proves WHICH binary was asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { neutralizeDotenv } = await import(path.join(HOST_ROOT, 'test/helpers/env.js'));
neutralizeDotenv();
const { goldenSpec } = await import(path.join(HOST_ROOT, 'test/helpers/golden-spec.js'));
const { buildPromptViews } = await import('../../lib/prompt-service.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kva-prompt-probe-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const runDir = path.join(tmpRoot, 'run');
const envRoot = path.join(tmpRoot, 'env');
const voicesDir = path.join(tmpRoot, 'voices');
const binDir = path.join(tmpRoot, 'bin');
for (const d of [runDir, envRoot, voicesDir, binDir]) fs.mkdirSync(d, { recursive: true });

// One minted speaker whose clip is NOT readable by any real ffprobe: an unprobeable clip is KEPT
// (the renderer's own "send it as-is" fallback), so every drop below is the fake's answer, not a
// lucky failure.
const clip = path.join(voicesDir, 'ana.mp3');
fs.writeFileSync(clip, 'ID3');
fs.writeFileSync(path.join(voicesDir, 'voices.json'), JSON.stringify({
  ana: { name: 'ana', voice_id: 'v-ana', ref_clip: clip, minted_at: null },
}, null, 2));

/** A stand-in ffprobe that always reports `durationS` and appends every call to its own log. */
function fakeFfprobe(name, durationS) {
  const file = path.join(binDir, `${name}.mjs`);
  const log = path.join(binDir, `${name}.calls`);
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
    `process.stdout.write(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '${durationS}' } }));`,
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return {
    file,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

// 0.8s is under Segmind's 2s floor (dropped); 5s sits inside the window (kept). Same clip, same
// spec — only the binary that answers for it differs.
const tooShort = fakeFfprobe('ffprobe-short', '0.800000');
const longEnough = fakeFfprobe('ffprobe-long', '5.000000');

/** One reference-to-video job (a cast image is what makes voice refs ride) with a line for `ana`. */
function specWithAna() {
  const spec = goldenSpec();
  spec.kling.elements = [{ id: 'c1', role: 'subject', image: 'elements/references/c1.png' }];
  spec.kling.jobs = [{ job_id: 'K1', shots: ['S1'], elements: ['c1'] }];
  spec.audio.voice.lines = [{ shot_id: 'S1', speaker: 'ana', text: 'the lamp still turns' }];
  return spec;
}

const preview = async (childEnv = {}) => (await buildPromptViews({
  root: HOST_ROOT, envRoot, childEnv, runDir, spec: specWithAna(), backend: 'seedance-2.5@segmind', voicesDir,
})).prompts[0];

const voiceRefs = (view) => view.refs.filter((r) => r.role === 'voice').map((r) => r.character);

const writeEnv = (line) => fs.writeFileSync(path.join(envRoot, '.env'), `# isolated\n${line}\n`);

test('the run\'s FFPROBE_BIN decides whether a voice clip rides — a sub-floor clip is dropped', async () => {
  writeEnv(`FFPROBE_BIN=${tooShort.file}`);
  const view = await preview();

  assert.deepEqual(tooShort.calls().map((c) => path.basename(c.split(' ').at(-1))), ['ana.mp3'],
    'the binary the RUN configured is the one that probed the clip');
  assert.equal(view.error ?? null, null);
  assert.deepEqual(voiceRefs(view), [], 'a 0.8s clip is under Segmind 2.5\'s 2s floor — the render drops it, so the preview must too');
  assert.doesNotMatch(view.prompt, /@Audio/, 'and the prompt cites no reference the wire will not carry');
});

test('…and the same clip rides when that binary reports a duration inside the window', async () => {
  writeEnv(`FFPROBE_BIN=${longEnough.file}`);
  const view = await preview();

  assert.equal(longEnough.calls().length, 1, 'the run\'s binary answered again — nothing was cached across previews');
  assert.deepEqual(voiceRefs(view), ['ana'], 'a 5s clip fits the window, so the render sends it');
  assert.match(view.prompt, /@Audio ?1/, 'and the prompt cites it');
});

test('childEnv beats the .env, exactly as dotenv leaves an already-set variable alone', async () => {
  writeEnv(`FFPROBE_BIN=${longEnough.file}`);
  const before = tooShort.calls().length;
  const view = await preview({ FFPROBE_BIN: tooShort.file });

  assert.equal(tooShort.calls().length, before + 1, 'the spawned child would get the pinned binary — so does the preview');
  assert.deepEqual(voiceRefs(view), [], 'and its answer is the one the prompt is built on');
});

// A relative FFPROBE_BIN means "under the project root" to the render child, because every child
// this server spawns runs with cwd = root (run-service). The server's own cwd is not the child's,
// so a preview that resolved it against process.cwd() would probe a path that exists on neither.
test('a relative FFPROBE_BIN resolves against the project ROOT, not the server\'s cwd', async () => {
  const { ffprobeBinFor } = await import(path.join(HOST_ROOT, 'src/lib/ffprobe.js'));
  assert.equal(ffprobeBinFor('./tools/ffprobe', HOST_ROOT), path.join(HOST_ROOT, 'tools/ffprobe'));
  assert.equal(ffprobeBinFor('/opt/ff/ffprobe', HOST_ROOT), '/opt/ff/ffprobe', 'an absolute path is left alone');
  assert.equal(ffprobeBinFor('ffprobe7', HOST_ROOT), 'ffprobe7', 'a BARE name stays a PATH lookup — <root>/ffprobe7 is a file nowhere');
  assert.equal(ffprobeBinFor('', HOST_ROOT), 'ffprobe', 'unset is config.js\'s own default');
});
