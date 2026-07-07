// Every money-bearing button in the review flow goes through this wrapper: the price is stated
// on the button (CostTag), the very first paid click per browser asks once, and the click is the
// natural moment to request OS-notification permission ("I'll be waiting").
import { useState } from 'react';
import { Button, useFirstPaidConfirm, type ButtonProps } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { requestNotifyPermission } from '../../../hooks/useNotifications';

export function PaidButton({
  onPaidClick, children, ...rest
}: Omit<ButtonProps, 'onClick'> & { onPaidClick: () => void }) {
  const { needsConfirm, confirm } = useFirstPaidConfirm();
  const [asking, setAsking] = useState(false);

  const go = () => {
    requestNotifyPermission();
    onPaidClick();
  };

  // price gating lives in Button itself: costUsd === null renders "≈ $…" and disables the click
  return (
    <>
      <Button {...rest} onClick={() => (needsConfirm ? setAsking(true) : go())}>{children}</Button>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title="This one spends real money"
        actions={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => { confirm(); setAsking(false); go(); }}
            >
              Continue
            </Button>
          </>
        }
      >
        Rendering calls fal.ai with your key and bills your account. Every paid button states its
        estimated price before you click — this is the only time we ask.
      </Dialog>
    </>
  );
}
