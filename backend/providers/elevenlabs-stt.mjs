// TranscriptionProvider adapter — ElevenLabs Scribe.
//
// A faithful wrap of the existing server.mjs `elevenLabsSTT`: same endpoint,
// same form fields, same word-normalization (drop 'spacing', round to 1/100s,
// keep audio-event + logprob markers). Deps (fetch, readFile, apiKey, model)
// are injected so it unit-tests without a real key or network. This is the
// reference pattern for the other adapters.
import { basename } from 'node:path'
import { providerError } from './types.mjs'

export function createElevenLabsSttAdapter({
  fetch: fetchImpl,
  readFile,
  apiKey,
  model = 'scribe_v2',
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  return {
    id: () => 'elevenlabs-scribe',
    model,
    async transcribe(audioPath, { lang } = {}) {
      const buf = await readFile(audioPath)
      const form = new FormData()
      form.append('model_id', model)
      if (lang) form.append('language_code', lang)
      form.append('timestamps_granularity', 'word')
      form.append('tag_audio_events', 'true')
      form.append('diarize', 'false')
      form.append('file', new Blob([buf], { type: 'audio/mpeg' }), basename(audioPath))
      const res = await doFetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST', headers: { 'xi-api-key': apiKey }, body: form,
      })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300)
        throw providerError(`ElevenLabs STT ${res.status}: ${body}`, res.status)
      }
      const d = await res.json()
      const words = Array.isArray(d.words)
        ? d.words
            .filter((w) => w.type !== 'spacing')
            .map((w) => ({
              t: w.text,
              s: Math.round((w.start || 0) * 100) / 100,
              e: Math.round((w.end || 0) * 100) / 100,
              ...(w.type === 'audio_event' ? { ev: 1 } : {}),
              ...(typeof w.logprob === 'number' ? { lp: Math.round(w.logprob * 1000) / 1000 } : {}),
            }))
        : undefined
      return {
        text: d.text || '',
        words,
        providerMeta: {
          provider: 'elevenlabs-scribe',
          model,
          languageCode: d.language_code || null,
          languageProbability: typeof d.language_probability === 'number' ? d.language_probability : null,
        },
      }
    },
  }
}
