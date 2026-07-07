// Empty states always sell the next action — never a dead grid.
import type { ReactNode } from 'react';

export function EmptyState({ icon, title, children, action }: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-[360px] flex-col items-center py-16 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-soft)] text-accent" aria-hidden>
        {icon}
      </div>
      <h3 className="mt-3 text-heading text-ink">{title}</h3>
      {children && <p className="mt-1 text-body text-ink-secondary">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
