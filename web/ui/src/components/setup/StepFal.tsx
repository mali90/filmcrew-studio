// Step 4 — the render key, for whichever provider the CHOSEN backend bills (the backend step runs
// first for exactly this reason). fal picks collect a fal key; Segmind picks collect a Segmind key
// and offer the fal key as an optional extra — Kling and voice minting run on fal, but a
// Segmind-only install is valid and must not be gated on an account it doesn't have. Money is
// involved either way, so on success we nudge about credit rather than celebrating.
import type { Dispatch } from 'react';
import { api, ApiClientError } from '../../api/client';
import { canonicalBackendFor } from '../../../../shared/render-models';
import { FixFooter } from './FixFooter';
import { KeyField } from '../ui/KeyField';
import type { WizardAction, WizardState } from './wizard';

/** The provider the selected backend bills; fal when the value is somehow unreadable. */
const providerOf = (backend: string): 'fal' | 'segmind' => {
  try { return canonicalBackendFor(backend).split('@')[1] === 'segmind' ? 'segmind' : 'fal'; }
  catch { return 'fal'; }
};

export function StepFal({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const provider = providerOf(state.backend);
  const canContinue = provider === 'segmind'
    ? state.segmindCheck.state === 'valid'
    : state.falCheck.state === 'valid';

  const validateFal = async () => {
    dispatch({ type: 'patch', patch: { falCheck: { state: 'checking' } } });
    try {
      const r = await api.validateFal(state.falKey);
      dispatch({
        type: 'patch',
        patch: {
          falCheck: r.ok
            ? { state: 'valid', note: 'make sure the account has a few dollars of credit' }
            : { state: 'invalid', reason: r.reason ?? 'That key did not validate.' },
        },
      });
    } catch (e) {
      dispatch({
        type: 'patch',
        patch: {
          falCheck: {
            state: 'invalid',
            reason: e instanceof ApiClientError ? e.hint : 'Could not reach the server.',
          },
        },
      });
    }
  };

  const validateSegmind = async () => {
    dispatch({ type: 'patch', patch: { segmindCheck: { state: 'checking' } } });
    try {
      const r = await api.validateSegmind(state.segmindKey);
      dispatch({
        type: 'patch',
        patch: {
          segmindCheck: r.ok
            ? { state: 'valid', note: 'make sure the account has a few dollars of credit' }
            : { state: 'invalid', reason: r.reason ?? 'That key did not validate.' },
        },
      });
    } catch (e) {
      dispatch({
        type: 'patch',
        patch: {
          segmindCheck: {
            state: 'invalid',
            reason: e instanceof ApiClientError ? e.hint : 'Could not reach the server.',
          },
        },
      });
    }
  };

  const falField = (
    <KeyField
      label="fal.ai API key"
      value={state.falKey}
      onChange={(v) => dispatch({ type: 'patch', patch: { falKey: v, falCheck: { state: 'idle' } } })}
      onValidate={validateFal}
      check={state.falCheck}
      placeholder="key_id:key_secret"
    />
  );

  if (provider === 'segmind') {
    return (
      <div>
        <h1 className="text-title text-ink">Connect Segmind for rendering.</h1>
        <p className="mt-1 text-body text-ink-secondary">
          Your default backend renders on Segmind and bills that account. Create a key at{' '}
          <a
            href="https://www.segmind.com"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline-offset-2 hover:text-accent-hover hover:underline"
          >
            segmind.com
          </a>{' '}
          → Console → API Keys.
        </p>

        <div className="mt-5">
          <KeyField
            label="Segmind API key"
            value={state.segmindKey}
            onChange={(v) => dispatch({ type: 'patch', patch: { segmindKey: v, segmindCheck: { state: 'idle' } } })}
            onValidate={validateSegmind}
            check={state.segmindCheck}
            placeholder="SG_…"
          />
        </div>

        <p className="mt-5 text-caption text-ink-muted">
          Optional: Kling 3.0 Omni and minting persistent character voices run on fal.ai. Add a fal
          key too, or skip it — a Segmind-only install renders and upscales without one.
        </p>
        <div className="mt-2">{falField}</div>

        <FixFooter state={state} dispatch={dispatch} canContinue={canContinue} scope="fal" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-title text-ink">Connect fal.ai for rendering.</h1>
      <p className="mt-1 text-body text-ink-secondary">
        Renders run on fal.ai and bill this account. Create a key at{' '}
        <a
          href="https://fal.ai/dashboard/keys"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:text-accent-hover hover:underline"
        >
          fal.ai/dashboard/keys
        </a>
        .
      </p>

      <div className="mt-5">{falField}</div>

      <FixFooter state={state} dispatch={dispatch} canContinue={canContinue} scope="fal" />
    </div>
  );
}
