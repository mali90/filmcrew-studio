// WS2-P2 — web/server/lib/lineage.js: the continuity rule, pure.
//
// THE RULE (one sentence, and the whole reason this module exists):
//   segment i continues from i−1 iff its recorded seam SOURCE CLIP is the clip currently at
//   position i−1 of the cut.
//
// Not "a seam frame was used" — b1nx used one and is still broken, because the frame came from a K1
// that the cut no longer contains. Getting this wrong is not cosmetic: WS3's seamless stitcher runs
// colour matching and frame dedup on joints this module calls continuations, and the UI promises
// "seamless" on the strength of it.
//
// Pure by construction: no fs, no config, no run-service. The fixtures are the two real runs from
// the plan's forensics, plus a pre-P1 run with no recorded lineage at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = path.resolve(HERE, '../../../..');
const { armed, pending } = await import(path.join(HOST_ROOT, 'test/helpers/tdd.js'));

const lineage = await armed(
  () => import('../../lib/lineage.js'),
  ['computeLineage', 'serializeContinuity', 'resolveBoundaries'],
);
const PENDING = pending(lineage, 'WS2-P2: web/server/lib/lineage.js');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, '../fixtures/lineage', `${name}.json`), 'utf8'));
const b1nx = fixture('b1nx');
const fivemjo = fixture('5mjo');
const legacy = fixture('legacy-c7qa');

test('b1nx: a cut that mixes takes is NOT a continuation, even though a seam frame was used', PENDING, () => {
  const { segments, joints } = lineage.computeLineage(b1nx);
  assert.equal(segments.length, 2);

  assert.equal(segments[0].jobId, 'K1');
  assert.equal(segments[0].take, 't2');
  assert.equal(segments[0].continuesFromPrev, false, 'the first segment continues from nothing');

  assert.equal(segments[1].jobId, 'K2');
  assert.equal(segments[1].take, 't1');
  assert.equal(segments[1].continuesFromPrev, false,
    "t1's K2 was conditioned on t1's K1 — the cut now opens with t2's K1, so the join is broken");
  assert.equal(segments[1].confidence, 'recorded', 'the lineage was written down; no guessing involved');

  assert.equal(joints.length, 1, 'N segments → N−1 joints');
  assert.equal(joints[0].kind, 'broken');
  assert.equal(joints[0].linked, false);
});

test('5mjo: an intact chain within one take IS a continuation on every joint', PENDING, () => {
  const { segments, joints } = lineage.computeLineage(fivemjo);
  assert.deepEqual(segments.map((s) => s.jobId), ['K1', 'K2', 'K3']);
  assert.deepEqual(segments.map((s) => s.continuesFromPrev), [false, true, true]);
  assert.deepEqual(joints.map((j) => j.kind), ['linked', 'linked']);
  for (const s of segments) assert.equal(s.confidence, 'recorded');
});

test('the rule is take-aware, not job-aware: re-rendering the LAST segment breaks nothing', PENDING, () => {
  // t4's K3 replaced by a hypothetical t5 K3 that chained from t4's K2 → still linked.
  const run = structuredClone(fivemjo);
  run.takes.push({
    take: 't5',
    at: '2026-06-28T16:00:00.000Z',
    jobs: [{
      jobId: 'K3',
      clip: '/runs/5mjo/renders/t5/K3/clip.mp4',
      seamIn: { mode: 'soft', frame: '/runs/5mjo/renders/t4/K2/last_frame.png', from: { take: 't4', job: 'K2', clip: '/runs/5mjo/renders/t4/K2/clip.mp4' } },
      seamOut: { mode: 'none', frame: null, to: null },
    }],
  });
  run.cut[2] = { jobId: 'K3', take: 't5' };
  const { segments } = lineage.computeLineage(run);
  assert.deepEqual(segments.map((s) => s.continuesFromPrev), [false, true, true],
    'a downstream re-render that chained from the CURRENT upstream clip keeps the chain intact');
});

test('re-rendering an UPSTREAM segment breaks exactly the joint after it, and no others', PENDING, () => {
  const run = structuredClone(fivemjo);
  run.takes.push({
    take: 't5',
    at: '2026-06-28T16:00:00.000Z',
    jobs: [{
      jobId: 'K2',
      clip: '/runs/5mjo/renders/t5/K2/clip.mp4',
      seamIn: { mode: 'soft', frame: '/runs/5mjo/renders/t4/K1/last_frame.png', from: { take: 't4', job: 'K1', clip: '/runs/5mjo/renders/t4/K1/clip.mp4' } },
      seamOut: { mode: 'none', frame: null, to: null },
    }],
  });
  run.cut[1] = { jobId: 'K2', take: 't5' };
  const { segments, joints } = lineage.computeLineage(run);
  assert.equal(segments[1].continuesFromPrev, true, "the new K2 chained from the K1 that is still in the cut");
  assert.equal(segments[2].continuesFromPrev, false, "t4's K3 opens on the OLD K2's frame — that joint is now broken");
  assert.deepEqual(joints.map((j) => j.kind), ['linked', 'broken']);
});

test('a segment rendered with no seam at all is "isolated" — a scene cut by design, not a fault', PENDING, () => {
  const run = structuredClone(fivemjo);
  run.takes.at(-1).jobs[1].seamIn = { mode: 'none', frame: null, from: null };
  const { segments, joints } = lineage.computeLineage(run);
  assert.equal(segments[1].continuesFromPrev, false);
  assert.equal(joints[0].kind, 'isolated', 'nothing was ever pinned here — the UI must not cry "broken"');
});

test('legacy runs with no recorded lineage are DERIVED from take history and flagged as such', PENDING, () => {
  const { segments, joints } = lineage.computeLineage(legacy);
  for (const s of segments) assert.equal(s.confidence, 'derived', 'nothing here was recorded — say so');
  // Replaying history: K2 was rendered in t1, so its seam frame came from t1's K1 — which is NOT
  // the K1 in the cut. A derivation that ignored take history would report a continuation.
  assert.equal(segments[1].continuesFromPrev, false);
  assert.equal(joints[0].kind, 'unknown', "derived answers draw the DASHED connector, never a solid one");
});

test('an intact legacy chain derives to linked-but-unknown (dashed), never to a bare false', PENDING, () => {
  const run = structuredClone(legacy);
  run.takes.pop();                       // no re-render ever happened
  run.cut[0] = { jobId: 'K1', take: 't1' };
  const { segments, joints } = lineage.computeLineage(run);
  assert.equal(segments[1].continuesFromPrev, true);
  assert.equal(segments[1].confidence, 'derived');
  assert.equal(joints[0].kind, 'unknown', 'still reconstructed — confidence outranks the verdict in the drawing');
});

test('computeLineage is pure: same input twice, identical output, and the input is untouched', PENDING, () => {
  const input = structuredClone(b1nx);
  const before = JSON.stringify(input);
  const a = lineage.computeLineage(input);
  const b = lineage.computeLineage(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before, 'no mutation of the caller\'s run record');
});

test('degenerate cuts: zero and one segment produce no joints and never throw', PENDING, () => {
  for (const cut of [[], [{ jobId: 'K1', take: 't4' }]]) {
    const run = { ...structuredClone(fivemjo), cut };
    const { segments, joints } = lineage.computeLineage(run);
    assert.equal(segments.length, cut.length);
    assert.deepEqual(joints, []);
  }
});

test('a cut naming a take/job that was never rendered degrades to unknown instead of throwing', PENDING, () => {
  const run = structuredClone(fivemjo);
  run.cut[1] = { jobId: 'K2', take: 't9' };
  const { segments, joints } = lineage.computeLineage(run);
  assert.equal(segments[1].confidence, 'derived');
  assert.equal(joints[0].kind, 'unknown');
  assert.equal(joints[1].kind, 'unknown', 'the joint AFTER an unknown segment cannot be trusted either');
});

// ── The wire shape: ids only, never filesystem paths ────────────────────────────────────────────

test('serializeContinuity exposes take/job ids and NEVER a filesystem path', PENDING, () => {
  const wire = lineage.serializeContinuity(lineage.computeLineage(b1nx));
  const blob = JSON.stringify(wire);
  assert.ok(!blob.includes('/runs/'), 'a run directory path in an API response leaks the host filesystem');
  assert.ok(!/\.mp4|\.png/.test(blob), 'no clip or frame filenames either');
  assert.ok(!/[/\\]/.test(blob), 'no path separator of any kind survives into the wire shape');

  assert.equal(wire.segments.length, 2);
  assert.deepEqual(wire.segments.map((s) => s.jobId), ['K1', 'K2']);
  assert.deepEqual(wire.segments.map((s) => s.take), ['t2', 't1']);
  assert.equal(wire.segments[1].continuesFromPrev, false);
  assert.equal(wire.joints[0].kind, 'broken');
});

test('serializeContinuity is what the UI draws from — every joint carries a kind and a confidence', PENDING, () => {
  const wire = lineage.serializeContinuity(lineage.computeLineage(legacy));
  for (const j of wire.joints) {
    assert.ok(['linked', 'broken', 'isolated', 'unknown'].includes(j.kind), `unexpected joint kind ${j.kind}`);
    assert.ok(['recorded', 'derived'].includes(j.confidence));
  }
});

// ── resolveBoundaries: what P5's re-render dialog is allowed to promise ─────────────────────────

test('resolveBoundaries names the neighbours a re-render may be pinned to', PENDING, () => {
  const l = lineage.computeLineage(fivemjo);
  const mid = lineage.resolveBoundaries(l, 1);
  assert.equal(mid.first.jobId, 'K1', "K2 may open on K1's last frame");
  assert.equal(mid.first.take, 't4');
  assert.equal(mid.last.jobId, 'K3', "…and close on K3's opening frame");
  assert.equal(mid.last.take, 't4');

  const head = lineage.resolveBoundaries(l, 0);
  assert.equal(head.first, null, 'the first segment has nothing before it — the dialog says "opens on a cut"');
  assert.equal(head.last.jobId, 'K2');

  const tail = lineage.resolveBoundaries(l, 2);
  assert.equal(tail.first.jobId, 'K2');
  assert.equal(tail.last, null);
});

test('resolveBoundaries on a single-segment cut offers nothing to join to', PENDING, () => {
  const run = { ...structuredClone(fivemjo), cut: [{ jobId: 'K1', take: 't4' }] };
  const only = lineage.resolveBoundaries(lineage.computeLineage(run), 0);
  assert.equal(only.first, null);
  assert.equal(only.last, null);
});

// ── WS2-P5: the boundary plan a frame-conditioned re-render buys ───────────────────────────────
//
// `auto` is the load-bearing one. It MIRRORS the cut as it stands: a joint that is linked today
// stays linked, one that is broken stays broken. It must never quietly repair a break — the whole
// point of the dialog is that repairing a joint is a thing the user chooses and pays for.

const BOUNDARY_PENDING = pending(lineage?.BOUNDARY_MODES,
  'WS2-P5: resolveBoundaries({ jobIds, jobId, continuity, caps, mode })');

const K = ['K1', 'K2', 'K3'];
const planFor = (run, jobId, mode, extra = {}) => lineage.resolveBoundaries({
  jobIds: K.slice(0, run.cut.length), jobId, mode, continuity: lineage.computeLineage(run), ...extra,
});

test("auto pins only the joints the cut ALREADY has — b1nx's break stays broken", BOUNDARY_PENDING, () => {
  // b1nx's single joint is recorded-broken (K2 opens on a K1 the cut no longer contains).
  const k2 = planFor(b1nx, 'K2', 'auto');
  assert.equal(k2.start, null, 'auto must not silently repair the break — that is the explicit ask');
  assert.equal(k2.end, null, 'K2 ends the cut');
  assert.deepEqual(k2.first, { index: 0, jobId: 'K1', take: 't2' }, 'the neighbour is still OFFERED');

  const k1 = planFor(b1nx, 'K1', 'auto');
  assert.equal(k1.start, null, 'the first segment never gets a start pin');
  assert.equal(k1.end, null, 'the joint into K2 is broken today, so auto leaves it broken');
});

test('auto on an intact chain (5mjo) keeps BOTH joins of a middle segment', BOUNDARY_PENDING, () => {
  const mid = planFor(fivemjo, 'K2', 'auto');
  assert.deepEqual(mid.start, { frame: 'last', from: { index: 0, jobId: 'K1', take: 't4' } },
    "the opening pin takes the PREVIOUS clip's last frame");
  assert.deepEqual(mid.end, { frame: 'first', to: { index: 2, jobId: 'K3', take: 't4' } },
    "the closing pin takes the NEXT clip's first frame — that is how K3's join survives a K2 re-render");
});

test('both/start/end force each end; none renders standalone', BOUNDARY_PENDING, () => {
  assert.ok(planFor(b1nx, 'K2', 'both').start, 'both REPAIRS the joint auto left broken');
  const both = planFor(fivemjo, 'K2', 'both');
  assert.ok(both.start && both.end, 'both pins both ends');

  const startOnly = planFor(fivemjo, 'K2', 'start');
  assert.ok(startOnly.start && startOnly.end === null);
  const endOnly = planFor(fivemjo, 'K2', 'end');
  assert.ok(endOnly.end && endOnly.start === null);

  const none = planFor(fivemjo, 'K2', 'none');
  assert.equal(none.start, null);
  assert.equal(none.end, null);
  assert.equal(none.startMode, 'none');
  assert.equal(none.endMode, 'none');
});

test('the ends of the cut have nothing to pin to, whatever is asked for', BOUNDARY_PENDING, () => {
  const head = planFor(fivemjo, 'K1', 'both');
  assert.equal(head.start, null, 'the first segment never gets a start pin');
  assert.ok(head.end, 'but it can still be pinned to the segment after it');
  const tail = planFor(fivemjo, 'K3', 'both');
  assert.ok(tail.start);
  assert.equal(tail.end, null, 'the last segment never gets an end pin');
});

test('the pin STRENGTH is the renderer\'s answer, not the dialog\'s', BOUNDARY_PENDING, () => {
  // Segmind's native slots are mutually exclusive with reference images (the correction note): a
  // cast-less segment goes native, one with cast refs is soft-pinned and may only ever be called
  // "near-seamless (reference-guided)".
  const segmind = { family: 'seedance', label: 'Seedance', nativeFirstFrame: true, nativeLastFrame: true, firstFrameExcludesRefs: true };
  const bare = planFor(fivemjo, 'K2', 'both', { caps: segmind, castRefCount: 0 });
  assert.equal(bare.startMode, 'native');
  assert.equal(bare.endMode, 'native');

  const withCast = planFor(fivemjo, 'K2', 'both', { caps: segmind, castRefCount: 2 });
  assert.equal(withCast.startMode, 'soft', 'keeping the cast means soft-pinning the frame');
  assert.equal(withCast.endMode, 'soft');

  const unknown = planFor(fivemjo, 'K2', 'both');
  assert.equal(unknown.startMode, 'soft', 'with no caps on file, claim the WEAKER of the two');
});

test('a reconstruction is not evidence: a legacy run keeps the chain it has always rendered', BOUNDARY_PENDING, () => {
  const l = lineage.computeLineage(legacy);
  assert.ok(l.segments.every((s) => s.confidence === 'derived'), 'this fixture is the pre-P1 shape');
  const plan = lineage.resolveBoundaries({ jobIds: ['K1', 'K2'], jobId: 'K2', mode: 'auto', continuity: l });
  assert.ok(plan.start, 'auto neither repairs a derived break nor drops a chain over a guess');
});

test('a job the cut does not hold yet is planned from the job list alone', BOUNDARY_PENDING, () => {
  const plan = lineage.resolveBoundaries({ jobIds: ['K1', 'K2', 'K3'], jobId: 'K2', mode: 'auto' });
  assert.equal(plan.index, 1);
  assert.ok(plan.start, 'nothing recorded to mirror → the historical default: chain the opening frame');
  assert.equal(plan.end, null, 'and pin no ending, exactly as re-renders have always behaved');
  assert.deepEqual(plan.first, { index: 0, jobId: 'K1', take: null });
});

test('an unknown boundary mode is refused, not guessed at', BOUNDARY_PENDING, () => {
  assert.throws(() => planFor(fivemjo, 'K2', 'bogus'), /boundary mode/);
  assert.deepEqual(lineage.BOUNDARY_MODES, ['auto', 'both', 'start', 'end', 'none']);
});

test('resolveBoundaries is pure, and its answer names no filesystem path', BOUNDARY_PENDING, () => {
  const l = lineage.computeLineage(fivemjo);
  const before = JSON.stringify(l);
  const blob = JSON.stringify(lineage.resolveBoundaries({ jobIds: K, jobId: 'K2', mode: 'both', continuity: l }));
  assert.equal(JSON.stringify(l), before, 'the caller\'s lineage is not mutated');
  assert.ok(!/[/\\]/.test(blob), 'take/job ids only — a host directory is a leak');
});

test('lineage.js is pure: it imports no config, no fs, and no run-service', PENDING, () => {
  const src = fs.readFileSync(path.join(HERE, '../../lib/lineage.js'), 'utf8');
  for (const forbidden of ['node:fs', 'node:path', 'config.js', 'run-service', 'dotenv']) {
    assert.ok(!src.includes(forbidden), `lineage.js must not import ${forbidden} — it is a pure rule over a run record`);
  }
  assert.ok(!/process\.env/.test(src));
});

// The same transitive leak canary the caps route gets (test/integration/runs-caps.test.js): the
// source check above only sees lineage.js itself, so if it ever grows a relative import this walk
// keeps the promise for the whole graph behind it.
test("lineage.js's STATIC import graph never reaches config.js or dotenv", PENDING, () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const specifiers = [
      ...src.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*export\b[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g), // lazy imports leak just as well
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (!spec.startsWith('.')) continue; // node: builtins and npm deps carry no repo config
      const resolved = path.resolve(path.dirname(file), spec);
      assert.notEqual(path.basename(resolved), 'config.js',
        `${path.relative(HOST_ROOT, file)} imports config.js — the continuity rule must stay config-free`);
      visit(resolved);
    }
    assert.ok(!/from\s+['"]dotenv/.test(src), `${path.relative(HOST_ROOT, file)} must not load dotenv`);
  };
  visit(path.join(HERE, '../../lib/lineage.js'));
  assert.ok(seen.size >= 1, 'the walker found lineage.js');
});
