import { describe, it, expect, vi } from 'vitest'
import { createElevenLabsSttAdapter } from './elevenlabs-stt.mjs'
import { withTimeout, timeoutFor, providerError } from './types.mjs'

const EL_RESPONSE = {
  text: 'بسم الله',
  language_code: 'fa',
  language_probability: 0.98,
  words: [
    { type: 'word', text: 'بسم', start: 0.5, end: 0.912, logprob: -0.1234 },
    { type: 'spacing', text: ' ', start: 0.912, end: 0.95 }, // dropped
    { type: 'word', text: 'الله', start: 0.95, end: 1.4 },
    { type: 'audio_event', text: '(music)', start: 1.4, end: 1.6 },
  ],
}
const okRes = (json) => ({ ok: true, json: async () => json })
const errRes = (status) => ({ ok: false, status, text: async () => 'nope' })

describe('ElevenLabsSttAdapter', () => {
  it('id is stable', () => {
    expect(createElevenLabsSttAdapter({ readFile: async () => Buffer.from('') }).id()).toBe('elevenlabs-scribe')
  })

  it('posts the exact Scribe request (endpoint, key, form fields)', async () => {
    const fetchImpl = vi.fn(async () => okRes(EL_RESPONSE))
    const readFile = vi.fn(async () => Buffer.from('audio'))
    const a = createElevenLabsSttAdapter({ fetch: fetchImpl, readFile, apiKey: 'K', model: 'scribe_v2' })
    await a.transcribe('/srv/tafsir/ssn/001/001_001.mp3', { lang: 'fa' })

    expect(readFile).toHaveBeenCalledWith('/srv/tafsir/ssn/001/001_001.mp3')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect(init.method).toBe('POST')
    expect(init.headers['xi-api-key']).toBe('K')
    const form = init.body // FormData
    expect(form.get('model_id')).toBe('scribe_v2')
    expect(form.get('language_code')).toBe('fa')
    expect(form.get('timestamps_granularity')).toBe('word')
    expect(form.get('tag_audio_events')).toBe('true')
    expect(form.get('diarize')).toBe('false')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })

  it('normalizes words: drops spacing, rounds to 1/100s, keeps ev + lp markers', async () => {
    const a = createElevenLabsSttAdapter({ fetch: async () => okRes(EL_RESPONSE), readFile: async () => Buffer.from('') })
    const r = await a.transcribe('/x.mp3', { lang: 'fa' })
    expect(r.text).toBe('بسم الله')
    expect(r.words).toEqual([
      { t: 'بسم', s: 0.5, e: 0.91, lp: -0.123 },
      { t: 'الله', s: 0.95, e: 1.4 },
      { t: '(music)', s: 1.4, e: 1.6, ev: 1 },
    ])
    expect(r.providerMeta).toMatchObject({ provider: 'elevenlabs-scribe', model: 'scribe_v2', languageCode: 'fa', languageProbability: 0.98 })
  })

  it('throws a status-carrying error on !ok (so the registry can fall back)', async () => {
    const a = createElevenLabsSttAdapter({ fetch: async () => errRes(402), readFile: async () => Buffer.from('') })
    await expect(a.transcribe('/x.mp3', {})).rejects.toMatchObject({ status: 402 })
  })

  it('omits language_code from the form when no lang is given', async () => {
    const fetchImpl = vi.fn(async () => okRes({ text: '', words: [] }))
    const a = createElevenLabsSttAdapter({ fetch: fetchImpl, readFile: async () => Buffer.from(''), apiKey: 'K' })
    await a.transcribe('/x.mp3', {})
    expect(fetchImpl.mock.calls[0][1].body.get('language_code')).toBeNull()
  })
})

describe('withTimeout / timeoutFor (length-aware provider timeout)', () => {
  it('resolves a fast promise', async () => {
    await expect(withTimeout(Promise.resolve(7), 100)).resolves.toBe(7)
  })
  it('rejects a slow promise with an ETIMEDOUT-coded error (triggers fallback)', async () => {
    const slow = new Promise((r) => setTimeout(() => r(1), 50))
    await expect(withTimeout(slow, 5, 'stt')).rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })
  it('scales the ceiling with the input size', () => {
    expect(timeoutFor(30000, 0)).toBe(30000)
    expect(timeoutFor(30000, 2000, 10)).toBe(50000) // 2000 chars × 10ms
  })
  it('providerError attaches status', () => {
    expect(providerError('x', 429)).toMatchObject({ message: 'x', status: 429 })
  })
})
