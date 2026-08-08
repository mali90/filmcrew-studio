// Drives the real tools/seamstitch CLI over ffmpeg-built chained fixtures. This is the coverage that
// stands in for the Python package's never-written test suite (tools/seamstitch/PROVENANCE.md), so it
// checks the things a Node caller will depend on: the JSON contract, the verify gates actually
// discriminating a matched seam from an unmatched one, the AR-preserving refit, and the offset math
// agreeing with src/lib/stitch-math.js — an independent re-derivation, not a copy of the tool's output.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { neutralizeDotenv } from '../helpers/env.js';
import { mkTmp } from '../helpers/tmp.js';
import { hasFfmpeg } from '../helpers/ffmpeg-clips.js';
import { makeChainedClips, reencodeAt, hasSeamstitch, TOOLS_DIR } from '../helpers/seam-fixtures.js';

neutralizeDotenv();
const { computeOffsets } = await import('../../src/lib/stitch-math.js');
const { runSeamstitch } = await import('../../src/lib/seamstitch.js');
const { probeClip } = await import('../../src/lib/assemble.js');

const READY = (await hasFfmpeg()) && (await hasSeamstitch());
const SKIP = READY ? false : 'requires ffmpeg + python3 with numpy/pillow';

// One fixture for the whole file — building it costs several ffmpeg passes.
const FPS = 24;
const FRAMES = 48;
const tmp = READY ? mkTmp('seamstitch') : null;
const fixture = READY ? await makeChainedClips({ dir: tmp.dir, fps: FPS, frames: FRAMES }) : null;
after(() => tmp?.cleanup());

// Fast encodes: this suite tests geometry and seam metrics, not compression quality.
const FAST = ['--crf', '28', '--preset', 'veryfast'];
const out = (name) => path.join(tmp.dir, name);

/** Run the CLI the only way it can be run: `-m seamstitch` with tools/ on PYTHONPATH. */
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-m', 'seamstitch', ...args], {
      env: { ...process.env, PYTHONPATH: TOOLS_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      let report = null;
      try { report = JSON.parse(stdout.trim()); } catch { /* asserted per test */ }
      resolve({ code, stdout, stderr, report });
    });
  });
}

test('A: --method none leaves the grade jump, and the seam gate catches it', { skip: SKIP }, async () => {
  const dst = out('none.mp4');
  const { code, report, stdout } = await cli([...fixture.segments, '-o', dst, '--method', 'none', '--verify', '--json', ...FAST]);

  assert.ok(report, `expected one JSON object on stdout, got: ${stdout.slice(0, 200)}`);
  assert.equal(report.verify.seamPassed, false, 'an unmatched seam MUST fail the metric');
  assert.equal(report.ok, false);
  assert.equal(code, 2, 'verify failure exits 2');
  // Not a marginal miss: the ungraded jump is many luma levels wide.
  assert.ok(report.verify.seam.some((j) => j.drift > 3), `expected a large drift, got ${JSON.stringify(report.verify.seam)}`);
});

test('B: defaults pass both gates, and the report agrees with the JS offset oracle', { skip: SKIP }, async () => {
  const dst = out('default.mp4');
  const { code, report } = await cli([...fixture.segments, '-o', dst, '--verify', '--json', ...FAST]);

  assert.equal(code, 0, `expected a clean run, got exit ${code}`);
  assert.equal(report.ok, true);
  assert.equal(report.verify.seamPassed, true, `seam gate: ${JSON.stringify(report.verify.seam)}`);
  assert.equal(report.verify.geometryPassed, true, `geometry gate: ${JSON.stringify(report.verify.geometry)}`);

  // Independent re-derivation of §7.5 — every joint is a continuation, so every first frame is dropped.
  const oracle = computeOffsets([FRAMES, FRAMES, FRAMES], FPS, 0.25);
  assert.deepEqual(report.offsets, oracle.offsets);
  assert.equal(report.expectedDuration, oracle.expectedDuration);

  const tol = 1 / FPS + 0.05; // one frame + AAC priming slack (§12.7)
  assert.ok(Math.abs(report.outputDuration - report.expectedDuration) <= tol,
    `output ${report.outputDuration}s vs expected ${report.expectedDuration}s`);

  // Shape of the report the Node wrapper depends on.
  assert.deepEqual(report.target, [160, 96]);
  assert.deepEqual(report.jointMatch, [true, true]);
  assert.deepEqual(report.xfades, [0.25, 0.25]);
  assert.equal(report.segments.length, 3);
  assert.ok(Array.isArray(report.warnings));
});

test('C: an odd-bucket segment is cover-fitted without squeezing it', { skip: SKIP }, async () => {
  // 176x104 against a 160x96 canvas: 1.5% off framing, the bucket-rounding case ADDENDUM_AR describes.
  const wide = await reencodeAt(fixture.segments[2], '176x104');
  const dst = out('cover.mp4');
  const { code, report } = await cli([
    fixture.segments[0], fixture.segments[1], wide, '-o', dst,
    '--fit', 'cover', '--target-res', '160x96', '--verify', '--json', ...FAST,
  ]);

  assert.equal(code, 0, `expected a clean run, got exit ${code}`);
  for (const g of report.verify.geometry) {
    assert.notEqual(g.verdict, 'FAIL', `joint ${g.joint} reported a squeeze: ${JSON.stringify(g)}`);
  }
  assert.equal(report.segments[2].action.startsWith('cover'), true, `expected a cover refit, got "${report.segments[2].action}"`);

  const probe = await probeClip(dst);
  assert.equal(probe.width, 160);
  assert.equal(probe.height, 96);

  // 8%+ off framing is a different shot, not a bucket: the tool must refuse rather than crop it.
  const tooWide = await reencodeAt(fixture.segments[2], '176x96');
  const refused = await cli([fixture.segments[0], fixture.segments[1], tooWide, '-o', out('nope.mp4'),
    '--fit', 'cover', '--target-res', '160x96', '--json', ...FAST]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /off target framing/);
});

test('D: --joint-match 1,0 cuts the second joint — no LUT, and the frame is kept', { skip: SKIP }, async () => {
  const dst = out('cut.mp4');
  const { code, report, stderr } = await cli([...fixture.segments, '-o', dst, '--joint-match', '1,0', '--json', '-v', ...FAST]);

  assert.equal(code, 0, `expected a clean run, got exit ${code}`);
  assert.deepEqual(report.jointMatch, [true, false]);

  // Exactly one LUT PNG is baked and fed to ffmpeg — the chained segment's. (-v echoes the command
  // and the graph, more than once, so assert on the SET of LUT inputs rather than a match count.)
  const luts = new Set([...stderr.matchAll(/lut_(\d+)\.png/g)].map((m) => m[1]));
  assert.deepEqual([...luts], ['1'], 'only the chained joint should bake a LUT');
  // ...and only that segment drops its duplicated first frame.
  assert.match(stderr, /\[1:v\]trim=start_frame=1/);
  assert.ok(!/\[2:v\]trim=start_frame=1/.test(stderr), 'the cut segment must keep its first frame');
  assert.match(stderr, /marked as a cut/);

  // The cut segment keeps its first frame, so the timeline is one frame longer than the all-chained case.
  const oracle = computeOffsets([FRAMES, FRAMES, FRAMES], FPS, [0.25, 0.25], [false, true, false]);
  assert.deepEqual(report.offsets, oracle.offsets);
  assert.equal(report.expectedDuration, oracle.expectedDuration);
  const chained = computeOffsets([FRAMES, FRAMES, FRAMES], FPS, 0.25);
  assert.ok(Math.abs((report.expectedDuration - chained.expectedDuration) - 1 / FPS) < 1e-9);

  const tol = 1 / FPS + 0.05;
  assert.ok(Math.abs(report.outputDuration - report.expectedDuration) <= tol,
    `output ${report.outputDuration}s vs expected ${report.expectedDuration}s`);
});

test('E: --dry-run reports the plan through the Node wrapper and writes nothing', { skip: SKIP }, async () => {
  const dst = out('never-written.mp4');
  const res = await runSeamstitch([...fixture.segments, '-o', dst, '--dry-run', '--json']);

  assert.equal(res.ok, true, `wrapper reported: ${res.reason}`);
  assert.equal(res.report.dryRun, true);
  assert.equal(res.report.output, dst);
  assert.equal(res.report.outputDuration, undefined, 'nothing was rendered, so there is no output duration');
  assert.equal(res.report.verify, undefined, 'nothing was rendered, so there is nothing to verify');
  assert.deepEqual(res.report.offsets, computeOffsets([FRAMES, FRAMES, FRAMES], FPS, 0.25).offsets);
  assert.equal(fs.existsSync(dst), false, '--dry-run must not write the output file');
});
