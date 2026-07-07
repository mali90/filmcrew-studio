// The one place the curated per-provider model list lives — shared by the CLI wizard, config.js
// (default resolution), and the web app (served via /api/setup/models). Plain data, NO imports: it
// must be importable by config.js, and config.js is imported by llm.js, so this can't depend on
// either without a cycle. Adding/refreshing a model = one edit here.
//
// `default` is the id used when LLM_MODEL is blank (blank = "use the provider default"). Copilot's
// default is genuinely blank — it rides the CLI's own default model. Seed values track
// src/cli/init.js's MODEL_DEFAULT and docs/PROVIDERS.md.
export const MODELS = {
  claude: {
    default: 'claude-opus-4-8',
    options: [
      { id: 'claude-opus-4-8', hint: 'most capable' },
      { id: 'claude-sonnet-5', hint: 'faster, cheaper' },
      { id: 'claude-sonnet-4-5', hint: 'cheaper' },
    ],
  },
  openai: {
    default: 'gpt-5.5',
    options: [
      { id: 'gpt-5.5', hint: 'recommended' },
      { id: 'gpt-5.4-mini', hint: 'fastest, cheapest' },
    ],
  },
  gemini: { default: 'gemini-2.5-pro', options: [{ id: 'gemini-2.5-flash', hint: 'cheaper, faster' }] },
  copilot: { default: '', options: [{ id: 'claude-sonnet-4.5', hint: 'via Copilot' }, { id: 'gpt-5', hint: 'via Copilot' }] },
};

/** The provider's default model id when LLM_MODEL is blank. Unknown provider → Claude's default. */
export const modelDefault = (provider) => MODELS[provider]?.default ?? MODELS.claude.default;

/** The curated `{ default, options }` for a provider (empty shell for an unknown one). */
export const curatedFor = (provider) => MODELS[provider] ?? { default: '', options: [] };

export default { MODELS, modelDefault, curatedFor };
