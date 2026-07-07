// Setup wizard: step flow, copilot CLI lock, key validation states, env preview/write payload,
// doctor gating, and the finishing handoff back to the studio.
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse, server } from '../test/msw';
import { STEPS, type WizardState } from '../components/setup/wizard';
import SetupPage from './Setup';

const at = (step: (typeof STEPS)[number], over: Partial<WizardState> = {}): Partial<WizardState> => ({
  step: STEPS.indexOf(step),
  ...over,
});

function renderSetup(initial?: Partial<WizardState>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/setup']}>
        <Routes>
          <Route path="/setup" element={<SetupPage initial={initial} />} />
          <Route path="/" element={<div>home page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

describe('Setup wizard — step flow', () => {
  it('moves forward with the primary action and Back keeps earlier answers', async () => {
    renderSetup();
    expect(screen.getByRole('heading', { name: /make short videos/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /set up/i }));
    expect(screen.getByRole('heading', { name: /choose your planner/i })).toBeInTheDocument();

    // change an answer, walk back, walk forward — the answer survives
    await userEvent.click(screen.getByRole('radio', { name: /openai/i }));
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByRole('heading', { name: /make short videos/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /set up/i }));
    expect(screen.getByRole('radio', { name: /openai/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('selecting Copilot forces the Local CLI transport and disables the transport choice', async () => {
    renderSetup(at('llm'));
    await userEvent.click(screen.getByRole('radio', { name: /copilot/i }));

    const transport = screen.getByRole('radiogroup', { name: 'Transport' });
    expect(within(transport).getByRole('radio', { name: 'Local CLI' })).toHaveAttribute('aria-checked', 'true');
    expect(transport.className).toContain('pointer-events-none');

    // CLI transport: no key field, the detect/install panel takes its place, Continue is available
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /install copilot cli/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });
});

describe('Setup wizard — LLM key validation', () => {
  it('a valid key renders the KeyCheck valid state and unlocks Continue', async () => {
    let body: unknown;
    server.use(http.post('/api/setup/validate-llm', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ok: true });
    }));
    renderSetup(at('llm'));
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Claude API key'), 'sk-ant-test');
    await userEvent.click(screen.getByRole('button', { name: /validate/i }));
    await screen.findByText(/key valid/i);
    expect(body).toMatchObject({ provider: 'claude', transport: 'api', apiKey: 'sk-ant-test' });
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('a rejected key renders the KeyCheck invalid reason and keeps Continue disabled', async () => {
    server.use(http.post('/api/setup/validate-llm', () =>
      HttpResponse.json({ ok: false, reason: 'That key was rejected by the provider.' })));
    renderSetup(at('llm'));

    await userEvent.type(screen.getByLabelText('Claude API key'), 'sk-bad');
    await userEvent.click(screen.getByRole('button', { name: /validate/i }));
    await screen.findByText('That key was rejected by the provider.');
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });
});

describe('Setup wizard — fal.ai key', () => {
  it('validates the key, nudges about credit, and unlocks Continue', async () => {
    let body: unknown;
    server.use(http.post('/api/setup/validate-fal', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ok: true });
    }));
    renderSetup(at('fal'));
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('fal.ai API key'), 'fal-key-1');
    await userEvent.click(screen.getByRole('button', { name: /validate/i }));
    await screen.findByText(/make sure the account has a few dollars of credit/i);
    expect(body).toEqual({ apiKey: 'fal-key-1' });

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('heading', { name: /render backend/i })).toBeInTheDocument();
  });
});

describe('Setup wizard — save step', () => {
  it('renders the masked env diff rows from the preview', async () => {
    server.use(http.post('/api/settings/env/preview', () => HttpResponse.json({
      rows: [
        { key: 'FAL_KEY', from: '(unset)', to: 'fal_…cd12' },
        { key: 'LLM_PROVIDER', from: 'openai', to: 'claude' },
      ],
      overwritingReal: true,
    })));
    renderSetup(at('review'));

    await screen.findByText('FAL_KEY');
    expect(screen.getByText('(unset)')).toBeInTheDocument();
    expect(screen.getByText('fal_…cd12')).toBeInTheDocument();
    expect(screen.getByText('LLM_PROVIDER')).toBeInTheDocument();
    expect(screen.getByText(/nothing leaves your machine/i)).toBeInTheDocument();
  });

  it('Write .env posts the full updates map with RENDER_BACKEND "" for kling, then runs the doctor', async () => {
    let written: unknown;
    server.use(
      http.post('/api/settings/env/preview', () => HttpResponse.json({ rows: [], overwritingReal: false })),
      http.post('/api/settings/env', async ({ request }) => {
        written = await request.json();
        return HttpResponse.json({ written: ['FAL_KEY'] });
      }),
    );
    renderSetup(at('review', {
      provider: 'claude',
      transport: 'api',
      model: '',
      llmKey: 'sk-ant-1',
      falKey: 'fal-key-1',
      backend: 'kling',
      aspect: '9:16',
      resolution: '1080p',
    }));

    const writeBtn = await screen.findByRole('button', { name: /write \.env/i });
    await userEvent.click(writeBtn);

    await screen.findByRole('heading', { name: /one health check/i });
    expect(written).toEqual({
      updates: {
        LLM_PROVIDER: 'claude',
        LLM_TRANSPORT: 'api',
        LLM_MODEL: '',
        ANTHROPIC_API_KEY: 'sk-ant-1',
        LLM_API_KEY: 'sk-ant-1',
        FAL_KEY: 'fal-key-1',
        RENDER_BACKEND: '',
        KLING_ASPECT: '9:16',
        KLING_RESOLUTION: '1080p',
      },
    });
  });

  it('CLI transport writes no API key envs and a seedance default is written as-is', async () => {
    let written: unknown;
    server.use(
      http.post('/api/settings/env/preview', () => HttpResponse.json({ rows: [], overwritingReal: false })),
      http.post('/api/settings/env', async ({ request }) => {
        written = await request.json();
        return HttpResponse.json({ written: [] });
      }),
    );
    renderSetup(at('review', { provider: 'copilot', transport: 'cli', falKey: 'f', backend: 'seedance' }));

    await userEvent.click(await screen.findByRole('button', { name: /write \.env/i }));
    await screen.findByRole('heading', { name: /one health check/i });
    const updates = (written as { updates: Record<string, string> }).updates;
    expect(updates.RENDER_BACKEND).toBe('seedance');
    expect(updates.LLM_TRANSPORT).toBe('cli');
    expect(updates).not.toHaveProperty('LLM_API_KEY');
    expect(updates).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

describe('Setup wizard — doctor', () => {
  it('a hard ffmpeg failure blocks Continue and AUTO-EXPANDS the guided install panel', async () => {
    server.use(http.post('/api/doctor', () => HttpResponse.json({
      checks: [{ id: 'ffmpeg', ok: false, label: 'ffmpeg present (ffmpeg)', hint: 'cli hint', soft: false }],
      hard: 1,
      platform: 'darwin',
    })));
    renderSetup(at('doctor'));

    // the only unfixable-in-web check opens its own guidance — never a dead end
    expect(await screen.findByText('Install ffmpeg — a one-time step.')).toBeInTheDocument();
    expect(screen.getByText('brew install ffmpeg')).toBeInTheDocument();
    expect(screen.queryByText('cli hint')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('soft warnings defer to the Cast page and never block Continue', async () => {
    server.use(http.post('/api/doctor', () => HttpResponse.json({
      checks: [
        { id: 'fal-key', ok: true, label: 'FAL_KEY set', hint: '', soft: false },
        { id: 'references', ok: false, label: 'reference images found (0)', hint: 'cli hint', soft: true },
      ],
      hard: 0,
    })));
    renderSetup(at('doctor'));

    await screen.findByText('reference images found (0)');
    expect(screen.getByText(/you.ll add reference images on the Cast page/)).toBeInTheDocument();
    expect(screen.getByText('later, on the Cast page')).toBeInTheDocument();
    const cont = screen.getByRole('button', { name: /continue/i });
    expect(cont).toBeEnabled();
    await userEvent.click(cont);
    expect(screen.getByRole('heading', { name: /you.re set/i })).toBeInTheDocument();
  });

  it('the fix loop: Fix key → fal step in fix-mode → Save & re-check writes ONLY that key and returns', async () => {
    let doctorCalls = 0;
    let written: unknown;
    server.use(
      http.post('/api/doctor', () => {
        doctorCalls++;
        return HttpResponse.json({
          checks: [{ id: 'fal-key', ok: doctorCalls > 1, label: 'FAL_KEY set', hint: 'cli hint', soft: false }],
          hard: doctorCalls > 1 ? 0 : 1,
        });
      }),
      http.post('/api/setup/validate-fal', () => HttpResponse.json({ ok: true })),
      http.post('/api/settings/env', async ({ request }) => {
        written = await request.json();
        return HttpResponse.json({ written: ['FAL_KEY'] });
      }),
    );
    renderSetup(at('doctor'));

    // the failed row carries its fix
    await userEvent.click(await screen.findByRole('button', { name: 'Fix key' }));

    // fix-mode: the fal step, with a return ticket instead of the corridor
    expect(await screen.findByRole('heading', { name: /fal\.ai/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to health check' })).toBeInTheDocument();

    // enter + validate a key, then Save & re-check
    await userEvent.type(screen.getByLabelText(/fal.*key/i), 'fal-new-key');
    await userEvent.click(screen.getByRole('button', { name: /validate/i }));
    const save = await screen.findByRole('button', { name: 'Save & re-check' });
    expect(screen.getByText(/Writes FAL_KEY to \.env, then re-runs the checks\./)).toBeInTheDocument();
    await userEvent.click(save);

    // it wrote ONLY the fal delta and returned to the doctor, which re-ran and now passes
    await waitFor(() => expect(written).toEqual({ updates: { FAL_KEY: 'fal-new-key' } }));
    expect(await screen.findByRole('heading', { name: /one health check/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled());
  });
});

describe('Setup wizard — finish', () => {
  it('refetches setup-status BEFORE navigating home (the gate must flip first, or it bounces back)', async () => {
    const { qc } = renderSetup(at('done'));
    const refetch = vi.spyOn(qc, 'refetchQueries');

    await userEvent.click(screen.getByRole('button', { name: /create your first video/i }));
    await screen.findByText('home page');
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['setup-status'] });
  });
});
