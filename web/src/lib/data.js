// Data + audio helpers for JoowQuran.
// Text corpus lives in /public/data (extracted from the Quran Hakim app).
// ALL audio (recitation + tafsir) is served from the quranner.com backend.
//   web build : AUDIO_BASE = '' -> same-origin relative URLs (/recitation, /tafsir); Vite proxies in dev.
//   android   : VITE_AUDIO_BASE = 'https://quranner.com' -> absolute URLs (WebView isn't same-origin).

const base = import.meta.env.BASE_URL || '/'

// Absolute backend origin for audio when the app isn't served from the backend (Capacitor/Android).
export const AUDIO_BASE = import.meta.env.VITE_AUDIO_BASE || ''

export async function loadSurahIndex() {
  const res = await fetch(`${base}data/surahs.json`)
  if (!res.ok) throw new Error(`surah index ${res.status}`)
  return res.json()
}

const surahCache = new Map()
export async function loadSurah(num) {
  const key = String(num)
  if (surahCache.has(key)) return surahCache.get(key)
  const res = await fetch(`${base}data/surah/${num}.json`)
  if (!res.ok) throw new Error(`surah ${num} ${res.status}`)
  const data = await res.json()
  surahCache.set(key, data)
  return data
}

const pad3 = (n) => String(n).padStart(3, '0')
const fillPattern = (pattern, surah, ayah) =>
  pattern
    .replaceAll('{c3}', pad3(surah)).replaceAll('{v3}', pad3(ayah))
    .replaceAll('{c}', String(surah)).replaceAll('{v}', String(ayah))

// ---- Reciters ----
// Registry: /public/data/reciters.json — [{ id, nameEn, nameFa, pattern }].
// The selected reciter (localStorage jq.reciter, default 'app') drives EVERY
// recitation URL, download path and offline cache key. The selected pattern is
// mirrored in localStorage (jq.reciterPattern) so URLs are correct synchronously
// at boot, before the registry JSON has finished loading.
const RECITER_KEY = 'jq.reciter'
const RECITER_PATTERN_KEY = 'jq.reciterPattern'
const APP_RECITER_PATTERN = '/recitation/{c3}/{c3}_{v3}.mp3'

let _reciters = null
let _pattern = (() => {
  try { return localStorage.getItem(RECITER_PATTERN_KEY) || APP_RECITER_PATTERN } catch { return APP_RECITER_PATTERN }
})()

const applyPattern = (p) => {
  _pattern = p || APP_RECITER_PATTERN
  try { localStorage.setItem(RECITER_PATTERN_KEY, _pattern) } catch { /* private mode */ }
}

export async function loadReciters() {
  if (_reciters) return _reciters
  const res = await fetch(`${base}data/reciters.json`)
  if (!res.ok) throw new Error(`reciters ${res.status}`)
  _reciters = await res.json()
  // Re-apply the stored selection against the fresh registry (heals a stale mirror).
  const cur = _reciters.find((r) => r.id === getReciter())
  if (cur) applyPattern(cur.pattern)
  return _reciters
}

export function getReciter() {
  try { return localStorage.getItem(RECITER_KEY) || 'app' } catch { return 'app' }
}

export function setReciter(id) {
  try { localStorage.setItem(RECITER_KEY, id) } catch { /* private mode */ }
  const r = _reciters?.find((x) => x.id === id)
  applyPattern(id === 'app' ? APP_RECITER_PATTERN : r?.pattern)
}

// Relative paths on the backend (also used as offline cache keys).
// Recitation follows the SELECTED reciter's pattern.
export function recitationPath(surah, ayah) {
  return fillPattern(_pattern, surah, ayah)
}
export function tafsirPath(surah, ayah) {
  return `/tafsir/ssn/${pad3(surah)}/${pad3(surah)}_${pad3(ayah)}.mp3`
}

// Recitation (selected reciter; default = the Quran Hakim reciter) — streamed from the backend.
export function recitationAudioUrl(surah, ayah) {
  return `${AUDIO_BASE}${recitationPath(surah, ayah)}`
}

// Bazargan tafsir — one clip per ayah — streamed from the backend.
export function tafsirAudioUrl(surah, ayah) {
  return `${AUDIO_BASE}${tafsirPath(surah, ayah)}`
}

// Short tafsir (خلاصه / summary) — human Persian recording — streamed from the backend.
export function shortTafsirAudioUrl(surah, ayah) {
  return `${AUDIO_BASE}/tafsir-short/${pad3(surah)}/${pad3(surah)}_${pad3(ayah)}.mp3`
}
