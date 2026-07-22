import { describe, it, expect, vi } from 'vitest'
import { createWhisperSttAdapter } from './whisper-stt.mjs'

// The JSON shape faster-whisper emits (via the injected `run` subprocess):
// segments, each with `text` and `words:[{word,start,end}]`. Note the leading
// spaces on `word` and a whitespace-only token — both handled by the parse.
const WHISPER_JSON = {
  language: 'fa',
  segments: [
    {
      text: ' بسم الله',
      words: [
        { word: ' بسم', start: 0.5, end: 0.912, probability: 0.98 },
        { word: ' الله', start: 0.95, end: 1.4, probability: 0.95 },
      ],
    },
    {
      text: 'الرحمن',
      words: [
        { word: '  ', start: 1.4, end: 1.41 }, // whitespace-only → dropped
        { word: 'الرحمن', start: 1.42, end: 2.003, probability: 0.9 },
      ],
    },
  ],
}

describe('WhisperSttAdapter', () => {
  it('id is stable', () => {
    expect(createWhisperSttAdapter({ run: async () => WHISPER_JSON }).id()).toBe('whisper-local')
  })

  it('calls run with the audio path + lang', async () => {
    const run = vi.fn(async () => WHISPER_JSON)
    const a = createWhisperSttAdapter({ run, model: 'large-v3' })
    await a.transcribe('/srv/tafsir/ssn/001/001_001.mp3', { lang: 'fa' })
    expect(run).toHaveBeenCalledWith('/srv/tafsir/ssn/001/001_001.mp3', { lang: 'fa' })
  })

  it('normalizes words: flattens segments, strips + drops empties, rounds to 1/100s', async () => {
    const a = createWhisperSttAdapter({ run: async () => WHISPER_JSON, model: 'large-v3' })
    const r = await a.transcribe('/x.mp3', { lang: 'fa' })
    expect(r.text).toBe('بسم الله الرحمن')
    expect(r.words).toEqual([
      { t: 'بسم', s: 0.5, e: 0.91 },
      { t: 'الله', s: 0.95, e: 1.4 },
      { t: 'الرحمن', s: 1.42, e: 2 },
    ])
    expect(r.providerMeta).toMatchObject({ provider: 'whisper-local', model: 'large-v3', languageCode: 'fa' })
  })

  it('handles a whisperJson with no segments (empty text + words)', async () => {
    const a = createWhisperSttAdapter({ run: async () => ({ language: 'fa' }) })
    const r = await a.transcribe('/x.mp3', {})
    expect(r.text).toBe('')
    expect(r.words).toEqual([])
    expect(r.providerMeta).toMatchObject({ provider: 'whisper-local', model: 'large-v3' })
  })

  it('rethrows a run failure as a status-carrying error (so the registry can fall back)', async () => {
    const run = async () => { const e = new Error('whisper crashed'); e.status = 500; throw e }
    const a = createWhisperSttAdapter({ run })
    await expect(a.transcribe('/x.mp3', {})).rejects.toMatchObject({ status: 500 })
  })

  it('throws when run yields no result', async () => {
    const a = createWhisperSttAdapter({ run: async () => null })
    await expect(a.transcribe('/x.mp3', {})).rejects.toThrow(/empty transcription result/)
  })
})
