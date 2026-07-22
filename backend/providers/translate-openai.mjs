// TranslationProvider adapter — OpenAI-compatible chat completions.
//
// A faithful wrap of the existing translate-tafsir.mjs OpenAI-compat path: same
// `${baseUrl}/chat/completions` endpoint (trailing slash stripped, as in the
// script), same `Authorization: Bearer` header, same request body shape
// ({ model, messages:[system,user] }), same `choices[0].message.content` parse,
// and the same tafsir-translation instruction. Point baseUrl at Ollama / LM
// Studio for the FREE local path. Deps (fetch, apiKey, baseUrl, model) are
// injected so it unit-tests without a real key or network.
import { providerError } from './types.mjs'

// Same tafsir-translator persona the script uses (translate-tafsir.mjs SYS),
// adapted to a single-string translate() instead of numbered segments.
const SYS =
  "You are an expert translator of Islamic Qur'an commentary (tafsir) by Abdolali Bazargan. " +
  'Translate faithfully and naturally, preserving meaning, register, and reverent tone. ' +
  'Return ONLY the translation — no commentary, no markdown.'

// Same code → display-name map the script uses, so the instruction reads well.
const LANG_NAME = {
  fa: 'Persian', en: 'English', ar: 'Arabic', es: 'Spanish', fr: 'French', ur: 'Urdu',
  id: 'Indonesian', ru: 'Russian', de: 'German', tr: 'Turkish', hi: 'Hindi', bn: 'Bengali',
  ms: 'Malay', sw: 'Swahili',
}
const name = (code) => LANG_NAME[code] || code || 'the source language'

export function createOpenAiTranslateAdapter({
  fetch: fetchImpl,
  apiKey = 'local',
  baseUrl = 'https://api.openai.com/v1',
  model = 'gpt-4o-mini',
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  const base = baseUrl.replace(/\/$/, '')
  return {
    id: () => 'openai-compat',
    model,
    async translate(text, { src, dst } = {}) {
      const user =
        `Translate the following ${name(src)} tafsir into ${name(dst)}.\n\n${text}`
      const res = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYS },
            { role: 'user', content: user },
          ],
        }),
      })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 150)
        throw providerError(`openai ${res.status}: ${body}`, res.status)
      }
      const d = await res.json()
      const out = d.choices?.[0]?.message?.content || ''
      return { text: out, providerMeta: { provider: 'openai-compat', model } }
    },
  }
}
