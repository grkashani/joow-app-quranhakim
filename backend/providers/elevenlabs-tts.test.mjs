import { describe, it, expect, vi } from 'vitest'
import { createElevenLabsTtsAdapter } from './elevenlabs-tts.mjs'

const MP3 = Buffer.from('ID3-fake-mp3-bytes')
const EL_RESPONSE = {
  audio_base64: MP3.toString('base64'),
  alignment: {
    characters: ['ب', 'س', 'م'],
    character_start_times_seconds: [0.0, 0.12, 0.31],
    character_end_times_seconds: [0.12, 0.31, 0.5],
  },
  normalized_alignment: {
    characters: ['b', 'i', 's', 'm'],
    character_start_times_seconds: [0.0, 0.1, 0.2, 0.3],
    character_end_times_seconds: [0.1, 0.2, 0.3, 0.4],
  },
}
const headers = (h = {}) => ({ get: (k) => (k in h ? h[k] : null) })
const okRes = (json, h) => ({ ok: true, headers: headers(h), json: async () => json })
const errRes = (status) => ({ ok: false, status, headers: headers(), text: async () => 'nope' })

// Reference voiceFor: env-overridable per language, else a default voice id.
const voiceFor = (lang) => (lang === 'fa' ? 'VOICE_FA' : 'VOICE_DEFAULT')

describe('ElevenLabsTtsAdapter', () => {
  it('id is stable and it advertises timestamp support', () => {
    const a = createElevenLabsTtsAdapter()
    expect(a.id()).toBe('elevenlabs')
    expect(a.supportsTimestamps()).toBe(true)
  })

  it('posts the exact with-timestamps request (voice, output_format, key, body JSON)', async () => {
    const fetchImpl = vi.fn(async () => okRes(EL_RESPONSE))
    const a = createElevenLabsTtsAdapter({
      fetch: fetchImpl,
      apiKey: 'K',
      voiceFor,
      format: 'mp3_44100_128',
      model: 'eleven_v3',
    })
    await a.synthesize('بسم', { lang: 'fa' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/VOICE_FA/with-timestamps?output_format=mp3_44100_128',
    )
    expect(init.method).toBe('POST')
    expect(init.headers['xi-api-key']).toBe('K')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers.Accept).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({
      text: 'بسم',
      model_id: 'eleven_v3',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      language_code: 'fa',
    })
  })

  it('decodes audio_base64 to a Buffer and packs raw + normalized alignment', async () => {
    const a = createElevenLabsTtsAdapter({ fetch: async () => okRes(EL_RESPONSE), apiKey: 'K', voiceFor })
    const r = await a.synthesize('بسم', { lang: 'fa' })

    expect(Buffer.isBuffer(r.audio)).toBe(true)
    expect(r.audio.equals(MP3)).toBe(true)
    expect(r.alignment.raw).toEqual({
      characters: ['ب', 'س', 'م'],
      starts: [0.0, 0.12, 0.31],
      ends: [0.12, 0.31, 0.5],
    })
    expect(r.alignment.normalized).toEqual({
      characters: ['b', 'i', 's', 'm'],
      starts: [0.0, 0.1, 0.2, 0.3],
      ends: [0.1, 0.2, 0.3, 0.4],
    })
    expect(r.providerMeta).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v3', voice: 'VOICE_FA' })
  })

  it('surfaces request-id and character-cost from the response headers', async () => {
    const a = createElevenLabsTtsAdapter({
      fetch: async () => okRes(EL_RESPONSE, { 'request-id': 'req_42', 'character-cost': '3' }),
      apiKey: 'K',
      voiceFor,
    })
    const r = await a.synthesize('بسم', { lang: 'fa' })
    expect(r.providerMeta.requestId).toBe('req_42')
    expect(r.providerMeta.characterCost).toBe(3)
  })

  it('null alignment when the vendor returns no character alignment', async () => {
    const a = createElevenLabsTtsAdapter({
      fetch: async () => okRes({ audio_base64: MP3.toString('base64'), alignment: {}, normalized_alignment: null }),
      apiKey: 'K',
      voiceFor,
    })
    const r = await a.synthesize('x', { lang: 'fa' })
    expect(r.alignment).toEqual({ raw: null, normalized: null })
  })

  it('honors an explicit voice and per-call voice settings, overriding defaults', async () => {
    const fetchImpl = vi.fn(async () => okRes(EL_RESPONSE))
    const a = createElevenLabsTtsAdapter({ fetch: fetchImpl, apiKey: 'K', voiceFor })
    await a.synthesize('hi', { voice: 'CUSTOM_VOICE', lang: 'en', settings: { stability: 0.9, similarity_boost: 0.1 } })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/text-to-speech/CUSTOM_VOICE/with-timestamps')
    expect(JSON.parse(init.body).voice_settings).toEqual({ stability: 0.9, similarity_boost: 0.1 })
  })

  it('omits language_code from the body when no lang is given', async () => {
    const fetchImpl = vi.fn(async () => okRes(EL_RESPONSE))
    const a = createElevenLabsTtsAdapter({ fetch: fetchImpl, apiKey: 'K', voiceFor })
    await a.synthesize('hello', {})
    expect('language_code' in JSON.parse(fetchImpl.mock.calls[0][1].body)).toBe(false)
  })

  it('throws a status-carrying error on !ok (so the registry can fall back)', async () => {
    const a = createElevenLabsTtsAdapter({ fetch: async () => errRes(429), apiKey: 'K', voiceFor })
    await expect(a.synthesize('x', { lang: 'fa' })).rejects.toMatchObject({ status: 429 })
  })

  it('throws when the decoded audio is empty', async () => {
    const a = createElevenLabsTtsAdapter({
      fetch: async () => okRes({ audio_base64: '', alignment: null, normalized_alignment: null }),
      apiKey: 'K',
      voiceFor,
    })
    await expect(a.synthesize('x', { lang: 'fa' })).rejects.toThrow(/empty audio/)
  })
})
