// Every money-bearing button in the review flow goes through this wrapper: the price is stated
// on the button (CostTag), the very first paid click per browser asks once, and the click is the
// natural moment to request OS-notification permission ("I'll be waiting").
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { Button, useFirstPaidConfirm, type ButtonProps } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { requestNotifyPermission } from '../../../hooks/useNotifications';

/** The one-time sentence, shared by both confirm shapes so the promise cannot drift between them. */
const CONFIRM_TEXT = 'Rendering calls your configured provider (fal.ai or Segmind) with your key and bills that '
  + 'account. Every paid button states its estimated price when a rate is on file — and says so when one isn\'t. '
  + 'This is the only time we ask.';

export function PaidButton({
  onPaidClick, children, confirmMode = 'modal', confirmSlot = null, ...rest
}: Omit<ButtonProps, 'onClick'> & {
  onPaidClick: () => void;
  /**
   * How the first-paid confirmation asks. `modal` opens this component's own Dialog; `inline`
   * renders the same sentence into a slot the PARENT owns, because a PaidButton that already lives
   * inside an open Dialog would otherwise stack a second scrim over the first (spec D13b) — and two
   * scrims read as two decisions when there is only one.
   */
  confirmMode?: 'modal' | 'inline';
  /** Where the inline confirmation renders. Null falls back to rendering it beside the button. */
  confirmSlot?: HTMLElement | null;
}) {
  const { needsConfirm, confirm } = useFirstPaidConfirm();
  const [asking, setAsking] = useState(false);

  const go = () => {
    requestNotifyPermission();
    onPaidClick();
  };
  const accept = () => { confirm(); setAsking(false); go(); };

  // price gating lives in Button itself: costUsd === null renders "≈ $…" and disables the click
  const button = <Button {...rest} onClick={() => (needsConfirm ? setAsking(true) : go())}>{children}</Button>;

  if (confirmMode === 'inline') {
    const note = asking && needsConfirm ? (
      <div
        role="group"
        aria-label="This one spends real money"
        data-testid="paid-inline-confirm"
        className="flex flex-col gap-2 rounded-r2 border border-line bg-[var(--status-warn-soft)] p-2.5 text-dense text-ink-secondary"
      >
        <p className="flex gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-warn" aria-hidden />
          <span><strong className="text-ink">This one spends real money.</strong> {CONFIRM_TEXT}</span>
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>Not yet</Button>
          <Button variant="primary" size="sm" onClick={accept}>Continue</Button>
        </div>
      </div>
    ) : null;
    return (
      <>
        {note && confirmSlot ? createPortal(note, confirmSlot) : note}
        {button}
      </>
    );
  }

  return (
    <>
      {button}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title="This one spends real money"
        actions={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button variant="primary" onClick={accept}>Continue</Button>
          </>
        }
      >
        {CONFIRM_TEXT}
      </Dialog>
    </>
  );
}
