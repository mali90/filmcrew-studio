// Masked API-key input with live validation: idle → checking → valid/invalid, the result persists
// as a caption under the field. Paste-friendly; the reveal eye is a press-and-hold.
import { useState } from 'react';
import { Eye, EyeOff, CheckCircle2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { Button } from './Button';
import { Spinner } from './Spinner';

export type KeyCheck = { state: 'idle' } | { state: 'checking' } | { state: 'valid'; note?: string } | { state: 'invalid'; reason: string };

export function KeyField({ label, value, onChange, onValidate, check, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onValidate: () => void;
  check: KeyCheck;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  const id = label.toLowerCase().replace(/\W+/g, '-');
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-label text-ink-secondary">{label}</label>
      <div className="flex items-center gap-2">
        <div className={clsx(
          'flex h-8 flex-1 items-center rounded-r2 border bg-surface-2 px-2.5',
          check.state === 'invalid' ? 'border-status-failed' : 'border-line-strong focus-within:border-accent',
        )}>
          <input
            id={id}
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent font-mono text-dense text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="button"
            aria-label={show ? 'hide key' : 'reveal key'}
            className="ml-1 text-ink-muted hover:text-ink-secondary"
            onClick={() => setShow((s) => !s)}
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <Button variant="quiet" size="md" onClick={onValidate} disabled={!value || check.state === 'checking'}>
          Validate
        </Button>
      </div>
      <p className="mt-1 flex min-h-4 items-center gap-1.5 text-caption" aria-live="polite">
        {check.state === 'checking' && (<><Spinner size={12} /> <span className="text-ink-muted">Checking…</span></>)}
        {check.state === 'valid' && (<><CheckCircle2 size={12} className="text-status-done" /> <span className="text-status-done">Key valid{check.note ? ` · ${check.note}` : ''}</span></>)}
        {check.state === 'invalid' && (<><XCircle size={12} className="text-status-failed" /> <span className="text-status-failed">{check.reason}</span></>)}
      </p>
    </div>
  );
}
