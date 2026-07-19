// Tafsir transcripts.
//  1) Server cache (fast): GET /transcripts/<tafsir>/<lang>/<c3>/<c3>_<v3>.json — static, instant.
//  2) Server generate (get-or-create): GET /api/transcript?... — transcribes via ElevenLabs
//     Scribe (original language) and/or translates (other languages), persists the result,
//     so it's done ONCE and reused for every user, in every language.
//  3) On-device fallback: in-browser Whisper (transformers.js) if the server isn't configured.
// Local browser cache avoids repeat network round-trips.
import { AUDIO_BASE } from './data.js'

const pad3 = (n) => String(n).padStart(3, '0')
const CACHE = 'jq.transcripts.v2' // v2: entries may carry word timestamps ({ words: [{ t, s, e, ev? }] })
const key = (id, lang, s, a) => `${id}:${lang}:${s}:${a}`
const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE)) || {} } catch { return {} } }
const writeCache = (o) => localStorage.setItem(CACHE, JSON.stringify(o))
export function getCached(id, lang, s, a) { return readCache()[key(id, lang, s, a)] || null }
export function setCached(id, lang, s, a, entry) { const c = readCache(); c[key(id, lang, s, a)] = entry; writeCache(c) }

// UI language code -> BCP-47 locale for on-device speech (Apple wants e.g. 'fa-IR').
const LOCALE = { fa: 'fa-IR', ar: 'ar-SA', en: 'en-US', tr: 'tr-TR', ur: 'ur-PK', id: 'id-ID', ms: 'ms-MY', fr: 'fr-FR', es: 'es-ES', de: 'de-DE', ru: 'ru-RU', hi: 'hi-IN', bn: 'bn-BD', sw: 'sw-KE' }
export const localeFor = (tafsir) => tafsir?.transcript?.locale || LOCALE[tafsir?.transcript?.lang || tafsir?.language] || 'und'

// Contribute a locally/on-device produced transcript to the shared server cache so
// every future user (web, iOS, Android) reads it instantly. Best-effort; never throws.
export async function contributeTranscript(tafsir, s, a, lang, text, source = 'device-ios') {
  try {
    const r = await fetch(`${AUDIO_BASE}/api/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tafsir: tafsir.id, surah: s, ayah: a, lang, text, source }),
    })
    return r.ok
  } catch { return false }
}

// Get-or-create a transcript in `lang`. Returns { text, source, translated?, words?, segments? } or null.
// `words` (when present) is [{ t, s, e, ev? }] — word text + start/end seconds for karaoke sync.
// `segments` (when present) is [{ s, e, text }] — sentence-level windows for the Language Lab.
export async function getServerTranscript(tafsir, s, a, lang) {
  const l = lang || tafsir.transcript?.lang || tafsir.language
  const staticUrl = `${AUDIO_BASE}/transcripts/${tafsir.id}/${l}/${pad3(s)}/${pad3(s)}_${pad3(a)}.json`
  try {
    const r = await fetch(staticUrl)
    if (r.ok) { const d = await r.json(); return { text: d.text, source: d.source || 'server', lang: d.lang, words: Array.isArray(d.words) ? d.words : undefined, segments: Array.isArray(d.segments) ? d.segments : undefined } }
  } catch { /* miss */ }
  // Generate (may take a few seconds on first request for this clip/lang).
  const api = `${AUDIO_BASE}/api/transcript?tafsir=${encodeURIComponent(tafsir.id)}&surah=${s}&ayah=${a}&lang=${encodeURIComponent(l)}`
  const r = await fetch(api)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(d.error || `server ${r.status}`); e.status = r.status; throw e }
  return { text: d.text, source: d.source || 'server', lang: d.lang, translated: d.translated, words: Array.isArray(d.words) ? d.words : undefined, segments: Array.isArray(d.segments) ? d.segments : undefined }
}

// NOTE: the in-browser Whisper fallback was REMOVED by owner directive — all
// transcription and TTS go through the backend so every result is generated once,
// saved on the server, and shared (local/dev runs included). The only non-server
// path is iOS native on-device speech, which is free and contributes its result.
