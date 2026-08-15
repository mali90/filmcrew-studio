// The Segmind path's STORED-key guard: a rerun leaves FAL_KEY in .env while the wizard field
// starts empty — and that preserved key still steers SEGMIND_UPLOAD_MODE to fal-storage. An empty
// field with a stored key must therefore validate the STORED key (the server checks it when none
// is typed) before Continue unlocks; a truly fal-less Segmind install continues unimpeded.
import { useReducer } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { server, http, HttpResponse } from '../../test/msw';
import { ToastProvider } from '../ui/Toast';
import { StepFal } from './StepFal';
import { initialWizardState, wizardReducer, type WizardState } from './wizard';
import PRICES from '../../../../server/lib/prices.json';

const SEGMIND_SEED: Partial<WizardState> = {
  backend: 'seedance-2.5@segmind' as WizardState['backend'],
  segmindCheck: { state: 'valid' }, // isolate the fal-key part of the continue gate
};

// StepFal's auto-check dispatches falCheck transitions that must re-render — live reducer state.
function Harness({ over, falKeyStored }: { over: Partial<WizardState>; falKeyStored: boolean }) {
  const [state, dispatch] = useReducer(wizardReducer, { ...initialWizardState, ...over });
  return <StepFal state={state} dispatch={dispatch} falKeyStored={falKeyStored} />;
}

function renderStep(falKeyStored: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Harness over={SEGMIND_SEED} falKeyStored={falKeyStored} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function captureValidateFal(reply: { ok: boolean; reason?: string }) {
  const calls: unknown[] = [];
  server.use(
    http.post('/api/setup/validate-fal', async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json(reply);
    }),
  );
  return calls;
}

describe('StepFal stored-key guard (Segmind path)', () => {
  it('auto-checks the STORED key — a stale one blocks Continue with the reason stated', async () => {
    const calls = captureValidateFal({ ok: false, reason: 'auth' });
    renderStep(true);
    // the empty field means "keep the stored key" — the server is asked about THAT key
    await waitFor(() => expect(calls).toEqual([{ apiKey: '' }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled());
    expect(screen.getByText(/already stored from an earlier setup/i)).toBeInTheDocument();
  });

  it('a healthy stored key unlocks Continue without any typing', async () => {
    captureValidateFal({ ok: true });
    renderStep(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
  });

  it('no stored key ⇒ Segmind-only continues unimpeded, and nothing is asked of the server', async () => {
    const calls = captureValidateFal({ ok: true });
    renderStep(false);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(calls).toHaveLength(0);
  });
});

// The optional fal key on the Segmind path is the upscale half of the low-cost setup, so the
// paragraph makes ONE comparative claim — and no figure, because a figure here would be a second
// copy of prices.json. The claim is relative, so the test checks the relation, not a number.
describe('StepFal — why a Segmind install still wants a fal key', () => {
  it('states the upscale claim in words, quoting nothing', () => {
    renderStep(false);
    const para = screen.getByText(/every fal\.ai tier on file bills under Segmind’s flat per-second rate/);
    expect(para).toBeInTheDocument();
    expect(para.textContent ?? '').not.toMatch(/\$|\bfree\b/i);
  });

  it('…and prices.json still makes that sentence true', () => {
    // if this fails the sentence above is no longer true — change the copy, not the test
    expect(Math.max(...(Object.values(PRICES.topaz.perSecondUsd) as number[])))
      .toBeLessThan(PRICES['topaz@segmind'].perSecondUsd);
  });
});
