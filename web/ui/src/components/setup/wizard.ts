// The first-run wizard's state machine — one reducer holds every answer so Back is lossless
// within the session. Nothing persists client-side: the .env written at the end IS the persistence.
import type { Aspect, Backend, Resolution } from '../../../../shared/api-types';
import { defaultResolutionFor, resolutionEnvFor } from '../../../../shared/render-models';
import type { KeyCheck } from '../ui/KeyField';

export type Provider = 'claude' | 'openai' | 'gemini' | 'copilot';
export type Transport = 'api' | 'cli';
export type { Resolution };

// `backend` comes BEFORE the render-key step: the key the wizard must collect depends on which
// provider the chosen backend bills (a Segmind pick needs SEGMIND_API_KEY, not a fal key).
export const STEPS = ['welcome', 'llm', 'backend', 'fal', 'presets', 'review', 'doctor', 'done'] as const;
export type StepId = (typeof STEPS)[number];

export interface WizardState {
  step: number;
  /** A fix jump from the health check is a detour with a return ticket, not a rewind. */
  returnTo: 'doctor' | null;
  provider: Provider;
  transport: Transport;
  model: string;
  llmKey: string;
  llmCheck: KeyCheck;
  falKey: string;
  falCheck: KeyCheck;
  segmindKey: string;
  segmindCheck: KeyCheck;
  backend: Backend;
  aspect: Aspect;
  /** null = the chosen backend has no selectable tier (Kling renders the endpoint's own output). */
  resolution: Resolution | null;
}

export const initialWizardState: WizardState = {
  step: 0,
  returnTo: null,
  provider: 'claude',
  transport: 'api',
  model: '',
  llmKey: '',
  llmCheck: { state: 'idle' },
  falKey: '',
  falCheck: { state: 'idle' },
  segmindKey: '',
  segmindCheck: { state: 'idle' },
  backend: 'kling',
  aspect: '9:16',
  resolution: defaultResolutionFor('kling') ?? null, // the default backend's own tier (null = none selectable) — trimmed on backend switch
};

export type WizardAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'fix'; step: StepId }
  | { type: 'returnToDoctor' }
  | { type: 'patch'; patch: Partial<WizardState> }
  | { type: 'provider'; provider: Provider };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'next':
      return { ...state, step: Math.min(state.step + 1, STEPS.length - 1) };
    case 'back':
      return { ...state, step: Math.max(state.step - 1, 0) };
    case 'fix':
      return { ...state, step: STEPS.indexOf(action.step), returnTo: 'doctor' };
    case 'returnToDoctor':
      return { ...state, step: STEPS.indexOf('doctor'), returnTo: null };
    case 'patch':
      return { ...state, ...action.patch };
    case 'provider': {
      if (action.provider === state.provider) return state;
      return {
        ...state,
        provider: action.provider,
        // Copilot has no API surface — it always rides the installed CLI.
        transport: action.provider === 'copilot' ? 'cli' : state.transport,
        model: '', // model ids are provider-specific — reset to the new provider's default
        llmCheck: { state: 'idle' },
      };
    }
  }
}

export const PROVIDERS: { id: Provider; name: string; note: string; keyEnv: string | null }[] = [
  { id: 'claude', name: 'Claude', note: 'API key or CLI', keyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', note: 'API key or CLI', keyEnv: 'OPENAI_API_KEY' },
  { id: 'gemini', name: 'Gemini', note: 'API key or CLI', keyEnv: 'GEMINI_API_KEY' },
  { id: 'copilot', name: 'Copilot', note: 'CLI only', keyEnv: null },
];

/** The exact .env updates map the save step previews and writes — kept in one place so the
 *  preview and the write can never drift apart. RENDER_BACKEND is '' for kling (the default). */
export function buildUpdates(s: WizardState): Record<string, string> {
  const updates: Record<string, string> = {
    LLM_PROVIDER: s.provider,
    LLM_TRANSPORT: s.transport,
    LLM_MODEL: s.model,
    // Only when entered — for BOTH provider keys: on the Segmind path the fal field is optional,
    // and `/setup?rerun=1` saving `FAL_KEY: ''` would silently erase a configured key (breaking
    // Kling renders, voice minting and fal-storage uploads). On the fal path the key is required
    // by the step gate, so it is always non-empty there.
    ...(s.falKey ? { FAL_KEY: s.falKey } : {}),
    ...(s.segmindKey ? { SEGMIND_API_KEY: s.segmindKey } : {}),
    RENDER_BACKEND: s.backend === 'kling' ? '' : s.backend,
    KLING_ASPECT: s.aspect,
    // The knob the CHOSEN backend's model actually reads (KLING_RESOLUTION / SEEDANCE_RESOLUTION /
    // SEEDANCE25_RESOLUTION, from the registry). Writing KLING_RESOLUTION unconditionally was the
    // silent bug: a Seedance default backend ignored the wizard's pick entirely and rendered at its
    // own .env default. Other models' knobs are left alone — a rerun must not blank them.
    // No knob, no write: a model without a ladder (Kling) has no resolution variable at all, and
    // `[undefined]: …` would literally write a key named "undefined" into .env.
    ...(resolutionEnvFor(s.backend) && s.resolution ? { [resolutionEnvFor(s.backend)]: s.resolution } : {}),
  };
  if (s.transport === 'api') {
    const keyEnv = PROVIDERS.find((p) => p.id === s.provider)?.keyEnv;
    if (keyEnv) updates[keyEnv] = s.llmKey;
    updates.LLM_API_KEY = s.llmKey;
  }
  return updates;
}

/** The .env delta ONE fix step owns — a fix writes just its named keys, never the whole review. */
export function fixUpdates(s: WizardState, scope: 'llm' | 'fal' | 'backend'): Record<string, string> {
  if (scope === 'fal') {
    // Only the keys actually entered: the fix loop also runs on EXISTING installs (doctor → Fix
    // key), where writing the other provider's empty field would blank a configured key.
    const keys = { FAL_KEY: s.falKey, SEGMIND_API_KEY: s.segmindKey };
    return Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
  }
  if (scope === 'backend') return { RENDER_BACKEND: s.backend === 'kling' ? '' : s.backend };
  const updates: Record<string, string> = { LLM_PROVIDER: s.provider, LLM_TRANSPORT: s.transport, LLM_MODEL: s.model };
  if (s.transport === 'api') {
    const keyEnv = PROVIDERS.find((p) => p.id === s.provider)?.keyEnv;
    if (keyEnv) updates[keyEnv] = s.llmKey;
    updates.LLM_API_KEY = s.llmKey;
  }
  return updates;
}
