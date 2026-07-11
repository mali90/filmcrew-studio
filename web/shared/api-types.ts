// The single source of truth for API shapes — the UI imports these; the server's route handlers
// are the reference implementation (web/server/routes/*). Keep field names in lockstep with
// serializeRun in routes/runs.js and the event emitters in lib/run-service.js.

export type Backend = 'kling' | 'seedance';
export type Aspect = '9:16' | '16:9' | '1:1';
export type RunStatus = 'planning' | 'plan-ready' | 'rendering' | 'attention' | 'review' | 'complete';
export type Phase = 'plan' | 'render' | 'review' | 'deliver';
export type ActionKind = 'plan' | 'revise' | 'render' | 'probe' | 'render-job' | 'assemble' | 'upscale' | 'mint-voice';

export interface AgentProgress { done: number; total: 8; qcCycles: number }

export interface JobView {
  jobId: string;
  clip: string | null;      // absolute fs path (display only)
  clipExists: boolean;
  clipUrl: string | null;   // range-served media URL
  error: string | null;
}

export interface RenderView {
  dir: string;
  backend: Backend | null;
  jobs: JobView[];
  master: string | null;
  masterExists: boolean;
  masterShortSide?: number | null; // delivered pixels (short side) — ≥1080 disables the paid upscale
  masterUrl: string | null;
  cover: string | null;
  coverUrl: string | null;
}

export interface RunError { ts: string; action: string; message: string; logTail: string[] }

export interface Manifest {
  v: number;
  idea: string;
  backend: Backend;
  aspect: Aspect;
  durationS: number | null;                 // null = auto (the engine decides)
  environment?: string | null;              // selected world/mood/style bible slug (null = none) — revisions re-inject it
  createdAt: string;
  revisions: { id: string; feedback: string | null; scope: string; owners: number[]; createdAt: string }[];
  takes: { id: string; mode: 'probe' | 'full' | 'job'; jobId?: string; cascade?: boolean; revision: string | null; createdAt: string; estUsd?: number; feedback?: string | null }[];
  cuts: { id: string; take: string; master: string | null; shortSide?: number | null; createdAt: string }[];
  costLedger: { ts: string; action: string; estUsd: number | null; note: string }[];
  approved: { cut: string | null; final: string; upscaled: boolean; at: string } | null;
  lastError: RunError | null;
  activeJob: { kind: ActionKind; pid: number; startedAt: string; queueId?: string } | null;
  jobClips?: Record<string, string>;
}

export interface RunSummary {
  id: string;
  source: 'web' | 'cli';
  manifest: Manifest | null;
  idea: string | null;
  backend: Backend | null;
  aspect: Aspect | null;
  durationS: number | null;
  createdAt: string | null;
  title: string | null;
  planned: boolean;
  agents: AgentProgress;
  latestRender: RenderView | null;
  coverUrl: string | null;
  finalUrl: string | null;
  finalFsPath: string | null;
  status: RunStatus;
  revising?: { id: string; owners: number[]; scope: string } | null; // live revision (owners re-running)
  phase: Phase;
  error: RunError | null;
}

export interface RunDetail extends RunSummary {
  spec: ProductionSpec | null;
  queue: { position: number } | null;
  logCursor: number;
}

// ── Production Spec (the 8-agent engine's output; validator: src/lib/spec-schema.js) ──
export interface Shot {
  shot_id: string;
  beat?: string;
  duration_s?: number;
  description?: string;
  kling?: { content_prompt?: string; shot_size?: string; perspective?: string; camera_move?: string; duration?: number };
}
export interface ProductionSpec {
  spec_version: string;
  render_backend?: Backend;
  cast?: string[];                          // engine-stamped: the run's starred slugs (revisions re-inject them)
  environment?: string;                     // engine-stamped: the run's "Set in" slug (revisions re-inject it)
  project: { title: string; logline?: string; format?: string; duration_target_s?: number; aspect_ratio?: Aspect; hook?: string; payoff?: string; cast?: string[]; cover_frame_s?: number };
  shots: Shot[];
  audio?: { voice?: { lines?: { shot_id?: string; at_s?: number; text: string; speaker?: string; tone?: string }[] } };
  kling: {
    model_name?: string; aspect_ratio?: Aspect; resolution?: string; generate_audio?: boolean;
    elements?: { id: string; role?: string; image: string; character?: string }[];
    jobs: { job_id: string; shots: string[]; elements?: string[]; first_frame?: string; last_frame?: string }[];
  };
  qc?: { status: 'pass' | 'fail'; checks?: { check: string; passed: boolean; evidence?: string }[]; notes?: string };
}

// ── Events (SSE) ──
export type RunEvent =
  | { type: 'snapshot'; run: RunDetail }
  | { type: 'status'; status: RunStatus; phase: Phase }
  | { type: 'action-start'; kind: ActionKind }
  | { type: 'agent'; idx: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; state: 'started'; cycle?: number; revision?: boolean }
  | { type: 'qc'; state: 'pass' | 'redo'; owners?: number[] }
  | { type: 'spec-block'; file: string }
  | { type: 'artifact'; file: string }
  | { type: 'job'; jobId: string; state: 'started' | 'done' | 'failed'; clip?: string; message?: string }
  | { type: 'assemble'; state: 'started' }
  | { type: 'master'; path: string }
  | { type: 'upscale'; state: 'started' }
  | { type: 'log'; cursor: number; line: string }
  | { type: 'done'; kind: ActionKind; result: unknown }
  | { type: 'error'; kind: ActionKind; message: string };

export interface QueueItem { id: string; runId: string; lane: 'plan' | 'spend' | 'free'; kind: ActionKind; startedAt: string | null }
export type GlobalEvent =
  | { type: 'snapshot'; queue: { active: QueueItem[]; queued: QueueItem[] } }
  | { type: 'queue'; active: QueueItem[]; queued: QueueItem[] }
  | { type: 'run-status'; runId: string; status: RunStatus }
  | { type: 'run-activity'; runId: string; eventType: string };

// ── Endpoint payloads ──
export interface CreateRunBody { idea: string; backend: Backend; aspect: Aspect; durationS: number | null; cast?: string[]; environment?: string }
export interface Estimate { perJob: { jobId: string; seconds: number; usd: number }[]; totalUsd: number; currency: 'USD'; label: 'estimate' }
export interface SetupStatus {
  envSource: '.env' | '.env.example' | 'none';
  llm: { provider: string; transport: string; model: string | null; hasKey: boolean };
  fal: { hasKey: boolean };
  defaults: { backend: Backend; aspect: Aspect; resolution: string };
  complete: boolean;
}
// ── Provider CLI install + model list (Settings › Keys) ──
export interface CliStatus { provider: string; bin: string; npmPackage: string; installMethod: 'npm' | 'native'; installCmd: string; installed: boolean; version: string | null }
/** NDJSON events streamed by POST /setup/install-cli (one per line). */
export type InstallCliEvent =
  | { type: 'start'; provider: string; pkg?: string; command: string }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'done'; ok: true; bin: string; installed: boolean; version: string | null }
  | { type: 'error'; ok: false; message: string; hint: string; code?: number };
export interface ModelOption { id: string; hint?: string }
export interface LiveModel { id: string; label?: string; recommended?: boolean }
export interface ModelsResponse {
  provider: string;
  default: string;              // '' means the provider rides its own default (Copilot)
  options: ModelOption[];       // curated alternatives (always present)
  live: LiveModel[] | null;     // provider's live list when a key is set; null otherwise
  liveError?: 'no-key' | 'cli-only' | 'fetch-failed';
}

export type CheckId = 'fal-key' | 'backend' | 'voices' | 'voice-clips' | 'llm' | 'ffmpeg' | 'ffprobe' | 'references';
export interface DoctorReport {
  checks: { id: CheckId; ok: boolean; label: string; hint: string; soft: boolean }[];
  hard: number;
  platform?: string; // server OS — drives the guided ffmpeg install commands
}
export interface VoiceRow { key?: string; name: string | null; voiceId: string | null; mintedAt: string | null; refClipAvailable: boolean; clipName?: string | null }
export interface VoicesList { mintUsd: number; voices: VoiceRow[] }
export interface ReferenceRow { id: string; type: string; file: string; abs: string; description?: string; url?: string | null }
export interface ReferencesList { references: ReferenceRow[] }
/** A character = profiles/<slug>.md + refs linked by filename prefix + a voice keyed by the slug. */
export interface CharacterView {
  slug: string;
  name: string;
  description: string;         // the profile markdown (first heading = display name)
  refs: ReferenceRow[];
  voice: VoiceRow | null;
}
export interface CharactersResponse {
  characters: CharacterView[];
  unassigned: { references: ReferenceRow[]; voices: VoiceRow[] };
}
/** An environment = environments/<slug>.md — a descriptive-only world/mood/style bible (no assets). */
export interface EnvironmentView {
  slug: string;
  name: string;
  description: string;         // the full environment markdown (first heading = display name)
}
export interface EnvironmentsResponse { environments: EnvironmentView[] }
export interface ApiError { error: string; hint: string }

// The 8 agents, in pipeline order — names/roles mirror engine/agents/*.md.
export const AGENTS = [
  { idx: 0, name: 'Showrunner', block: 'project', doing: 'Turning your idea into a title, logline, hook and payoff…' },
  { idx: 1, name: 'Storyboard', block: 'shots', doing: 'Breaking the story into timed shots…' },
  { idx: 2, name: 'Scene Director', block: 'content', doing: 'Writing what happens in every shot…' },
  { idx: 3, name: 'Cinematographer', block: 'camera', doing: 'Choosing framing and camera moves…' },
  { idx: 4, name: 'Casting', block: 'elements', doing: 'Pinning reference images for the cast…' },
  { idx: 5, name: 'Sound', block: 'audio', doing: 'Deciding voice lines, SFX and ambience…' },
  { idx: 6, name: 'Job Planner', block: 'jobs', doing: 'Packing shots into ≤15s render jobs…' },
  { idx: 7, name: 'QC', block: 'qc', doing: 'Checking the whole plan end to end…' },
] as const;
