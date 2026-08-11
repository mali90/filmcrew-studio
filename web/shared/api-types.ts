// The single source of truth for API shapes — the UI imports these; the server's route handlers
// are the reference implementation (web/server/routes/*). Keep field names in lockstep with
// serializeRun in routes/runs.js and the event emitters in lib/run-service.js.

/** Render backend ids: the canonical `<model>@<provider>` form the server now returns, plus the two
 *  legacy one-word aliases that stay valid forever (old manifests are never migrated on disk).
 *  Mirrors ALL_BACKENDS in src/lib/render-models.js. */
export type Backend =
  | 'kling' | 'seedance'                                  // legacy one-word aliases (never migrated on disk)
  | 'kling-o3@fal'
  | 'seedance-2.0@fal' | 'seedance-2.0@segmind'
  | 'seedance-2.5@fal' | 'seedance-2.5@segmind';
/** Every aspect ratio SOME model can render — which ones a given run may pick is per-model
 *  (aspectsFor(backend)). 'adaptive'/'auto' are deliberately absent: the stitch canvas needs a
 *  deterministic ratio. */
export type Aspect = '9:16' | '16:9' | '1:1' | '4:3' | '3:4' | '21:9';
/** Every render tier SOME model offers — which ones a given run may pick is per-model
 *  (resolutionsFor(backend): Kling is 720p+, Seedance 2.5 tops out at 720p). */
export type Resolution = '480p' | '720p' | '1080p' | '4k';
export type RunStatus = 'planning' | 'plan-ready' | 'rendering' | 'attention' | 'review' | 'complete';
/** The two vendors that run the approve-time Topaz upscale. Only ever these two literal ids on the
 *  wire — 'auto' is a config value, never a payload one (the server 400s anything else). */
export type UpscaleProvider = 'fal' | 'segmind';
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
  /** Per-run render resolution pick; null/absent = the model's configured default. Reapplied as the
   *  model's own env knob on every child spawn, and priced by the estimator over the .env value. */
  resolution?: Resolution | null;
  durationS: number | null;                 // null = auto (the engine decides)
  environment?: string | null;              // selected world/mood/style bible slug (null = none) — revisions re-inject it
  createdAt: string;
  revisions: { id: string; feedback: string | null; scope: string; owners: number[]; createdAt: string }[];
  /** `promptSource` records whose words a take rendered: the agents' plan, or a saved edit. */
  takes: { id: string; mode: 'probe' | 'full' | 'job'; jobId?: string; cascade?: boolean; revision: string | null; createdAt: string; estUsd?: number | null; feedback?: string | null; promptSource?: 'plan' | 'override' }[];
  // `stitcher`/`joints`/`matched` describe how the seams were joined ('seamless' = colour-matched
  // chained joints, 'concat' = a hard cut at every seam). Absent on cuts made before that existed.
  cuts: { id: string; take: string; master: string | null; shortSide?: number | null; stitcher?: 'seamless' | 'concat'; joints?: number; matched?: number; createdAt: string }[];
  // `unpriced` marks a line that SPENT money at a rate nobody publishes (Segmind, Topaz per-clip):
  // estUsd is null there because the figure is unknown, not because the step was free.
  // `provider` (upscale lines only) records which vendor the Topaz job billed — the reviewer's
  // explicit pick, or the same derivation the estimate priced when nothing was picked.
  costLedger: { ts: string; action: string; estUsd: number | null; unpriced?: boolean; provider?: UpscaleProvider; note: string }[];
  approved: { cut: string | null; final: string; upscaled: boolean; stitcher?: 'seamless' | 'concat'; joints?: number; matched?: number; at: string } | null;
  // Delivery lifecycle (WS2-P6), all three ADDITIVE — absent on every run delivered before it
  // existed, and absence means "never reopened, no history", never an error.
  /** When the user reopened a delivered run to make changes. The run is delivered again only once
   *  `approved.at` is newer than this; until then it is back in review and spending is unlocked. */
  reopenedAt?: string | null;
  /** Every delivery this run has made, oldest first. `replacedBy` names the entry that superseded
   *  it — the file itself is never deleted, so an older final stays downloadable. */
  finals?: { id: string; cut: string | null; final: string; upscaled: boolean; at: string; replacedBy?: string }[];
  /** Lifecycle markers for the History panel to list beside takes/cuts/revisions: reopens, and the
   *  prompt edits that change which words the NEXT render sends (`job` names the segment). Saving
   *  or discarding an edit is a local file write — these rows record a change of intent, not spend. */
  history?: { id: string; kind: 'reopen' | 'prompt-edit' | 'prompt-discard'; job?: string; final?: string; at: string }[];
  lastError: RunError | null;
  activeJob: { kind: ActionKind; pid: number; startedAt: string; queueId?: string } | null;
  jobClips?: Record<string, string>;
  // Where each job's newest clip came from and the seams the renderer recorded for it. Absent on
  // runs made before WS2-P1 — their continuity is derived from take history and flagged as such.
  clipLineage?: Record<string, { take: string; seamIn?: unknown; seamOut?: unknown }>;
}

/**
 * One segment of the cut on screen, and whether it really continues from the segment before it.
 * `confidence:'derived'` means the answer was reconstructed from take history (a pre-WS2 run) — the
 * UI draws a dashed "join unknown" connector for those, never a solid link. Ids only, by contract:
 * no filesystem path is ever serialized here.
 */
export interface ContinuityEntry {
  jobId: string;
  index: number;
  take: string | null;         // the take this clip was rendered in
  continuesFromPrev: boolean;
  confidence: 'recorded' | 'derived';
  from: { take: string | null; job: string | null } | null; // the clip its opening frame came off, when recorded
  reason: string;              // machine token (see lib/lineage.js CONTINUITY_REASONS) — the UI words it
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
  // DETAIL only. Aligned 1:1 with `latestRender.jobs`; null while a take is still rendering (nothing
  // recorded yet) or when the run has no cut at all. The library LIST does not carry it: deriving it
  // costs a render.json read per take per run, and the list re-fetches on every SSE status tick —
  // for a field only the run page (ClipStrip, SegmentRerenderDialog) ever reads.
  continuity: ContinuityEntry[] | null;
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
  /** A prompt edit was saved or discarded (free — a local file write, nothing submitted). Broadcast
   *  so a second tab's prompt sheet stops showing text that is no longer what we would send. */
  | { type: 'prompt-override'; jobId: string; action: 'saved' | 'discarded'; source: 'plan' | 'override'; stale: boolean }
  | { type: 'done'; kind: ActionKind; result: unknown }
  | { type: 'error'; kind: ActionKind; message: string };

export interface QueueItem { id: string; runId: string; lane: 'plan' | 'spend' | 'free'; kind: ActionKind; startedAt: string | null }
export type GlobalEvent =
  | { type: 'snapshot'; queue: { active: QueueItem[]; queued: QueueItem[] } }
  | { type: 'queue'; active: QueueItem[]; queued: QueueItem[] }
  | { type: 'run-status'; runId: string; status: RunStatus }
  | { type: 'run-activity'; runId: string; eventType: string };

// ── Endpoint payloads ──
export interface CreateRunBody {
  idea: string;
  backend: Backend;
  aspect: Aspect;
  /** Per-run render resolution — one of the model's own resolutionsFor(backend); omitted/null = the
   *  configured default. Validated server-side (400 before any spawn). */
  resolution?: Resolution | null;
  durationS: number | null;
  cast?: string[];
  environment?: string;
}

// ── Frame-conditioned re-render (WS2-P5) ──
/** What a re-render pins at its two ends. `auto` mirrors the joins the cut already has — it keeps a
 *  linked joint linked and leaves a broken one broken; repairing a break is always an explicit ask. */
export type BoundaryMode = 'auto' | 'both' | 'start' | 'end' | 'none';
/** A neighbour segment, by id — never a host path. */
export interface BoundaryNeighbour { index: number; jobId: string | null; take: string | null }
/** How each end was ACTUALLY pinned (null = nothing pinned; the frame was missing or not asked for).
 *  `startMode`/`endMode` come from the renderer's own chooseSeamMode: only `native` may be called
 *  seamless in copy, `soft` is "near-seamless (reference-guided)", `none` is a scene cut. */
export interface BoundaryPlan {
  mode: BoundaryMode;
  start: { frame: 'last'; from: BoundaryNeighbour | null } | null;
  end: { frame: 'first'; to: BoundaryNeighbour | null } | null;
  startMode: 'native' | 'soft' | 'none' | 'unsupported';
  endMode: 'native' | 'soft' | 'none' | 'unsupported';
}
export interface RerenderJobBody { jobId: string; cascade?: boolean; feedback?: string; take?: number; boundaries?: BoundaryMode }
/** POST /api/runs/:id/approve — finalize (free) or upscale-and-finalize (paid). */
export interface ApproveBody {
  upscale: boolean;
  /** Which cut to finalize; omitted = the latest render (the stage's implicit target). */
  cut?: string;
  /** Which vendor runs the Topaz upscale — the ApproveBar's pick. Only meaningful with
   *  `upscale: true`; omitted = the server derives it exactly as the estimate did (env/keys).
   *  Anything but 'fal'/'segmind' is a 400 before any money moves. */
  provider?: UpscaleProvider;
}
/** GET /api/runs/:id/estimate query params (api.estimate). */
export interface EstimateParams {
  mode: 'full' | 'probe' | 'job' | 'upscale';
  jobId?: string;
  cascade?: boolean;
  /** mode=upscale only: price this cut's clips (omitted = every job in the current spec). */
  cut?: string;
  /** mode=upscale only: quote THIS vendor's Topaz rate (and its delivered target) instead of the
   *  env-derived one — the ApproveBar re-quotes per pick through this. */
  provider?: UpscaleProvider;
}
export interface RerenderJobResult {
  takeId: string;
  estUsd: number | null;
  cascadeJobs: string[];
  boundaries: BoundaryPlan;
}
// `usd`/`totalUsd` are NULLABLE on purpose: some providers publish no per-second rate (every Segmind
// model we drive), and the estimator answers "I don't know" rather than guessing a sibling's price or
// 500ing the run page. null + `unknownPrice` = the rate is not on file; the render still costs money.
export interface Estimate {
  perJob: { jobId: string; seconds: number; usd: number | null }[];
  totalUsd: number | null;
  currency: 'USD';
  label: 'estimate';
  unknownPrice?: { provider?: string | null; hint: string };
  /** mode=upscale only: the short side the upscale would DELIVER (Segmind's explicit target, or
   *  ~1080 for fal's factor plan) — the review UI's "already HD" gate judges against this. Follows
   *  the `provider` query param when one is given, so the gate tracks the PICKED vendor. */
  targetShortSide?: number;
}
// ── Prompt preview (WS2-P3) ──
// What the render will be sent, composed by the SAME pure builder the renderer uses
// (src/lib/prompt-compose.js) — so `prompt` here is byte-for-byte what leaves for the provider.
/** One image/audio reference the prompt cites by label. Ids and names only — never a file path. */
export interface PromptRef { ref: string; character?: string | null; role?: string }
/** Kling composes one ≤500-byte segment per shot, so its budget (and its editor) is per segment. */
export interface PromptSegment {
  shotId: string | null;
  prompt: string;
  duration: number | null;
  speaker: string | null;
  bytes: number;
  maxBytes: number | null;
  pinBytes: number | null;
}
export interface PromptView {
  jobId: string;
  /** The model that will render it — `<model>@<provider>`, or what a past take recorded. */
  backend: Backend | string | null;
  /** Plain-words provider + model ("fal.ai Seedance 2.0"), for honest "what you are paying" copy. */
  endpointLabel: string;
  shots: string[];
  /** 'plan' = the agents' text; 'override' = a saved edit (P4); 'take' = immutable, as sent. */
  source: 'plan' | 'override' | 'take';
  take: string | null;
  /** When a 'take' view's prompts.json was written — i.e. when this text was sent. */
  sentAt: string | null;
  /** True when the plan moved under a saved override (fingerprint mismatch). It changes nothing
   *  about what is sent — a stale override still renders word for word — only what is SAID. */
  stale: boolean;
  /** When the override was saved; null on plan/take views. */
  updatedAt?: string | null;
  /** The agents' CURRENT text, offered alongside an override so "Refresh from plan" has something
   *  to load and the two can be compared. Absent unless `source === 'override'`. */
  planPrompt?: string;
  /** Same, per shot (Kling segments / Seedance shot blocks). */
  planSegments?: string[];
  /** The words the EDITOR owns — the authored scene body, without the system scaffolding that is
   *  re-composed on top at render time. Saved back unchanged it re-composes to `prompt`, byte for
   *  byte. Absent on a past take, which is a record and not a draft. */
  draft?: string;
  /** Kling: one authored body per shot, because its byte cap is per shot. Null on Seedance. */
  draftSegments?: string[] | null;
  /** The agents' CURRENT authored body, in the same editable form — what `Refresh from plan` loads
   *  into the editor. Present only alongside an override. */
  planDraft?: string;
  planDraftSegments?: string[] | null;
  /** Hash of exactly the authored inputs this prompt is composed from; null for a past take. */
  fingerprint: string | null;
  /** Take ids that kept a `prompts.json` for THIS job, newest first — the version picker's options.
   *  A take that never sent this job is absent, so no option opens onto a 404. */
  availableTakes: string[];
  prompt: string;
  /** Kling only — one entry per shot; null on Seedance (one prompt per job). */
  segments: PromptSegment[] | null;
  /** Seedance only — the raw per-shot blocks before they are joined. */
  shotPrompts: string[] | null;
  refs: PromptRef[];
  bytes: number;
  /** The byte budget the meter draws against; null for a past take (its budget isn't recorded). */
  maxBytes: number | null;
  /** Kling's per-segment cap, when the budget is per segment. */
  segmentMaxBytes: number | null;
  /** Bytes the SYSTEM already owns (front matter, guards, frame pins) — an edit cannot spend them. */
  pinBytes: number | null;
  /** How each boundary will be pinned: only 'native' may ever be called seamless in UI copy. */
  seam?: { in: string | null; out: string | null };
  /** Set when this job cannot be composed at all (the render would fail on the same message). */
  error?: string;
}
export interface PromptsResponse {
  runId: string;
  backend: Backend | string;
  jobs: string[];
  prompts: PromptView[];
  /** Saved overrides whose job the plan no longer has — kept WITH their text, never silently
   *  discarded: the agents re-cutting the segments must not delete words a user typed. */
  orphaned: { jobId: string; prompt?: string; segments?: string[]; updatedAt?: string | null }[];
}
/** PUT /api/runs/:id/prompt — the user's own words, stored verbatim (no pins, no truncation). */
export interface SetPromptBody {
  /** Which job. `jobId` is accepted as an alias. */
  job: string;
  /** Seedance: the whole job in one document. */
  prompt?: string;
  /** Kling: one entry per shot, in shot order (its byte cap is per segment). */
  segments?: string[];
}

export interface SetupStatus {
  envSource: '.env' | '.env.example' | 'none';
  llm: { provider: string; transport: string; model: string | null; hasKey: boolean };
  fal: { hasKey: boolean };
  segmind: { hasKey: boolean };
  /** The DEFAULT backend's billing provider — the key that gates `complete` (a Segmind-only
   *  install needs no fal account; requiring FAL_KEY would trap it in /setup). */
  renderProvider: 'fal' | 'segmind';
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

// `soft` is decided per check by the doctor (not by the id): a missing SEGMIND_API_KEY blocks the
// person whose default backend renders on Segmind and merely informs everyone else.
export type CheckId =
  | 'fal-key' | 'segmind-key' | 'render-assets' | 'backend' | 'upscale-provider'
  | 'voices' | 'voice-clips' | 'llm' | 'ffmpeg' | 'ffmpeg-version' | 'ffprobe' | 'references';
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
