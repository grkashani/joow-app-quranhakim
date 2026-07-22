import { describe, it, expect } from 'vitest'
import { createRegistry, isRetryable } from './registry.mjs'

const fake = (id) => ({ id: () => id, transcribe: async () => ({}) })

describe('registry precedence (chainIds)', () => {
  const config = {
    defaults: { stt: ['whisper-local', 'elevenlabs-scribe'] },
    scopes: {
      'stt:fa': ['whisper-local', 'elevenlabs-scribe'],
      'stt:bazargan': ['elevenlabs-scribe'],
    },
  }
  it('override wins over everything', () => {
    const r = createRegistry({ config })
    expect(r.chainIds('stt', { override: 'x', lang: 'fa' })).toEqual(['x'])
  })
  it('per-lang scope wins over default', () => {
    const r = createRegistry({ config })
    expect(r.chainIds('stt', { lang: 'fa' })).toEqual(['whisper-local', 'elevenlabs-scribe'])
  })
  it('per-tafsir scope used when no lang match', () => {
    const r = createRegistry({ config })
    expect(r.chainIds('stt', { tafsir: 'bazargan' })).toEqual(['elevenlabs-scribe'])
  })
  it('falls back to defaults when no scope matches', () => {
    const r = createRegistry({ config })
    expect(r.chainIds('stt', { lang: 'zz' })).toEqual(['whisper-local', 'elevenlabs-scribe'])
  })
  it('empty when a capability has no config at all', () => {
    const r = createRegistry({ config: {} })
    expect(r.chainIds('tts', {})).toEqual([])
  })
})

describe('resolve — skips unregistered providers (degrades, never throws)', () => {
  it('returns only registered instances, in chain order', () => {
    const r = createRegistry({ config: { defaults: { stt: ['whisper-local', 'elevenlabs-scribe'] } } })
    r.register('stt', fake('whisper-local'))
    // elevenlabs-scribe NOT registered → dropped from the resolved chain
    const chain = r.resolve('stt', {})
    expect(chain.map((p) => p.id())).toEqual(['whisper-local'])
  })
  it('preserves order when both are registered', () => {
    const r = createRegistry({ config: { defaults: { stt: ['whisper-local', 'elevenlabs-scribe'] } } })
    r.register('stt', fake('elevenlabs-scribe'))
    r.register('stt', fake('whisper-local'))
    expect(r.resolve('stt', {}).map((p) => p.id())).toEqual(['whisper-local', 'elevenlabs-scribe'])
  })
  it('register requires an id() function', () => {
    const r = createRegistry({})
    expect(() => r.register('stt', {})).toThrow()
  })
})

describe('isRetryable — fallback triggers', () => {
  it('retries on 402/408/429/5xx and transient network errors', () => {
    expect(isRetryable({ status: 402 })).toBe(true)     // EL past_due
    expect(isRetryable({ status: 429 })).toBe(true)
    expect(isRetryable({ status: 503 })).toBe(true)
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isRetryable({ name: 'AbortError' })).toBe(true)
    expect(isRetryable({ message: 'socket hang up' })).toBe(true)
  })
  it('does NOT retry on 4xx client errors (a real bug in our request)', () => {
    expect(isRetryable({ status: 400 })).toBe(false)
    expect(isRetryable({ status: 401 })).toBe(false)
    expect(isRetryable(null)).toBe(false)
  })
})
