// TranscriptionProvider adapter — local faster-whisper (large-v3).
//
// A faithful wrap of the existing `transcribe-bazargan-mac.py` parse: faster-
// whisper yields `segments`, each with a `text` and a `words` array of
// `{word,start,end}`. We normalize to the reader's word shape — strip each
// word, drop empties, round timings to 1/100s (same rounding as the ElevenLabs
// adapter) — and build `text` by joining the stripped segment texts. The
// subprocess call is INJECTED as `run(audioPath,{lang}) => Promise<whisperJson>`
// so this unit-tests without ever spawning Python. Mirrors the reference
// elevenlabs-stt.mjs pattern.
import { providerError } from './types.mjs'

const round2 = (x) => Math.round((x || 0) * 100) / 100

export function createWhisperSttAdapter({
  run,
  model = 'large-v3',
} = {}) {
  return {
    id: () => 'whisper-local',
    model,
    async transcribe(audioPath, { lang } = {}) {
      let d
      try {
        d = await run(audioPath, { lang })
      } catch (e) {
        // Surface the subprocess failure with a status/code so the registry can
        // classify it for fallback (same contract as the ElevenLabs !ok path).
        const err = providerError(`whisper-local failed: ${e?.message || e}`, e?.status)
        if (e?.code != null) err.code = e.code
        throw err
      }
      if (!d || typeof d !== 'object') {
        throw providerError('whisper-local: empty transcription result')
      }
      const segments = Array.isArray(d.segments) ? d.segments : []
      // words: flatten segment.words, strip, drop empties, round to 1/100s.
      const words = []
      for (const s of segments) {
        const sw = Array.isArray(s?.words) ? s.words : []
        for (const w of sw) {
          const t = String(w?.word ?? '').trim()
          if (!t) continue
          words.push({ t, s: round2(w.start), e: round2(w.end) })
        }
      }
      // text: join the stripped segment texts (matches the Python's
      // `" ".join(s.text.strip() for s in segs).strip()`).
      const text = segments.map((s) => String(s?.text ?? '').trim()).join(' ').trim()
      return {
        text,
        words,
        providerMeta: {
          provider: 'whisper-local',
          model,
          languageCode: d.language || null,
        },
      }
    },
  }
}
