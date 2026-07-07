// Toasts for exactly three occasions: background completion while the user is elsewhere, errors,
// and copy confirmations. On-screen state changes never toast — the run page narrates itself.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CheckCircle2, XCircle, Info } from 'lucide-react';

export interface ToastItem { id: number; kind: 'success' | 'error' | 'info'; text: string; actionLabel?: string; onAction?: () => void }

const ToastCtx = createContext<{ toast: (t: Omit<ToastItem, 'id'>) => void }>({ toast: () => {} });
export const useToast = () => useContext(ToastCtx);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((t: Omit<ToastItem, 'id'>) => {
    const item = { ...t, id: nextId++ };
    setItems((prev) => [...prev.slice(-3), item]);
    // errors stay until the user files them — a 6-second window is not an error surface
    if (t.kind !== 'error') setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== item.id)), 6000);
  }, []);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((i) => i.id !== id)), []);

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={clsx('pointer-events-auto flex items-center gap-2.5 rounded-r3 border border-line bg-surface-3 p-3 text-dense text-ink')}
            style={{ boxShadow: 'var(--shadow-2)' }}
            role={t.kind === 'error' ? 'alert' : undefined}
          >
            {t.kind === 'success' && <CheckCircle2 size={16} className="shrink-0 text-status-done" aria-hidden />}
            {t.kind === 'error' && <XCircle size={16} className="shrink-0 text-status-failed" aria-hidden />}
            {t.kind === 'info' && <Info size={16} className="shrink-0 text-ink-muted" aria-hidden />}
            <span className="flex-1">{t.text}</span>
            {t.actionLabel && (
              <button className="text-label text-accent hover:text-accent-hover" onClick={t.onAction}>{t.actionLabel}</button>
            )}
            {t.kind === 'error' && (
              <button className="text-label text-ink-muted hover:text-ink" aria-label="Dismiss" onClick={() => dismiss(t.id)}>✕</button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
