// Default MSW handlers — a healthy, set-up app with one plan-ready run. Tests override per case
// with server.use(...).
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ESTIMATE, makeRun, SETUP_COMPLETE } from './fixtures';

export const handlers = [
  http.get('/api/health', () => HttpResponse.json({ ok: true, setupComplete: true })),
  http.get('/api/setup/status', () => HttpResponse.json(SETUP_COMPLETE)),
  http.get('/api/runs', () => HttpResponse.json({ runs: [makeRun('plan-ready')] })),
  http.get('/api/runs/:id', ({ params }) => HttpResponse.json({ run: makeRun('plan-ready', { id: String(params.id) }) })),
  http.get('/api/runs/:id/estimate', () => HttpResponse.json(ESTIMATE)),
  http.get('/api/runs/:id/log', () => HttpResponse.json({ lines: [], nextCursor: 0 })),
  http.get('/api/settings/defaults', () => HttpResponse.json(SETUP_COMPLETE.defaults)),
  http.get('/api/settings/env', () => HttpResponse.json({ source: '.env', rows: [] })),
  http.get('/api/setup/cli-status', ({ request }) => {
    const provider = new URL(request.url).searchParams.get('provider');
    const one = (p: string) => ({ provider: p, bin: p, npmPackage: `@x/${p}`, installMethod: 'npm' as const, installCmd: `npm install -g @x/${p}`, installed: false, version: null });
    return HttpResponse.json(provider ? one(provider) : { providers: ['claude', 'openai', 'gemini', 'copilot'].map(one) });
  }),
  http.get('/api/setup/models', ({ request }) => {
    const provider = new URL(request.url).searchParams.get('provider') ?? 'claude';
    return HttpResponse.json({ provider, default: provider === 'copilot' ? '' : `${provider}-default`, options: [], live: null, liveError: 'no-key' });
  }),
  http.get('/api/storage', () => HttpResponse.json({ runs: { bytes: 1048576, count: 3 }, out: { bytes: 2097152, count: 1 } })),
  http.get('/api/cast/references', () => HttpResponse.json({ references: [] })),
  http.get('/api/cast/voices', () => HttpResponse.json({ mintUsd: 0.007, voices: [] })),
  http.get('/api/cast/profiles', () => HttpResponse.json({ profiles: [] })),
  http.get('/api/cast/characters', () => HttpResponse.json({ characters: [], unassigned: { references: [], voices: [] } })),
  http.get('/api/environments', () => HttpResponse.json({ environments: [] })),
  http.post('/api/doctor', () => HttpResponse.json({ checks: [{ ok: true, label: 'FAL_KEY set', hint: '', soft: false }], hard: 0 })),
];

export const server = setupServer(...handlers);
export { http, HttpResponse };
