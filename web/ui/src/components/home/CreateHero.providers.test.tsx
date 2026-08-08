// The create hero grows a second axis. Until now "backend" was one segmented control with two
// one-word options; now a run picks a MODEL and, where that model runs in more than one place, a
// PROVIDER. The two collapse back into the single `<model>@<provider>` string the API has always
// taken, so nothing downstream changes shape.
//
// The rules this pins, all of them the registry's rather than the component's:
//   * three model segments — Kling 3.0 Omni, Seedance 2.0, Seedance 2.5
//   * a Provider control appears for a model with >1 provider (both Seedance models: fal + Segmind)
//     and states availability HONESTLY for a model with one (Kling is fal-only, and says so — it
//     does not silently pretend the choice was never offered)
//   * the posted `backend` is the canonical compound id for the pair on screen
//   * caps follow the pair: Seedance 2.5 stars up to 4, Segmind renders all six ratios while
//     fal Seedance 2.0 renders three — and an invalid selection trims on switch, as it already does
//   * per-model hint copy is HONEST about money: fal 2.5 quotes its real published rate; the Segmind
//     entries say the rate is not on file yet and quote NO $/s figure at all
//
// TDD (red first): CreateHero has two hardcoded segments and no provider axis.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { http, HttpResponse, server } from '../../test/msw';
import type { CharactersResponse } from '../../../../shared/api-types';
import type { GlobalLive } from '../../hooks/useGlobalEvents';
import { ToastProvider } from '../ui/Toast';
import HomePage from '../../pages/Home';
import { aspectsFor, castLimitFor } from '../../../../shared/render-models';

const globalLive = vi.hoisted(() => ({ state: { active: [], queued: [], lastRunStatus: null } as GlobalLive }));
vi.mock('../../hooks/useGlobalEvents', () => ({ useGlobalEvents: () => globalLive.state }));

function RunProbe() {
  const { id } = useParams();
  return <div>run page {id}</div>;
}

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/runs/:id" element={<RunProbe />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const CAST_FIVE: CharactersResponse = {
  characters: ['keeper', 'gull', 'crab', 'whale', 'squid'].map((slug) => ({
    slug, name: slug, description: `# ${slug}`, refs: [], voice: null,
  })),
  unassigned: { references: [], voices: [] },
};

const capturePost = () => {
  const seen: { body?: Record<string, unknown> } = {};
  server.use(http.post('/api/runs', async ({ request }) => {
    seen.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ runId: 'web-prov-1' });
  }));
  return seen;
};

const pickModel = (name: string) => userEvent.click(screen.getByRole('radio', { name }));
const providerGroup = () => screen.getByRole('radiogroup', { name: 'Provider' });

describe('CreateHero — the model axis', () => {
  it('offers all three models', async () => {
    renderHome();
    const group = await screen.findByRole('radiogroup', { name: 'Render backend' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(
      expect.arrayContaining(['Kling', 'Seedance 2.0', 'Seedance 2.5']),
    );
  });

  it('a plain model switch still posts a backend the server accepts', async () => {
    const seen = capturePost();
    renderHome();
    await pickModel('Seedance 2.5');
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a harbour at dawn{Enter}');
    await screen.findByText('run page web-prov-1');
    expect(String(seen.body?.backend)).toMatch(/^seedance-2\.5@(fal|segmind)$/);
  });
});

describe('CreateHero — the provider axis', () => {
  it('a multi-provider model shows a Provider choice; picking one reaches the payload', async () => {
    const seen = capturePost();
    renderHome();
    await pickModel('Seedance 2.5');

    const group = providerGroup();
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label') ?? r.textContent))
      .toEqual(['fal', 'Segmind']);

    await userEvent.click(within(group).getByRole('radio', { name: 'Segmind' }));
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a harbour at dawn{Enter}');
    await screen.findByText('run page web-prov-1');
    expect(seen.body?.backend).toBe('seedance-2.5@segmind');
  });

  it('Seedance 2.0 offers both providers too — the same model, two bills', async () => {
    const seen = capturePost();
    renderHome();
    await pickModel('Seedance 2.0');
    await userEvent.click(within(providerGroup()).getByRole('radio', { name: 'Segmind' }));
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'two of them{Enter}');
    await screen.findByText('run page web-prov-1');
    expect(seen.body?.backend).toBe('seedance-2.0@segmind');
  });

  it('Kling is fal-only and SAYS SO — availability is stated, never quietly hidden', async () => {
    renderHome();
    await pickModel('Kling');
    // Either the control is absent with an explicit note, or it is present with Segmind disabled —
    // what must never happen is a Segmind option that silently produces an unrenderable backend.
    const segmind = screen.queryByRole('radio', { name: 'Segmind' });
    if (segmind) expect(segmind).toBeDisabled();
    expect(screen.getByText(/fal only/i)).toBeInTheDocument();
  });

  it('switching to a model the current provider cannot serve moves the pick back to fal', async () => {
    const seen = capturePost();
    renderHome();
    await pickModel('Seedance 2.5');
    await userEvent.click(within(providerGroup()).getByRole('radio', { name: 'Segmind' }));
    await pickModel('Kling');
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a lighthouse{Enter}');
    await screen.findByText('run page web-prov-1');
    expect(seen.body?.backend).toBe('kling-o3@fal');
  });
});

describe('CreateHero — caps follow the (model, provider) pair', () => {
  it('Seedance 2.5 stars up to four, and the caption states the registry number', async () => {
    server.use(http.get('/api/cast/characters', () => HttpResponse.json(CAST_FIVE)));
    renderHome();
    await pickModel('Seedance 2.5');
    expect(await screen.findByText(`Starring — up to ${castLimitFor('seedance-2.5')} for Seedance 2.5`)).toBeInTheDocument();
  });

  it('the ratio list is the PROVIDER\'s: six on Segmind Seedance 2.0, three on fal', async () => {
    renderHome();
    await pickModel('Seedance 2.0');
    const aspects = screen.getByRole('radiogroup', { name: 'Aspect ratio' });
    expect(within(aspects).getAllByRole('radio').map((r) => r.getAttribute('aria-label')))
      .toEqual(aspectsFor('seedance-2.0@fal'));

    await userEvent.click(within(providerGroup()).getByRole('radio', { name: 'Segmind' }));
    expect(within(aspects).getAllByRole('radio').map((r) => r.getAttribute('aria-label')))
      .toEqual(aspectsFor('seedance-2.0@segmind'));
    expect(within(aspects).getByRole('radio', { name: '21:9' })).toBeInTheDocument();
  });

  it('a ratio the next provider cannot render is trimmed on switch, and the trim is announced', async () => {
    const seen = capturePost();
    renderHome();
    await pickModel('Seedance 2.0');
    await userEvent.click(within(providerGroup()).getByRole('radio', { name: 'Segmind' }));
    const aspects = screen.getByRole('radiogroup', { name: 'Aspect ratio' });
    await userEvent.click(within(aspects).getByRole('radio', { name: '21:9' }));

    await userEvent.click(within(providerGroup()).getByRole('radio', { name: 'fal' }));
    expect(within(aspects).queryByRole('radio', { name: '21:9' })).not.toBeInTheDocument();
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('21:9');

    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a wide shore{Enter}');
    await screen.findByText('run page web-prov-1');
    expect(seen.body?.aspect).toBe(aspectsFor('seedance-2.0@fal')[0]);
  });
});

describe('CreateHero — honest money copy', () => {
  it('fal Seedance 2.5 quotes its REAL published rate', async () => {
    renderHome();
    await pickModel('Seedance 2.5');
    expect(screen.getByText(/\$0\.47/)).toBeInTheDocument(); // $0.4730/s at 720p, fal's published figure
  });

  it('a Segmind pick says the rate is not on file — and invents no $/s figure', async () => {
    renderHome();
    await pickModel('Seedance 2.5');
    await userEvent.click(within(providerGroup()).getByRole('radio', { name: 'Segmind' }));

    const hint = screen.getByTestId('backend-hint');
    expect(hint).toHaveTextContent(/not on file|not published/i);
    expect(hint).toHaveTextContent(/costs money|charges|bills/i); // it is NOT free, and says so
    expect(hint.textContent ?? '').not.toMatch(/\$\s?\d/); // no invented number, anywhere in the copy
  });

  it('no per-second figure is attached to any Segmind option', async () => {
    renderHome();
    await pickModel('Seedance 2.0');
    const segmind = within(providerGroup()).getByRole('radio', { name: 'Segmind' });
    expect(segmind.textContent ?? '').not.toMatch(/\$\s?\d/);
  });
});

describe('CreateHero — server defaults', () => {
  it('a saved compound default lights up BOTH its model and its provider', async () => {
    server.use(http.get('/api/settings/defaults', () => HttpResponse.json({
      backend: 'seedance-2.5@segmind', aspect: '21:9', resolution: '1080p', seedanceResolution: '720p',
    })));
    const seen = capturePost();
    renderHome();
    await vi.waitFor(() => expect(screen.getByRole('radio', { name: 'Seedance 2.5' })).toHaveAttribute('aria-checked', 'true'));
    expect(within(providerGroup()).getByRole('radio', { name: 'Segmind' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a harbour at dawn{Enter}');
    await screen.findByText('run page web-prov-1');
    expect(seen.body?.backend).toBe('seedance-2.5@segmind');
    expect(seen.body?.aspect).toBe('21:9'); // Segmind renders it, so the saved default survives
  });
});
