// WS2-P1 (WS2-07) — the boundary flags on the two render CLIs.
//
//   --first-frame-from <path>   pin this job's OPENING frame. A PNG is used as-is; a CLIP has its
//                               LAST frame grabbed (lastFrameOf) — "start where that clip ended".
//                               Overrides the frame --seam-from would have derived.
//   --last-frame-from <path>    pin the CLOSING frame. A PNG as-is; a CLIP has its FIRST frame
//                               grabbed (firstFrameOf, WS2-03) — "end where that clip begins".
//   --prompt-overrides <file>   path to a prompt-overrides.json sidecar; parsed and validated here,
//                               consumed for real in P4.
//
// On src/cli/render.js the same three apply to the run: --first-frame-from to the FIRST job,
// --last-frame-from to the LAST job, --prompt-overrides to the whole run.
//
// Black-box, through the real CLI (helpers/cli.js blanks every credential), so the JSON-to-stdout
// contract and the fail-fast messages are covered, not just the library call underneath.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';
import { hasFfmpeg, tinyMp4Bytes, makeTwoToneClip } from '../helpers/ffmpeg-clips.js';
import { startFalServer } from '../helpers/fal-server.js';
import { runCli, jsonTail } from '../helpers/cli.js';
import { pending } from '../helpers/tdd.js';

neutralizeDotenv();
const FF = await hasFfmpeg();
const fal = await startFalServer({ videoBytes: FF ? await tinyMp4Bytes() : Buffer.from('FAKE-MP4') });

const work = mkTmp('cli-frames');
const voices = mkTmp('cli-frames-voices');
fs.writeFileSync(path.join(voices.dir, 'voices.json'), '{}');
const REF_PNG = path.join(work.dir, 'ref.png');
const PIN_PNG = path.join(work.dir, 'pin.png');
fs.writeFileSync(REF_PNG, ONE_PX_PNG);
fs.writeFileSync(PIN_PNG, ONE_PX_PNG);

const CHILD_ENV = {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-probe',
  FAL_SEEDANCE_TEXT_ENDPOINT: 'seedance-text',
  SEEDANCE_UPLOAD_MODE: 'data-uri', RENDER_BACKEND: 'seedance-2.0@fal',
  VOICES_DIR: voices.dir, RUNS_DIR: work.dir, OUT_DIR: work.dir, CACHE_DIR: work.dir,
  VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
};

function writeSpec(name, jobs) {
  const spec = loadGoldenSpec();
  spec.render_backend = 'seedance-2.0@fal';
  spec.kling.elements = [{ id: 'subject', role: 'subject', character: 'keeper', image: REF_PNG }];
  spec.kling.jobs = jobs;
  const file = path.join(work.dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}
const TWO_JOBS = [
  { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
  { job_id: 'K2', shots: ['S2'], elements: ['subject'] },
];

// Arm on the flag being parsed at all — cheaper and more honest than spawning a render to find out.
const READY = /['"]first-frame-from['"]/.test(fs.readFileSync(new URL('../../src/cli/render-job.js', import.meta.url), 'utf8'));
const PENDING = pending(READY, 'WS2-07: --first-frame-from/--last-frame-from/--prompt-overrides');
const PENDING_FF = FF ? PENDING : { skip: 'ffmpeg not installed' };

test.after(async () => { await fal.close(); work.cleanup(); voices.cleanup(); });

test('render-job: --first-frame-from <png> pins the opening frame and is recorded as the seam source', PENDING, async () => {
  const spec = writeSpec('rj-first', TWO_JOBS);
  const runDir = path.join(work.dir, 'rj-first-out');
  const before = fal.requests.length;
  const r = await runCli('src/cli/render-job.js', ['--spec', spec, '--job', 'K2', '--out', runDir, '--first-frame-from', PIN_PNG], { env: CHILD_ENV });
  assert.equal(r.code, 0, r.stderr);
  const out = jsonTail(r.stdout);
  assert.equal(out.jobId, 'K2', 'the JSON-to-stdout contract is unchanged');

  const body = JSON.parse(fal.requests.slice(before).find((q) => q.method === 'POST').body);
  assert.equal(body.image_urls.length, 2, 'the pin rides as an extra image ref on fal (soft pin)');
  assert.match(body.prompt, /Use @Image2 as the literal first frame/);
  const side = JSON.parse(fs.readFileSync(path.join(runDir, 'K2', 'prompts.json'), 'utf8'));
  assert.equal(path.basename(side.seam_in.frame), path.basename(PIN_PNG));
});

test('render-job: --first-frame-from BEATS the frame --seam-from would have derived', PENDING, async () => {
  const spec = writeSpec('rj-beats', TWO_JOBS);
  const prior = path.join(work.dir, 'prior-take');
  fs.mkdirSync(path.join(prior, 'K1'), { recursive: true });
  const derived = path.join(prior, 'K1', 'last_frame.png');
  fs.writeFileSync(derived, ONE_PX_PNG);
  const runDir = path.join(work.dir, 'rj-beats-out');
  const r = await runCli('src/cli/render-job.js', [
    '--spec', spec, '--job', 'K2', '--out', runDir, '--seam-from', prior, '--first-frame-from', PIN_PNG,
  ], { env: CHILD_ENV });
  assert.equal(r.code, 0, r.stderr);
  const side = JSON.parse(fs.readFileSync(path.join(runDir, 'K2', 'prompts.json'), 'utf8'));
  assert.equal(path.basename(side.seam_in.frame), path.basename(PIN_PNG), 'the explicit flag wins');
  assert.notEqual(side.seam_in.frame, derived);
  assert.equal(side.seam_in.from, null, 'a hand-picked still points back at no take, job or clip');
});

// WS2-P5: the web layer names the boundary BOTH ways — --seam-from for the take the frame came off,
// --first-frame-from for the frame itself, so the reviewer's choice survives however chainFrames is
// configured. Naming the same frame twice must not cost the lineage: without the recorded source,
// lib/lineage.js reads every re-rendered joint as a scene cut and the seamless stitcher never runs.
test('render-job: --first-frame-from ON the chained frame KEEPS the recorded seam source', PENDING, async () => {
  const spec = writeSpec('rj-same', TWO_JOBS);
  const prior = path.join(work.dir, 'same-take');
  fs.mkdirSync(path.join(prior, 'K1'), { recursive: true });
  const derived = path.join(prior, 'K1', 'last_frame.png');
  fs.writeFileSync(derived, ONE_PX_PNG);
  fs.writeFileSync(path.join(prior, 'render.json'), JSON.stringify({ jobs: [{ jobId: 'K1', clip: path.join(prior, 'K1', 'clip.mp4') }] }));
  const runDir = path.join(work.dir, 'rj-same-out');
  const r = await runCli('src/cli/render-job.js', [
    '--spec', spec, '--job', 'K2', '--out', runDir, '--seam-from', prior, '--first-frame-from', derived,
  ], { env: CHILD_ENV });
  assert.equal(r.code, 0, r.stderr);
  const side = JSON.parse(fs.readFileSync(path.join(runDir, 'K2', 'prompts.json'), 'utf8'));
  assert.equal(side.seam_in.frame, derived);
  assert.equal(side.seam_in.from?.job, 'K1', 'the joint stays readable — this IS the chain, spelled out');
  assert.equal(side.seam_in.from?.take, path.basename(prior));
  assert.equal(side.seam_in.from?.clip, path.join(prior, 'K1', 'clip.mp4'));
});

// The same lineage, one step further out: the pin may name the neighbour's CLIP rather than a still
// beside it — the documented `--first-frame-from <clip>` usage, and what the web layer hands over
// when no closing still was ever written (chaining off, a cleaned or legacy take). The frame comes
// off the same predecessor either way, so the joint must stay readable either way; recording
// `from: null` here is what turned a paid pin into a scene cut.
test('render-job: --first-frame-from <clip> records the clip it was grabbed from', PENDING_FF, async () => {
  const spec = writeSpec('rj-clip-src', TWO_JOBS);
  const jobDir = path.join(work.dir, 'clip-take', 'renders', 't1', 'K1');
  fs.mkdirSync(jobDir, { recursive: true });
  const neighbour = path.join(jobDir, 'clip.mp4');
  await makeTwoToneClip({ out: neighbour, seconds: 1 });
  const runDir = path.join(work.dir, 'rj-clip-src-out');
  const r = await runCli('src/cli/render-job.js', [
    '--spec', spec, '--job', 'K2', '--out', runDir, '--first-frame-from', neighbour,
  ], { env: CHILD_ENV });
  assert.equal(r.code, 0, r.stderr);
  const side = JSON.parse(fs.readFileSync(path.join(runDir, 'K2', 'prompts.json'), 'utf8'));
  assert.equal(path.basename(side.seam_in.frame), 'pin_first_frame.png', "the clip's LAST frame was grabbed");
  assert.deepEqual(side.seam_in.from, { take: 't1', job: 'K1', clip: neighbour },
    'and the clip it came off is on the record, exactly as the chain would have written it');
});

// …but only for a frame that really is that neighbour's CLOSING one. Any other still sitting in a
// take's job dir is a different image, and naming a source for it would claim a continuation the
// clip does not have — the same lie as `from: null`, told the other way round.
test('render-job: another still inside a take dir still points at no source', PENDING, async () => {
  const spec = writeSpec('rj-other-still', TWO_JOBS);
  const jobDir = path.join(work.dir, 'other-take', 'renders', 't1', 'K1');
  fs.mkdirSync(jobDir, { recursive: true });
  const other = path.join(jobDir, 'cover.png');
  fs.writeFileSync(other, ONE_PX_PNG);
  const runDir = path.join(work.dir, 'rj-other-still-out');
  const r = await runCli('src/cli/render-job.js', [
    '--spec', spec, '--job', 'K2', '--out', runDir, '--first-frame-from', other,
  ], { env: CHILD_ENV });
  assert.equal(r.code, 0, r.stderr);
  const side = JSON.parse(fs.readFileSync(path.join(runDir, 'K2', 'prompts.json'), 'utf8'));
  assert.equal(side.seam_in.from, null);
});

// Chaining off (KLING_CHAIN_FRAMES=0) is the other half of the same case: nothing derives a frame,
// so the pin is the ONLY thing that knows which clip this segment continues from.
test('render-job: with chaining disabled the pin alone keeps the joint readable', PENDING, async () => {
  const spec = writeSpec('rj-nochain', TWO_JOBS);
  const jobDir = path.join(work.dir, 'nochain-take', 'renders', 't3', 'K1');
  fs.mkdirSync(jobDir, { recursive: true });
  const frame = path.join(jobDir, 'last_frame.png');
  fs.writeFileSync(frame, ONE_PX_PNG);
  fs.writeFileSync(path.join(jobDir, 'clip.mp4'), 'FAKE-MP4');
  const runDir = path.join(work.dir, 'rj-nochain-out');
  const r = await runCli('src/cli/render-job.js', [
    '--spec', spec, '--job', 'K2', '--out', runDir, '--first-frame-from', frame,
  ], { env: { ...CHILD_ENV, KLING_CHAIN_FRAMES: '0' } });
  assert.equal(r.code, 0, r.stderr);
  const side = JSON.parse(fs.readFileSync(path.join(runDir, 'K2', 'prompts.json'), 'utf8'));
  assert.deepEqual(side.seam_in.from, { take: 't3', job: 'K1', clip: path.join(jobDir, 'clip.mp4') });
});

test('render-job: --last-frame-from <clip> grabs that clip\'s FIRST frame (end where the next one begins)', PENDING_FF, async () => {
  const clip = path.join(work.dir, 'next.mp4');
  await makeTwoToneClip({ out: clip, first: 'red', last: 'blue' });
  const spec = writeSpec('rj-last', TWO_JOBS);
  const runDir = path.join(work.dir, 'rj-last-out');
  const before = fal.requests.length;
  const r = await runCli('src/cli/render-job.js', ['--spec', spec, '--job', 'K1', '--out', runDir, '--last-frame-from', clip], { env: CHILD_ENV });
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(fal.requests.slice(before).find((q) => q.method === 'POST').body);
  assert.match(body.prompt, /literal last frame/, 'the closing pin reached the prompt');
  const side = JSON.parse(fs.readFileSync(path.join(runDir, 'K1', 'prompts.json'), 'utf8'));
  assert.equal(side.seam_out.mode, 'soft');
  assert.ok(side.seam_out.frame, 'the grabbed still is recorded, not just the clip it came from');
});

test('render: --first-frame-from applies to the FIRST job and --last-frame-from to the LAST', PENDING, async () => {
  const spec = writeSpec('rn-both', TWO_JOBS);
  const runDir = path.join(work.dir, 'rn-both-out');
  const before = fal.requests.length;
  const r = await runCli('src/cli/render.js', [
    '--spec', spec, '--out', runDir, '--first-frame-from', PIN_PNG, '--last-frame-from', PIN_PNG,
  ], { env: CHILD_ENV });
  assert.equal(r.code, 0, r.stderr);
  const submits = fal.requests.slice(before).filter((q) => q.method === 'POST');
  const b1 = JSON.parse(submits[0].body);
  const b2 = JSON.parse(submits[1].body);
  assert.match(b1.prompt, /literal first frame/, 'K1 opens on the given frame');
  assert.ok(!/literal last frame/.test(b1.prompt), 'K1 is not the last job');
  assert.match(b2.prompt, /literal last frame/, 'K2 closes on the given frame');
});

test('both CLIs fail FAST with a clear message when a frame path does not exist', PENDING, async () => {
  const spec = writeSpec('rj-missing', TWO_JOBS);
  const before = fal.requests.length;
  for (const [script, args] of [
    ['src/cli/render-job.js', ['--spec', spec, '--job', 'K2', '--first-frame-from', '/nope/missing.png']],
    ['src/cli/render-job.js', ['--spec', spec, '--job', 'K2', '--last-frame-from', '/nope/missing.png']],
    ['src/cli/render.js', ['--spec', spec, '--first-frame-from', '/nope/missing.png']],
  ]) {
    const r = await runCli(script, args, { env: CHILD_ENV });
    assert.notEqual(r.code, 0, `${script} must reject a missing frame path`);
    assert.match(r.stderr, /missing\.png/, 'the message names the path the user typed');
  }
  assert.equal(fal.requests.slice(before).filter((q) => q.method === 'POST').length, 0,
    'nothing was submitted — a bad flag must never cost money');
});

test('--prompt-overrides is parsed and validated before any submit', PENDING, async () => {
  const spec = writeSpec('rj-overrides', TWO_JOBS);
  const good = path.join(work.dir, 'prompt-overrides.json');
  fs.writeFileSync(good, JSON.stringify({ schema: 1, jobs: { K2: { prompt: 'A quieter version of the same shot.' } } }));
  const runDir = path.join(work.dir, 'rj-overrides-out');
  const ok = await runCli('src/cli/render-job.js', ['--spec', spec, '--job', 'K2', '--out', runDir, '--prompt-overrides', good], { env: CHILD_ENV });
  assert.equal(ok.code, 0, ok.stderr);

  const before = fal.requests.length;
  const bad = path.join(work.dir, 'broken-overrides.json');
  fs.writeFileSync(bad, '{ not json');
  const r1 = await runCli('src/cli/render-job.js', ['--spec', spec, '--job', 'K2', '--prompt-overrides', bad], { env: CHILD_ENV });
  assert.notEqual(r1.code, 0);
  const r2 = await runCli('src/cli/render-job.js', ['--spec', spec, '--job', 'K2', '--prompt-overrides', '/nope/overrides.json'], { env: CHILD_ENV });
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /overrides\.json/);
  assert.equal(fal.requests.slice(before).filter((q) => q.method === 'POST').length, 0);
});

test('the header usage comments document all three flags (the CLI is the docs here)', PENDING, () => {
  for (const rel of ['../../src/cli/render-job.js', '../../src/cli/render.js']) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const header = src.slice(0, src.indexOf('import '));
    for (const flag of ['--first-frame-from', '--last-frame-from', '--prompt-overrides']) {
      assert.ok(header.includes(flag), `${rel}'s header usage block must document ${flag}`);
    }
  }
});
