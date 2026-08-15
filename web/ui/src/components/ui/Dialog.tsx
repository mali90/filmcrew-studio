// Modal dialog — reserved for destructive confirms and the one-time first-paid-action confirm.
// Esc closes, focus is trapped, the scrim click cancels.
import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({ open, onClose, title, children, actions, size = 'default' }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** `wide` (640px) is for a dialog that has to SHOW something — 480px cannot carry two boundary
   *  frames side by side and still read as one row (spec D13a). */
  size?: 'default' | 'wide';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Skip roving-tabindex members (a SegmentedControl gives its unselected options tabindex="-1"):
    // landing on an UNCHECKED radio would read as the dialog's opening statement and put a paid
    // choice one reflex keypress from flipping. The first tabbable control is the checked one.
    const first = ref.current?.querySelector<HTMLElement>('button:not([tabindex="-1"]), [href], input, textarea, select');
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
        // The panel must never outgrow the viewport: a tall dialog (the re-render dialog with every
        // warn row up plus its inline paid confirm) would otherwise clip its action row off-screen
        // with nothing scrollable — the paid button this dialog exists to gate becomes unreachable
        // on a laptop viewport. Title and actions stay pinned; only the content between them scrolls.
        className={`relative flex max-h-[calc(100vh-3rem)] w-full ${size === 'wide' ? 'max-w-[640px]' : 'max-w-[480px]'} flex-col rounded-r4 border border-line bg-surface-1 p-5`}
        style={{ boxShadow: 'var(--shadow-3)' }}
      >
        <h2 className="text-heading text-ink">{title}</h2>
        <div className="mt-2 min-h-0 overflow-y-auto text-body text-ink-secondary">{children}</div>
        <div className="mt-5 flex justify-end gap-2">{actions}</div>
      </div>
    </div>
  );
}
