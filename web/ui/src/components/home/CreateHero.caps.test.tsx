// Per-model caps in the create hero — layer 3 of 3 (engine → server → UI). The UI's job is to make
// the caps un-hittable rather than to explain a 400 after the fact:
//   * the Starring row states the cap and disables unselected pills once it is reached;
//   * switching model TRIMS an over-cap selection (and says so) instead of submitting something the
//     server will reject;
//   * the Aspect control offers exactly the chosen model's ratios, and trims an invalid one on switch.
//
// The trim rules are exported as PURE helpers so they can be asserted against seedance-2.5 — the
// model that has all six ratios and a cast cap of 4 but no provider entry (and therefore no UI
// option) yet. The DOM cases below deliberately assert BEHAVIOUR, not where the caps data comes from.
//
// TDD (red first): CreateHero has no cap awareness and a hardcoded three-tile ASPECT_TILES list.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { http, HttpResponse, server } from '../../test/msw';
import type { Aspect, Backend, CharactersResponse, EnvironmentsResponse } from '../../../../shared/api-types';
import type { GlobalLive } from '../../hooks/useGlobalEvents';
import { ToastProvider } from '../../components/ui/Toast';
import HomePage from '../../pages/Home';
import { aspectsForBackend, castCapFor, modelLabelFor, trimAspect, trimCast } from './CreateHero';

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

const CAST_THREE: CharactersResponse = {
  characters: [
    { slug: 'keeper', name: 'The Keeper', description: '# Keeper', refs: [], voice: null },
    { slug: 'gull', name: 'Gull', description: '# Gull', refs: [], voice: null },
    { slug: 'crab', name: 'Crab', description: '# Crab', refs: [], voice: null },
  ],
  unassigned: { references: [], voices: [] },
};

const ENVS: EnvironmentsResponse = {
  environments: [
    { slug: 'neon-city', name: 'Neon City', description: '# Neon City' },
    { slug: 'harbor', name: 'Harbor', description: '# Harbor' },
  ],
};

const withCast = () => server.use(http.get('/api/cast/characters', () => HttpResponse.json(CAST_THREE)));
const capturePost = () => {
  const seen: { body?: Record<string, unknown> } = {};
  server.use(http.post('/api/runs', async ({ request }) => {
    seen.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ runId: 'web-caps-1' });
  }));
  return seen;
};

// ── shared types (compile-time contract; `npm run typecheck` is the real gate) ──
describe('web/shared/api-types', () => {
  it('Aspect is the six-ratio numeric superset and Backend keeps the legacy names', () => {
    const aspects: Aspect[] = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
    expect(aspects).toHaveLength(6);
    // legacy values must stay assignable — old manifests are never migrated
    const backends: Backend[] = ['kling', 'seedance', 'kling-o3@fal', 'seedance-2.0@fal'];
    expect(backends).toHaveLength(4);
  });
});

// ── the pure rules (assertable for models the UI cannot yet select) ─────────
// NOTE for the implementation: these helpers take a plain `string`, not `Backend`. They must accept
// a BARE MODEL ID ('seedance-2.5') as well as a backend id, exactly like the registry's
// castLimitFor/aspectsFor — that is what makes a model assertable (and later selectable) before it
// has a provider entry.
describe('CreateHero — pure cap helpers', () => {
  it('castCapFor / modelLabelFor read the registry, including models with no provider yet', () => {
    expect(castCapFor('kling')).toBe(1);
    expect(castCapFor('seedance')).toBe(2);
    expect(castCapFor('seedance-2.5')).toBe(4);
    expect(modelLabelFor('kling')).toBe('Kling 3.0 Omni');
    expect(modelLabelFor('seedance')).toBe('Seedance 2.0');
    expect(modelLabelFor('seedance-2.5')).toBe('Seedance 2.5');
  });

  it('aspectsForBackend is per model — six ratios for 2.5, three for today\'s two', () => {
    expect(aspectsForBackend('kling')).toEqual(['16:9', '9:16', '1:1']);
    expect(aspectsForBackend('seedance-2.0@fal')).toEqual(['16:9', '9:16', '1:1']);
    expect(aspectsForBackend('seedance-2.5')).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);
    for (const list of [aspectsForBackend('kling'), aspectsForBackend('seedance-2.5')]) {
      expect(list).not.toContain('adaptive');
      expect(list).not.toContain('auto');
    }
  });

  it('trimCast keeps the FIRST N starred, so the trim is predictable', () => {
    expect(trimCast(['keeper', 'gull', 'crab', 'whale', 'squid'], 'seedance-2.5')).toEqual(['keeper', 'gull', 'crab', 'whale']);
    expect(trimCast(['keeper', 'gull'], 'seedance')).toEqual(['keeper', 'gull']);
    expect(trimCast(['keeper', 'gull'], 'kling')).toEqual(['keeper']);
    expect(trimCast([], 'kling')).toEqual([]);
  });

  it('trimAspect keeps a valid ratio and falls back to the model\'s first when it is not', () => {
    expect(trimAspect('21:9', 'seedance-2.5')).toBe('21:9');
    expect(trimAspect('9:16', 'kling')).toBe('9:16');
    expect(trimAspect('21:9', 'kling')).toBe('16:9');
    expect(trimAspect('4:3', 'seedance')).toBe('16:9');
  });
});

// ── cast caps in the DOM ────────────────────────────────────────────────────
describe('Home — cast caps', () => {
  it('the Starring label states the cap for the selected model', async () => {
    withCast();
    renderHome();
    expect(await screen.findByText('Starring — up to 1 for Kling 3.0 Omni')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Seedance' }));
    expect(screen.getByText('Starring — up to 2 for Seedance 2.0')).toBeInTheDocument();
  });

  it('at the cap, unselected pills are disabled and explain why; selected ones still toggle off', async () => {
    withCast();
    renderHome();
    const group = await screen.findByRole('group', { name: 'Starring' });
    const keeper = within(group).getByRole('button', { name: 'The Keeper' });
    const gull = within(group).getByRole('button', { name: 'Gull' });

    await userEvent.click(keeper);
    expect(keeper).toHaveAttribute('aria-pressed', 'true');
    expect(gull).toBeDisabled();
    expect(gull).toHaveAttribute('title', expect.stringContaining('1'));

    await userEvent.click(gull);                                  // a disabled pill refuses the add
    expect(gull).toHaveAttribute('aria-pressed', 'false');
    expect(keeper).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(keeper);                                // unstarring frees the slot again
    expect(gull).toBeEnabled();
    expect(gull).not.toHaveAttribute('title');
  });

  it('switching to a model with a smaller cap TRIMS the selection and says so', async () => {
    withCast();
    const seen = capturePost();
    renderHome();
    await userEvent.click(screen.getByRole('radio', { name: 'Seedance' }));
    const group = await screen.findByRole('group', { name: 'Starring' });
    await userEvent.click(within(group).getByRole('button', { name: 'The Keeper' }));
    await userEvent.click(within(group).getByRole('button', { name: 'Gull' }));
    expect(within(group).getByRole('button', { name: 'Gull' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('radio', { name: 'Kling' }));
    expect(within(group).getByRole('button', { name: 'The Keeper' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Gull' })).toHaveAttribute('aria-pressed', 'false');
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(/Gull/);
    expect(note).toHaveTextContent(/Kling 3\.0 Omni/);

    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a keeper at dusk{Enter}');
    await screen.findByText('run page web-caps-1');
    expect(seen.body?.cast).toEqual(['keeper']);
  });

  it('a cast within the cap reaches the payload untouched', async () => {
    withCast();
    const seen = capturePost();
    renderHome();
    await userEvent.click(screen.getByRole('radio', { name: 'Seedance' }));
    const group = await screen.findByRole('group', { name: 'Starring' });
    await userEvent.click(within(group).getByRole('button', { name: 'The Keeper' }));
    await userEvent.click(within(group).getByRole('button', { name: 'Gull' }));
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'two of them{Enter}');
    await screen.findByText('run page web-caps-1');
    expect(seen.body?.cast).toEqual(['keeper', 'gull']);
  });
});

// ── per-model aspects in the DOM ────────────────────────────────────────────
describe('Home — per-model aspect ratios', () => {
  it('the Aspect control renders exactly the selected model\'s ratios', async () => {
    renderHome();
    const group = await screen.findByRole('radiogroup', { name: 'Aspect ratio' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['16:9', '9:16', '1:1']);
    expect(within(group).queryByRole('radio', { name: '21:9' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Seedance' }));
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['16:9', '9:16', '1:1']);
  });

  it('the selected aspect survives a model switch when both models offer it', async () => {
    const seen = capturePost();
    renderHome();
    const group = await screen.findByRole('radiogroup', { name: 'Aspect ratio' });
    await userEvent.click(within(group).getByRole('radio', { name: '16:9' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Seedance' }));
    expect(within(group).getByRole('radio', { name: '16:9' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'wide open{Enter}');
    await screen.findByText('run page web-caps-1');
    expect(seen.body?.aspect).toBe('16:9');
  });
});

// ── environment single-select: REGRESSION ONLY (already enforced) ───────────
describe('Home — environment stays single-select', () => {
  it('the picker is a radiogroup and only ever one slug reaches the payload', async () => {
    server.use(http.get('/api/environments', () => HttpResponse.json(ENVS)));
    const seen = capturePost();
    renderHome();
    const group = await screen.findByRole('radiogroup', { name: 'Set in' });
    await userEvent.click(within(group).getByRole('radio', { name: /Neon City/ }));
    await userEvent.click(within(group).getByRole('radio', { name: /Harbor/ }));
    expect(within(group).getByRole('radio', { name: /Neon City/ })).toHaveAttribute('aria-checked', 'false');
    expect(within(group).getByRole('radio', { name: /Harbor/ })).toHaveAttribute('aria-checked', 'true');

    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'set it here{Enter}');
    await screen.findByText('run page web-caps-1');
    expect(seen.body?.environment).toBe('harbor');
    expect(Array.isArray(seen.body?.environment)).toBe(false);
  });
});
