// Cast page: character grid + completeness, empty state, delete flow (± deleteRefs), and the
// Unassigned assets disclosure with its assign-to-character chips.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HttpResponse, http, server } from '../test/msw';
import type { CharactersResponse, CharacterView } from '../../../shared/api-types';
import { ToastProvider } from '../components/ui/Toast';
import CastPage from './Cast';

function renderCast() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/cast']}>
          <Routes>
            <Route path="/cast" element={<CastPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const KEEPER: CharacterView = {
  slug: 'keeper',
  name: 'Keeper',
  description: '# Keeper\n\nWeathered face, wool coat, kind eyes.',
  refs: [{ id: 'keeper-01', type: 'reference', file: 'keeper-01.png', abs: '/abs/elements/references/keeper-01.png', url: '/api/media/elements/references/keeper-01.png' }],
  voice: { key: 'keeper', name: 'Keeper', voiceId: 'kling_voice_abc123', mintedAt: '2026-07-04T09:00:00.000Z', refClipAvailable: true },
};

// nothing but a heading in the profile: no refs, no bio body, no voice
const GULL: CharacterView = { slug: 'gull', name: 'Gull', description: '# Gull', refs: [], voice: null };

const NO_UNASSIGNED: CharactersResponse['unassigned'] = { references: [], voices: [] };
const UNASSIGNED: CharactersResponse['unassigned'] = {
  references: [{ id: 'lantern', type: 'reference', file: 'lantern.png', abs: '/abs/lantern.png', url: null }],
  voices: [{ key: 'gull-voice', name: 'gull', voiceId: 'kling_voice_def456', mintedAt: '2026-07-01T09:00:00.000Z', refClipAvailable: false }],
};

const charactersAre = (body: CharactersResponse) =>
  http.get('/api/cast/characters', () => HttpResponse.json(body));

// this jsdom setup exposes no localStorage (the app guards every access) — clear it only if present
beforeEach(() => { try { localStorage.removeItem('kva-unassigned-open'); } catch { /* no storage in jsdom */ } });

describe('Cast — character grid', () => {
  it('shows the empty state with a New character link when there are no characters', async () => {
    server.use(charactersAre({ characters: [], unassigned: NO_UNASSIGNED }));
    renderCast();

    expect(await screen.findByRole('heading', { name: 'No characters yet' })).toBeInTheDocument();
    expect(screen.getByText('Create a character once — name, look, voice — and star them in any video.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New character' })).toHaveAttribute('href', '/cast/new');
    // the subtitle sells that a cast is optional
    expect(screen.getByText('Characters carry a profile, reference images and a voice into every plan; environments carry a world in words. All of it is optional — ideas work fine without either.')).toBeInTheDocument();
  });

  it('renders cards with completeness rows — warn for gaps, fully neutral when complete — linking to the editor', async () => {
    server.use(charactersAre({ characters: [KEEPER, GULL], unassigned: NO_UNASSIGNED }));
    renderCast();

    // whole card = stretched link to /cast/<slug>
    const keeperLink = await screen.findByRole('link', { name: 'Edit Keeper' });
    expect(keeperLink).toHaveAttribute('href', '/cast/keeper');
    expect(screen.getByRole('link', { name: 'Edit Gull' })).toHaveAttribute('href', '/cast/gull');

    // Gull is missing everything: refs/bio warn, voice merely faint (it's optional)
    const gullCard = screen.getByRole('link', { name: 'Edit Gull' }).closest('article')!;
    expect(within(gullCard).getByText('no refs')).toHaveClass('text-status-warn');
    expect(within(gullCard).getByText('no bio')).toHaveClass('text-status-warn');
    expect(within(gullCard).getByText('no voice')).toHaveClass('text-ink-faint');

    // Keeper is complete: the row is plain text with nothing warn-colored
    const keeperCard = keeperLink.closest('article')!;
    expect(within(keeperCard).getByText('1 ref')).toBeInTheDocument();
    expect(within(keeperCard).getByText('bio')).toBeInTheDocument();
    expect(within(keeperCard).getByText('voice')).toBeInTheDocument();
    expect(keeperCard.querySelector('.text-status-warn')).toBeNull();

    // bio excerpt = first non-heading line
    expect(within(keeperCard).getByText('Weathered face, wool coat, kind eyes.')).toBeInTheDocument();

    // the New character tile closes the grid
    expect(screen.getByRole('link', { name: 'New character' })).toHaveAttribute('href', '/cast/new');
    // no unassigned assets → the parking lot is absent entirely
    expect(screen.queryByText('Unassigned assets')).toBeNull();
  });
});

describe('Cast — delete character', () => {
  it('confirms via dialog and deletes WITHOUT deleteRefs by default', async () => {
    let url: URL | null = null;
    server.use(
      charactersAre({ characters: [KEEPER], unassigned: NO_UNASSIGNED }),
      http.delete('/api/cast/profiles/:slug', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ deleted: 'keeper', refsDeleted: 0 });
      }),
    );
    renderCast();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Keeper' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Keeper?' });
    expect(within(dialog).getByText('The minted voice is kept — minting it again would cost money.')).toBeInTheDocument();
    expect(url).toBeNull(); // nothing fired before the confirm

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete character' }));
    await waitFor(() => expect(url).not.toBeNull());
    expect(url!.pathname).toBe('/api/cast/profiles/keeper');
    expect(url!.searchParams.get('deleteRefs')).toBeNull();
    expect(await screen.findByText('Deleted Keeper.')).toBeInTheDocument();
  });

  it('sends ?deleteRefs=1 when the checkbox is ticked', async () => {
    let url: URL | null = null;
    server.use(
      charactersAre({ characters: [KEEPER], unassigned: NO_UNASSIGNED }),
      http.delete('/api/cast/profiles/:slug', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ deleted: 'keeper', refsDeleted: 1 });
      }),
    );
    renderCast();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Keeper' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Also delete its 1 reference image' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete character' }));

    await waitFor(() => expect(url).not.toBeNull());
    expect(url!.searchParams.get('deleteRefs')).toBe('1');
  });
});

describe('Cast — unassigned assets', () => {
  it('starts collapsed, expands on click, and assigns a reference by slug via the chip row', async () => {
    let posted: { id: string; body: unknown } | null = null;
    server.use(
      charactersAre({ characters: [KEEPER], unassigned: UNASSIGNED }),
      http.post('/api/cast/references/:id/assign', async ({ request, params }) => {
        posted = { id: String(params.id), body: await request.json() };
        return HttpResponse.json({ id: 'keeper-02' });
      }),
    );
    renderCast();

    const disclosure = await screen.findByRole('button', { name: /unassigned assets/i });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('1 reference · 1 voice')).toBeInTheDocument();
    expect(screen.queryByText('lantern.png')).toBeNull(); // collapsed hides the pools

    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('lantern.png')).toBeInTheDocument();
    expect(screen.getByText('kling_voice_def456')).toBeInTheDocument();
    expect(screen.getByText('no clip — Seedance falls back to native audio')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Assign lantern to a character' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keeper' }));

    await waitFor(() => expect(posted).toEqual({ id: 'lantern', body: { character: 'keeper' } }));
    expect(await screen.findByText('Assigned to Keeper.')).toBeInTheDocument();
  });

  it('assigns a voice by display NAME and surfaces a 409 as a persistent error toast', async () => {
    let body: unknown = null;
    server.use(
      charactersAre({ characters: [KEEPER], unassigned: UNASSIGNED }),
      http.post('/api/cast/voices/:key/assign', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ error: 'Keeper already has a voice', hint: 'unassign it first' }, { status: 409 });
      }),
    );
    renderCast();

    await userEvent.click(await screen.findByRole('button', { name: /unassigned assets/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Assign voice gull to a character' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keeper' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Keeper already has a voice — unassign it first');
    expect(body).toEqual({ character: 'Keeper' }); // display name, not the slug
  });

  it('deletes an unassigned reference only after the dialog confirm', async () => {
    let deletedId: string | null = null;
    server.use(
      charactersAre({ characters: [KEEPER], unassigned: UNASSIGNED }),
      http.delete('/api/cast/references/:id', ({ params }) => {
        deletedId = String(params.id);
        return HttpResponse.json({ deleted: deletedId });
      }),
    );
    renderCast();

    await userEvent.click(await screen.findByRole('button', { name: /unassigned assets/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete reference lantern' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this reference?' });
    expect(within(dialog).getByText(/Runs that already rendered with it keep their copies\./)).toBeInTheDocument();
    expect(deletedId).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deletedId).toBe('lantern'));
    expect(await screen.findByText('Reference deleted.')).toBeInTheDocument();
  });
});
