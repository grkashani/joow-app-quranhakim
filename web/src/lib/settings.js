// Lightweight app settings (theme + font size), persisted and applied via
// data-attributes on <html> so CSS can react.
export function getTheme() { return localStorage.getItem('jq.theme') || 'light' }
export function getFont() { return localStorage.getItem('jq.font') || 'medium' }

export function applyTheme(t) { document.documentElement.setAttribute('data-theme', t) }
export function applyFont(f) { document.documentElement.setAttribute('data-font', f) }

export function setTheme(t) { localStorage.setItem('jq.theme', t); applyTheme(t) }
export function setFont(f) { localStorage.setItem('jq.font', f); applyFont(f) }

export function initSettings() { applyTheme(getTheme()); applyFont(getFont()) }

// ---- Reader model settings ----
// The reader plays a per-ayah SEQUENCE in ONE meaning language and auto-scrolls
// as it reads. Three persisted settings drive it, all chosen in the Settings
// drawer:
//   a. meaningLang      — the SINGLE language the meaning is shown/spoken in
//   b. reciteArabic     — play the Arabic recitation BEFORE the meaning (default ON)
//   c. tafsirMode       — 'off' | 'short' | 'long' commentary after the meaning
//   d. readAnnotations  — include the translator's [..]/(..) clarifying insertions
//                         in the spoken audio + display (default ON)
// A single change-event carries the whole settings object (same CustomEvent
// pattern the old reading-languages list used), so the reader live-updates while
// the drawer is open.
// EXACTLY the 8 meaning languages present in the surah data JSON (fa/en + t{}).
export const MEANING_LANGS = ['en', 'fa', 'ar', 'tr', 'fr', 'es', 'de', 'ru']
export const READER_SETTINGS_EVENT = 'jq:reader-settings'

const MEANING_KEY = 'jq.meaningLang'
const RECITE_KEY = 'jq.reciteArabic'
const TAFSIR_KEY = 'jq.tafsirMode'
const ANNOTATIONS_KEY = 'jq.readAnnotations'
// Farsi "Original" mode: play Abdolali Bazargan's OWN voice for the tafsir
// (short + long) instead of the AI-narrated Persian. The human recordings cover
// the WHOLE Qur'an, so this is what lets Farsi users use every surah today (the
// AI narration only exists for a few surahs). Farsi-only; ignored for other
// meaning languages. Default OFF (AI narration remains the default everywhere).
const ORIGINAL_KEY = 'jq.farsiOriginal'

export function getMeaningLang() {
  const v = localStorage.getItem(MEANING_KEY)
  if (v && MEANING_LANGS.includes(v)) return v
  // First run: inherit the app content language if it's one we offer, else English.
  const content = localStorage.getItem('jq.lang')
  return MEANING_LANGS.includes(content) ? content : 'en'
}
export function getReciteArabic() {
  const v = localStorage.getItem(RECITE_KEY)
  return v == null ? true : v === '1' // default ON
}
export function getTafsirMode() {
  const v = localStorage.getItem(TAFSIR_KEY)
  return v === 'short' || v === 'long' ? v : 'off' // default Off
}
export function getReadAnnotations() {
  const v = localStorage.getItem(ANNOTATIONS_KEY)
  return v == null ? true : v === '1' // default ON — read the translator's [..]/(..) insertions
}
export function getFarsiOriginal() {
  return localStorage.getItem(ORIGINAL_KEY) === '1' // default OFF
}

export function getReaderSettings() {
  return { meaningLang: getMeaningLang(), reciteArabic: getReciteArabic(), tafsirMode: getTafsirMode(), readAnnotations: getReadAnnotations(), farsiOriginal: getFarsiOriginal() }
}
const emit = () => window.dispatchEvent(new CustomEvent(READER_SETTINGS_EVENT, { detail: getReaderSettings() }))

export function setMeaningLang(l) {
  if (!MEANING_LANGS.includes(l)) return getMeaningLang()
  localStorage.setItem(MEANING_KEY, l); emit(); return l
}
export function setReciteArabic(on) { localStorage.setItem(RECITE_KEY, on ? '1' : '0'); emit(); return !!on }
export function setReadAnnotations(on) { localStorage.setItem(ANNOTATIONS_KEY, on ? '1' : '0'); emit(); return !!on }
export function setTafsirMode(m) {
  const v = m === 'short' || m === 'long' ? m : 'off'
  localStorage.setItem(TAFSIR_KEY, v); emit(); return v
}
export function setFarsiOriginal(on) { localStorage.setItem(ORIGINAL_KEY, on ? '1' : '0'); emit(); return !!on }
