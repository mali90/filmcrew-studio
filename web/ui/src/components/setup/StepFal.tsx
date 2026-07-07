// Step 3 — the fal.ai key. This is the account that gets charged for renders, so on success we
// nudge about credit rather than celebrating.
import type { Dispatch } from 'react';
import { api, ApiClientError } from '../../api/client';
import { FixFooter } from './FixFooter';
import { KeyField } from '../ui/KeyField';
import type { WizardAction, WizardState } from './wizard';

export function StepFal({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const canContinue = state.falCheck.state === 'valid';

  const validate = async () => {
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

      <div className="mt-5">
        <KeyField
          label="fal.ai API key"
          value={state.falKey}
          onChange={(v) => dispatch({ type: 'patch', patch: { falKey: v, falCheck: { state: 'idle' } } })}
          onValidate={validate}
          check={state.falCheck}
          placeholder="key_id:key_secret"
        />
      </div>

      <FixFooter state={state} dispatch={dispatch} canContinue={canContinue} scope="fal" />
    </div>
  );
}
