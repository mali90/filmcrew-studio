import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HttpResponse, http, server } from '../test/msw';
import { ToastProvider } from '../components/ui/Toast';
import SettingsPage from './Settings';

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter><SettingsPage /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Settings — defaults', () => {
  it('saves only the values the user changed', async () => {
    let body: unknown = null;
    server.use(
      // aspect differs from the pre-seed state so the test can wait for the query to land
      http.get('/api/settings/defaults', () => HttpResponse.json({ backend: 'kling', aspect: '16:9', resolution: '1080p', seedanceResolution: '480p' })),
      http.post('/api/settings/defaults', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ written: ['RENDER_BACKEND'] });
      }),
    );
    renderSettings();

    // wait for the server defaults to seed the controls
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /16:9/ })).toHaveAttribute('aria-checked', 'true'));

    await userEvent.click(screen.getByRole('radio', { name: 'Seedance' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));

    // backend changed; aspect and resolution match the server → omitted
    await waitFor(() => expect(body).toEqual({ backend: 'seedance' }));
    expect(await screen.findByText('Defaults saved — new runs start from these.')).toBeInTheDocument();
  });

});

describe('Settings — keys', () => {
  it('shows the masked current value as a placeholder and posts only the touched envs', async () => {
    let body: unknown = null;
    server.use(
      http.get('/api/settings/env', () => HttpResponse.json({
        source: '.env',
        rows: [
          { key: 'FAL_KEY', value: 'fal_••••••cdef', secret: true, set: true },
          { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-••••wxyz', secret: true, set: true },
        ],
      })),
      http.post('/api/settings/env', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ written: ['FAL_KEY'] });
      }),
    );
    renderSettings();

    // provider/transport seed from setup-status (claude + cli in the fixture)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'CLI' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByLabelText('fal.ai key')).toHaveAttribute('placeholder', 'fal_••••••cdef');

    await userEvent.type(screen.getByLabelText('fal.ai key'), 'fal_brand_new');
    await userEvent.click(screen.getByRole('button', { name: 'Save keys' }));

    // untouched: LLM_PROVIDER, LLM_TRANSPORT, ANTHROPIC_API_KEY — none may ride along
    await waitFor(() => expect(body).toEqual({ updates: { FAL_KEY: 'fal_brand_new' } }));
  });

  it('auto-saves provider/transport on change; Save keys posts only the key under the right env var', async () => {
    const updates: Record<string, string>[] = [];
    server.use(
      http.post('/api/settings/env', async ({ request }) => {
        const u = ((await request.json()) as { updates: Record<string, string> }).updates;
        updates.push(u);
        return HttpResponse.json({ written: Object.keys(u) });
      }),
    );
    renderSettings();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'CLI' })).toHaveAttribute('aria-checked', 'true'));

    // provider change auto-saves LLM_PROVIDER and resets the model (no Save click needed)
    await userEvent.selectOptions(screen.getByLabelText('LLM provider'), 'openai');
    await waitFor(() => expect(updates.some((u) => u.LLM_PROVIDER === 'openai' && u.LLM_MODEL === '')).toBe(true));

    // transport change auto-saves LLM_TRANSPORT
    await userEvent.click(screen.getByRole('radio', { name: 'API key' }));
    await waitFor(() => expect(updates.some((u) => u.LLM_TRANSPORT === 'api')).toBe(true));

    // the secret still waits for Save keys — and rides under the SELECTED provider's env var only
    await userEvent.type(screen.getByLabelText('LLM key (OPENAI_API_KEY)'), 'sk-openai-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save keys' }));
    await waitFor(() => expect(updates.at(-1)).toEqual({ OPENAI_API_KEY: 'sk-openai-123' }));
  });
});

describe('Settings — health (doctor)', () => {
  const DOCTOR = {
    checks: [
      { id: 'fal-key', ok: false, label: 'FAL_KEY set', hint: 'cli hint', soft: false },
      { id: 'references', ok: false, label: 'reference images found (0)', hint: 'cli hint', soft: true },
      { id: 'ffmpeg', ok: false, label: 'ffmpeg present (ffmpeg)', hint: 'cli hint', soft: false },
      { id: 'ffprobe', ok: false, label: 'ffprobe present (ffprobe)', hint: 'cli hint', soft: false },
      { id: 'llm', ok: true, label: 'LLM transport=cli', hint: '', soft: false },
    ],
    hard: 3,
    platform: 'darwin',
  };

  it('every failed row is ACTIONABLE: fix buttons, Cast links, and the guided ffmpeg panel', async () => {
    let calls = 0;
    server.use(http.post('/api/doctor', () => {
      calls++;
      return HttpResponse.json(DOCTOR);
    }));
    renderSettings();

    // hard row → web-native hint (never the CLI string) + a Fix button targeting the owning card
    expect(await screen.findByText('The render key is missing or invalid.')).toBeInTheDocument();
    expect(screen.queryByText('cli hint')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix in Keys' })).toBeInTheDocument();

    // soft row → a real link to Cast (it exists here, unlike in the wizard)
    expect(screen.getByRole('link', { name: 'Open Cast' })).toHaveAttribute('href', '/cast');

    // ffmpeg row opens the guided panel with the SERVER's platform command; ffprobe defers to it
    await userEvent.click(screen.getByRole('button', { name: 'How to install' }));
    expect(await screen.findByText('Install ffmpeg — a one-time step.')).toBeInTheDocument();
    expect(screen.getByText('brew install ffmpeg')).toBeInTheDocument(); // platform: darwin
    expect(screen.getByText('Ships with ffmpeg — the install above covers it.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it('the advanced escape saves FFMPEG_BIN through the env API and re-runs the checks', async () => {
    let written: unknown;
    let calls = 0;
    server.use(
      http.post('/api/doctor', () => {
        calls++;
        return HttpResponse.json(DOCTOR);
      }),
      http.post('/api/settings/env', async ({ request }) => {
        written = await request.json();
        return HttpResponse.json({ written: ['FFMPEG_BIN'] });
      }),
    );
    renderSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'How to install' }));
    await userEvent.click(screen.getByRole('button', { name: 'Installed somewhere unusual?' }));
    await userEvent.type(screen.getByLabelText('Path to ffmpeg'), '/usr/local/bin/ffmpeg');
    await userEvent.click(screen.getByRole('button', { name: 'Save & check' }));
    await waitFor(() => expect(written).toEqual({ updates: { FFMPEG_BIN: '/usr/local/bin/ffmpeg' } }));
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2)); // the fix re-verifies itself
  });
});

describe('Settings — storage', () => {
  it('formats runs/ and out/ sizes with human bytes', async () => {
    // default MSW handler: runs 3 files @1 MiB, out 1 file @2 MiB
    renderSettings();
    expect(await screen.findByText('— 3 files · 1.0 MB')).toBeInTheDocument();
    expect(screen.getByText('— 1 file · 2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('runs/')).toBeInTheDocument();
    expect(screen.getByText('out/')).toBeInTheDocument();
    expect(screen.getByText('Delete runs from their cards on Home.')).toBeInTheDocument();
  });
});
