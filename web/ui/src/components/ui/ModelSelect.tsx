// Model picker shared by the Settings Keys card and the first-run wizard. A native <select> that
// matches the provider dropdown exactly, with: a "Provider default — <id>" sentinel (value ''), the
// curated alternatives, any live models the provider returned (behind an optgroup; OpenAI's noisy list
// gated behind "show all"), and a "Custom…" escape that swaps in a free-text field. Emits only the
// plain LLM_MODEL string ('' = provider default).
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button } from './Button';

const CUSTOM = '__custom__';
const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', copilot: 'Copilot' };
const selectCls = 'h-8 rounded-r2 border border-line-strong bg-surface-2 px-2 text-dense text-ink outline-none focus:border-accent';

export function ModelSelect({ provider, value, onChange, id = 'llm-model', label = 'Model', disabled }: {
  provider: string;
  value: string;                 // '' = provider default
  onChange: (model: string) => void;
  id?: string;
  label?: string;
  disabled?: boolean;
}) {
  const { data } = useQuery({ queryKey: ['models', provider], queryFn: () => api.models(provider) });
  const [custom, setCustom] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const options = data?.options ?? [];
  const live = data?.live ?? [];
  const curatedIds = new Set(options.map((o) => o.id));
  const liveIds = new Set(live.map((m) => m.id));
  const known = (v: string) => v === '' || curatedIds.has(v) || liveIds.has(v);

  // provider changed → back to the list; a value the list can't represent → open in Custom
  useEffect(() => { setCustom(false); setShowAll(false); }, [provider]);
  useEffect(() => { if (data && !custom && value && !known(value)) setCustom(true); }, [data, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const providerLabel = PROVIDER_LABEL[provider] ?? provider;
  const liveExtra = live.filter((m) => !curatedIds.has(m.id) && m.id !== data?.default);
  const shownLive = provider === 'openai' && !showAll ? liveExtra.filter((m) => m.recommended) : liveExtra;
  const hiddenLive = liveExtra.length - shownLive.length;

  const onSelect = (v: string) => {
    if (v === CUSTOM) { setCustom(true); if (!value || !known(value)) onChange(value); return; }
    setCustom(false);
    onChange(v);
  };

  const caption = (() => {
    if (custom) return 'Enter any model id your provider accepts.';
    if (value === '') return `Uses ${providerLabel}'s current default${data?.default ? ` — ${data.default}` : ''}. Not pinned.`;
    const hint = options.find((o) => o.id === value)?.hint;
    if (hint) return `${hint[0].toUpperCase()}${hint.slice(1)} than the default.`;
    return '';
  })();

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-label text-ink-secondary">
        {label}{custom && <span className="font-normal text-ink-faint"> · custom</span>}
      </label>
      {custom ? (
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="blank uses the provider default"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="h-8 w-full rounded-r2 border border-line-strong bg-surface-2 px-2.5 font-mono text-dense text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
          <Button variant="quiet" size="sm" onClick={() => { setCustom(false); onChange(known(value) ? value : ''); }}>Choose from list</Button>
        </div>
      ) : (
        <select id={id} value={value} disabled={disabled} onChange={(e) => onSelect(e.target.value)} className={selectCls}>
          <option value="">{`Provider default${data?.default && !curatedIds.has(data.default) ? ` — ${data.default}` : ''}`}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.id}{o.hint ? ` · ${o.hint}` : ''}</option>)}
          {shownLive.length > 0 && (
            <optgroup label={`From your ${providerLabel} key`}>
              {shownLive.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
            </optgroup>
          )}
          <option value={CUSTOM}>Custom…</option>
        </select>
      )}
      <p className="mt-1 flex min-h-4 items-center gap-1.5 text-caption text-ink-muted">
        {caption}
        {!custom && hiddenLive > 0 && (
          <button type="button" className="text-accent hover:text-accent-hover" onClick={() => setShowAll(true)}>Show all {liveExtra.length} models</button>
        )}
        {!custom && data?.liveError === 'no-key' && provider !== 'copilot' && <span>Add an API key to list all available models.</span>}
      </p>
    </div>
  );
}
