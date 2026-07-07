// API keys — fal.ai and the LLM provider. Secrets (fal + LLM key) write only on "Save keys"; the
// non-secret provider/transport/model auto-save the moment you change them (so navigating away never
// loses the choice, and Health re-checks against the live selection). CLI transport swaps the key
// field for a detect/install/login panel; Copilot is CLI-only so it locks transport to CLI.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { KeyField, type KeyCheck } from '../ui/KeyField';
import { ModelSelect } from '../ui/ModelSelect';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CliInstallPanel } from './CliInstallPanel';
import { useToast } from '../ui/Toast';

export const PROVIDERS = [
  { value: 'claude', label: 'Claude', keyEnv: 'ANTHROPIC_API_KEY' },
  { value: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY' },
  { value: 'gemini', label: 'Gemini', keyEnv: 'GEMINI_API_KEY' },
  { value: 'copilot', label: 'Copilot (CLI only)', keyEnv: 'GITHUB_TOKEN' },
] as const;

export function KeysCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus });
  const env = useQuery({ queryKey: ['settings-env'], queryFn: api.envRead });
  const cliAll = useQuery({ queryKey: ['cli-status'], queryFn: api.cliStatusAll });

  const [falKey, setFalKey] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [provider, setProvider] = useState('claude');
  const [transport, setTransport] = useState('api');
  const [model, setModel] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [falCheck, setFalCheck] = useState<KeyCheck>({ state: 'idle' });
  const [llmCheck, setLlmCheck] = useState<KeyCheck>({ state: 'idle' });
  const modelTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (seeded || !status.data) return;
    setProvider(status.data.llm.provider);
    setTransport(status.data.llm.transport);
    setModel(status.data.llm.model ?? '');
    setSeeded(true);
  }, [seeded, status.data]);
  useEffect(() => () => clearTimeout(modelTimer.current), []);

  const keyEnv = PROVIDERS.find((p) => p.value === provider)?.keyEnv ?? 'LLM_API_KEY';
  const maskedFor = (envKey: string) => {
    const row = env.data?.rows.find((r) => r.key === envKey);
    return row?.set ? row.value : 'not set';
  };
  const keySet = (envKey: string) => !!env.data?.rows.find((r) => r.key === envKey)?.set;

  // The non-secret selection auto-saves; secrets stay behind "Save keys".
  const autoSave = useMutation({
    mutationFn: (updates: Record<string, string>) => api.envWrite(updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['setup-status'] });
      qc.invalidateQueries({ queryKey: ['doctor'] });
      qc.invalidateQueries({ queryKey: ['settings-env'] });
    },
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : 'Could not save that change.' }),
  });

  const changeProvider = (p: string) => {
    const t = p === 'copilot' ? 'cli' : transport; // Copilot has no HTTP API — it rides its CLI
    setProvider(p); setTransport(t); setModel(''); setLlmKey(''); setLlmCheck({ state: 'idle' });
    // write provider + model together so .env never holds a provider/model mismatch
    autoSave.mutate({ LLM_PROVIDER: p, LLM_TRANSPORT: t, LLM_MODEL: '' });
  };
  const changeTransport = (t: string) => {
    setTransport(t); setLlmCheck({ state: 'idle' });
    autoSave.mutate({ LLM_TRANSPORT: t });
  };
  const changeModel = (m: string) => {
    setModel(m);
    clearTimeout(modelTimer.current); // debounce so typing a Custom id doesn't rewrite .env per keystroke
    modelTimer.current = setTimeout(() => autoSave.mutate({ LLM_MODEL: m }), 500);
  };

  const validateFal = async () => {
    setFalCheck({ state: 'checking' });
    try {
      const r = await api.validateFal(falKey);
      setFalCheck(r.ok ? { state: 'valid' } : { state: 'invalid', reason: r.reason ?? 'key rejected' });
    } catch (e) {
      setFalCheck({ state: 'invalid', reason: e instanceof ApiClientError ? e.hint : 'validation failed' });
    }
  };

  const validateLlm = async () => {
    setLlmCheck({ state: 'checking' });
    try {
      const r = await api.validateLlm({ provider, transport, model: model || undefined, apiKey: llmKey || undefined });
      setLlmCheck(r.ok ? { state: 'valid' } : { state: 'invalid', reason: r.reason ?? 'key rejected' });
    } catch (e) {
      setLlmCheck({ state: 'invalid', reason: e instanceof ApiClientError ? e.hint : 'validation failed' });
    }
  };

  const save = useMutation({
    mutationFn: (updates: Record<string, string>) => api.envWrite(updates),
    onSuccess: () => {
      toast({ kind: 'success', text: 'Keys saved. Children read .env fresh — no restart needed.' });
      setFalKey('');
      setLlmKey('');
      setFalCheck({ state: 'idle' });
      setLlmCheck({ state: 'idle' });
      qc.invalidateQueries({ queryKey: ['settings-env'] });
      qc.invalidateQueries({ queryKey: ['doctor'] });
      qc.invalidateQueries({ queryKey: ['setup-status'] });
    },
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : 'Saving keys failed.' }),
  });

  const onSave = () => {
    const updates: Record<string, string> = {};
    if (falKey.trim()) updates.FAL_KEY = falKey.trim();
    if (llmKey.trim()) updates[keyEnv] = llmKey.trim();
    if (!Object.keys(updates).length) {
      toast({ kind: 'info', text: 'Nothing to save — enter a key first. (Provider, model, and transport save on change.)' });
      return;
    }
    save.mutate(updates);
  };

  // new-user nudge: a provider CLI you're already signed into, when the current API provider has no key
  const installedClis = (cliAll.data?.providers ?? []).filter((c) => c.installed).map((c) => c.provider);
  const showCliHint = transport === 'api' && !keySet(keyEnv) && installedClis.length > 0;

  return (
    <section aria-labelledby="keys-heading" className="rounded-r3 border border-line bg-surface-1 p-5">
      <h2 id="keys-heading" className="text-heading text-ink">Keys</h2>
      <p className="mt-1 text-dense text-ink-muted">fal.ai renders the clips; your LLM provider plans them.</p>

      <div className="mt-4 space-y-5">
        <KeyField
          label="fal.ai key"
          value={falKey}
          onChange={(v) => { setFalKey(v); setFalCheck({ state: 'idle' }); }}
          onValidate={validateFal}
          check={falCheck}
          placeholder={maskedFor('FAL_KEY')}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="llm-provider" className="mb-1 block text-label text-ink-secondary">LLM provider</label>
            <select
              id="llm-provider"
              value={provider}
              onChange={(e) => changeProvider(e.target.value)}
              className="h-8 rounded-r2 border border-line-strong bg-surface-2 px-2 text-dense text-ink outline-none focus:border-accent"
            >
              {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <SegmentedControl
            label="LLM transport"
            value={transport}
            onChange={changeTransport}
            disabled={provider === 'copilot'}
            segments={[
              { value: 'api', label: 'API key', hint: 'direct HTTPS calls with your key' },
              { value: 'cli', label: 'CLI', hint: 'shells out to the provider CLI you are logged into' },
            ]}
          />
          {provider === 'copilot' && <span className="text-caption text-ink-muted">Copilot works through its CLI only.</span>}
          {transport === 'api' && provider !== 'copilot' && (
            <span className={clsx('text-caption', keySet(keyEnv) ? 'text-status-done' : 'text-ink-muted')}>
              {keySet(keyEnv) ? '● Key set' : '○ Needs key'}
            </span>
          )}
          <span className="ml-auto text-caption text-ink-faint" aria-live="polite">{autoSave.isPending ? 'Saving…' : ''}</span>
        </div>

        {showCliHint && (
          <p className="text-caption text-ink-muted">
            You&rsquo;re already signed into {installedClis.join(', ')} — switch that provider to <strong className="font-medium text-ink-secondary">CLI</strong> transport to use it with no API key.
          </p>
        )}

        <ModelSelect provider={provider} value={model} onChange={changeModel} />

        {transport === 'api' ? (
          <KeyField
            label={`LLM key (${keyEnv})`}
            value={llmKey}
            onChange={(v) => { setLlmKey(v); setLlmCheck({ state: 'idle' }); }}
            onValidate={validateLlm}
            check={llmCheck}
            placeholder={maskedFor(keyEnv)}
          />
        ) : (
          <CliInstallPanel provider={provider} model={model} />
        )}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Button variant="secondary" loading={save.isPending} onClick={onSave}>Save keys</Button>
        <span className="text-caption text-ink-muted">Provider, model, and transport save on change; keys save here.</span>
      </div>
    </section>
  );
}
