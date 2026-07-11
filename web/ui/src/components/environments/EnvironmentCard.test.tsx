// EnvironmentCard: a text-only card on the Cast page's Environments section. The whole card is a
// stretched link to the editor; there is NO thumbnail (an environment has no image) and NO
// completeness dots. Empty description shows a warn-coloured "no description" nudge. Delete is a
// hover overlay + confirm dialog that invalidates ['environments'].
//
// TDD (red first): components/environments/EnvironmentCard.tsx and the client's deleteEnvironment
// do not exist yet.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { EnvironmentView } from '../../../../shared/api-types';
import { HttpResponse, http, server } from '../../test/msw';
import { ToastProvider } from '../ui/Toast';
import { EnvironmentCard } from './EnvironmentCard';

function renderCard(environment: EnvironmentView) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <EnvironmentCard environment={environment} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const NEON: EnvironmentView = { slug: 'neon-city', name: 'Neon City', description: '# Neon City\n\nRain-slicked neon streets, sodium haze, wet asphalt.' };
const BARE: EnvironmentView = { slug: 'bare-room', name: 'Bare Room', description: '# Bare Room' };

describe('EnvironmentCard', () => {
  it('is a stretched link to the editor, shows the name + excerpt, and renders NO thumbnail image', () => {
    const { container } = renderCard(NEON);
    const link = screen.getByRole('link', { name: /Neon City/i });
    expect(link).toHaveAttribute('href', '/environments/neon-city');
    expect(screen.getByRole('heading', { name: 'Neon City' })).toBeInTheDocument();
    expect(screen.getByText(/Rain-slicked neon streets/)).toBeInTheDocument();
    // text-only, by design: no reference image, so never an <img>
    expect(container.querySelector('img')).toBeNull();
  });

  it('an empty description shows a warn-coloured "no description" nudge (parity with cast "no bio")', () => {
    renderCard(BARE);
    expect(screen.getByText('no description')).toHaveClass('text-status-warn');
  });

  it('delete asks for confirmation, then DELETEs and invalidates on confirm', async () => {
    let deleted: string | null = null;
    server.use(http.delete('/api/environments/:slug', ({ params }) => {
      deleted = String(params.slug);
      return HttpResponse.json({ deleted: String(params.slug) });
    }));
    renderCard(NEON);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Neon City' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Neon City?' });
    expect(within(dialog).getByText(/Ideas already rendered in this setting keep their copy\./)).toBeInTheDocument();
    expect(deleted).toBeNull(); // nothing fired before confirm

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
    await waitFor(() => expect(deleted).toBe('neon-city'));
    expect(await screen.findByText(/Deleted Neon City\./)).toBeInTheDocument();
  });
});
