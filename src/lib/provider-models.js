// Live "list models" fetchers for the providers that expose an HTTP API. The curated src/lib/models.js
// catalog is always the backbone (default + hints + works with no key / in CLI mode); this layers the
// provider's real, account-specific list on top when an API key is present. The provider CLIs have no
// scriptable list-models command, so this is API-key-only. Separate from models.js because it does
// network I/O and imports util.js — models.js must stay a pure-data module config.js can import.
import { fetchJson as defaultFetchJson } from './util.js';

// OpenAI's /v1/models returns EVERY model (embeddings, tts, whisper, image, realtime…) with no
// capability flag, so we flag the chat-likely ones; the UI shows those inline and the rest on demand.
const OPENAI_CHAT_RE = /^(gpt|o\d|chatgpt)/i;
const OPENAI_NON_CHAT_RE = /(embedding|whisper|tts|dall-?e|moderation|realtime|audio|image|transcribe|search|codex)/i;

async function listClaude(apiKey, fetchJson, timeoutMs) {
  const out = [];
  let url = 'https://api.anthropic.com/v1/models?limit=1000';
  for (let page = 0; page < 10; page++) { // bound pagination — every real account is one page today
    const body = await fetchJson(url, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }, { retries: 1, timeoutMs });
    for (const m of body?.data ?? []) out.push({ id: m.id, label: m.display_name || m.id });
    if (!body?.has_more || !body?.last_id) break;
    url = `https://api.anthropic.com/v1/models?limit=1000&after_id=${encodeURIComponent(body.last_id)}`;
  }
  return out;
}

async function listOpenai(apiKey, fetchJson, timeoutMs) {
  const body = await fetchJson('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } }, { retries: 1, timeoutMs });
  return (body?.data ?? []).map((m) => ({
    id: m.id,
    recommended: OPENAI_CHAT_RE.test(m.id) && !OPENAI_NON_CHAT_RE.test(m.id),
  }));
}

async function listGemini(apiKey, fetchJson, timeoutMs) {
  const out = [];
  const base = 'https://generativelanguage.googleapis.com/v1beta/models';
  let url = `${base}?pageSize=1000&key=${encodeURIComponent(apiKey)}`;
  for (let page = 0; page < 10; page++) {
    const body = await fetchJson(url, {}, { retries: 1, timeoutMs });
    for (const m of body?.models ?? []) {
      const methods = m.supportedGenerationMethods || m.supportedActions || [];
      if (!methods.includes('generateContent')) continue; // drop embedding/vision-only entries
      const id = String(m.name || '').replace(/^models\//, '');
      if (id) out.push({ id, label: m.displayName || id });
    }
    if (!body?.nextPageToken) break;
    url = `${base}?pageSize=1000&pageToken=${encodeURIComponent(body.nextPageToken)}&key=${encodeURIComponent(apiKey)}`;
  }
  return out;
}

const FETCHERS = { claude: listClaude, openai: listOpenai, gemini: listGemini };

/** True iff the provider has an HTTP models API we can query (copilot is CLI-only → false). */
export const hasLiveModelApi = (provider) => provider in FETCHERS;

/** Fetch the provider's live model list. Throws if the provider has no API or the request fails —
 *  the caller decides how to degrade. `fetchJson` is injectable for tests. */
export async function listProviderModels({ provider, apiKey, timeoutMs = 8000, fetchJson = defaultFetchJson }) {
  const fn = FETCHERS[provider];
  if (!fn) throw new Error(`no live model API for provider "${provider}"`);
  if (!apiKey) throw new Error('no API key');
  return { models: await fn(apiKey, fetchJson, timeoutMs) };
}

export default { hasLiveModelApi, listProviderModels };
