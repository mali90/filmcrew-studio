// The honest answer when a provider publishes no per-second rate. Every provider we ship is priced
// today; this is the path the NEXT one lands on until its rates are looked up, so it stays generic.
//
// Two things have to be true at once, and it is easy to get either one wrong:
//   1. Unknown is NOT free. The render bills exactly like any other, so the copy says so in words —
//      no "$0.00", no borrowed sibling rate, no cheerful silence.
//   2. Unknown does NOT block. The estimate will never arrive, so the paid button stays enabled and
//      this note carries the caution instead — amber, not green, and never a spinner.
// The `hint` comes from the server's `unknownPrice.hint`: it names the provider and where the rate
// could be looked up, so the note is actionable rather than merely apologetic.
import clsx from 'clsx';

export function UnknownPriceNote({ hint, className }: { hint?: string | null; className?: string }) {
  return (
    <p className={clsx('mt-2 text-caption text-status-warn', className)} aria-live="polite">
      <span className="font-medium">Price not set</span>
      {' — this render still costs money; the provider does not publish a per-second rate, so there is no estimate to show. '}
      {hint}
    </p>
  );
}
