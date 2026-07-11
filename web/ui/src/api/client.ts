// Typed same-origin API client. Every non-2xx response throws ApiClientError carrying the
// server's {error, hint} body — surfaces verbatim in the UI's error states.
import type {
  CharactersResponse, CliStatus, CreateRunBody, DoctorReport, EnvironmentsResponse, Estimate, InstallCliEvent, ModelsResponse,
  ReferencesList, RunDetail, RunSummary, SetupStatus, VoicesList,
} from '../../../shared/api-types';

const BASE = '/api';

export class ApiClientError extends Error {
  hint: string;
  status: number;
  constructor(status: number, error: string, hint: string) {
    super(error);
    this.status = status;
    this.hint = hint;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiClientError(res.status, body?.error ?? `HTTP ${res.status}`, body?.hint ?? 'try again');
  return body as T;
}

const get = <T,>(p: string) => req<T>(p);
const post = <T,>(p: string, body?: unknown) => req<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const del = <T,>(p: string) => req<T>(p, { method: 'DELETE' });

export const api = {
  health: () => get<{ ok: boolean; bootId: string; setupComplete: boolean }>('/health'),
  quitApp: () => post<{ ok: boolean }>('/app/quit'),
  restartApp: () => post<{ ok: boolean }>('/app/restart'),
  setupStatus: () => get<SetupStatus>('/setup/status'),
  validateLlm: (body: { provider: string; transport: string; model?: string; apiKey?: string }) =>
    post<{ ok: boolean; reason?: string }>('/setup/validate-llm', body),
  validateFal: (apiKey: string) => post<{ ok: boolean; reason?: string }>('/setup/validate-fal', { apiKey }),

  envRead: () => get<{ source: string; rows: { key: string; value: string; secret: boolean; set: boolean }[] }>('/settings/env'),
  envPreview: (updates: Record<string, string>) => post<{ rows: { key: string; from: string; to: string }[]; overwritingReal: boolean }>('/settings/env/preview', { updates }),
  envWrite: (updates: Record<string, string>) => post<{ written: string[] }>('/settings/env', { updates }),
  defaults: () => get<{ backend: string; aspect: string; resolution: string; seedanceResolution: string }>('/settings/defaults'),
  saveDefaults: (d: { backend?: string; aspect?: string; resolution?: string; seedanceResolution?: string }) => post<{ written: string[] }>('/settings/defaults', d),
  doctor: () => post<DoctorReport>('/doctor'),
  storage: () => get<{ runs: { bytes: number; count: number }; out: { bytes: number; count: number } }>('/storage'),

  cliStatus: (provider: string) => get<CliStatus>(`/setup/cli-status?provider=${encodeURIComponent(provider)}`),
  cliStatusAll: () => get<{ providers: CliStatus[] }>('/setup/cli-status'),
  models: (provider: string) => get<ModelsResponse>(`/setup/models?provider=${encodeURIComponent(provider)}`),
  /** Install a provider's CLI, streaming npm's output. Calls onEvent per NDJSON line; resolves the
   *  terminal done/error event. (Bypasses req() — the response is a stream, not a single JSON body.) */
  installCli: async (provider: string, onEvent: (e: InstallCliEvent) => void): Promise<InstallCliEvent> => {
    const res = await fetch(`${BASE}/setup/install-cli`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }),
    });
    if (!res.ok || !res.body) {
      const b = await res.json().catch(() => null);
      throw new ApiClientError(res.status, b?.error ?? 'install failed', b?.hint ?? 'try again');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let last: InstallCliEvent | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const e = JSON.parse(line) as InstallCliEvent;
        onEvent(e);
        if (e.type === 'done' || e.type === 'error') last = e;
      }
    }
    if (!last) throw new ApiClientError(500, 'install ended without a result', 'check the server log');
    return last;
  },

  runs: () => get<{ runs: RunSummary[] }>('/runs'),
  run: (id: string) => get<{ run: RunDetail }>(`/runs/${id}`),
  createRun: (body: CreateRunBody) => post<{ runId: string }>('/runs', body),
  deleteRun: (id: string) => del<{ deleted: boolean; bytes: number }>(`/runs/${id}`),
  spec: (id: string, file?: string) => get<unknown>(`/runs/${id}/spec${file ? `?file=${encodeURIComponent(file)}` : ''}`),
  log: (id: string, cursor = 0) => get<{ lines: { cursor: number; line: string }[]; nextCursor: number }>(`/runs/${id}/log?cursor=${cursor}`),
  estimate: (id: string, q: { mode: string; jobId?: string; cascade?: boolean }) =>
    get<Estimate>(`/runs/${id}/estimate?mode=${q.mode}${q.jobId ? `&jobId=${q.jobId}` : ''}${q.cascade ? '&cascade=1' : ''}`),

  render: (id: string, mode: 'probe' | 'full') => post<{ takeId: string; estUsd: number }>(`/runs/${id}/render`, { mode }),
  revise: (id: string, body: { feedback: string; scope?: string }) => post<{ revisionId: string }>(`/runs/${id}/revise`, body),
  rerenderJob: (id: string, body: { jobId: string; cascade?: boolean; feedback?: string }) =>
    post<{ takeId: string; estUsd: number; cascadeJobs: string[] }>(`/runs/${id}/rerender-job`, body),
  assemble: (id: string, composition?: Record<string, string>) => post<unknown>(`/runs/${id}/assemble`, { composition }),
  approve: (id: string, upscale: boolean) => post<{ final: string | null }>(`/runs/${id}/approve`, { upscale }),
  cancel: (id: string) => post<{ cancelled: 'queued' | 'active' | 'stale' | false }>(`/runs/${id}/cancel`),
  dismissError: (id: string) => post<{ dismissed: boolean }>(`/runs/${id}/dismiss-error`),
  replan: (id: string) => post<{ queued: unknown }>(`/runs/${id}/plan`),
  reviseForContentPolicy: (id: string) => post<{ revisionId: string }>(`/runs/${id}/revise-content-policy`),
  reveal: (id: string) => post<{ revealed: boolean; path?: string }>(`/runs/${id}/reveal`),

  references: () => get<ReferencesList>('/cast/references'),
  deleteReference: (id: string) => del<{ deleted: string }>(`/cast/references/${id}`),
  voices: () => get<VoicesList>('/cast/voices'),
  profiles: () => get<{ profiles: { name: string; content: string }[] }>('/cast/profiles'),
  characters: () => get<CharactersResponse>('/cast/characters'),
  createProfile: (body: { name: string; description?: string }) => post<{ slug: string }>('/cast/profiles', body),
  updateProfile: (slug: string, body: { name?: string; description: string }) =>
    req<{ slug: string }>(`/cast/profiles/${slug}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProfile: (slug: string, deleteRefs = false) =>
    del<{ deleted: string; refsDeleted: number }>(`/cast/profiles/${slug}${deleteRefs ? '?deleteRefs=1' : ''}`),
  environments: () => get<EnvironmentsResponse>('/environments'),
  createEnvironment: (body: { name: string; description?: string }) => post<{ slug: string }>('/environments', body),
  updateEnvironment: (slug: string, body: { description: string }) =>
    req<{ slug: string }>(`/environments/${slug}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteEnvironment: (slug: string) => del<{ deleted: string }>(`/environments/${slug}`),

  assignReference: (id: string, character: string | null) =>
    post<{ id: string }>(`/cast/references/${id}/assign`, character ? { character } : {}),
  assignVoice: (key: string, character: string | null) =>
    post<{ key: string }>(`/cast/voices/${key}/assign`, character ? { character } : {}),
  uploadReference: async (file: File, character?: string) => {
    const form = new FormData();
    if (character) form.append('character', character); // field must precede the file part
    form.append('file', file);
    const res = await fetch(`${BASE}/cast/references`, { method: 'POST', body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiClientError(res.status, body?.error ?? 'upload failed', body?.hint ?? 'try again');
    return body as { added: string };
  },
  /** Save a voice clip to the character WITHOUT minting (free — minting is the paid step). */
  stageVoice: async (character: string, clip: File) => {
    const form = new FormData();
    form.append('character', character);
    form.append('clip', clip);
    const res = await fetch(`${BASE}/cast/voices/stage`, { method: 'POST', body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiClientError(res.status, body?.error ?? 'stage failed', body?.hint ?? 'try again');
    return body as { key: string; clipName: string; minted: boolean };
  },
  /** Mint from the character's already-staged clip (paid). */
  mintStagedVoice: (name: string) => post<{ estUsd: number }>('/cast/voices', { name }),
  mintVoice: async (name: string, clip: File) => {
    const form = new FormData();
    form.append('name', name);
    form.append('clip', clip);
    const res = await fetch(`${BASE}/cast/voices`, { method: 'POST', body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiClientError(res.status, body?.error ?? 'mint failed', body?.hint ?? 'try again');
    return body as { estUsd: number };
  },
};

export type Api = typeof api;
