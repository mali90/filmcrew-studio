// RunDetail builders per status — the MSW handlers and component tests share these so every test
// documents exactly which state it renders.
import type { ProductionSpec, PromptView, RunDetail, RunStatus } from '../../../shared/api-types';

export const SPEC: ProductionSpec = {
  spec_version: '1.0',
  project: {
    title: 'Ocean Lighthouse',
    logline: 'On the last night, an old keeper tends the lamp one final time.',
    duration_target_s: 13,
    aspect_ratio: '9:16',
    hook: 'A lone beam sweeps the black sea.',
    payoff: 'The lamp goes dark; the keeper closes the door.',
    cast: ['the lighthouse keeper'],
  },
  shots: [
    { shot_id: 'S1', beat: 'hook', duration_s: 5, kling: { content_prompt: 'A lighthouse beam sweeps across a black, storm-flecked sea.', shot_size: 'extreme_wide', perspective: 'distant eye level', camera_move: 'slow push in' } },
    { shot_id: 'S2', beat: 'turn', duration_s: 4, kling: { content_prompt: 'Inside the warm lamp room, the keeper polishes the great lens.', shot_size: 'medium_close_up', perspective: 'low angle', camera_move: 'static' } },
    { shot_id: 'S3', beat: 'payoff', duration_s: 4, kling: { content_prompt: 'At first light the lamp goes dark; the keeper closes the door.', shot_size: 'wide', perspective: 'eye level', camera_move: 'hold' } },
  ],
  audio: { voice: { lines: [{ shot_id: 'S1', text: 'Forty years I kept this light.', speaker: 'keeper' }] } },
  kling: {
    aspect_ratio: '9:16', resolution: '1080p', generate_audio: true,
    elements: [{ id: 'subject', role: 'subject', image: 'elements/references/wren-01.png' }],
    jobs: [
      { job_id: 'K1', shots: ['S1', 'S2'], elements: ['subject'] },
      { job_id: 'K2', shots: ['S3'], elements: ['subject'] },
    ],
  },
  qc: { status: 'pass', checks: [{ check: 'hook + payoff present', passed: true }] },
};

const baseManifest = {
  v: 1,
  idea: 'a lighthouse keeper at dusk',
  backend: 'kling' as const,
  aspect: '9:16' as const,
  durationS: null,
  createdAt: '2026-07-04T10:00:00.000Z',
  revisions: [],
  takes: [],
  cuts: [],
  costLedger: [],
  approved: null,
  lastError: null,
  activeJob: null,
};

export function makeRun(status: RunStatus, over: Partial<RunDetail> = {}): RunDetail {
  const planned = status !== 'planning';
  const rendered = ['review', 'complete'].includes(status);
  const base: RunDetail = {
    id: 'web-20260704100000-ab12',
    source: 'web',
    manifest: { ...baseManifest, takes: rendered ? [{ id: 't1', mode: 'full', revision: null, createdAt: baseManifest.createdAt, estUsd: 4.2 }] : [], cuts: rendered ? [{ id: 'c1', take: 't1', master: '/abs/out/ocean.mp4', createdAt: baseManifest.createdAt }] : [] },
    idea: baseManifest.idea,
    backend: 'kling',
    aspect: '9:16',
    durationS: null,
    createdAt: baseManifest.createdAt,
    title: planned ? 'Ocean Lighthouse' : null,
    planned,
    agents: { done: planned ? 8 : 3, total: 8, qcCycles: planned ? 1 : 0 },
    latestRender: rendered
      ? {
          dir: '/abs/runs/x/renders/t1', backend: 'kling',
          jobs: [
            { jobId: 'K1', clip: '/abs/clip1.mp4', clipExists: true, clipUrl: '/api/media/runs/x/renders/t1/K1/clip.mp4', error: null },
            { jobId: 'K2', clip: '/abs/clip2.mp4', clipExists: true, clipUrl: '/api/media/runs/x/renders/t1/K2/clip.mp4', error: null },
          ],
          master: '/abs/out/ocean.mp4', masterExists: true, masterUrl: '/api/media/out/ocean.mp4',
          cover: '/abs/cover.png', coverUrl: '/api/media/runs/x/renders/t1/cover.png',
        }
      : status === 'rendering'
        ? {
            dir: '/abs/runs/x/renders/t1', backend: 'kling',
            jobs: [
              { jobId: 'K1', clip: null, clipExists: false, clipUrl: null, error: null },
              { jobId: 'K2', clip: null, clipExists: false, clipUrl: null, error: null },
            ],
            master: null, masterExists: false, masterUrl: null, cover: null, coverUrl: null,
          }
        : null,
    // One entry per clip in `latestRender.jobs`: an intact single-take chain (K2 opened on K1's
    // closing frame and that K1 is still the one in the cut).
    continuity: rendered
      ? [
          { jobId: 'K1', index: 0, take: 't1', continuesFromPrev: false, confidence: 'recorded', from: null, reason: 'no-prev' },
          { jobId: 'K2', index: 1, take: 't1', continuesFromPrev: true, confidence: 'recorded', from: { take: 't1', job: 'K1' }, reason: 'source-matches' },
        ]
      : null,
    coverUrl: rendered ? '/api/media/runs/x/renders/t1/cover.png' : null,
    finalUrl: status === 'complete' ? '/api/media/out/ocean-final.mp4' : null,
    finalFsPath: status === 'complete' ? '/abs/out/ocean-final.mp4' : null,
    status,
    phase: status === 'complete' ? 'deliver' : status === 'review' ? 'review' : status === 'rendering' ? 'render' : 'plan',
    error: status === 'attention' ? { ts: baseManifest.createdAt, action: 'render', message: 'fal job failed: boom', logTail: ['ERR boom'] } : null,
    spec: planned ? SPEC : null,
    queue: null,
    logCursor: 0,
  };
  if (status === 'complete' && base.manifest) base.manifest.approved = { cut: 'c1', final: '/abs/out/ocean-final.mp4', upscaled: true, at: baseManifest.createdAt };
  return { ...base, ...over };
}

export const SETUP_COMPLETE = {
  envSource: '.env' as const,
  llm: { provider: 'claude', transport: 'cli', model: null, hasKey: true },
  fal: { hasKey: true },
  segmind: { hasKey: false },
  renderProvider: 'fal' as const,
  defaults: {
    backend: 'kling' as const,
    aspect: '9:16' as const,
    // kling (the fixture's default backend) has no ladder: the server reports null for it, exactly
    // as GET /settings/defaults now answers — a tier here would resurrect the decorative knob
    resolution: null,
    resolutions: { 'kling-o3': null, 'seedance-2.0': '480p', 'seedance-2.5': '720p' },
    seedanceResolution: '480p',
  },
  complete: true,
};

export const ESTIMATE = {
  perJob: [{ jobId: 'K1', seconds: 9, usd: 2.88 }, { jobId: 'K2', seconds: 4, usd: 1.28 }],
  totalUsd: 4.16,
  currency: 'USD' as const,
  label: 'estimate' as const,
};

// ── Prompt preview (WS2-P3) ─────────────────────────────────────────────────────────────────────
// The default run renders on Kling, whose budget is per shot segment — so the default view carries
// one metered segment per shot, exactly as the server composes it. Every number here comes from the
// API in real life; the UI never recounts bytes.
const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** One job's plan prompt, shaped like the server's `PromptView`. */
export function promptView(jobId: string, over: Partial<PromptView> = {}): PromptView {
  const shots = SPEC.kling.jobs.find((j) => j.job_id === jobId)?.shots ?? [];
  // The AUTHORED body per shot — what the editor edits. The composed segment wraps it in the lead
  // reference and the framing the system owns, which is why the two are not the same string.
  const bodies = shots.map((shotId) => SPEC.shots.find((s) => s.shot_id === shotId)?.kling?.content_prompt ?? 'a shot');
  const segments = shots.map((shotId) => {
    const shot = SPEC.shots.find((s) => s.shot_id === shotId);
    const prompt = `@Element1 ${shot?.kling?.content_prompt ?? 'a shot'}`;
    return {
      shotId,
      prompt,
      duration: shot?.duration_s ?? null,
      speaker: null,
      bytes: utf8(prompt),
      maxBytes: 500,
      pinBytes: 64,
    };
  });
  const prompt = segments.map((s) => s.prompt).join('\n\n');
  return {
    jobId,
    backend: 'kling-o3@fal',
    endpointLabel: 'fal.ai Kling O3',
    shots,
    source: 'plan',
    take: null,
    sentAt: null,
    stale: false,
    fingerprint: 'abc123',
    availableTakes: [],
    prompt,
    segments,
    shotPrompts: null,
    refs: [{ ref: '@Element1', character: 'the lighthouse keeper' }],
    bytes: utf8(prompt),
    maxBytes: 500 * segments.length,
    segmentMaxBytes: 500,
    pinBytes: 64 * segments.length,
    draft: bodies.join('\n\n'),
    draftSegments: bodies,
    ...over,
  };
}

/** The same job as a past take remembers it: verbatim, with no budget on record. */
export function sentPromptView(jobId: string, take: string, over: Partial<PromptView> = {}): PromptView {
  const prompt = `@Element1 the words take ${take} really sent for ${jobId}.`;
  return {
    ...promptView(jobId),
    source: 'take',
    take,
    sentAt: '2026-07-04T09:00:00.000Z',
    fingerprint: null,
    prompt,
    segments: [{ shotId: null, prompt, duration: null, speaker: null, bytes: utf8(prompt), maxBytes: null, pinBytes: null }],
    bytes: utf8(prompt),
    maxBytes: null,
    segmentMaxBytes: null,
    pinBytes: null,
    // A past take is a record, not a draft — the server sends no editable body for one.
    draft: undefined,
    draftSegments: undefined,
    ...over,
  };
}
