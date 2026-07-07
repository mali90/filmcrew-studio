// The step footer, fix-mode aware. Normally "Continue" walks the corridor; when the user jumped
// here FROM the health check, the button becomes "Save & re-check" — it writes only this step's
// named .env keys (the caption says which) and returns to the doctor, which re-runs on arrival.
import type { Dispatch } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';
import { fixUpdates, type WizardAction, type WizardState } from './wizard';

export function FixFooter({ state, dispatch, canContinue, scope }: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  canContinue: boolean;
  scope: 'llm' | 'fal' | 'backend';
}) {
  const { toast } = useToast();
  const updates = fixUpdates(state, scope);
  const save = useMutation({
    mutationFn: () => api.envWrite(updates),
    onSuccess: () => dispatch({ type: 'returnToDoctor' }), // StepDoctor re-runs on mount
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : 'Saving failed.' }),
  });

  if (state.returnTo !== 'doctor') {
    return (
      <div className="mt-8 flex justify-end">
        <Button variant="primary" size="lg" disabled={!canContinue} onClick={() => dispatch({ type: 'next' })}>
          Continue
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-8 flex flex-col items-end gap-1.5">
      <Button variant="primary" size="lg" disabled={!canContinue} loading={save.isPending} onClick={() => save.mutate()}>
        Save &amp; re-check
      </Button>
      <p className="text-caption text-ink-muted">
        Writes {Object.keys(updates).join(', ')} to .env, then re-runs the checks.
      </p>
    </div>
  );
}
