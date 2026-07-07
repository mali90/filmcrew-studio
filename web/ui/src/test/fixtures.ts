// RunDetail builders per status — the MSW handlers and component tests share these so every test
// documents exactly which state it renders.
import type { ProductionSpec, RunDetail, RunStatus } from '../../../shared/api-types';

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
  defaults: { backend: 'kling' as const, aspect: '9:16' as const, resolution: '1080p' },
  complete: true,
};

export const ESTIMATE = {
  perJob: [{ jobId: 'K1', seconds: 9, usd: 2.88 }, { jobId: 'K2', seconds: 4, usd: 1.28 }],
  totalUsd: 4.16,
  currency: 'USD' as const,
  label: 'estimate' as const,
};
