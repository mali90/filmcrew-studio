// Shared render wrappers for the Run-slice tests: React Query + router + toasts, retries off.
// `renderRunPage` mounts the real page at /runs/:id so tests can drive the SSE stream through
// MockEventSource exactly like the browser does.
import type { PropsWithChildren, ReactElement } from 'react';

// Node 22+ ships an experimental global `localStorage` that throws unless the process was
// started with --localstorage-file — and it shadows jsdom's working Storage in vitest. The
// first-paid-confirm hook treats a throwing store as "already confirmed", so give every test
// in this slice a real in-memory Storage before anything renders.
(() => {
  try { globalThis.localStorage.getItem('probe'); return; } catch { /* replace it below */ }
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
})();
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RunDetail } from '../../../../shared/api-types';
import { http, HttpResponse, server } from '../../test/msw';
import { ToastProvider } from '../ui/Toast';
import RunPage from '../../pages/Run';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export function renderWithProviders(ui: ReactElement) {
  const client = makeClient();
  const Wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>{children}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper });
}

/** Mount the whole Run page for `run`, serving it from MSW at /runs/:id. */
export function renderRunPage(run: RunDetail) {
  server.use(http.get('/api/runs/:id', () => HttpResponse.json({ run })));
  const client = makeClient();
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/runs/${run.id}`]}>
          <Routes>
            <Route path="/runs/:id" element={<RunPage />} />
            <Route path="/" element={<div>home page</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Reset the one-time first-paid-click confirmation between tests. */
export const clearPaidState = () => {
  try { localStorage.clear(); } catch { /* unavailable */ }
};

/** Skip the first-paid-click dialog so paid buttons fire directly. */
export const markPaidConfirmed = () => {
  try { localStorage.setItem('kva-paid-confirmed', '1'); } catch { /* unavailable */ }
};
