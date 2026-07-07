// Step 2 — the planning LLM: provider card grid, API-key vs local-CLI transport, live key check.
// Copilot is CLI-only, so picking it locks the transport to the installed CLI.
import type { Dispatch } from 'react';
import clsx from 'clsx';
import { api, ApiClientError } from '../../api/client';
import { FixFooter } from './FixFooter';
import { KeyField } from '../ui/KeyField';
import { ModelSelect } from '../ui/ModelSelect';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CliInstallPanel } from '../settings/CliInstallPanel';
import { PROVIDERS, type Transport, type WizardAction, type WizardState } from './wizard';

export function StepLlm({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const isCopilot = state.provider === 'copilot';
  const providerName = PROVIDERS.find((p) => p.id === state.provider)?.name ?? state.provider;
  const canContinue = state.transport === 'cli' || state.llmCheck.state === 'valid';

  const validate = async () => {
    dispatch({ type: 'patch', patch: { llmCheck: { state: 'checking' } } });
    try {
      const r = await api.validateLlm({
        provider: state.provider,
        transport: state.transport,
        model: state.model || undefined,
        apiKey: state.llmKey,
      });
      dispatch({
        type: 'patch',
        patch: {
          llmCheck: r.ok
            ? { state: 'valid' }
            : { state: 'invalid', reason: r.reason ?? 'That key did not validate.' },
        },
      });
    } catch (e) {
      dispatch({
        type: 'patch',
        patch: {
          llmCheck: {
            state: 'invalid',
            reason: e instanceof ApiClientError ? e.hint : 'Could not reach the server.',
          },
        },
      });
    }
  };

  return (
    <div>
      <h1 className="text-title text-ink">Choose your planner.</h1>
      <p className="mt-1 text-body text-ink-secondary">
        This model writes the production plan. Planning calls cost pennies at most.
      </p>

      <div role="radiogroup" aria-label="LLM provider" className="mt-5 grid grid-cols-2 gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={state.provider === p.id}
            onClick={() => dispatch({ type: 'provider', provider: p.id })}
            className={clsx(
              'rounded-r2 border p-3 text-left transition-colors duration-[120ms]',
              state.provider === p.id
                ? 'border-accent bg-[var(--accent-soft)]'
                : 'border-line bg-surface-2 hover:border-line-strong',
            )}
          >
            <span className="block text-label text-ink">{p.name}</span>
            <span className="block text-caption text-ink-muted">{p.note}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <SegmentedControl<Transport>
          label="Transport"
          value={state.transport}
          onChange={(v) => dispatch({ type: 'patch', patch: { transport: v } })}
          segments={[
            { value: 'api', label: 'API key' },
            { value: 'cli', label: 'Local CLI' },
          ]}
          disabled={isCopilot}
        />
        {isCopilot && <span className="text-caption text-ink-muted">Copilot works through its CLI only.</span>}
      </div>

      {state.transport === 'api' ? (
        <div className="mt-4">
          <KeyField
            label={`${providerName} API key`}
            value={state.llmKey}
            onChange={(v) => dispatch({ type: 'patch', patch: { llmKey: v, llmCheck: { state: 'idle' } } })}
            onValidate={validate}
            check={state.llmCheck}
            placeholder="paste your key"
          />
        </div>
      ) : (
        <div className="mt-4">
          <CliInstallPanel provider={state.provider} model={state.model} />
        </div>
      )}

      <div className="mt-4">
        <ModelSelect
          provider={state.provider}
          value={state.model}
          onChange={(m) => dispatch({ type: 'patch', patch: { model: m } })}
        />
      </div>

      <FixFooter state={state} dispatch={dispatch} canContinue={canContinue} scope="llm" />
    </div>
  );
}
