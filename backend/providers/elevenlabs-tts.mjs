// TtsProvider adapter — ElevenLabs (timestamped / with-timestamps).
//
// A faithful wrap of the existing server.mjs `ttsElevenLabsTimed`: same
// `/text-to-speech/{voice}/with-timestamps?output_format=…` endpoint, same JSON
// body (text, model_id, voice_settings, optional language_code), same headers
// (xi-api-key + JSON), and the same read of `audio_base64` (→ Buffer) plus the
// per-character `alignment` / `normalized_alignment` (packed as
// {characters,starts,ends}). Deps (fetch, apiKey, voiceFor, format, model,
// voiceSettings) are injected so it unit-tests with no real key or network.
//
// It does NOT do the budget ledger, chunking, or word-grouping that live around
// this call in server.mjs — those are Job/store concerns, not the provider's.
import { providerError } from './types.mjs'

// Same shape as server.mjs `packAlignment`: keep the per-character arrays under
// stable keys, or null when the vendor returned no character alignment.
const packAlignment = (a) =>
  a && a.characters
    ? {
        characters: a.characters,
        starts: a.character_start_times_seconds,
        ends: a.character_end_times_seconds,
      }
    : null

export function createElevenLabsTtsAdapter({
  fetch: fetchImpl,
  apiKey,
  voiceFor = (lang) => lang,
  format = 'mp3_44100_128',
  model = 'eleven_v3',
  voiceSettings = { stability: 0.5, similarity_boost: 0.75 },
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  return {
    id: () => 'elevenlabs',
    supportsTimestamps: () => true,
    async synthesize(text, { voice, lang, settings } = {}) {
      const useVoice = voice || voiceFor(lang)
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(useVoice)}/with-timestamps?output_format=${format}`
      const body = { text, model_id: model, voice_settings: settings || voiceSettings }
      if (lang) body.language_code = lang
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = (await res.text().catch(() => '')).slice(0, 300)
        throw providerError(`ElevenLabs TTS(ts) ${res.status}: ${errBody}`, res.status)
      }
      const requestId = res.headers?.get?.('request-id') || null
      const characterCost = Number(res.headers?.get?.('character-cost')) || null
      const j = await res.json()
      const audio = Buffer.from(j.audio_base64 || '', 'base64')
      if (!audio.length) throw providerError('ElevenLabs TTS(ts) returned empty audio', 502)
      return {
        audio,
        alignment: {
          raw: packAlignment(j.alignment),
          normalized: packAlignment(j.normalized_alignment),
        },
        providerMeta: {
          provider: 'elevenlabs',
          model,
          voice: useVoice,
          requestId,
          characterCost,
        },
      }
    },
  }
}
