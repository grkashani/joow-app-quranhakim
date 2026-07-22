// TranslationProvider adapter — Anthropic Messages API.
//
// A faithful wrap of the existing server.mjs `translate`: same endpoint
// (/v1/messages), same x-api-key + anthropic-version headers, the exact
// tafsir-translation prompt, TRANSLATE_MODEL, and content?.[0]?.text?.trim()
// parse. Deps (fetch, apiKey, model) are injected so it unit-tests without a
// real key or network. Returns null when there is no apiKey — matching current
// server behavior — so the registry can skip translation entirely.
import { providerError } from './types.mjs'

export function createAnthropicTranslateAdapter({
  fetch: fetchImpl,
  apiKey,
  model = 'claude-haiku-4-5-20251001',
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  return {
    id: () => 'anthropic',
    model,
    async translate(text, { src, dst } = {}) {
      if (!apiKey) return null
      const res = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [
            {
              role: 'user',
              content: `Translate this Qur'an tafsir (commentary) passage from ${src} to ${dst}. Preserve meaning faithfully and read naturally. Output ONLY the translation, no preamble.\n\n${text}`,
            },
          ],
        }),
      })
      if (!res.ok) throw providerError(`translate ${res.status}`, res.status)
      const d = await res.json()
      const out = d.content?.[0]?.text?.trim() || null
      if (out == null) return null
      return { text: out, providerMeta: { provider: 'anthropic', model } }
    },
  }
}
