// Home page: create hero payloads + navigation, queue strip, the Recent glimpse, and the
// first-run example chips (the full library lives on /library — see Library.test.tsx).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { http, HttpResponse, server } from '../test/msw';
import { makeRun } from '../test/fixtures';
import type { CharactersResponse } from '../../../shared/api-types';
import type { GlobalLive } from '../hooks/useGlobalEvents';
import { ToastProvider } from '../components/ui/Toast';
import HomePage from './Home';

// The queue strip reads useGlobalEvents — stub the module so tests set the queue directly.
const globalLive = vi.hoisted(() => ({
  state: { active: [], queued: [], lastRunStatus: null } as GlobalLive,
}));
vi.mock('../hooks/useGlobalEvents', () => ({
  useGlobalEvents: () => globalLive.state,
}));

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

beforeEach(() => {
  globalLive.state = { active: [], queued: [], lastRunStatus: null };
});

describe('Home — create hero', () => {
  it('Plan it posts the exact payload and navigates to the new run', async () => {
    let body: unknown;
    server.use(http.post('/api/runs', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ runId: 'web-20260704-xy99' });
    }));
    renderHome();
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a tiny robot gardener');
    await userEvent.click(screen.getByRole('button', { name: /plan it/i }));
    await screen.findByText('run page web-20260704-xy99');
    expect(body).toEqual({ idea: 'a tiny robot gardener', backend: 'kling', aspect: '9:16', durationS: null });
  });

  it('Custom duration flows the number into durationS (Enter in the idea submits)', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ runId: 'web-custom-1' });
    }));
    renderHome();
    await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    const secs = screen.getByLabelText('Duration in seconds');
    await userEvent.clear(secs);
    await userEvent.type(secs, '45');
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'storm at sea{Enter}');
    await screen.findByText('run page web-custom-1');
    expect(body?.durationS).toBe(45);
    expect(body?.idea).toBe('storm at sea');
  });

  it('picking a backend or duration AFTER typing the idea must not submit the form', async () => {
    // regression: SegmentedControl buttons defaulted to type="submit" inside the create form,
    // so "Seedance"/"Custom" planned the run the moment they were clicked
    let posts = 0;
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs', async ({ request }) => {
      posts += 1;
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ runId: 'web-noaccident-1' });
    }));
    renderHome();
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'a fox in the snow');
    await userEvent.click(screen.getByRole('radio', { name: 'Seedance' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(posts).toBe(0); // choosing options is never a submit

    await userEvent.click(screen.getByRole('button', { name: /plan it/i }));
    await screen.findByText('run page web-noaccident-1');
    expect(posts).toBe(1); // only the explicit Plan it creates the run
    expect(body?.backend).toBe('seedance');
  });

  it('aspect tiles select like radios and the choice reaches the payload', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(http.post('/api/runs', async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ runId: 'web-aspect-1' });
    }));
    renderHome();
    const group = screen.getByRole('radiogroup', { name: 'Aspect ratio' });
    await userEvent.click(within(group).getByRole('radio', { name: '16:9' }));
    expect(within(group).getByRole('radio', { name: '16:9' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: '9:16' })).toHaveAttribute('aria-checked', 'false');
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'wide vista{Enter}');
    await screen.findByText('run page web-aspect-1');
    expect(body?.aspect).toBe('16:9');
  });

  it('a failed create surfaces the server hint inline, not as a toast', async () => {
    server.use(http.post('/api/runs', () =>
      HttpResponse.json({ error: 'idea too short', hint: 'Give the studio at least a few words.' }, { status: 400 })));
    renderHome();
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'hm{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Give the studio at least a few words.');
  });
});

// Two profiles: one with a reference image (avatar chip), one without (initials chip + warn caption).
const CAST_TWO: CharactersResponse = {
  characters: [
    {
      slug: 'keeper',
      name: 'The Keeper',
      description: '# The Keeper\n\nAn old lighthouse keeper.',
      refs: [{ id: 'keeper-01', type: 'reference', file: 'keeper-01.png', abs: '/abs/refs/keeper-01.png', url: '/api/media/refs/keeper-01.png' }],
      voice: null,
    },
    { slug: 'gull', name: 'Gull', description: '# Gull', refs: [], voice: null },
  ],
  unassigned: { references: [], voices: [] },
};

describe('Home — starring picker', () => {
  it('zero character profiles → no Starring row, no placeholder DOM', async () => {
    renderHome(); // default handler answers with zero characters
    await screen.findByLabelText('Your idea, in one line');
    expect(screen.queryByText('Starring')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Starring' })).not.toBeInTheDocument();
  });

  it('chips toggle aria-pressed, the hint names the selection, and only selected slugs reach the payload', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/cast/characters', () => HttpResponse.json(CAST_TWO)),
      http.post('/api/runs', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ runId: 'web-cast-1' });
      }),
    );
    renderHome();
    const group = await screen.findByRole('group', { name: 'Starring' });
    expect(within(group).getAllByRole('button')).toHaveLength(2);
    const keeper = within(group).getByRole('button', { name: 'The Keeper' });
    expect(keeper).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(keeper);
    expect(keeper).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('The Keeper ★ — their profile, reference images and voice will guide the plan.')).toBeInTheDocument();

    // toggles off and back on (multi-select, not a radio)
    await userEvent.click(keeper);
    expect(keeper).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Optional — star characters to build the plan around them.')).toBeInTheDocument();
    await userEvent.click(keeper);

    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'the keeper returns{Enter}');
    await screen.findByText('run page web-cast-1');
    expect(body?.cast).toEqual(['keeper']);
  });

  it('characters present but none starred → the payload has no cast key', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/cast/characters', () => HttpResponse.json(CAST_TWO)),
      http.post('/api/runs', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ runId: 'web-cast-2' });
      }),
    );
    renderHome();
    await screen.findByRole('group', { name: 'Starring' });
    await userEvent.type(screen.getByLabelText('Your idea, in one line'), 'no stars tonight{Enter}');
    await screen.findByText('run page web-cast-2');
    expect(body).not.toHaveProperty('cast');
  });

  it('starring a character with zero reference images shows the look-will-vary warning', async () => {
    server.use(http.get('/api/cast/characters', () => HttpResponse.json(CAST_TWO)));
    renderHome();
    const group = await screen.findByRole('group', { name: 'Starring' });
    await userEvent.click(within(group).getByRole('button', { name: 'Gull' }));
    expect(screen.getByText('Gull has no reference images — their look will vary between shots.')).toBeInTheDocument();
    // the keeper has refs — starring them too must not warn about them
    await userEvent.click(within(group).getByRole('button', { name: 'The Keeper' }));
    expect(screen.queryByText(/The Keeper.*no reference images/)).not.toBeInTheDocument();
  });
});

describe('Home — recent & example chips', () => {
  it('shows at most the 4 newest runs, read-only, with a See all link to the Library', async () => {
    const statuses = ['planning', 'plan-ready', 'rendering', 'attention', 'review', 'complete'] as const;
    server.use(http.get('/api/runs', () =>
      HttpResponse.json({ runs: statuses.map((s, i) => makeRun(s, { id: `run-${i}` })) })));
    renderHome();
    const recent = await screen.findByRole('region', { name: 'Recent runs' });
    expect(within(recent).getByRole('link', { name: 'See all →' })).toHaveAttribute('href', '/library');
    // 4 cards + the See-all link = 5 links total; never a fifth card
    expect(within(recent).getAllByRole('link')).toHaveLength(5);
    // management lives in the Library — the glimpse carries no destructive affordances
    expect(within(recent).queryByRole('button', { name: /delete run/i })).not.toBeInTheDocument();
    // and the first-run chips are gone once runs exist
    expect(screen.queryByText('Try one of these to see how the studio works.')).not.toBeInTheDocument();
  });

  it('the responsibility footer is always present, at whisper volume', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: [] })));
    renderHome();
    await screen.findByLabelText('Your idea, in one line');
    expect(screen.getByText(/Make kind things/)).toBeInTheDocument();
    expect(screen.getByText(/your responsibility, not the author/)).toBeInTheDocument();
  });

  it('zero runs: no Recent section; the example chips fill the idea input', async () => {
    server.use(http.get('/api/runs', () => HttpResponse.json({ runs: [] })));
    renderHome();
    await screen.findByText('Try one of these to see how the studio works.');
    expect(screen.queryByRole('region', { name: 'Recent runs' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'A cat reviews expensive cheese, deadpan' }));
    expect(screen.getByLabelText('Your idea, in one line')).toHaveValue('A cat reviews expensive cheese, deadpan');
  });
});

describe('Home — queue strip', () => {
  it('lists the active item with a run link and queued items with position numbers', async () => {
    globalLive.state = {
      active: [{ id: 'q1', runId: 'web-active-1', lane: 'spend', kind: 'render', startedAt: '2026-07-04T10:00:00.000Z' }],
      queued: [
        { id: 'q2', runId: 'web-queued-1', lane: 'plan', kind: 'plan', startedAt: null },
        { id: 'q3', runId: 'web-queued-2', lane: 'free', kind: 'assemble', startedAt: null },
      ],
      lastRunStatus: null,
    };
    renderHome();
    const strip = await screen.findByRole('region', { name: 'Queue' });
    expect(within(strip).getByText('Rendering')).toBeInTheDocument();
    expect(within(strip).getByRole('link', { name: 'web-active-1' })).toHaveAttribute('href', '/runs/web-active-1');
    expect(within(strip).getByText('Planning')).toBeInTheDocument();
    expect(within(strip).getByText('Assembling the cut')).toBeInTheDocument();
    expect(within(strip).getByText('1')).toBeInTheDocument();
    expect(within(strip).getByText('2')).toBeInTheDocument();
  });

  it('cancel on a queued item posts /cancel for that run', async () => {
    let cancelled: string | undefined;
    server.use(http.post('/api/runs/:id/cancel', ({ params }) => {
      cancelled = String(params.id);
      return HttpResponse.json({ cancelled: 'queued' });
    }));
    globalLive.state = {
      active: [],
      queued: [{ id: 'q2', runId: 'web-queued-1', lane: 'plan', kind: 'plan', startedAt: null }],
      lastRunStatus: null,
    };
    renderHome();
    await userEvent.click(await screen.findByRole('button', { name: /cancel queued planning for web-queued-1/i }));
    await vi.waitFor(() => expect(cancelled).toBe('web-queued-1'));
  });

  it('hides entirely when nothing is active or queued', async () => {
    renderHome();
    await screen.findByLabelText('Your idea, in one line');
    expect(screen.queryByRole('region', { name: 'Queue' })).not.toBeInTheDocument();
  });
});
