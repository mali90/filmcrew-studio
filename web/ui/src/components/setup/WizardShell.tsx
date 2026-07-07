// Centered 560px wizard card on the bare stage — progress dots across the top (current = accent),
// Back on every step after the first. One concern per step; the steps render inside the card.
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import clsx from 'clsx';
import { Button } from '../ui/Button';

export function WizardShell({ step, total, onBack, backLabel, children }: {
  step: number;
  total: number;
  onBack?: () => void;
  backLabel?: string; // fix-mode: a jump from the health check returns THERE, not one step back
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen justify-center bg-surface-0 px-6 py-14">
      <main className="w-full max-w-[560px]">
        <div className="mb-5 flex h-8 items-center">
          {onBack && (
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} aria-hidden />} onClick={onBack}>
              {backLabel ?? 'Back'}
            </Button>
          )}
          <div role="img" aria-label={`Step ${step + 1} of ${total}`} className="ml-auto flex items-center gap-2">
            {Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                aria-hidden
                className={clsx(
                  'h-1.5 w-1.5 rounded-full transition-colors duration-[120ms]',
                  i === step ? 'bg-accent' : i < step ? 'bg-line-strong' : 'bg-surface-3',
                )}
              />
            ))}
          </div>
        </div>
        <div className="rounded-r3 border border-line bg-surface-1 p-8">{children}</div>
      </main>
    </div>
  );
}
