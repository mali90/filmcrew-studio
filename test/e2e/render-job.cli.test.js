import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, jsonTail } from '../helpers/cli.js';
import { mkTmp } from '../helpers/tmp.js';
import { loadGoldenSpec, ONE_PX_PNG } from '../helpers/fixtures.js';
import { startFalServer } from '../helpers/fal-server.js';
import { hasFfmpeg, makeTwoToneClip, pixelRgb } from '../helpers/ffmpeg-clips.js';

const fal = await startFalServer({ videoBytes: Buffer.from('FAKE-MP4') });
test.after(async () => { await fal.close(); });
const FF = await hasFfmpeg();
const needsFfmpeg = FF ? {} : { skip: 'ffmpeg not installed' };

const FAL_ENV = {
  FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_MAX_RETRIES: '1',
  FAL_KLING_ENDPOINT: 'submit',
};

/** A 2-job spec file in `dir`; `firstFrame`/`lastFrame` author K2's boundary frames in the SPEC. */
function twoJobSpec(dir, { firstFrame, lastFrame, name = 'spec.json' } = {}) {
  const spec = loadGoldenSpec();
  spec.kling.jobs = [
    { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
    {
      job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'],
      ...(firstFrame ? { first_frame: firstFrame } : {}), ...(lastFrame ? { last_frame: lastFrame } : {}),
    },
  ];
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(spec));
  return p;
}

const sidecarOf = (runDir, jobId) => JSON.parse(fs.readFileSync(path.join(runDir, jobId, 'prompts.json'), 'utf8'));

/** A prior take dir, i.e. what --seam-from chains K2's opening frame from. */
function priorTake(dir) {
  const takeDir = path.join(dir, 'prior-take');
  fs.mkdirSync(path.join(takeDir, 'K1'), { recursive: true });
  const frame = path.join(takeDir, 'K1', 'last_frame.png');
  fs.writeFileSync(frame, ONE_PX_PNG);
  return { dir: takeDir, frame };
}

test('render-job CLI: re-renders one job of a multi-job spec into --out', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli');
  try {
    const spec = loadGoldenSpec();
    spec.kling.jobs = [
      { job_id: 'K1', shots: ['S1'], elements: ['subject'] },
      { job_id: 'K2', shots: ['S2', 'S3'], elements: ['subject'] },
    ];
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const out = path.join(dir, 't2');
    const { code, stdout } = await runCli('src/cli/render-job.js',
      ['--spec', specPath, '--job', 'K2', '--out', out],
      { env: FAL_ENV });
    assert.equal(code, 0, stdout);
    const r = jsonTail(stdout);
    assert.equal(r.jobId, 'K2');
    assert.deepEqual(r.staleDownstream, []);
    assert.ok(fs.existsSync(r.clip));
    assert.ok(fs.existsSync(path.join(out, 'render.json')));
  } finally { cleanup(); }
});

test('render-job CLI: bad --take and missing --job are usage errors', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-usage');
  try {
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(loadGoldenSpec()));
    const noJob = await runCli('src/cli/render-job.js', ['--spec', specPath], { env: FAL_ENV });
    assert.equal(noJob.code, 1);
    assert.match(noJob.stderr, /--job/);
    const badTake = await runCli('src/cli/render-job.js', ['--spec', specPath, '--job', 'K1', '--take', 'two'], { env: FAL_ENV });
    assert.equal(badTake.code, 1);
    assert.match(badTake.stderr, /--take/);
    // Pinning an end and freeing it are two answers to one question — neither may silently win.
    const bothWays = await runCli('src/cli/render-job.js',
      ['--spec', specPath, '--job', 'K1', '--first-frame-from', path.join(dir, 'pin.png'), '--no-first-frame'], { env: FAL_ENV });
    assert.equal(bothWays.code, 1);
    assert.match(bothWays.stderr, /--no-first-frame contradicts --first-frame-from/);
  } finally { cleanup(); }
});

// ── WS2-P1: boundary-frame and prompt-override flags ────────────────────────────────────────────

test('render-job CLI: --first-frame-from <png> pins the opening frame and claims no lineage', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-pin');
  try {
    const pin = path.join(dir, 'pin.png');
    fs.writeFileSync(pin, ONE_PX_PNG);
    const out = path.join(dir, 't2');
    const { code, stderr } = await runCli('src/cli/render-job.js',
      ['--spec', twoJobSpec(dir), '--job', 'K2', '--out', out, '--first-frame-from', pin],
      { env: FAL_ENV });
    assert.equal(code, 0, stderr);
    const s = sidecarOf(out, 'K2');
    assert.equal(s.seam_in.frame, pin, 'a still is pinned as it is — no frame grab');
    assert.equal(s.seam_in.mode, 'native', 'Kling seeds it through start_image_url');
    assert.equal(s.seam_in.from, null, 'a hand-picked frame is not a continuation of any clip');
  } finally { cleanup(); }
});

test("render-job CLI: --last-frame-from <clip> pins that clip's FIRST frame", needsFfmpeg, async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-endpin');
  try {
    const next = path.join(dir, 'next.mp4');
    await makeTwoToneClip({ out: next, first: 'red', last: 'blue' });
    const out = path.join(dir, 't2');
    const { code, stderr } = await runCli('src/cli/render-job.js',
      ['--spec', twoJobSpec(dir), '--job', 'K1', '--out', out, '--last-frame-from', next],
      { env: FAL_ENV });
    assert.equal(code, 0, stderr);
    // "End where that clip begins": the grab is the neighbour's OPENING half (red), never its close.
    const pinned = path.join(out, 'K1', 'pin_last_frame.png');
    assert.ok(fs.existsSync(pinned), 'a clip is grabbed into a still inside the take dir');
    const [r, g, b] = await pixelRgb(pinned);
    assert.ok(r > 150 && b < 100, `expected the clip's opening (red) frame, got ${r},${g},${b}`);
    assert.equal(sidecarOf(out, 'K1').seam_out.mode, 'native', 'Kling pins the close through end_image_url');
  } finally { cleanup(); }
});

test('render-job CLI: opening-frame precedence — flag > authored first_frame > chained seam', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-precedence');
  try {
    const authored = path.join(dir, 'authored.png');
    const pin = path.join(dir, 'pin.png');
    for (const f of [authored, pin]) fs.writeFileSync(f, ONE_PX_PNG);
    const prior = priorTake(dir);
    const plainSpec = twoJobSpec(dir, { name: 'plain.json' });
    const authoredSpec = twoJobSpec(dir, { firstFrame: authored, name: 'authored.json' });
    const runFor = (out, specPath, extra = []) => runCli('src/cli/render-job.js',
      ['--spec', specPath, '--job', 'K2', '--out', path.join(dir, out), '--seam-from', prior.dir, ...extra],
      { env: FAL_ENV });

    // 3rd — nothing else authored: the chain, recorded WITH the clip it came off.
    const chained = await runFor('chained', plainSpec);
    assert.equal(chained.code, 0, chained.stderr);
    const sChained = sidecarOf(path.join(dir, 'chained'), 'K2');
    assert.equal(sChained.seam_in.frame, prior.frame);
    assert.equal(sChained.seam_in.from?.job, 'K1', 'a chained frame names its source job');

    // 2nd — the spec's own first_frame outranks the chain, and takes the lineage claim with it.
    const spec = await runFor('authored', authoredSpec);
    assert.equal(spec.code, 0, spec.stderr);
    const sSpec = sidecarOf(path.join(dir, 'authored'), 'K2');
    assert.equal(sSpec.seam_in.frame, authored);
    assert.equal(sSpec.seam_in.from, null, 'this clip never opened on the prior take — nothing may say it did');

    // 1st — the flag beats both.
    const flag = await runFor('flag', authoredSpec, ['--first-frame-from', pin]);
    assert.equal(flag.code, 0, flag.stderr);
    const sFlag = sidecarOf(path.join(dir, 'flag'), 'K2');
    assert.equal(sFlag.seam_in.frame, pin);
    assert.equal(sFlag.seam_in.from, null);
  } finally { cleanup(); }
});

// The other answer a caller can give about an end: FREE. A per-job re-render is chosen boundary by
// boundary and priced before it runs — the web dialog says in plain words what each end will do — so
// an omitted pin must not quietly mean "whatever the spec authored", or a join just described as a
// scene cut renders conditioned on a frame anyway. These two flags are how that choice arrives.
// A FULL render is deliberately the other way round: an authored frame is the documented way to seed
// a job, and renderSpec never sends them.
test('render-job CLI: --no-first-frame/--no-last-frame render that end free', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-clear');
  try {
    const authored = path.join(dir, 'authored.png');
    fs.writeFileSync(authored, ONE_PX_PNG);
    const specPath = twoJobSpec(dir, { firstFrame: authored, lastFrame: authored });
    const runFor = (out, extra) => runCli('src/cli/render-job.js',
      ['--spec', specPath, '--job', 'K2', '--out', path.join(dir, out), ...extra], { env: FAL_ENV });

    // The control: both authored frames are what this job renders on when nobody decided otherwise.
    const kept = await runFor('kept', []);
    assert.equal(kept.code, 0, kept.stderr);
    const sKept = sidecarOf(path.join(dir, 'kept'), 'K2');
    assert.equal(sKept.seam_in.frame, authored, 'the spec seeds the opening…');
    assert.equal(sKept.seam_out.mode, 'native', '…and the close');

    const freed = await runFor('freed', ['--no-first-frame', '--no-last-frame']);
    assert.equal(freed.code, 0, freed.stderr);
    const sFreed = sidecarOf(path.join(dir, 'freed'), 'K2');
    assert.equal(sFreed.seam_in.mode, 'none', 'nothing conditions the opening — the join really is a cut');
    assert.equal(sFreed.seam_in.frame, null, 'and the record says so, so no joint is claimed');
    assert.equal(sFreed.seam_out.mode, 'none', 'same at the close');
  } finally { cleanup(); }
});

// The cascade shape, at the CLI: a follow-up job opens on the chain the cascade take is rebuilding
// (--seam-from), which an authored first_frame outranks. Cleared, the chain comes through — with the
// lineage that keeps the joint readable afterwards.
test('render-job CLI: a cleared opening falls through to the --seam-from chain', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-clear-chain');
  try {
    const authored = path.join(dir, 'authored.png');
    fs.writeFileSync(authored, ONE_PX_PNG);
    const prior = priorTake(dir);
    const out = path.join(dir, 't2');
    const { code, stderr } = await runCli('src/cli/render-job.js', [
      '--spec', twoJobSpec(dir, { firstFrame: authored }), '--job', 'K2', '--out', out,
      '--seam-from', prior.dir, '--no-first-frame',
    ], { env: FAL_ENV });
    assert.equal(code, 0, stderr);
    const s = sidecarOf(out, 'K2');
    assert.equal(s.seam_in.frame, prior.frame, "the chained still, not the spec's authored frame");
    assert.equal(s.seam_in.from?.job, 'K1', 'and the joint still names the clip it came off');
  } finally { cleanup(); }
});

test('render-job CLI: a path flag pointing at nothing fails fast, naming the flag', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-missing');
  try {
    const specPath = twoJobSpec(dir);
    const never = path.join(dir, 'never');
    const before = fal.requests.length;
    for (const flag of ['--first-frame-from', '--last-frame-from', '--prompt-overrides']) {
      const { code, stderr } = await runCli('src/cli/render-job.js',
        ['--spec', specPath, '--job', 'K2', '--out', never, flag, '/nope/missing.png'], { env: FAL_ENV });
      assert.equal(code, 1, `${flag} must be refused`);
      assert.match(stderr, new RegExp(flag), 'the message names the flag the user typed');
      assert.match(stderr, /missing\.png/);
    }
    assert.equal(fal.requests.length, before, 'a typo costs no render…');
    assert.ok(!fs.existsSync(never), '…and leaves no run dir behind');
  } finally { cleanup(); }
});

test('render-job CLI: --prompt-overrides is validated up front and snapshotted into the take', async () => {
  const { dir, cleanup } = mkTmp('renderjob-cli-overrides');
  try {
    const specPath = twoJobSpec(dir);
    const overrides = path.join(dir, 'prompt-overrides.json');
    fs.writeFileSync(overrides, JSON.stringify({ schema: 1, jobs: { K2: { prompt: 'A quieter version of the same shot.' } } }));
    const out = path.join(dir, 't2');
    const ok = await runCli('src/cli/render-job.js',
      ['--spec', specPath, '--job', 'K2', '--out', out, '--prompt-overrides', overrides], { env: FAL_ENV });
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(jsonTail(ok.stdout)?.clip, 'the JSON-to-stdout contract is unchanged');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'prompt-overrides.json'), 'utf8')).jobs.K2,
      { prompt: 'A quieter version of the same shot.' });

    const before = fal.requests.length;
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ not json');
    const bad = await runCli('src/cli/render-job.js',
      ['--spec', specPath, '--job', 'K2', '--out', path.join(dir, 'never'), '--prompt-overrides', broken], { env: FAL_ENV });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /not valid JSON/);
    assert.equal(fal.requests.length, before, 'a malformed sidecar is caught before any submit');
  } finally { cleanup(); }
});
