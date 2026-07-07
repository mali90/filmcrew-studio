// Shared render wrapper for the review-slice tests: React Query + router + toasts, retries off.
import type { PropsWithChildren, ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../ui/Toast';

export function renderReview(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>{children}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper });
}

// localStorage may be missing in this Node/jsdom combo — useFirstPaidConfirm treats that as
// "already confirmed", so guarding here keeps the paid-button tests deterministic either way.
/** Skip the one-time first-paid-click dialog so paid buttons fire directly. */
export const markPaidConfirmed = () => {
  try { localStorage.setItem('kva-paid-confirmed', '1'); } catch { /* unavailable → already skipped */ }
};

/** Reset the first-paid-click state between tests. */
export const clearPaidState = () => {
  try { localStorage.clear(); } catch { /* unavailable */ }
};
