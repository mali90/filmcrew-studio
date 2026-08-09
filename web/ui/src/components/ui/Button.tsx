// Button with the CostTag pattern: money-bearing actions carry their price INSIDE the button,
// stated calmly before the click — never a surprise charge. The first paid click per session asks
// once (see useFirstPaidConfirm in this file).
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Spinner } from './Spinner';
import { usd } from '../../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'destructive';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'lg' | 'md' | 'sm';
  loading?: boolean;
  icon?: ReactNode;
  /** Estimated cost in USD — renders the integrated CostTag segment. */
  costUsd?: number | null;
  /**
   * The action costs money but NO per-second rate is on file (Segmind publishes none). This is a
   * different state from `costUsd === null`, which means "the estimate is still loading" and rightly
   * disables the button: an unknown rate never resolves, so blocking would strand a perfectly
   * renderable backend behind a spinner forever. The button stays clickable and the tag stops
   * pretending to know a number — warn, don't block.
   */
  costUnknown?: boolean;
}

const variantClass: Record<Variant, string> = {
  primary: 'bg-accent text-onaccent hover:bg-accent-hover active:scale-[0.98] disabled:bg-surface-2 disabled:text-ink-faint',
  secondary: 'bg-surface-2 border border-line-strong text-ink hover:bg-surface-3 disabled:text-ink-faint',
  ghost: 'text-ink-secondary hover:bg-surface-2 disabled:text-ink-faint',
  quiet: 'text-accent hover:text-accent-hover disabled:text-ink-faint',
  destructive: 'text-status-failed hover:bg-[var(--status-failed-soft)] disabled:text-ink-faint',
};
const sizeClass = { lg: 'h-9 px-4 text-label', md: 'h-8 px-3 text-label', sm: 'h-7 px-2.5 text-caption' };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, costUsd, costUnknown = false, className, children, disabled, title, type = 'button', ...rest }, ref,
) {
  // costUsd === null means "this button spends money and its estimate hasn't loaded" — a money
  // button must state its price BEFORE it can fire, so it waits. (undefined = not a priced button.)
  // An unknown RATE is not that: the number is never coming, so the button goes ahead unpriced.
  const awaitingPrice = costUsd === null && !costUnknown;
  const priced = costUsd !== undefined || costUnknown;
  return (
    <button
      ref={ref}
      type={type} // default "button": a Button inside a <form> must never submit it implicitly
      disabled={disabled || loading || awaitingPrice}
      title={awaitingPrice ? 'Waiting for the price estimate…'
        : costUnknown ? 'This spends real money — the provider publishes no per-second rate, so there is no estimate to show.'
        : title}
      className={clsx(
        'inline-flex items-center gap-2 rounded-r2 font-medium transition-colors duration-[120ms] select-none whitespace-nowrap',
        variantClass[variant], sizeClass[size], className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      <span>{children}</span>
      {priced && (
        <span
          className={clsx('tnum -mr-1 border-l border-current/20 pl-2 text-caption', costUnknown ? 'opacity-90' : 'opacity-80')}
          // The visible tag deliberately avoids the words the surrounding amber note uses, so the
          // page states "price not set" ONCE, in prose, with the reason — the tag just refuses to
          // show a figure it does not have.
          aria-label={costUnknown ? 'price not set' : awaitingPrice ? 'estimating cost' : `estimated cost ${usd(costUsd as number)}`}
        >
          {costUnknown ? 'rate not on file' : <>≈ {awaitingPrice ? '$…' : usd(costUsd as number)}</>}
        </span>
      )}
    </button>
  );
});

const PAID_KEY = 'kva-paid-confirmed';

/** One-time "this calls fal.ai and costs money" confirmation per browser, for the FIRST paid action. */
export function useFirstPaidConfirm() {
  const [confirmed, setConfirmed] = useState(() => {
    try { return localStorage.getItem(PAID_KEY) === '1'; } catch { return true; }
  });
  return {
    needsConfirm: !confirmed,
    confirm() {
      try { localStorage.setItem(PAID_KEY, '1'); } catch { /* private mode */ }
      setConfirmed(true);
    },
  };
}
