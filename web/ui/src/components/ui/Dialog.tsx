// Modal dialog — reserved for destructive confirms and the one-time first-paid-action confirm.
// Esc closes, focus is trapped, the scrim click cancels.
import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({ open, onClose, title, children, actions }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('button, [href], input, textarea, select');
    first?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[480px] rounded-r4 border border-line bg-surface-1 p-5"
        style={{ boxShadow: 'var(--shadow-3)' }}
      >
        <h2 className="text-heading text-ink">{title}</h2>
        <div className="mt-2 text-body text-ink-secondary">{children}</div>
        <div className="mt-5 flex justify-end gap-2">{actions}</div>
      </div>
    </div>
  );
}
