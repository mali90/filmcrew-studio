// Environment editor — /environments/new (create) and /environments/:slug (edit). Modeled on the
// Character page MINUS reference images and voice: an environment is purely descriptive. Create =
// editable name with validation + duplicate check; edit = read-only name, heading stripped from the
// textarea, Save PUTs {description}. Delete lives on the card only (parity with Character).
//
// TDD (red first): pages/Environment.tsx, the /environments routes, and the client's
// environments/createEnvironment/updateEnvironment methods do not exist yet.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import type { EnvironmentsResponse, EnvironmentView } from '../../../shared/api-types';
import { HttpResponse, http, server } from '../test/msw';
import { ToastProvider } from '../components/ui/Toast';
import EnvironmentPage from './Environment';

function SlugProbe() {
  const { slug } = useParams();
  return <div>environment route {slug}</div>;
}

function renderAt(path: string, { probeSlug = false } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/cast" element={<div>cast index</div>} />
            <Route path="/environments/new" element={<EnvironmentPage />} />
            <Route path="/environments/:slug" element={probeSlug ? <SlugProbe /> : <EnvironmentPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const NEON: EnvironmentView = { slug: 'neon-city', name: 'Neon City', description: '# Neon City\n\nRain-slicked neon streets, sodium haze.' };

function useEnvironments(over: Partial<EnvironmentsResponse> = {}) {
  server.use(http.get('/api/environments', () => HttpResponse.json({ environments: [NEON], ...over })));
}

describe('Environment — create mode', () => {
  it('flags invalid and duplicate names with a persistent caption and disables Create', async () => {
    useEnvironments(); // Neon City exists — used for the duplicate check
    renderAt('/environments/new');

    const nameInput = await screen.findByLabelText('Name');
    await userEvent.type(nameInput, '.bad');
    expect(screen.getByText(/start with a letter or number/i)).toBeInTheDocument();
    expect(nameInput).toHaveClass('border-status-failed');
    expect(screen.getByRole('button', { name: /create environment/i })).toBeDisabled();

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Neon City');
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create environment/i })).toBeDisabled();
  });

  it('has NO reference-image or voice controls (an environment is descriptive-only)', async () => {
    renderAt('/environments/new');
    await screen.findByLabelText('Name');
    expect(screen.queryByText(/reference image/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/voice clip/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('creates with {name, description}, toasts "Environment saved." and navigates to /environments/<slug>', async () => {
    let body: unknown;
    server.use(http.post('/api/environments', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ slug: 'undercity' }, { status: 201 });
    }));
    renderAt('/environments/new', { probeSlug: true });

    await userEvent.type(await screen.findByLabelText('Name'), 'Undercity');
    await userEvent.type(screen.getByLabelText('Description'), 'Neon-lit tunnels, no daylight.');
    await userEvent.click(screen.getByRole('button', { name: /create environment/i }));

    await screen.findByText('environment route undercity');
    expect(body).toEqual({ name: 'Undercity', description: 'Neon-lit tunnels, no daylight.' });
    expect(screen.getByText(/Environment saved\./i)).toBeInTheDocument();
  });

  it('surfaces a create failure as a persistent role=alert next to the buttons', async () => {
    server.use(http.post('/api/environments', () =>
      HttpResponse.json({ error: 'environment exists', hint: 'pick another name' }, { status: 409 })));
    renderAt('/environments/new');

    await userEvent.type(await screen.findByLabelText('Name'), 'Skyline');
    await userEvent.click(screen.getByRole('button', { name: /create environment/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('environment exists — pick another name');
  });
});

describe('Environment — edit mode', () => {
  it('heads the page with the display name, keeps the name read-only, and strips the "# Name" heading', async () => {
    useEnvironments();
    renderAt('/environments/neon-city');

    expect(await screen.findByRole('heading', { level: 1, name: 'Neon City' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument(); // read-only in edit mode
    const textarea = screen.getByLabelText('Description') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('Rain-slicked neon streets, sodium haze.'));
  });

  it('Save PUTs the bare description body (server owns the heading) and stays in edit mode', async () => {
    useEnvironments();
    let putBody: unknown;
    server.use(http.put('/api/environments/neon-city', async ({ request }) => {
      putBody = await request.json();
      return HttpResponse.json({ slug: 'neon-city' });
    }));
    renderAt('/environments/neon-city');

    const textarea = await screen.findByLabelText('Description');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('Rain-slicked neon streets, sodium haze.'));
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Now the fog lifts at noon.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putBody).toEqual({ description: 'Now the fog lifts at noon.' }));
    expect(await screen.findByText(/Environment saved\./i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Neon City' })).toBeInTheDocument();
  });
});

describe('Environment — not found', () => {
  it('an unknown slug shows a "No such environment" empty state with a way back to Cast', async () => {
    renderAt('/environments/ghost'); // default handler: no environments at all

    expect(await screen.findByText(/No such environment/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /cast/i }));
    expect(await screen.findByText('cast index')).toBeInTheDocument();
  });
});
