import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, jsonTail } from '../helpers/cli.js';
import { startFalServer } from '../helpers/fal-server.js';
import { hasFfmpeg, tinyMp4Bytes } from '../helpers/ffmpeg-clips.js';
import { mkTmp } from '../helpers/tmp.js';
import { ROOT } from '../helpers/fixtures.js';

const FAKE = path.join(ROOT, 'test/helpers/fake-llm.mjs');
fs.chmodSync(FAKE, 0o755);
const FF = await hasFfmpeg();
const fal = await startFalServer({ videoBytes: Buffer.from('MP4') });
test.after(async () => { await fal.close(); });

// 'TWO-JOB' in the brief makes the fake LLM plan two jobs — probes only exist on multi-job plans.
test('engine --brief --render --probe: fake LLM plans two jobs, mock fal renders the first', async () => {
  const { dir, cleanup } = mkTmp('engine-cli');
  try {
    const { code, stdout } = await runCli('src/cli/engine.js',
      ['--brief', 'a lighthouse keeper at dusk TWO-JOB', '--render', '--probe', '--out', dir],
      { env: {
        LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
        FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_KLING_ENDPOINT: 'submit', FAL_MAX_RETRIES: '1',
      } });
    assert.equal(code, 0, stdout);
    const r = jsonTail(stdout);
    assert.equal(r.passed, true);
    assert.ok(r.master, 'probe clip path present');
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
    assert.equal(spec.kling.jobs.length, 2, 'the TWO-JOB brief planned two jobs');
    const render = JSON.parse(fs.readFileSync(path.join(dir, 'render/render.json'), 'utf8'));
    assert.equal(render.jobs.length, 1, 'the probe rendered only the first job');
  } finally { cleanup(); }
});

test('engine --render --probe on a single-job plan warns and renders fully', { skip: FF ? false : 'ffmpeg not installed' }, async () => {
  const { dir, cleanup } = mkTmp('engine-cli-downgrade');
  const falReal = await startFalServer({ videoBytes: await tinyMp4Bytes() });
  try {
    const { code, stdout, stderr } = await runCli('src/cli/engine.js',
      ['--brief', 'a lighthouse keeper at dusk', '--render', '--probe', '--out', dir],
      { env: {
        LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
        FAL_BASE_URL: falReal.baseUrl, FAL_KEY: 'fake', FAL_UPLOAD_MODE: 'data-uri', FAL_KLING_ENDPOINT: 'submit', FAL_MAX_RETRIES: '1',
        VIDEO_WIDTH: '128', VIDEO_HEIGHT: '128', VIDEO_FPS: '15', VIDEO_INTERPOLATE: 'false',
        OUT_DIR: dir, // the stitched master must land in the tmp dir, never the repo's real out/
        LOG_LEVEL: 'warn', // runCli defaults to 'error'; the downgrade warning is the point here
      } });
    assert.equal(code, 0, stdout + stderr);
    assert.match(stderr + stdout, /--probe ignored/, 'the downgrade is announced, never silent');
    const r = jsonTail(stdout);
    assert.ok(r.master && fs.existsSync(r.master), 'the run finished as a full render with a stitched master');
    // the discriminator: a full render's stitched master lands in OUT_DIR; a probe's clip would
    // live under <dir>/render/K1 — so this fails if the downgrade regresses but the warning survives
    assert.equal(path.dirname(r.master), dir, 'master is the stitched OUT_DIR file, not a probe clip');
  } finally { cleanup(); await falReal.close(); }
});

test('engine --backend seedance: plans, renders on the seedance endpoint, and stamps the spec', async () => {
  const { dir, cleanup } = mkTmp('engine-cli-seedance');
  try {
    const { code, stdout } = await runCli('src/cli/engine.js',
      ['--brief', 'a lighthouse keeper at dusk TWO-JOB', '--render', '--probe', '--backend', 'seedance', '--out', dir],
      { env: {
        LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
        FAL_BASE_URL: fal.baseUrl, FAL_KEY: 'fake', SEEDANCE_UPLOAD_MODE: 'data-uri',
        FAL_SEEDANCE_ENDPOINT: 'seedance-submit', FAL_SEEDANCE_PROBE_ENDPOINT: 'seedance-submit', FAL_MAX_RETRIES: '1',
      } });
    assert.equal(code, 0, stdout);
    assert.equal(jsonTail(stdout).passed, true);
    // the explicit choice must persist so a later render/assemble of this run picks the same backend
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
    assert.equal(spec.render_backend, 'seedance');
  } finally { cleanup(); }
});

test('engine --aspect: stamps the requested aspect onto the final spec', async () => {
  const { dir, cleanup } = mkTmp('engine-cli-aspect');
  try {
    const { code, stdout } = await runCli('src/cli/engine.js',
      ['--brief', 'a lighthouse keeper at dusk', '--aspect', '16:9', '--out', dir],
      { env: { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake' } });
    assert.equal(code, 0, stdout);
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
    assert.equal(spec.kling.aspect_ratio, '16:9');
    assert.equal(spec.project.aspect_ratio, '16:9');
  } finally { cleanup(); }
});

test('engine --aspect rejects an unknown ratio before any planning', async () => {
  const { dir, cleanup } = mkTmp('engine-cli-badaspect');
  try {
    const { code, stderr } = await runCli('src/cli/engine.js',
      ['--brief', 'x', '--aspect', '4:3', '--out', dir],
      { env: { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake' } });
    assert.equal(code, 1);
    assert.match(stderr, /Unknown aspect ratio "4:3"/);
    assert.ok(!fs.existsSync(path.join(dir, 'spec-00.json')), 'no agent ran');
  } finally { cleanup(); }
});

test('engine reads the brief from stdin', async () => {
  const { dir, cleanup } = mkTmp('engine-stdin');
  try {
    const { code, stdout } = await runCli('src/cli/engine.js', ['--out', dir],
      { input: 'a cat reviews cheese', env: { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake' } });
    assert.equal(code, 0, stdout);
    assert.equal(jsonTail(stdout).passed, true);
  } finally { cleanup(); }
});

test('engine --cast: only the starred profile reaches the agents, and the spec remembers the cast', async () => {
  const { dir, cleanup } = mkTmp('engine-cli-cast');
  const profiles = mkTmp('engine-cli-profiles');
  const dumps = mkTmp('engine-cli-dumps');
  try {
    fs.writeFileSync(path.join(profiles.dir, 'keeper.md'), '# Keeper\nA weathered lighthouse keeper, calm and wry. KEEPER-MARKER');
    fs.writeFileSync(path.join(profiles.dir, 'villain.md'), '# Villain\nA scheming harbor master. VILLAIN-MARKER');
    const { code, stdout } = await runCli('src/cli/engine.js',
      ['--brief', 'a lighthouse keeper at dusk', '--cast', 'keeper', '--out', dir],
      { env: {
        LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
        PROFILES_DIR: profiles.dir, FAKE_LLM_DUMP: dumps.dir,
      } });
    assert.equal(code, 0, stdout);
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
    assert.deepEqual(spec.cast, ['keeper'], 'the spec remembers who was starred (revisions re-inject them)');
    const prompts = fs.readdirSync(dumps.dir).map((f) => fs.readFileSync(path.join(dumps.dir, f), 'utf8'));
    assert.ok(prompts.length > 0, 'agent prompts were dumped');
    assert.ok(prompts.some((p) => p.includes('KEEPER-MARKER')), 'the starred profile is in the agent context');
    assert.ok(prompts.every((p) => !p.includes('VILLAIN-MARKER')), 'unstarred profiles are filtered out');
    assert.ok(prompts.some((p) => /Featured cast .*keeper/i.test(p)), 'agents are told to build around the cast');
  } finally { cleanup(); profiles.cleanup(); dumps.cleanup(); }
});

test('engine --cast with an unknown name fails BEFORE any agent runs (no LLM spend)', async () => {
  const { dir, cleanup } = mkTmp('engine-cli-badcast');
  const profiles = mkTmp('engine-cli-noprof');
  try {
    fs.writeFileSync(path.join(profiles.dir, 'keeper.md'), '# Keeper');
    const { code, stdout, stderr } = await runCli('src/cli/engine.js',
      ['--brief', 'x', '--cast', 'kepper', '--out', dir],
      { env: { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake', PROFILES_DIR: profiles.dir } });
    assert.notEqual(code, 0);
    assert.match(stderr + stdout, /Unknown cast member "kepper"/);
    assert.ok(!fs.existsSync(path.join(dir, 'spec-00.json')), 'no agent output was produced');
  } finally { cleanup(); profiles.cleanup(); }
});

test('engine --environment: a SINGLE slug injects the environment bible into every agent and the spec remembers it', async () => {
  const { dir, cleanup } = mkTmp('engine-cli-env');
  const envs = mkTmp('engine-cli-envs');
  const dumps = mkTmp('engine-cli-env-dumps');
  try {
    fs.writeFileSync(path.join(envs.dir, 'neon-city.md'),
      '# Neon City\n\nA synth-noir night city. NEON-MARKER\n\n## Avoid\n\nDaylight.');
    const { code, stdout } = await runCli('src/cli/engine.js',
      // a single slug — NOT comma-split like --cast (an environment is exactly one world bible)
      ['--brief', 'a courier races the last train', '--environment', 'neon-city', '--out', dir],
      { env: {
        LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake',
        ENVIRONMENTS_DIR: envs.dir, FAKE_LLM_DUMP: dumps.dir,
      } });
    assert.equal(code, 0, stdout);
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
    assert.equal(spec.environment, 'neon-city', 'the spec remembers the environment (revisions re-inject it)');
    const prompts = fs.readdirSync(dumps.dir).map((f) => fs.readFileSync(path.join(dumps.dir, f), 'utf8'));
    assert.ok(prompts.some((p) => p.includes('NEON-MARKER')), 'the environment bible is in the agent context');
    // it is presented as the REQUIRED world that takes precedence over a character's own world notes
    assert.ok(prompts.some((p) => /World & style/.test(p) && /overrid|precedence|priority|wins/i.test(p)),
      'the agents are told the environment overrides a character\'s own "## World & style"');
  } finally { cleanup(); envs.cleanup(); dumps.cleanup(); }
});

test('engine --environment with an unknown slug fails BEFORE any agent runs (no LLM spend)', async () => {
  const { dir, cleanup } = mkTmp('engine-cli-badenv');
  const envs = mkTmp('engine-cli-noenv');
  try {
    fs.writeFileSync(path.join(envs.dir, 'neon-city.md'), '# Neon City');
    const { code, stdout, stderr } = await runCli('src/cli/engine.js',
      ['--brief', 'x', '--environment', 'neon-ciyt', '--out', dir],
      { env: { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake', ENVIRONMENTS_DIR: envs.dir } });
    assert.notEqual(code, 0);
    assert.match(stderr + stdout, /Unknown environment "neon-ciyt"/);
    assert.ok(!fs.existsSync(path.join(dir, 'spec-00.json')), 'no agent output was produced');
  } finally { cleanup(); envs.cleanup(); }
});

test('engine --environment with NO value fails before any agent runs (explicit flag never silently skipped)', async () => {
  const { dir, cleanup } = mkTmp('engine-cli-envnoval');
  try {
    const { code, stdout, stderr } = await runCli('src/cli/engine.js',
      ['--brief', 'x', '--out', dir, '--environment'],
      { env: { LLM_PROVIDER: 'claude', LLM_TRANSPORT: 'cli', LLM_CLI_BIN: FAKE, LLM_MODEL: 'fake' } });
    assert.notEqual(code, 0);
    assert.match(stderr + stdout, /--environment needs a value/);
    assert.ok(!fs.existsSync(path.join(dir, 'spec-00.json')), 'no agent output was produced — nothing was spent');
  } finally { cleanup(); }
});
