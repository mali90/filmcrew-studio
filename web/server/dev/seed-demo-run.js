// A seeded run for the ZERO-SPEND demo: a three-segment cut whose middle clip was re-rendered, so
// the join after it is genuinely broken.
//
// Why seed one at all. Every WS2 surface worth showing needs a run that a single click cannot
// produce: the continuity strip only draws joins when there are at least two of them, the prompt
// sheet's version picker only offers takes that really kept a `prompts.json`, and the re-render
// dialog's boundary plan only says anything interesting when one join is whole and the next is not.
// Reaching that state by hand costs a full render plus a re-render on every boot, and an e2e spec
// cannot assert a "join broken" chip it had to spend two minutes manufacturing first.
//
// What keeps a fixture honest:
//   · the seam MODES come from `chooseSeamMode` — the same function the renderer and the re-render
//     dialog ask — so this run can never draw a seam Kling would not actually make;
//   · the prompt sidecars are composed by the server's own prompt service, so "what t1 sent" is
//     what today's composer would send, not prose typed into a fixture;
//   · the estimates come from the real estimator, so the cost readout says what this render would
//     have cost. Nothing was spent (no provider was ever called) — but nothing here is labelled
//     free either, because a render of this cut would not be.
//
// The layout below is the CLI's own, unchanged: renders/tN/<job>/clip.mp4 + prompts.json, one
// render.json per take, masters in the out dir. web/server/test/integration/demo-seed.test.js reads
// the result back through the HTTP API and asserts the joins it draws.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { estimateRender } from '../lib/estimator.js';

/** Fixed id: the demo banner prints its URL and e2e navigates straight to it. */
export const SEAM_DEMO_RUN_ID = 'web-demo-seam';

const BACKEND = 'kling-o3@fal';
const TITLE = 'Harbour Watch';
// Deliberately old, and fixed: the seed sorts to the BOTTOM of the library, so a spec that reaches
// for "the run I just made" still lands on its own rather than on this one.
const SEEDED_AT = '2026-01-05T09:00:00.000Z';
// What the demo renders at (childEnv's VIDEO_SHORT_SIDE) — recorded so the upscale offer is honest.
const SHORT_SIDE = 270;

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const writeBytes = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};

/**
 * The golden example plan, cut into ONE JOB PER SHOT. The fake LLM's `TWO-JOB` knob does the same
 * trick for probe specs; three segments is the smallest cut that can hold a whole join and a broken
 * one at the same time, which is the entire point of this run.
 */
function threeJobSpec(root) {
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'examples/ocean-lighthouse/spec.json'), 'utf8'));
  const [job] = spec.kling.jobs;
  spec.render_backend = BACKEND;
  spec.project.title = TITLE; // its own name in the library — never confusable with a run you made
  spec.kling.jobs = spec.shots.map((shot, i) => ({ ...job, job_id: `K${i + 1}`, shots: [shot.shot_id] }));
  return spec;
}

/** The clip's closing still, grabbed the way the pipeline's ffmpeg fallback grabs it. Best effort:
 *  without ffmpeg the demo already warns that its clips are fake bytes, and a seam frame that does
 *  not exist is recorded as absent rather than named anyway. */
function grabLastFrame(clip, out) {
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    spawnSync('ffmpeg', ['-y', '-sseof', '-0.2', '-i', clip, '-frames:v', '1', out], { stdio: 'ignore' });
    return fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Write the seeded run into `runsDir`, replacing any earlier copy.
 *
 * Re-seeded on every boot on purpose: the demo world is shared and stateful (e2e runs its specs
 * against one server), and a run that kept last session's approval — or last session's re-render —
 * would make the next walkthrough start somewhere else.
 *
 * @param {{root:string, runsDir:string, outDir:string, envRoot:string, childEnv?:object,
 *          videoBytes:Buffer, voicesDir?:string}} p
 * @returns {Promise<{runId:string, dir:string}>}
 */
export async function seedSeamDemoRun({ root, runsDir, outDir, envRoot, childEnv, videoBytes, voicesDir = 'voices' }) {
  const dir = path.join(runsDir, SEAM_DEMO_RUN_ID);
  fs.rmSync(dir, { recursive: true, force: true });

  const spec = threeJobSpec(root);
  const jobIds = spec.kling.jobs.map((j) => j.job_id);
  writeJson(path.join(dir, 'spec.json'), spec);
  // The engine's per-agent artifacts. Status is DERIVED from disk, so a run without them reads as
  // "0 of 8 agents" in the phase strip forever. Each stage here holds the finished plan rather than
  // a partial one — the seed is about the render, and a fabricated draft of somebody's story would
  // teach the reader nothing true.
  for (let i = 0; i <= 6; i++) writeJson(path.join(dir, `spec-${String(i).padStart(2, '0')}.json`), spec);
  writeJson(path.join(dir, 'spec-07-qc1.json'), spec);

  const t1 = path.join(dir, 'renders', 't1');
  const t2 = path.join(dir, 'renders', 't2');
  const clipOf = (take, jobId) => path.join(take, jobId, 'clip.mp4');
  for (const jobId of jobIds) writeBytes(clipOf(t1, jobId), videoBytes);
  writeBytes(clipOf(t2, 'K2'), videoBytes);
  // Each take keeps the spec it rendered from, exactly as the pipeline leaves it.
  for (const take of [t1, t2]) writeJson(path.join(take, 'spec.json'), spec);

  // Masters live in the out dir under the names the web layer's assemble would give them
  // (`<title-slug>-<run id tail>`, then `-2` for the next cut — masters are never overwritten).
  const master1 = path.join(outDir, 'harbour-watch-seam.mp4');
  const master2 = path.join(outDir, 'harbour-watch-seam-2.mp4');
  writeBytes(master1, videoBytes);
  writeBytes(master2, videoBytes);

  // How Kling really pins a boundary on this plan. A chained full render pins each clip's OPENING to
  // the previous clip's closing still and pins no ending at all, so `hasSeamOut` is false throughout
  // — the closing frame is still recorded, because it is the frame the next job opened on.
  const { chooseSeamMode } = await import(path.join(root, 'src/lib/prompt-compose.js'));
  const { capsFor } = await import(path.join(root, 'src/lib/render-models.js'));
  const caps = capsFor(BACKEND);
  const castRefCount = spec.kling.elements?.length ?? 0;
  const openingMode = chooseSeamMode({ caps, castRefCount, hasSeamIn: true, hasSeamOut: false }).in.mode;
  const noPin = { mode: 'none', frame: null, from: null };

  const lastFrame = Object.fromEntries(jobIds.map((jobId) =>
    [jobId, grabLastFrame(clipOf(t1, jobId), path.join(t1, jobId, 'last_frame.png'))]));

  // ── t1: the full render, chained end to end ──────────────────────────────────────────────────
  const t1Jobs = jobIds.map((jobId, i) => {
    const prev = jobIds[i - 1];
    const next = jobIds[i + 1];
    return {
      jobId,
      job: jobId,
      clip: clipOf(t1, jobId),
      error: null,
      seamIn: i === 0 ? { ...noPin }
        : { mode: openingMode, frame: lastFrame[prev], from: { take: 't1', job: prev, clip: clipOf(t1, prev) } },
      // `mode: 'none'` and a frame is not a contradiction: nothing pinned this clip's ENDING, and
      // the still it handed forward is recorded anyway so both ends of the joint are named.
      seamOut: {
        mode: 'none',
        frame: lastFrame[jobId],
        frameSource: lastFrame[jobId] ? 'ffmpeg' : null,
        to: next ? { take: 't1', job: next, clip: clipOf(t1, next) } : null,
      },
    };
  });

  // ── t2: K2 alone, re-rendered with only its opening pinned ───────────────────────────────────
  // This is the whole fixture in one record. K2's own join stays whole (it still opens on the K1
  // that is in the cut), and K3 — untouched, still t1's — opens on a K2 that the cut no longer
  // contains. That is a BROKEN join, and no run-level "was this chained?" flag can see it.
  const t2K2 = {
    jobId: 'K2',
    job: 'K2',
    clip: clipOf(t2, 'K2'),
    error: null,
    seamIn: { mode: openingMode, frame: lastFrame.K1, from: { take: 't1', job: 'K1', clip: clipOf(t1, 'K1') } },
    seamOut: { mode: 'none', frame: null, frameSource: null, to: null },
  };

  const takeRecord = (takeDir, master, jobs, extra) => ({
    runDir: takeDir,
    project: TITLE,
    backend: BACKEND,
    master,
    cover: null,
    masterShortSide: SHORT_SIDE,
    // Nothing was really stitched here (the master is a copy, not a join), so the record claims the
    // weakest thing it can: a hard-cut concat that colour-matched nothing.
    stitch: { stitcher: 'concat', joints: jobs.length - 1, matched: 0 },
    jobs,
    ...extra,
  });
  writeJson(path.join(t1, 'render.json'), takeRecord(t1, master1, t1Jobs, { chained: true }));
  // The composed cut, exactly as composeCut writes it: each clip carries its OWN seams in from the
  // take it was rendered in, and the run-level `chained` flag is cleared because a mixed cut has no
  // single answer — the per-joint records above are the answer now.
  const cutJobs = [{ ...t1Jobs[0], take: 't1' }, { ...t2K2, take: 't2' }, { ...t1Jobs[2], take: 't1' }];
  writeJson(path.join(t2, 'render.json'), takeRecord(t2, master2, cutJobs, { composed: true, chained: false }));

  // ── prompt sidecars: what each take sent, composed by the server's own prompt service ─────────
  const { buildPromptViews } = await import('../lib/prompt-service.js');
  const { prompts } = await buildPromptViews({ root, envRoot, childEnv, runDir: dir, spec, backend: BACKEND, voicesDir });
  const elementIds = (spec.kling.elements ?? []).map((e) => e.id);
  const sidecarFor = (view, seamIn, seamOut) => {
    const segments = view.segments ?? [];
    const total = segments.reduce((a, s) => a + (Number(s.duration) || 0), 0);
    const legend = (view.refs ?? []).filter((r) => r.role !== 'voice').map((r, i) => ({
      ref: r.ref, character: r.character ?? null, images: [elementIds[i] ?? null], voice_id: null,
    }));
    return {
      job_id: view.jobId,
      schema: 2,
      backend: BACKEND,
      transport: 'fal',
      endpoint: 'submit',
      aspect_ratio: spec.kling.aspect_ratio,
      resolution: spec.kling.resolution,
      duration_s: total,
      total_duration_s: total,
      generate_audio: !!spec.kling.generate_audio,
      // fal's Kling endpoint takes no seed input — the number is only ever a record, and this run
      // never asked for one.
      seed: null,
      seed_unused: null,
      nonce: 0,
      start_frame: seamIn.frame ? `seam:${path.basename(seamIn.frame)}` : null,
      seam_in: seamIn,
      seam_out: seamOut,
      image_refs: legend.map((e) => ({ ref: e.ref, id: e.images[0], character: e.character })),
      elements: legend,
      prompt_source: 'plan',
      segments: segments.map((s) => ({ prompt: s.prompt, duration: s.duration, speaker: s.speaker ?? null })),
    };
  };
  const viewOf = (jobId) => prompts.find((p) => p.jobId === jobId);
  for (const rec of t1Jobs) {
    const view = viewOf(rec.jobId);
    if (view) writeJson(path.join(t1, rec.jobId, 'prompts.json'), sidecarFor(view, rec.seamIn, rec.seamOut));
  }
  const k2 = viewOf('K2');
  if (k2) writeJson(path.join(t2, 'K2', 'prompts.json'), sidecarFor(k2, t2K2.seamIn, t2K2.seamOut));

  // ── the manifest ─────────────────────────────────────────────────────────────────────────────
  // Both estimates come from the real estimator: the ledger says what these renders would have
  // cost, which is what every other demo run's ledger says too (an estimate is recorded; no money
  // moves). A seeded zero is not on offer — it would read as "renders are free".
  const fullEst = estimateRender(spec, { backend: BACKEND, mode: 'full' });
  const jobEst = estimateRender(spec, { backend: BACKEND, mode: 'job', jobId: 'K2' });
  const ledgerLine = (est) => ({
    estUsd: est.totalUsd,
    note: est?.unknownPrice ? 'estimate unavailable — no published rate for this backend' : 'estimate',
    ...(est?.unknownPrice ? { unpriced: true } : {}),
  });
  const cutAt = (mins) => new Date(Date.parse(SEEDED_AT) + mins * 60_000).toISOString();

  writeJson(path.join(dir, 'web.json'), {
    v: 1,
    idea: 'a lighthouse keeper closes up at dawn (seeded demo run — three segments, the middle one re-rendered)',
    backend: BACKEND,
    aspect: spec.kling.aspect_ratio,
    durationS: spec.project.duration_target_s,
    cast: [],
    environment: null,
    createdAt: SEEDED_AT,
    revisions: [],
    takes: [
      { id: 't1', mode: 'full', revision: null, createdAt: cutAt(1), estUsd: fullEst.totalUsd, promptSource: 'plan' },
      { id: 't2', mode: 'job', jobId: 'K2', cascade: false, revision: null, createdAt: cutAt(6), estUsd: jobEst.totalUsd, promptSource: 'plan' },
    ],
    cuts: [
      { id: 'c1', take: 't1', master: master1, shortSide: SHORT_SIDE, stitcher: 'concat', joints: 2, matched: 0, createdAt: cutAt(3) },
      { id: 'c2', take: 't2', master: master2, shortSide: SHORT_SIDE, stitcher: 'concat', joints: 2, matched: 0, createdAt: cutAt(8) },
    ],
    costLedger: [
      { ts: cutAt(1), action: 'full', ...ledgerLine(fullEst) },
      { ts: cutAt(6), action: 'rerender K2', ...ledgerLine(jobEst) },
    ],
    approved: null,
    reopenedAt: null,
    finals: [],
    history: [],
    // Which take each job's NEWEST clip came out of, with the seams that clip recorded — the index
    // the composer and the continuity rule both read.
    jobClips: { K1: clipOf(t1, 'K1'), K2: clipOf(t2, 'K2'), K3: clipOf(t1, 'K3') },
    clipLineage: {
      K1: { take: 't1', seamIn: t1Jobs[0].seamIn, seamOut: t1Jobs[0].seamOut },
      K2: { take: 't2', seamIn: t2K2.seamIn, seamOut: t2K2.seamOut },
      K3: { take: 't1', seamIn: t1Jobs[2].seamIn, seamOut: t1Jobs[2].seamOut },
    },
    lastError: null,
    activeJob: null,
  });

  return { runId: SEAM_DEMO_RUN_ID, dir };
}

export default { SEAM_DEMO_RUN_ID, seedSeamDemoRun };
