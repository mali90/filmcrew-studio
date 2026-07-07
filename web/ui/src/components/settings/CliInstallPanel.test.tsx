import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { HttpResponse, http, server } from '../../test/msw';
import { ToastProvider } from '../ui/Toast';
import { CliInstallPanel } from './CliInstallPanel';

function renderPanel(provider = 'claude') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><CliInstallPanel provider={provider} /></ToastProvider>
    </QueryClientProvider>,
  );
}
const cliStatus = (installed: boolean) => ({ provider: 'claude', bin: 'claude', npmPackage: '@anthropic-ai/claude-code', installMethod: 'native' as const, installCmd: 'curl -fsSL https://claude.ai/install.sh | bash', installed, version: installed ? 'claude 9.9.9' : null });
const ndjson = (events: object[]) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(`${JSON.stringify(e)}\n`)); c.close(); } });
  return new HttpResponse(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
};

describe('CliInstallPanel', () => {
  it('offers an Install button when the CLI is not installed', async () => {
    server.use(http.get('/api/setup/cli-status', () => HttpResponse.json(cliStatus(false))));
    renderPanel();
    expect(await screen.findByRole('button', { name: /install claude cli/i })).toBeInTheDocument();
  });

  it('installs, re-detects, then prompts to sign in', async () => {
    let installed = false;
    server.use(
      http.get('/api/setup/cli-status', () => HttpResponse.json(cliStatus(installed))),
      http.post('/api/setup/install-cli', () => {
        installed = true;
        return ndjson([
          { type: 'start', provider: 'claude', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
          { type: 'log', stream: 'stdout', line: 'downloading claude' },
          { type: 'done', ok: true, bin: 'claude', installed: true, version: 'claude 9.9.9' },
        ]);
      }),
      http.post('/api/setup/validate-llm', () => HttpResponse.json({ ok: false, reason: 'not signed in yet' })),
    );
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: /install claude cli/i }));
    expect(await screen.findByText(/sign in to the claude cli/i)).toBeInTheDocument();
    expect(screen.getByText(/open a new terminal window first/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
  });

  it('surfaces a failed install with a Retry action', async () => {
    server.use(
      http.get('/api/setup/cli-status', () => HttpResponse.json(cliStatus(false))),
      http.post('/api/setup/install-cli', () => ndjson([
        { type: 'start', provider: 'claude', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
        { type: 'error', ok: false, code: 1, message: 'the install exited with code 1', hint: 'The installer exited with code 1. Run the shown command in a terminal.' },
      ])),
    );
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: /install claude cli/i }));
    expect(await screen.findByText(/install didn.t finish/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry install/i })).toBeInTheDocument();
  });
});
