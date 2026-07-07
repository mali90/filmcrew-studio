import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { HttpResponse, http, server } from '../../test/msw';
import { ModelSelect } from './ModelSelect';

// A controlled harness so onChange actually updates the value (and echoes it for assertions).
function Harness({ provider = 'claude', initial = '' }: { provider?: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ModelSelect provider={provider} value={value} onChange={setValue} />
      <span data-testid="val">{value}</span>
    </>
  );
}
function renderHarness(props?: { provider?: string; initial?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><Harness {...props} /></QueryClientProvider>);
}
const modelsResponse = (extra: Record<string, unknown>) =>
  http.get('/api/setup/models', () => HttpResponse.json({ provider: 'claude', default: 'claude-opus-4-8', options: [], live: null, ...extra }));

describe('ModelSelect', () => {
  it('lists the provider default, curated options, and live models (deduped) in an optgroup', async () => {
    server.use(modelsResponse({
      options: [{ id: 'claude-sonnet-4-6', hint: 'cheaper, faster' }],
      live: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }, { id: 'claude-opus-4-8' }],
    }));
    renderHarness();
    await waitFor(() => expect(screen.getByRole('option', { name: /provider default — claude-opus-4-8/i })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: /claude-sonnet-4-6 · cheaper, faster/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /from your claude key/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claude Haiku 4.5' })).toBeInTheDocument(); // live option uses its label
    // the default id must not appear as its own bare option (the sentinel already represents it)
    expect(screen.queryByRole('option', { name: 'claude-opus-4-8' })).not.toBeInTheDocument();
  });

  it('degrades to curated + Custom (no optgroup) when there is no key', async () => {
    server.use(modelsResponse({ options: [{ id: 'claude-sonnet-4-6' }], live: null, liveError: 'no-key' }));
    renderHarness();
    // wait for a data-dependent option (the always-present sentinel would resolve before the fetch)
    expect(await screen.findByRole('option', { name: /claude-sonnet-4-6/i })).toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument(); // no live optgroup without a key
    expect(screen.getByRole('option', { name: /custom/i })).toBeInTheDocument();
    expect(screen.getByText(/add an api key to list all available models/i)).toBeInTheDocument();
  });

  it('Custom… reveals a monospace field and emits the typed id', async () => {
    server.use(modelsResponse({ options: [], live: null, liveError: 'no-key' }));
    renderHarness();
    await waitFor(() => screen.getByRole('option', { name: /custom/i }));
    await userEvent.selectOptions(screen.getByLabelText('Model'), '__custom__');
    await userEvent.type(await screen.findByPlaceholderText(/blank uses the provider default/i), 'my-model');
    expect(screen.getByTestId('val')).toHaveTextContent('my-model');
  });

  it('opens in Custom mode, prefilled, for a saved value not in the catalog', async () => {
    server.use(modelsResponse({ options: [{ id: 'claude-sonnet-4-6' }], live: null, liveError: 'no-key' }));
    renderHarness({ initial: 'some-exotic-model' });
    expect(await screen.findByDisplayValue('some-exotic-model')).toBeInTheDocument();
  });
});
