// Text-to-speech for tafsir transcripts. The server generates spoken audio of the
// transcript (in the requested language) once via ElevenLabs v3 and caches it as a
// static mp3 — so every future listener streams it instantly, and the paid API is
// only ever hit ONCE per clip/lang for everyone. Returns an mp3 URL.
import { AUDIO_BASE } from './data.js'

const pad3 = (n) => String(n).padStart(3, '0')

export async function getTtsUrl(tafsir, s, a, lang) {
  const l = lang || tafsir.transcript?.lang || tafsir.language
  const staticUrl = `${AUDIO_BASE}/tafsir-tts/${tafsir.id}/${l}/${pad3(s)}/${pad3(s)}_${pad3(a)}.mp3`
  // Already generated WITH karaoke timings? Gate on the `.words.json` sidecar, not the
  // mp3: a clip that has audio but no sidecar (pre-word-timing) must be regenerated so
  // the word-by-word highlight works. The sidecar and mp3 are always written together.
  // A GET (not HEAD): the service worker only intercepts GETs, so this works offline
  // from the download cache — and it warms the sidecar cache for the reader.
  try {
    const h = await fetch(staticUrl.replace(/\.mp3$/, '.words.json'))
    if (h.ok) return staticUrl
  } catch { /* fall through to generate */ }
  // First time for this clip/lang: generate once; the server persists it for everyone.
  let r
  try {
    r = await fetch(`${AUDIO_BASE}/api/tts-audio?tafsir=${encodeURIComponent(tafsir.id)}&surah=${s}&ayah=${a}&lang=${encodeURIComponent(l)}`)
  } catch (err) {
    // Network unreachable (offline): treat as "not ready" so the reader skips the
    // step with its honest note instead of halting the whole read-along.
    const e = new Error('offline'); e.status = 503; throw e
  }
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.url) { const e = new Error(d.error || `tts ${r.status}`); e.status = r.status; throw e }
  return `${AUDIO_BASE}${d.url}`
}

// Per-sentence TTS for the Language Lab: one short clip per transcript segment.
// The server is get-or-create — the paid API is hit ONCE ever per clip, then the
// mp3 is a static cached file. Returns a playable URL ({ url } from the API).
// A small in-memory memo avoids re-asking the API within a session.
const segMemo = new Map()
export async function getTtsSegmentUrl(tafsir, s, a, lang, seg) {
  const k = `${tafsir.id}:${lang}:${s}:${a}:${seg}`
  if (segMemo.has(k)) return segMemo.get(k)
  // NOTE: the server's parameter is `idx` (see backend/server.mjs /api/tts-segment).
  // Sending `seg` would be ignored server-side (idx would parse as 0) and EVERY
  // sentence would come back as segment 0's clip — so `idx` it must be.
  const r = await fetch(
    `${AUDIO_BASE}/api/tts-segment?tafsir=${encodeURIComponent(tafsir.id)}&surah=${s}&ayah=${a}&lang=${encodeURIComponent(lang)}&idx=${seg}`
  )
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.url) { const e = new Error(d.error || `tts ${r.status}`); e.status = r.status; throw e }
  const url = d.url.startsWith('http') ? d.url : `${AUDIO_BASE}${d.url}`
  segMemo.set(k, url)
  return url
}
