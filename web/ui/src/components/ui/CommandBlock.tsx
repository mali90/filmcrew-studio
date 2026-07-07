// A copyable shell command in a mono well (extracted from FfmpegPanel so the CLI-install panel can
// reuse it). The command is `select-all` and scrolls horizontally; the copy button flips to a check.
import { useState } from 'react';
import clsx from 'clsx';
import { Check, Copy } from 'lucide-react';
import { useToast } from './Toast';

export function CommandBlock({ command, how, label, className }: {
  command: string;
  how?: string;
  label?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ kind: 'error', text: 'Could not copy — your browser blocked clipboard access.' });
    }
  };
  return (
    <div className={className}>
      {label && <p className="text-caption text-ink-muted">{label}</p>}
      <div className={clsx('flex items-center gap-2 rounded-r2 bg-surface-2 px-2.5 py-1.5', label && 'mt-1')}>
        <span className="flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-dense text-ink">{command}</span>
        <button
          type="button"
          aria-label="Copy command"
          onClick={() => void copy()}
          className="shrink-0 text-ink-muted transition-colors duration-[120ms] hover:text-ink-secondary"
        >
          {copied ? <Check size={14} className="text-status-done" /> : <Copy size={14} />}
        </button>
        <span aria-live="polite" className={copied ? 'text-caption text-status-done' : 'sr-only'}>{copied ? 'Copied' : ''}</span>
      </div>
      {how && <p className="mt-1.5 text-caption text-ink-muted">{how}</p>}
    </div>
  );
}
