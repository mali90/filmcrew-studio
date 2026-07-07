// First-run wizard — a route takeover at /setup, one concern per step. All answers live in one
// reducer so Back is lossless within the session; the .env written at the end is the only
// persistence. Finishing invalidates the setup gate and lands on the studio.
import { useReducer } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { WizardShell } from '../components/setup/WizardShell';
import { StepWelcome } from '../components/setup/StepWelcome';
import { StepLlm } from '../components/setup/StepLlm';
import { StepFal } from '../components/setup/StepFal';
import { StepBackend } from '../components/setup/StepBackend';
import { StepPresets } from '../components/setup/StepPresets';
import { StepReview } from '../components/setup/StepReview';
import { StepDoctor } from '../components/setup/StepDoctor';
import { StepDone } from '../components/setup/StepDone';
import { initialWizardState, STEPS, wizardReducer, type WizardState } from '../components/setup/wizard';

export default function SetupPage({ initial }: { initial?: Partial<WizardState> }) {
  // `initial` exists for tests/deep-links only — real sessions always start at the welcome step.
  const [state, dispatch] = useReducer(wizardReducer, { ...initialWizardState, ...initial });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const step = STEPS[state.step];
  const next = () => dispatch({ type: 'next' });

  const finish = async () => {
    // The gate redirects everything to /setup until setup-status reports complete — refetch must
    // land BEFORE navigating or the router bounces us straight back here.
    await queryClient.refetchQueries({ queryKey: ['setup-status'] });
    navigate('/');
  };

  return (
    <WizardShell
      step={state.step}
      total={STEPS.length}
      onBack={state.step > 0 ? () => dispatch(state.returnTo === 'doctor' ? { type: 'returnToDoctor' } : { type: 'back' }) : undefined}
      backLabel={state.returnTo === 'doctor' ? 'Back to health check' : undefined}
    >
      {step === 'welcome' && <StepWelcome onNext={next} />}
      {step === 'llm' && <StepLlm state={state} dispatch={dispatch} />}
      {step === 'fal' && <StepFal state={state} dispatch={dispatch} />}
      {step === 'backend' && <StepBackend state={state} dispatch={dispatch} />}
      {step === 'presets' && <StepPresets state={state} dispatch={dispatch} />}
      {step === 'review' && <StepReview state={state} dispatch={dispatch} />}
      {step === 'doctor' && <StepDoctor dispatch={dispatch} onContinue={next} />}
      {step === 'done' && <StepDone onFinish={finish} />}
    </WizardShell>
  );
}
