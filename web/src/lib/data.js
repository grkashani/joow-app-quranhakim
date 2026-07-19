// Data + audio helpers for JoowQuran.
// Text corpus lives in /public/data (extracted from the Quran Hakim app).
// ALL audio + API (recitation, tafsir, /api) is served same-origin, UNDER the app's
// deploy base (Vite's import.meta.env.BASE_URL), so a subpath deploy just works.
//   web build (--base=/hakim/) : AUDIO_BASE = '/hakim' -> /hakim/api, /hakim/recitation, ...
//   web build (--base=/)       : AUDIO_BASE = ''       -> same-origin root; Vite proxies in dev.
//   android/capacitor          : VITE_AUDIO_BASE = 'https://quranner.com' -> absolute origin
//                                (WebView isn't same-origin), overrides the base-derived value.

const base = import.meta.env.BASE_URL || '/'

// Prefix for every audio + /api request. On the web it is derived from the deploy base
// (BASE_URL) so the app is portable across subpaths (/, /hakim/, ...). Native builds set an
// explicit absolute origin via VITE_AUDIO_BASE, which takes precedence.
export const AUDIO_BASE = import.meta.env.VITE_AUDIO_BASE || base.replace(/\/$/, '')

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
// Default reciter = Mishary Alafasy. The old "app"/Quran-Hakim entry was removed:
// it is Bazargan's Persian tafsir voice, NOT an Arabic qari, so it doesn't belong
// in the reciter (قاری عربی) list.
const DEFAULT_RECITER_ID = 'alafasy'
const APP_RECITER_PATTERN = '/reciters/Alafasy_128kbps/{c3}{v3}.mp3'

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
    || _reciters.find((r) => r.id === DEFAULT_RECITER_ID) || _reciters[0]
  if (cur) applyPattern(cur.pattern)
  return _reciters
}

export function getReciter() {
  try { return localStorage.getItem(RECITER_KEY) || DEFAULT_RECITER_ID } catch { return DEFAULT_RECITER_ID }
}

export function setReciter(id) {
  try { localStorage.setItem(RECITER_KEY, id) } catch { /* private mode */ }
  const r = _reciters?.find((x) => x.id === id)
  applyPattern(r?.pattern || APP_RECITER_PATTERN)
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
