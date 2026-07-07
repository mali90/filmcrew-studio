// The first-run wizard's state machine — one reducer holds every answer so Back is lossless
// within the session. Nothing persists client-side: the .env written at the end IS the persistence.
import type { Aspect, Backend } from '../../../../shared/api-types';
import type { KeyCheck } from '../ui/KeyField';

export type Provider = 'claude' | 'openai' | 'gemini' | 'copilot';
export type Transport = 'api' | 'cli';
export type Resolution = '720p' | '1080p' | '4k';

export const STEPS = ['welcome', 'llm', 'fal', 'backend', 'presets', 'review', 'doctor', 'done'] as const;
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
  backend: Backend;
  aspect: Aspect;
  resolution: Resolution;
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
  backend: 'kling',
  aspect: '9:16',
  resolution: '1080p',
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
    FAL_KEY: s.falKey,
    RENDER_BACKEND: s.backend === 'kling' ? '' : s.backend,
    KLING_ASPECT: s.aspect,
    KLING_RESOLUTION: s.resolution,
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
  if (scope === 'fal') return { FAL_KEY: s.falKey };
  if (scope === 'backend') return { RENDER_BACKEND: s.backend === 'kling' ? '' : s.backend };
  const updates: Record<string, string> = { LLM_PROVIDER: s.provider, LLM_TRANSPORT: s.transport, LLM_MODEL: s.model };
  if (s.transport === 'api') {
    const keyEnv = PROVIDERS.find((p) => p.id === s.provider)?.keyEnv;
    if (keyEnv) updates[keyEnv] = s.llmKey;
    updates.LLM_API_KEY = s.llmKey;
  }
  return updates;
}
