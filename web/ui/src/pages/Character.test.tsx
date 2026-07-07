// Character page: create-mode validation + payloads, edit-mode heading stripping, reference
// link/unlink/upload, voice mint/unlink, and the not-found state.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { File as NodeFile } from 'node:buffer';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import type { CharactersResponse } from '../../../shared/api-types';
import { HttpResponse, http, server } from '../test/msw';
import { ToastProvider } from '../components/ui/Toast';
import CharacterPage from './Character';

// jsdom's FormData/File are not recognized by Node's undici fetch — a multipart body silently
// degrades to the string "[object FormData]". For this file's duration swap in undici's own
// classes so the upload/mint requests genuinely encode (and MSW can parse) multipart form data.
// undici's FormData class isn't importable, so recover it from a parsed multipart Response.
const domFormData = globalThis.FormData;
const domFile = globalThis.File;
beforeAll(async () => {
  const b = 'recover-undici-formdata';
  const res = new Response(`--${b}\r\nContent-Disposition: form-data; name="f"\r\n\r\nv\r\n--${b}--\r\n`, {
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  });
  globalThis.FormData = (await res.formData()).constructor as typeof FormData;
  globalThis.File = NodeFile as unknown as typeof File;
});
afterAll(() => {
  globalThis.FormData = domFormData;
  globalThis.File = domFile;
});

function SlugProbe() {
  const { slug } = useParams();
  return <div>character route {slug}</div>;
}

function renderAt(path: string, { probeSlug = false } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/cast" element={<div>cast index</div>} />
            <Route path="/cast/new" element={<CharacterPage />} />
            <Route path="/cast/:slug" element={probeSlug ? <SlugProbe /> : <CharacterPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const KEEPER: CharactersResponse['characters'][number] = {
  slug: 'keeper',
  name: 'Keeper',
  description: '# Keeper\n\nWeathered face, wool coat.',
  refs: [{
    id: 'keeper-01', type: 'reference', file: 'keeper-01.png',
    abs: '/abs/elements/references/keeper-01.png', url: '/api/media/elements/references/keeper-01.png',
  }],
  voice: null,
};
const KEEPER_VOICE = { key: 'keeper', name: 'Keeper', voiceId: 'kling_voice_abc123', mintedAt: '2026-07-04T09:00:00.000Z', refClipAvailable: true };

function useCharacters(over: Partial<CharactersResponse> = {}) {
  server.use(http.get('/api/cast/characters', () => HttpResponse.json({
    characters: [KEEPER],
    unassigned: { references: [], voices: [] },
    ...over,
  })));
}

describe('Character — create mode', () => {
  it('flags invalid and duplicate names with a persistent caption and disables Create', async () => {
    useCharacters(); // Keeper exists — used for the duplicate check
    renderAt('/cast/new');

    const nameInput = await screen.findByLabelText('Name');
    await userEvent.type(nameInput, '.bad');
    expect(screen.getByText(/start with a letter or number/i)).toBeInTheDocument();
    expect(nameInput).toHaveClass('border-status-failed');
    expect(screen.getByRole('button', { name: /create character/i })).toBeDisabled();

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Keeper');
    expect(await screen.findByText('A character with this name already exists.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create character/i })).toBeDisabled();
  });

  it('creates with {name, description}, toasts and navigates to /cast/<slug>', async () => {
    let body: unknown;
    server.use(http.post('/api/cast/profiles', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ slug: 'aria' }, { status: 201 });
    }));
    renderAt('/cast/new', { probeSlug: true });

    await userEvent.type(await screen.findByLabelText('Name'), 'Aria');
    await userEvent.type(screen.getByLabelText('Description'), 'A quiet navigator.');
    await userEvent.click(screen.getByRole('button', { name: /create character/i }));

    await screen.findByText('character route aria');
    expect(body).toEqual({ name: 'Aria', description: 'A quiet navigator.' });
    expect(screen.getByText('Profile saved to profiles/aria.md')).toBeInTheDocument();
  });

  it('Insert template fills the textarea and the button disappears', async () => {
    renderAt('/cast/new');

    await userEvent.click(await screen.findByRole('button', { name: 'Insert template' }));
    const textarea = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(textarea.value).toContain('# Appearance');
    expect(textarea.value).toContain('# Wardrobe');
    expect(textarea.value).toContain('# Mannerisms & voice');
    expect(screen.queryByRole('button', { name: 'Insert template' })).not.toBeInTheDocument();
  });

  it('surfaces a createProfile failure as a persistent role=alert next to the buttons', async () => {
    server.use(http.post('/api/cast/profiles', () =>
      HttpResponse.json({ error: 'profile exists', hint: 'pick another name' }, { status: 409 })));
    renderAt('/cast/new');

    await userEvent.type(await screen.findByLabelText('Name'), 'Aria');
    await userEvent.click(screen.getByRole('button', { name: /create character/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('profile exists — pick another name');
  });
});

describe('Character — edit mode', () => {
  it('heads the page with the display name and strips the "# Name" heading from the textarea', async () => {
    useCharacters();
    renderAt('/cast/keeper');

    expect(await screen.findByRole('heading', { level: 1, name: 'Keeper' })).toBeInTheDocument();
    // Name is a read-only mono caption, not an input
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    const textarea = screen.getByLabelText('Description') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('Weathered face, wool coat.'));
  });

  it('Save PUTs the stripped textarea body with the name heading re-attached, undoubled', async () => {
    useCharacters();
    let putBody: unknown;
    server.use(http.put('/api/cast/profiles/keeper', async ({ request }) => {
      putBody = await request.json();
      return HttpResponse.json({ slug: 'keeper' });
    }));
    renderAt('/cast/keeper');

    const textarea = await screen.findByLabelText('Description');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('Weathered face, wool coat.'));
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Sails at dawn.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // the server owns the heading — the client sends the BARE body (a re-attached heading once doubled on every save)
    await waitFor(() => expect(putBody).toEqual({ description: 'Sails at dawn.' }));
    expect(await screen.findByText('Profile saved to profiles/keeper.md')).toBeInTheDocument();
    // edit mode stays put
    expect(screen.getByRole('heading', { level: 1, name: 'Keeper' })).toBeInTheDocument();
  });
});

describe('Character — references', () => {
  it('unlinking a thumb fires assignReference(id, null)', async () => {
    useCharacters();
    let assigned: { id: string; body: unknown } | undefined;
    server.use(http.post('/api/cast/references/:id/assign', async ({ params, request }) => {
      assigned = { id: String(params.id), body: await request.json() };
      return HttpResponse.json({ id: String(params.id) });
    }));
    renderAt('/cast/keeper');

    await userEvent.click(await screen.findByRole('button', { name: 'Unlink keeper-01.png' }));
    await waitFor(() => expect(assigned).toEqual({ id: 'keeper-01', body: {} }));
  });

  it('uploading through the tile supports MULTIPLE files, each sent with the character field', async () => {
    useCharacters();
    const posted: { character: string | null; file: string | null }[] = [];
    server.use(http.post('/api/cast/references', async ({ request }) => {
      const fd = await request.formData();
      posted.push({ character: fd.get('character') as string | null, file: (fd.get('file') as File | null)?.name ?? null });
      return HttpResponse.json({ added: 'keeper-0x.png' }, { status: 201 });
    }));
    renderAt('/cast/keeper');
    await screen.findByRole('heading', { level: 1, name: 'Keeper' });

    const input = screen.getByLabelText('Upload reference images');
    expect(input).toHaveAttribute('multiple');
    fireEvent.change(input, {
      target: { files: [
        new File(['a'], 'front.png', { type: 'image/png' }),
        new File(['b'], 'side.png', { type: 'image/png' }),
      ] },
    });

    await waitFor(() => expect(posted).toEqual([
      { character: 'keeper', file: 'front.png' },
      { character: 'keeper', file: 'side.png' },
    ]));
    expect(await screen.findByText('2 references added.')).toBeInTheDocument();
  });

  it('the 7-image cap is shown and enforced: overflow is skipped with a warning, a full character cannot add', async () => {
    // 6 existing refs → exactly ONE slot left
    const refs = Array.from({ length: 6 }, (_, i) => ({
      id: `keeper-0${i + 1}`, type: 'reference', file: `keeper-0${i + 1}.png`,
      abs: `/abs/keeper-0${i + 1}.png`, url: null,
    }));
    useCharacters({ characters: [{ ...KEEPER, refs }] });
    const posted: string[] = [];
    server.use(http.post('/api/cast/references', async ({ request }) => {
      const fd = await request.formData();
      posted.push((fd.get('file') as File).name);
      return HttpResponse.json({ added: 'keeper-07.png' }, { status: 201 });
    }));
    renderAt('/cast/keeper');
    await screen.findByText('6 of 7'); // the count is stated next to the section label

    fireEvent.change(screen.getByLabelText('Upload reference images'), {
      target: { files: [
        new File(['a'], 'one.png', { type: 'image/png' }),
        new File(['b'], 'two.png', { type: 'image/png' }),
      ] },
    });
    // only the remaining slot is used; the overflow is called out, not silently dropped
    await screen.findByText(/Only 1 of 2 added — a character holds at most 7/);
    await waitFor(() => expect(posted).toEqual(['one.png']));

    // at the cap the tile reads Full and is disabled
    const full = Array.from({ length: 7 }, (_, i) => ({
      id: `keeper-0${i + 1}`, type: 'reference', file: `keeper-0${i + 1}.png`,
      abs: `/abs/keeper-0${i + 1}.png`, url: null,
    }));
    useCharacters({ characters: [{ ...KEEPER, refs: full }] });
    renderAt('/cast/keeper');
    const fullTiles = await screen.findAllByRole('button', { name: /full/i });
    expect(fullTiles[fullTiles.length - 1]).toBeDisabled();
  });

  it('Pick from library opens the tray and links an unassigned reference to the character', async () => {
    useCharacters({ unassigned: {
      references: [{ id: 'lantern', type: 'reference', file: 'lantern.png', abs: '/abs/lantern.png', url: null }],
      voices: [],
    } });
    let assigned: { id: string; body: unknown } | undefined;
    server.use(http.post('/api/cast/references/:id/assign', async ({ params, request }) => {
      assigned = { id: String(params.id), body: await request.json() };
      return HttpResponse.json({ id: 'keeper-02' });
    }));
    renderAt('/cast/keeper');

    await userEvent.click(await screen.findByRole('button', { name: 'Pick from library (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Link lantern.png' }));
    await waitFor(() => expect(assigned).toEqual({ id: 'lantern', body: { character: 'keeper' } }));
  });
});

describe('Character — voice', () => {
  it('choosing a clip STAGES it immediately (saved with the character, no money spent)', async () => {
    useCharacters(); // voice: null
    let staged: { character: string | null; clip: string | null } | undefined;
    server.use(http.post('/api/cast/voices/stage', async ({ request }) => {
      const fd = await request.formData();
      staged = { character: fd.get('character') as string | null, clip: (fd.get('clip') as File | null)?.name ?? null };
      return HttpResponse.json({ key: 'keeper', clipName: 'keeper.m4a', minted: false }, { status: 201 });
    }));
    renderAt('/cast/keeper');

    // no mint button before a clip exists — staging comes first, and it is free
    await screen.findByLabelText('Voice clip');
    expect(screen.queryByRole('button', { name: /mint voice/i })).not.toBeInTheDocument();
    expect(screen.getByText(/saves it with the\s+character right away/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Voice clip'), {
      target: { files: [new File(['aac'], 'keeper.m4a', { type: 'audio/mp4' })] },
    });
    await waitFor(() => expect(staged).toEqual({ character: 'Keeper', clip: 'keeper.m4a' }));
    expect(await screen.findByText(/Clip saved with Keeper/)).toBeInTheDocument();
  });

  it('a staged (unminted) voice shows the saved clip and a priced Mint that posts JSON {name}', async () => {
    useCharacters({ characters: [{ ...KEEPER, voice: { key: 'keeper', name: 'Keeper', voiceId: null, mintedAt: null, refClipAvailable: true, clipName: 'keeper.mp3' } }] });
    let minted: unknown;
    server.use(http.post('/api/cast/voices', async ({ request }) => {
      minted = await request.json();
      return HttpResponse.json({ estUsd: 0.007 }, { status: 202 });
    }));
    renderAt('/cast/keeper');

    expect(await screen.findByText(/clip saved — keeper\.mp3 · not minted yet/)).toBeInTheDocument();
    expect(screen.getByText('lip-sync ready')).toBeInTheDocument(); // Seedance works from the staged clip
    const mintBtn = screen.getByRole('button', { name: /mint voice/i });
    expect(screen.getByLabelText('estimated cost $0.01')).toBeInTheDocument();
    await userEvent.click(mintBtn);
    await waitFor(() => expect(minted).toEqual({ name: 'Keeper' }));
    expect(await screen.findByText('Minting — the voice appears here shortly.')).toBeInTheDocument();
  });

  it('with-voice state shows the binding and Unlink fires assignVoice(key, null)', async () => {
    useCharacters({ characters: [{ ...KEEPER, voice: KEEPER_VOICE }] });
    let assigned: { key: string; body: unknown } | undefined;
    server.use(http.post('/api/cast/voices/:key/assign', async ({ params, request }) => {
      assigned = { key: String(params.key), body: await request.json() };
      return HttpResponse.json({ key: String(params.key) });
    }));
    renderAt('/cast/keeper');

    expect(await screen.findByText('lip-sync ready')).toBeInTheDocument();
    expect(screen.getByText('kling_voice_abc123')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mint voice/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(assigned).toEqual({ key: 'keeper', body: {} }));
  });
});

describe('Character — not found', () => {
  it('an unknown slug shows the No such character empty state with a way back', async () => {
    renderAt('/cast/ghost'); // default handler: no characters at all

    expect(await screen.findByText('No such character')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /back to cast/i }));
    expect(await screen.findByText('cast index')).toBeInTheDocument();
  });
});
